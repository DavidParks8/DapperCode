use std::{
    fmt,
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::{Duration, SystemTime},
};

use axum::{
    body::Bytes,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo,
    },
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use futures_util::{SinkExt, StreamExt};
use hyper::server::conn::http1;
use hyper_util::{rt::TokioIo, service::TowerToHyperService};
use rcgen::{
    BasicConstraints, CertificateParams, CertifiedIssuer, CustomExtension, DnType,
    ExtendedKeyUsagePurpose, IsCa, KeyPair, KeyUsagePurpose, PKCS_ECDSA_P256_SHA256,
};
use rustls::{
    client::danger::HandshakeSignatureValid,
    crypto::{ring, verify_tls13_signature, CryptoProvider},
    pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, UnixTime},
    server::{
        danger::{ClientCertVerified, ClientCertVerifier},
        NoServerSessionStorage,
    },
    version::TLS13,
    DigitallySignedStruct, DistinguishedName, Error as TlsError, ServerConfig, SignatureScheme,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use tower::Service;
use x509_parser::prelude::*;

const EC_PUBLIC_KEY_OID: &str = "1.2.840.10045.2.1";
const P256_CURVE_OID: &str = "1.2.840.10045.3.1.7";
const ECDSA_SHA256_OID: &str = "1.2.840.10045.4.3.2";

type ProofResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[derive(Clone, Copy, Eq, PartialEq)]
pub struct SpkiPin([u8; 32]);

impl SpkiPin {
    pub fn parse(value: &str) -> ProofResult<Self> {
        let decoded = URL_SAFE_NO_PAD.decode(value)?;
        let bytes: [u8; 32] = decoded
            .try_into()
            .map_err(|_| "SPKI pin must decode to exactly 32 bytes")?;
        Ok(Self(bytes))
    }

    pub fn from_spki_der(spki_der: &[u8]) -> Self {
        Self(Sha256::digest(spki_der).into())
    }

    pub fn encoded(self) -> String {
        URL_SAFE_NO_PAD.encode(self.0)
    }

    fn matches(self, candidate: Self) -> bool {
        self.0
            .iter()
            .zip(candidate.0)
            .fold(0_u8, |difference, (left, right)| {
                difference | (left ^ right)
            })
            == 0
    }
}

impl fmt::Debug for SpkiPin {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("SpkiPin")
            .field(&self.encoded())
            .finish()
    }
}

#[derive(Debug)]
pub struct ExactClientSpkiVerifier {
    allowed_pin: SpkiPin,
    provider: Arc<CryptoProvider>,
    empty_hints: Vec<DistinguishedName>,
}

impl ExactClientSpkiVerifier {
    pub fn new(allowed_pin: SpkiPin, provider: Arc<CryptoProvider>) -> Self {
        Self {
            allowed_pin,
            provider,
            empty_hints: Vec::new(),
        }
    }

    fn verify_wrapper(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        now: UnixTime,
    ) -> Result<(), TlsError> {
        if !intermediates.is_empty() {
            return Err(TlsError::General(
                "client wrapper must be a single self-signed leaf".to_string(),
            ));
        }

        let (remaining, certificate) = parse_x509_certificate(end_entity.as_ref())
            .map_err(|error| TlsError::General(format!("malformed client wrapper: {error}")))?;
        if !remaining.is_empty() {
            return Err(TlsError::General(
                "client wrapper contains trailing DER".to_string(),
            ));
        }
        if certificate.version() != X509Version::V3 {
            return Err(TlsError::General(
                "client wrapper must be X.509 v3".to_string(),
            ));
        }
        if certificate.subject() != certificate.issuer() {
            return Err(TlsError::General(
                "client wrapper must be self-issued".to_string(),
            ));
        }
        if certificate.signature_algorithm.algorithm.to_id_string() != ECDSA_SHA256_OID {
            return Err(TlsError::General(
                "client wrapper must use ECDSA with SHA-256".to_string(),
            ));
        }

        let public_key = certificate.public_key();
        if public_key.algorithm.algorithm.to_id_string() != EC_PUBLIC_KEY_OID {
            return Err(TlsError::General(
                "client wrapper must contain an EC public key".to_string(),
            ));
        }
        let curve = public_key
            .algorithm
            .parameters
            .as_ref()
            .and_then(|parameters| parameters.as_oid().ok())
            .map(|oid| oid.to_id_string());
        if curve.as_deref() != Some(P256_CURVE_OID) {
            return Err(TlsError::General(
                "client wrapper must contain a P-256 public key".to_string(),
            ));
        }

        let now_seconds = i64::try_from(now.as_secs())
            .map_err(|_| TlsError::General("current time is out of range".to_string()))?;
        let now = ASN1Time::from_timestamp(now_seconds)
            .map_err(|error| TlsError::General(format!("invalid current time: {error}")))?;
        if !certificate.validity().is_valid_at(now) {
            return Err(TlsError::General(
                "client wrapper is not currently valid".to_string(),
            ));
        }

        if certificate.extensions().len() != 3 {
            return Err(TlsError::General(
                "client wrapper must contain only basicConstraints, keyUsage, and extendedKeyUsage"
                    .to_string(),
            ));
        }
        let basic_constraints = certificate
            .basic_constraints()
            .map_err(|error| TlsError::General(format!("invalid basic constraints: {error}")))?
            .ok_or_else(|| {
                TlsError::General("client wrapper is missing basic constraints".to_string())
            })?;
        if !basic_constraints.critical || basic_constraints.value.ca {
            return Err(TlsError::General(
                "client wrapper must contain critical CA=false basic constraints".to_string(),
            ));
        }

        let key_usage = certificate
            .key_usage()
            .map_err(|error| TlsError::General(format!("invalid key usage: {error}")))?
            .ok_or_else(|| TlsError::General("client wrapper is missing key usage".to_string()))?;
        if !key_usage.critical || key_usage.value.flags != 1 {
            return Err(TlsError::General(
                "client wrapper key usage must be critical and digitalSignature-only".to_string(),
            ));
        }

        let extended_key_usage = certificate
            .extended_key_usage()
            .map_err(|error| TlsError::General(format!("invalid extended key usage: {error}")))?
            .ok_or_else(|| {
                TlsError::General("client wrapper is missing extended key usage".to_string())
            })?;
        if !extended_key_usage.value.client_auth
            || extended_key_usage.value.any
            || extended_key_usage.value.server_auth
            || extended_key_usage.value.code_signing
            || extended_key_usage.value.email_protection
            || extended_key_usage.value.time_stamping
            || extended_key_usage.value.ocsp_signing
            || !extended_key_usage.value.other.is_empty()
        {
            return Err(TlsError::General(
                "client wrapper must be restricted to clientAuth".to_string(),
            ));
        }

        certificate
            .verify_signature(Some(public_key))
            .map_err(|error| {
                TlsError::General(format!("invalid client self-signature: {error}"))
            })?;

        let candidate_pin = SpkiPin::from_spki_der(public_key.raw);
        if !self.allowed_pin.matches(candidate_pin) {
            return Err(TlsError::General(
                "client SPKI is not authorized".to_string(),
            ));
        }
        Ok(())
    }
}

impl ClientCertVerifier for ExactClientSpkiVerifier {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &self.empty_hints
    }

    fn verify_client_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        now: UnixTime,
    ) -> Result<ClientCertVerified, TlsError> {
        self.verify_wrapper(end_entity, intermediates, now)?;
        Ok(ClientCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        Err(TlsError::General(
            "TLS 1.2 CertificateVerify is disabled".to_string(),
        ))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        if dss.scheme != SignatureScheme::ECDSA_NISTP256_SHA256 {
            return Err(TlsError::General(
                "client CertificateVerify must use ECDSA P-256 with SHA-256".to_string(),
            ));
        }
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![SignatureScheme::ECDSA_NISTP256_SHA256]
    }
}

pub struct ServerIdentity {
    pub certificate_chain: Vec<CertificateDer<'static>>,
    pub private_key: PrivateKeyDer<'static>,
    pub pin: SpkiPin,
}

pub fn generate_server_identity(hostname: &str) -> ProofResult<ServerIdentity> {
    let key_pair = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256)?;
    let parameters = server_certificate_parameters(hostname)?;
    let certificate = parameters.self_signed(&key_pair)?;
    let certificate_der = certificate.der().clone();
    let pin = certificate_spki_pin(certificate_der.as_ref())?;
    let private_key = PrivatePkcs8KeyDer::from(key_pair.serialize_der())
        .clone_key()
        .into();
    Ok(ServerIdentity {
        certificate_chain: vec![certificate_der],
        private_key,
        pin,
    })
}

pub fn generate_ca_signed_server_identity(hostname: &str) -> ProofResult<ServerIdentity> {
    let now = SystemTime::now();
    let ca_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256)?;
    let mut ca_parameters = CertificateParams::default();
    ca_parameters
        .distinguished_name
        .push(DnType::CommonName, "DapperCode proof substitution CA");
    ca_parameters.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_parameters.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyCertSign,
    ];
    ca_parameters.not_before = now
        .checked_sub(Duration::from_secs(300))
        .ok_or("substitution CA validity underflow")?
        .into();
    ca_parameters.not_after = now
        .checked_add(Duration::from_secs(30 * 24 * 60 * 60))
        .ok_or("substitution CA validity overflow")?
        .into();
    let ca = CertifiedIssuer::self_signed(ca_parameters, ca_key)?;

    let leaf_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256)?;
    let leaf = server_certificate_parameters(hostname)?.signed_by(&leaf_key, &ca)?;
    let leaf_der = leaf.der().clone();
    let pin = certificate_spki_pin(leaf_der.as_ref())?;
    let private_key = PrivatePkcs8KeyDer::from(leaf_key.serialize_der())
        .clone_key()
        .into();
    Ok(ServerIdentity {
        certificate_chain: vec![leaf_der, ca.der().clone()],
        private_key,
        pin,
    })
}

fn server_certificate_parameters(hostname: &str) -> ProofResult<CertificateParams> {
    let mut parameters = CertificateParams::new(vec![hostname.to_string()])?;
    parameters.is_ca = IsCa::NoCa;
    parameters.custom_extensions.push(not_ca_extension());
    parameters.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    parameters.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    parameters.not_before = SystemTime::now()
        .checked_sub(Duration::from_secs(300))
        .ok_or("server validity underflow")?
        .into();
    parameters.not_after = SystemTime::now()
        .checked_add(Duration::from_secs(30 * 24 * 60 * 60))
        .ok_or("server validity overflow")?
        .into();
    Ok(parameters)
}

fn not_ca_extension() -> CustomExtension {
    let mut extension = CustomExtension::from_oid_content(&[2, 5, 29, 19], vec![0x30, 0x00]);
    extension.set_criticality(true);
    extension
}

pub fn certificate_spki_pin(certificate_der: &[u8]) -> ProofResult<SpkiPin> {
    let (remaining, certificate) = parse_x509_certificate(certificate_der)?;
    if !remaining.is_empty() {
        return Err("certificate contains trailing DER".into());
    }
    Ok(SpkiPin::from_spki_der(certificate.public_key().raw))
}

pub fn build_server_config(
    identity: ServerIdentity,
    allowed_client_pin: SpkiPin,
) -> ProofResult<ServerConfig> {
    let provider = Arc::new(ring::default_provider());
    let verifier = Arc::new(ExactClientSpkiVerifier::new(
        allowed_client_pin,
        provider.clone(),
    ));
    let mut config = ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&TLS13])?
        .with_client_cert_verifier(verifier)
        .with_single_cert(identity.certificate_chain, identity.private_key)?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    config.session_storage = Arc::new(NoServerSessionStorage {});
    config.send_tls13_tickets = 0;
    config.max_early_data_size = 0;
    config.send_half_rtt_data = false;
    Ok(config)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadyReport {
    event: &'static str,
    bind_address: SocketAddr,
    hostname: String,
    server_spki_pin: String,
    tls_version: &'static str,
    acceptable_ca_hint_count: usize,
    tickets_enabled: bool,
    early_data_enabled: bool,
    reachability: &'static str,
    server_wrapper: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AcceptedHandshakeReport {
    event: &'static str,
    tls_version: &'static str,
    client_spki_pin: String,
    certificate_verify_verified: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthReport {
    ok: bool,
    tls_version: &'static str,
    peer_address: String,
}

async fn health(ConnectInfo(peer): ConnectInfo<SocketAddr>) -> Json<HealthReport> {
    Json(HealthReport {
        ok: true,
        tls_version: "TLS1.3",
        peer_address: peer.ip().to_string(),
    })
}

async fn echo(body: Bytes) -> Bytes {
    body
}

async fn websocket(upgrade: WebSocketUpgrade) -> impl IntoResponse {
    upgrade.on_upgrade(websocket_echo)
}

async fn websocket_echo(socket: WebSocket) {
    let (mut sender, mut receiver) = socket.split();
    while let Some(Ok(message)) = receiver.next().await {
        match message {
            Message::Text(_) | Message::Binary(_) | Message::Ping(_) => {
                if sender.send(message).await.is_err() {
                    break;
                }
            }
            Message::Close(close) => {
                let _ = sender.send(Message::Close(close)).await;
                break;
            }
            Message::Pong(_) => {}
        }
    }
}

pub async fn serve(
    bind_address: SocketAddr,
    hostname: String,
    allowed_client_pin: SpkiPin,
    simulator_loopback: bool,
    ca_signed_server_substitution: bool,
) -> ProofResult<()> {
    validate_bind_address(bind_address.ip(), simulator_loopback)?;
    let identity = if ca_signed_server_substitution {
        generate_ca_signed_server_identity(&hostname)?
    } else {
        generate_server_identity(&hostname)?
    };
    let server_pin = identity.pin;
    let config = build_server_config(identity, allowed_client_pin)?;
    let acceptor = TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind(bind_address).await?;
    let actual_address = listener.local_addr()?;
    println!(
        "{}",
        serde_json::to_string(&ReadyReport {
            event: "ready",
            bind_address: actual_address,
            hostname,
            server_spki_pin: server_pin.encoded(),
            tls_version: "TLS1.3",
            acceptable_ca_hint_count: 0,
            tickets_enabled: false,
            early_data_enabled: false,
            reachability: if simulator_loopback {
                "simulatorLoopback"
            } else {
                "tailscaleOnly"
            },
            server_wrapper: if ca_signed_server_substitution {
                "caSignedSubstitution"
            } else {
                "selfSignedExactPin"
            },
        })?
    );

    let router = Router::new()
        .route("/health", get(health))
        .route("/echo", post(echo))
        .route("/ws/echo", get(websocket));

    loop {
        let (tcp, peer) = listener.accept().await?;
        let acceptor = acceptor.clone();
        let mut service = router
            .clone()
            .into_make_service_with_connect_info::<SocketAddr>();
        tokio::spawn(async move {
            let tls = match acceptor.accept(tcp).await {
                Ok(tls) => tls,
                Err(error) => {
                    eprintln!("TLS handshake from {peer} rejected: {error}");
                    return;
                }
            };
            let client_spki_pin = tls
                .get_ref()
                .1
                .peer_certificates()
                .and_then(|certificates| certificates.first())
                .and_then(|certificate| certificate_spki_pin(certificate.as_ref()).ok());
            let Some(client_spki_pin) = client_spki_pin else {
                eprintln!(
                    "accepted TLS connection from {peer} had no parseable client certificate"
                );
                return;
            };
            println!(
                "{}",
                serde_json::to_string(&AcceptedHandshakeReport {
                    event: "acceptedHandshake",
                    tls_version: "TLS1.3",
                    client_spki_pin: client_spki_pin.encoded(),
                    certificate_verify_verified: true,
                })
                .expect("accepted handshake report is serializable")
            );
            let service = service.call(peer).await.expect("infallible router service");
            let connection = http1::Builder::new()
                .serve_connection(TokioIo::new(tls), TowerToHyperService::new(service))
                .with_upgrades();
            if let Err(error) = connection.await {
                eprintln!("HTTP connection from {peer} failed: {error}");
            }
        });
    }
}

fn validate_bind_address(address: IpAddr, simulator_loopback: bool) -> ProofResult<()> {
    if address.is_unspecified() {
        return Err("proof server refuses wildcard bind addresses".into());
    }
    if simulator_loopback && address.is_loopback() {
        return Ok(());
    }
    let tailscale = match address {
        IpAddr::V4(address) => u32::from(address) & 0xffc0_0000 == 0x6440_0000,
        IpAddr::V6(address) => address.segments()[..3] == [0xfd7a, 0x115c, 0xa1e0],
    };
    if !tailscale {
        return Err(
            "physical proof server must bind a Tailscale 100.64.0.0/10 or fd7a:115c:a1e0::/48 address"
                .into(),
        );
    }
    Ok(())
}

pub async fn run_from_args(args: impl IntoIterator<Item = String>) -> ProofResult<()> {
    let mut bind_address = None;
    let mut hostname = None;
    let mut client_pin = None;
    let mut simulator_loopback = false;
    let mut ca_signed_server_substitution = false;
    let mut arguments = args.into_iter();
    let command = arguments.next().ok_or(
        "usage: pinned_tls_proof serve --bind <ip:port> --hostname <name> --client-pin <pin>",
    )?;
    if command != "serve" {
        return Err(format!("unknown command {command:?}; expected \"serve\"").into());
    }
    while let Some(flag) = arguments.next() {
        if flag == "--simulator-loopback" {
            simulator_loopback = true;
            continue;
        }
        if flag == "--ca-signed-server-substitution" {
            ca_signed_server_substitution = true;
            continue;
        }
        let value = arguments
            .next()
            .ok_or_else(|| format!("missing value for {flag}"))?;
        match flag.as_str() {
            "--bind" => bind_address = Some(value.parse::<SocketAddr>()?),
            "--hostname" => hostname = Some(value),
            "--client-pin" => client_pin = Some(SpkiPin::parse(&value)?),
            _ => return Err(format!("unknown argument {flag:?}").into()),
        }
    }

    serve(
        bind_address.ok_or("--bind is required")?,
        hostname.ok_or("--hostname is required")?,
        client_pin.ok_or("--client-pin is required")?,
        simulator_loopback,
        ca_signed_server_substitution,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use rcgen::{PKCS_ECDSA_P384_SHA384, PKCS_ED25519};
    use rustls::{
        client::{
            danger::{ServerCertVerified, ServerCertVerifier},
            ResolvesClientCert,
        },
        pki_types::ServerName,
        sign::CertifiedKey as RustlsCertifiedKey,
        version::TLS12,
        ClientConfig, SupportedProtocolVersion,
    };
    use tokio::io::duplex;
    use tokio_rustls::TlsConnector;

    struct TestClientIdentity {
        certificate: CertificateDer<'static>,
        private_key: PrivateKeyDer<'static>,
        pin: SpkiPin,
    }

    fn client_identity(
        mutate: impl FnOnce(&mut CertificateParams),
    ) -> ProofResult<TestClientIdentity> {
        client_identity_with_algorithm(&PKCS_ECDSA_P256_SHA256, mutate)
    }

    fn client_identity_with_algorithm(
        algorithm: &'static rcgen::SignatureAlgorithm,
        mutate: impl FnOnce(&mut CertificateParams),
    ) -> ProofResult<TestClientIdentity> {
        let key_pair = KeyPair::generate_for(algorithm)?;
        let mut parameters = CertificateParams::default();
        parameters
            .distinguished_name
            .push(DnType::CommonName, "DapperCode proof client");
        parameters.is_ca = IsCa::NoCa;
        parameters.custom_extensions.push(not_ca_extension());
        parameters.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        parameters.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
        parameters.not_before = SystemTime::now()
            .checked_sub(Duration::from_secs(300))
            .unwrap()
            .into();
        parameters.not_after = SystemTime::now()
            .checked_add(Duration::from_secs(3600))
            .unwrap()
            .into();
        mutate(&mut parameters);
        let certificate = parameters.self_signed(&key_pair)?;
        let certificate_der = certificate.der().clone();
        Ok(TestClientIdentity {
            pin: certificate_spki_pin(certificate_der.as_ref())?,
            certificate: certificate_der,
            private_key: PrivatePkcs8KeyDer::from(key_pair.serialize_der())
                .clone_key()
                .into(),
        })
    }

    fn now() -> UnixTime {
        UnixTime::since_unix_epoch(Duration::from_secs(
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        ))
    }

    #[test]
    fn pin_encoding_is_base64url_without_padding() {
        let pin = SpkiPin([0xff; 32]);
        assert_eq!(pin.encoded(), "__________________________________________8");
        assert_eq!(SpkiPin::parse(&pin.encoded()).unwrap(), pin);
        assert!(!pin.encoded().contains('='));
    }

    #[test]
    fn accepts_valid_exact_pinned_wrapper() {
        let identity = client_identity(|_| {}).unwrap();
        let provider = Arc::new(ring::default_provider());
        let verifier = ExactClientSpkiVerifier::new(identity.pin, provider);
        assert!(verifier
            .verify_client_cert(&identity.certificate, &[], now())
            .is_ok());
        assert!(verifier.root_hint_subjects().is_empty());
        assert!(verifier.client_auth_mandatory());
    }

    #[test]
    fn rejects_unknown_spki() {
        let identity = client_identity(|_| {}).unwrap();
        let provider = Arc::new(ring::default_provider());
        let verifier = ExactClientSpkiVerifier::new(SpkiPin([7; 32]), provider);
        assert!(verifier
            .verify_client_cert(&identity.certificate, &[], now())
            .is_err());
    }

    #[test]
    fn rejects_wrong_purpose() {
        let identity = client_identity(|parameters| {
            parameters.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        })
        .unwrap();
        let provider = Arc::new(ring::default_provider());
        let verifier = ExactClientSpkiVerifier::new(identity.pin, provider);
        assert!(verifier
            .verify_client_cert(&identity.certificate, &[], now())
            .is_err());
    }

    #[test]
    fn rejects_expired_wrapper() {
        let identity = client_identity(|parameters| {
            parameters.not_before = SystemTime::UNIX_EPOCH.into();
            parameters.not_after = SystemTime::UNIX_EPOCH
                .checked_add(Duration::from_secs(60))
                .unwrap()
                .into();
        })
        .unwrap();
        let provider = Arc::new(ring::default_provider());
        let verifier = ExactClientSpkiVerifier::new(identity.pin, provider);
        assert!(verifier
            .verify_client_cert(&identity.certificate, &[], now())
            .is_err());
    }

    #[test]
    fn rejects_not_yet_valid_wrapper() {
        let identity = client_identity(|parameters| {
            parameters.not_before = SystemTime::now()
                .checked_add(Duration::from_secs(3600))
                .unwrap()
                .into();
            parameters.not_after = SystemTime::now()
                .checked_add(Duration::from_secs(7200))
                .unwrap()
                .into();
        })
        .unwrap();
        let verifier =
            ExactClientSpkiVerifier::new(identity.pin, Arc::new(ring::default_provider()));
        assert!(verifier
            .verify_client_cert(&identity.certificate, &[], now())
            .is_err());
    }

    #[test]
    fn rejects_missing_or_ca_basic_constraints() {
        let missing = client_identity(|parameters| {
            parameters.custom_extensions.clear();
        })
        .unwrap();
        let missing_verifier =
            ExactClientSpkiVerifier::new(missing.pin, Arc::new(ring::default_provider()));
        assert!(missing_verifier
            .verify_client_cert(&missing.certificate, &[], now())
            .is_err());

        let ca = client_identity(|parameters| {
            parameters.custom_extensions.clear();
            parameters.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        })
        .unwrap();
        let ca_verifier = ExactClientSpkiVerifier::new(ca.pin, Arc::new(ring::default_provider()));
        assert!(ca_verifier
            .verify_client_cert(&ca.certificate, &[], now())
            .is_err());

        let noncritical = client_identity(|parameters| {
            parameters.custom_extensions.clear();
            parameters
                .custom_extensions
                .push(CustomExtension::from_oid_content(
                    &[2, 5, 29, 19],
                    vec![0x30, 0x00],
                ));
        })
        .unwrap();
        let noncritical_verifier =
            ExactClientSpkiVerifier::new(noncritical.pin, Arc::new(ring::default_provider()));
        assert!(noncritical_verifier
            .verify_client_cert(&noncritical.certificate, &[], now())
            .is_err());
    }

    #[test]
    fn rejects_missing_or_wrong_key_usage() {
        let missing = client_identity(|parameters| {
            parameters.key_usages.clear();
        })
        .unwrap();
        let missing_verifier =
            ExactClientSpkiVerifier::new(missing.pin, Arc::new(ring::default_provider()));
        assert!(missing_verifier
            .verify_client_cert(&missing.certificate, &[], now())
            .is_err());

        let wrong = client_identity(|parameters| {
            parameters.key_usages = vec![
                KeyUsagePurpose::DigitalSignature,
                KeyUsagePurpose::KeyEncipherment,
            ];
        })
        .unwrap();
        let wrong_verifier =
            ExactClientSpkiVerifier::new(wrong.pin, Arc::new(ring::default_provider()));
        assert!(wrong_verifier
            .verify_client_cert(&wrong.certificate, &[], now())
            .is_err());
    }

    #[test]
    fn rejects_wrong_curve_and_signature_algorithms() {
        let p384 = client_identity_with_algorithm(&PKCS_ECDSA_P384_SHA384, |_| {}).unwrap();
        let p384_verifier =
            ExactClientSpkiVerifier::new(p384.pin, Arc::new(ring::default_provider()));
        assert!(p384_verifier
            .verify_client_cert(&p384.certificate, &[], now())
            .is_err());

        let ed25519 = client_identity_with_algorithm(&PKCS_ED25519, |_| {}).unwrap();
        let ed25519_verifier =
            ExactClientSpkiVerifier::new(ed25519.pin, Arc::new(ring::default_provider()));
        assert!(ed25519_verifier
            .verify_client_cert(&ed25519.certificate, &[], now())
            .is_err());
    }

    #[test]
    fn rejects_invalid_self_signature() {
        let identity = client_identity(|_| {}).unwrap();
        let mut corrupted = identity.certificate.to_vec();
        let final_byte = corrupted.last_mut().unwrap();
        *final_byte ^= 1;
        let corrupted = CertificateDer::from(corrupted);
        let verifier =
            ExactClientSpkiVerifier::new(identity.pin, Arc::new(ring::default_provider()));
        let error = verifier
            .verify_client_cert(&corrupted, &[], now())
            .unwrap_err();
        assert!(error.to_string().contains("invalid client self-signature"));
    }

    #[test]
    fn rejects_trailing_der_and_intermediates() {
        let identity = client_identity(|_| {}).unwrap();
        let provider = Arc::new(ring::default_provider());
        let verifier = ExactClientSpkiVerifier::new(identity.pin, provider);
        let mut malformed = identity.certificate.to_vec();
        malformed.push(0);
        assert!(verifier
            .verify_client_cert(&CertificateDer::from(malformed), &[], now())
            .is_err());
        assert!(verifier
            .verify_client_cert(
                &identity.certificate,
                std::slice::from_ref(&identity.certificate),
                now(),
            )
            .is_err());
        assert!(verifier
            .verify_client_cert(&CertificateDer::from(Vec::<u8>::new()), &[], now())
            .is_err());
    }

    #[test]
    fn server_config_disables_resumption_and_early_data() {
        let identity = generate_server_identity("localhost").unwrap();
        let config = build_server_config(identity, SpkiPin([1; 32])).unwrap();
        assert!(!config.session_storage.can_cache());
        assert!(!config.ticketer.enabled());
        assert_eq!(config.send_tls13_tickets, 0);
        assert_eq!(config.max_early_data_size, 0);
        assert!(!config.send_half_rtt_data);
    }

    #[derive(Debug)]
    struct AcceptServerCertificate {
        provider: Arc<CryptoProvider>,
    }

    impl ServerCertVerifier for AcceptServerCertificate {
        fn verify_server_cert(
            &self,
            _end_entity: &CertificateDer<'_>,
            _intermediates: &[CertificateDer<'_>],
            _server_name: &ServerName<'_>,
            _ocsp_response: &[u8],
            _now: UnixTime,
        ) -> Result<ServerCertVerified, TlsError> {
            Ok(ServerCertVerified::assertion())
        }

        fn verify_tls12_signature(
            &self,
            message: &[u8],
            cert: &CertificateDer<'_>,
            dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, TlsError> {
            rustls::crypto::verify_tls12_signature(
                message,
                cert,
                dss,
                &self.provider.signature_verification_algorithms,
            )
        }

        fn verify_tls13_signature(
            &self,
            message: &[u8],
            cert: &CertificateDer<'_>,
            dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, TlsError> {
            verify_tls13_signature(
                message,
                cert,
                dss,
                &self.provider.signature_verification_algorithms,
            )
        }

        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            self.provider
                .signature_verification_algorithms
                .supported_schemes()
        }
    }

    #[derive(Debug)]
    struct FixedClientCertificate(Arc<RustlsCertifiedKey>);

    impl ResolvesClientCert for FixedClientCertificate {
        fn resolve(
            &self,
            _root_hint_subjects: &[&[u8]],
            _sigschemes: &[SignatureScheme],
        ) -> Option<Arc<RustlsCertifiedKey>> {
            Some(self.0.clone())
        }

        fn has_certs(&self) -> bool {
            true
        }
    }

    fn client_config(
        certificate: CertificateDer<'static>,
        signing_key: PrivateKeyDer<'static>,
    ) -> ProofResult<ClientConfig> {
        client_config_with_versions(certificate, signing_key, &[&TLS13])
    }

    fn client_config_with_versions(
        certificate: CertificateDer<'static>,
        signing_key: PrivateKeyDer<'static>,
        versions: &[&'static SupportedProtocolVersion],
    ) -> ProofResult<ClientConfig> {
        let provider = Arc::new(ring::default_provider());
        let verifier = Arc::new(AcceptServerCertificate {
            provider: provider.clone(),
        });
        let certified_key = RustlsCertifiedKey::new(
            vec![certificate],
            ring::sign::any_supported_type(&signing_key)?,
        );
        let resolver = Arc::new(FixedClientCertificate(Arc::new(certified_key)));
        let mut config = ClientConfig::builder_with_provider(provider)
            .with_protocol_versions(versions)?
            .dangerous()
            .with_custom_certificate_verifier(verifier)
            .with_client_cert_resolver(resolver);
        config.resumption = rustls::client::Resumption::disabled();
        config.enable_early_data = false;
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok(config)
    }

    fn tls12_test_server_config(
        identity: ServerIdentity,
        allowed_client_pin: SpkiPin,
    ) -> ProofResult<ServerConfig> {
        let provider = Arc::new(ring::default_provider());
        let verifier = Arc::new(ExactClientSpkiVerifier::new(
            allowed_client_pin,
            provider.clone(),
        ));
        let mut config = ServerConfig::builder_with_provider(provider)
            .with_protocol_versions(&[&TLS12])?
            .with_client_cert_verifier(verifier)
            .with_single_cert(identity.certificate_chain, identity.private_key)?;
        config.session_storage = Arc::new(NoServerSessionStorage {});
        config.send_tls13_tickets = 0;
        config.max_early_data_size = 0;
        config.send_half_rtt_data = false;
        Ok(config)
    }

    async fn handshake(
        client: ClientConfig,
        server: ServerConfig,
    ) -> (
        Result<tokio_rustls::client::TlsStream<tokio::io::DuplexStream>, std::io::Error>,
        Result<tokio_rustls::server::TlsStream<tokio::io::DuplexStream>, std::io::Error>,
    ) {
        let (client_io, server_io) = duplex(128 * 1024);
        let connector = TlsConnector::from(Arc::new(client));
        let acceptor = TlsAcceptor::from(Arc::new(server));
        let name = ServerName::try_from("localhost").unwrap().to_owned();
        tokio::join!(
            connector.connect(name, client_io),
            acceptor.accept(server_io)
        )
    }

    #[tokio::test]
    async fn valid_certificate_verify_completes_handshake() {
        let client = client_identity(|_| {}).unwrap();
        let server_identity = generate_server_identity("localhost").unwrap();
        let server = build_server_config(server_identity, client.pin).unwrap();
        let client_config = client_config(client.certificate, client.private_key).unwrap();
        let (client_result, server_result) = handshake(client_config, server).await;
        assert!(client_result.is_ok(), "{client_result:?}");
        assert!(server_result.is_ok(), "{server_result:?}");
    }

    #[tokio::test]
    async fn wrong_private_key_certificate_verify_fails_handshake() {
        let presented = client_identity(|_| {}).unwrap();
        let wrong_signer = client_identity(|_| {}).unwrap();
        let server_identity = generate_server_identity("localhost").unwrap();
        let server = build_server_config(server_identity, presented.pin).unwrap();
        let malicious_client =
            client_config(presented.certificate, wrong_signer.private_key).unwrap();
        let (client_result, server_result) = handshake(malicious_client, server).await;
        assert!(client_result.is_err() || server_result.is_err());
    }

    #[tokio::test]
    async fn tls12_negotiation_is_rejected_by_production_config() {
        let client = client_identity(|_| {}).unwrap();
        let server_identity = generate_server_identity("localhost").unwrap();
        let server = build_server_config(server_identity, client.pin).unwrap();
        let client_config =
            client_config_with_versions(client.certificate, client.private_key, &[&TLS12]).unwrap();
        let (client_result, server_result) = handshake(client_config, server).await;
        assert!(client_result.is_err() || server_result.is_err());
    }

    #[tokio::test]
    async fn tls12_certificate_verify_callback_rejects_if_invoked() {
        let client = client_identity(|_| {}).unwrap();
        let server_identity = generate_server_identity("localhost").unwrap();
        let server = tls12_test_server_config(server_identity, client.pin).unwrap();
        let client_config =
            client_config_with_versions(client.certificate, client.private_key, &[&TLS12]).unwrap();
        let (client_result, server_result) = handshake(client_config, server).await;
        let combined = format!("{client_result:?} {server_result:?}");
        assert!(client_result.is_err() || server_result.is_err());
        assert!(combined.contains("TLS 1.2 CertificateVerify is disabled"));
    }

    #[test]
    fn ca_signed_substitution_has_distinct_issuer_and_chain() {
        let identity = generate_ca_signed_server_identity("localhost").unwrap();
        assert_eq!(identity.certificate_chain.len(), 2);
        let (_, leaf) = parse_x509_certificate(identity.certificate_chain[0].as_ref()).unwrap();
        assert_ne!(leaf.subject(), leaf.issuer());
        assert_eq!(
            certificate_spki_pin(identity.certificate_chain[0].as_ref()).unwrap(),
            identity.pin
        );
    }

    #[test]
    fn physical_binding_is_tailscale_only() {
        assert!(validate_bind_address("100.64.0.1".parse().unwrap(), false).is_ok());
        assert!(validate_bind_address("100.127.255.254".parse().unwrap(), false).is_ok());
        assert!(validate_bind_address("fd7a:115c:a1e0::1".parse().unwrap(), false).is_ok());
        assert!(validate_bind_address("127.0.0.1".parse().unwrap(), false).is_err());
        assert!(validate_bind_address("0.0.0.0".parse().unwrap(), true).is_err());
        assert!(validate_bind_address("127.0.0.1".parse().unwrap(), true).is_ok());
    }
}
