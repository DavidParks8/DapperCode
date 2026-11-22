#![cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::overly_long_file,
        reason = "existing bridge module predates perfectionist 500-line cap; keep ratcheted until split"
    )
)]
use getrandom::fill as fill_random;
use rustls_pki_types::ServerName;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use std::collections::VecDeque;
use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{lookup_host, TcpStream, UdpSocket};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior};
use tokio_rustls::client::TlsStream;
use tokio_rustls::TlsConnector;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub const PCMU_FRAME_BYTES: usize = 160;
pub const PCMU_SILENCE_BYTE: u8 = 0xFF;
pub const PCMU_PAYLOAD_TYPE: u8 = 0;
pub const COMFORT_NOISE_PAYLOAD_TYPE: u8 = 13;
pub const DEFAULT_TELEPHONE_EVENT_PT: u8 = 101;
pub const RTP_HEADER_BYTES: usize = 12;
pub const RTP_FRAME_INTERVAL: Duration = Duration::from_millis(20);
pub const RTP_TIMESTAMP_STEP: u32 = 160;
pub const SIP_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(25);

const DEFAULT_RING_TIMEOUT: Duration = Duration::from_secs(45);
const DEFAULT_INVITE_RESPONSE_TIMEOUT: Duration = Duration::from_secs(10);
const SIP_UDP_T1_RETRANSMIT: Duration = Duration::from_millis(500);
const SIP_UDP_MAX_RETRANSMIT: Duration = Duration::from_secs(4);
const SIP_TEARDOWN_DRAIN_TIMEOUT: Duration = Duration::from_millis(200);
const MAX_SIP_HEADER_BYTES: usize = 32 * 1024;
const MAX_SIP_BODY_BYTES: usize = 64 * 1024;
const MAX_AUTH_ATTEMPTS: usize = 2;
const DTMF_INTER_DIGIT_GAP_TICKS: usize = 2;
const INBOUND_AUDIO_CHANNEL_CAPACITY: usize = 512;
const CALL_EVENT_CHANNEL_CAPACITY: usize = 64;
const REORDER_WINDOW_SLOTS: usize = 3;
const REORDER_FLUSH_TIMEOUT: Duration = Duration::from_millis(60);
const MAX_SILENCE_GAP_FILL: u16 = 16;

#[derive(Debug, thiserror::Error)]
pub enum SipError {
    #[error("invalid SIP configuration: {0}")]
    InvalidConfig(String),
    #[error("SIP I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("SIP TLS error: {0}")]
    Tls(String),
    #[error("SIP protocol error: {0}")]
    Protocol(String),
    #[error("SIP authentication failed ({status_code} {reason})")]
    AuthFailed { status_code: u16, reason: String },
    #[error("SIP call rejected ({status_code} {reason})")]
    Rejected { status_code: u16, reason: String },
    #[error("SIP timeout: {0}")]
    Timeout(String),
    #[error("SIP session closed: {0}")]
    Closed(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SipTransportKind {
    Udp,
    Tls,
}

impl SipTransportKind {
    #[must_use]
    pub const fn default_port(self) -> u16 {
        match self {
            Self::Udp => 5060,
            Self::Tls => 5061,
        }
    }

    #[must_use]
    pub const fn via_protocol(self) -> &'static str {
        match self {
            Self::Udp => "SIP/2.0/UDP",
            Self::Tls => "SIP/2.0/TLS",
        }
    }

    #[must_use]
    pub const fn contact_transport_param(self) -> &'static str {
        match self {
            Self::Udp => "",
            Self::Tls => ";transport=tls",
        }
    }
}

#[derive(Clone)]
#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::too_many_struct_fields,
        reason = "existing protocol, configuration, or runtime state struct predates perfectionist field cap"
    )
)]
pub struct SipDialConfig {
    pub server_host: String,
    pub server_port: u16,
    pub transport: SipTransportKind,
    pub domain: String,
    pub username: String,
    pub password: String,
    pub caller_id: String,
    pub display_name: String,
    pub target_number: String,
    pub tls_server_name: Option<String>,
    pub custom_tls_config: Option<Arc<rustls::ClientConfig>>,
    pub ring_timeout: Duration,
    pub invite_response_timeout: Duration,
    pub keepalive_interval: Duration,
}

impl fmt::Debug for SipDialConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SipDialConfig")
            .field("server_host", &self.server_host)
            .field("server_port", &self.server_port)
            .field("transport", &self.transport)
            .field("domain", &self.domain)
            .field("username", &self.username)
            .field("password", &"[REDACTED]")
            .field("caller_id", &self.caller_id)
            .field("display_name", &self.display_name)
            .field("target_number", &self.target_number)
            .field("tls_server_name", &self.tls_server_name)
            .field("custom_tls_config", &self.custom_tls_config.is_some())
            .field("ring_timeout", &self.ring_timeout)
            .field("invite_response_timeout", &self.invite_response_timeout)
            .field("keepalive_interval", &self.keepalive_interval)
            .finish()
    }
}

impl SipDialConfig {
    #[must_use]
    pub fn new(
        server_host: impl Into<String>,
        server_port: u16,
        transport: SipTransportKind,
        caller_id: impl Into<String>,
        target_number: impl Into<String>,
    ) -> Self {
        let host = server_host.into();
        Self {
            domain: host.clone(),
            server_host: host,
            server_port,
            transport,
            username: String::new(),
            password: String::new(),
            caller_id: caller_id.into(),
            display_name: String::new(),
            target_number: target_number.into(),
            tls_server_name: None,
            custom_tls_config: None,
            ring_timeout: DEFAULT_RING_TIMEOUT,
            invite_response_timeout: DEFAULT_INVITE_RESPONSE_TIMEOUT,
            keepalive_interval: SIP_KEEPALIVE_INTERVAL,
        }
    }

    #[must_use]
    pub fn with_credentials(
        mut self,
        username: impl Into<String>,
        password: impl Into<String>,
    ) -> Self {
        self.username = username.into();
        self.password = password.into();
        self
    }

    #[cfg(test)]
    #[must_use]
    pub fn with_domain(mut self, domain: impl Into<String>) -> Self {
        self.domain = domain.into();
        self
    }

    #[must_use]
    pub fn with_display_name(mut self, display_name: impl Into<String>) -> Self {
        self.display_name = display_name.into();
        self
    }

    #[must_use]
    pub fn with_custom_tls_config(mut self, tls_config: Arc<rustls::ClientConfig>) -> Self {
        self.custom_tls_config = Some(tls_config);
        self
    }

    #[cfg(test)]
    #[must_use]
    pub fn with_tls_server_name(mut self, server_name: impl Into<String>) -> Self {
        self.tls_server_name = Some(server_name.into());
        self
    }

    fn effective_domain(&self) -> &str {
        if self.domain.trim().is_empty() {
            self.server_host.trim()
        } else {
            self.domain.trim()
        }
    }

    fn validate(&self) -> Result<(), SipError> {
        if self.server_host.trim().is_empty() {
            return Err(SipError::InvalidConfig(
                "server_host must not be empty".to_owned(),
            ));
        }
        if self.server_port == 0 {
            return Err(SipError::InvalidConfig(
                "server_port must be non-zero".to_owned(),
            ));
        }
        if self.caller_id.trim().is_empty() {
            return Err(SipError::InvalidConfig(
                "caller_id must not be empty".to_owned(),
            ));
        }
        if self.target_number.trim().is_empty() {
            return Err(SipError::InvalidConfig(
                "target_number must not be empty".to_owned(),
            ));
        }
        for (name, val) in [
            ("server_host", self.server_host.as_str()),
            ("domain", self.domain.as_str()),
            ("username", self.username.as_str()),
            ("caller_id", self.caller_id.as_str()),
            ("display_name", self.display_name.as_str()),
            ("target_number", self.target_number.as_str()),
        ] {
            if contains_header_control_chars(val) {
                return Err(SipError::InvalidConfig(format!(
                    "{name} contains forbidden control characters",
                )));
            }
        }
        Ok(())
    }
}

pub fn default_rustls_client_config() -> Result<Arc<rustls::ClientConfig>, SipError> {
    crate::tls::webpki_client_config()
        .map(Arc::new)
        .map_err(|err| SipError::Tls(format!("failed configuring TLS protocol versions: {err}")))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SipCallFailure {
    AuthFailed { status_code: u16, reason: String },
    Rejected { status_code: u16, reason: String },
    Timeout(String),
    Protocol(String),
    Transport(String),
}

impl SipCallFailure {
    #[must_use]
    pub fn into_sip_error(self) -> SipError {
        match self {
            Self::AuthFailed {
                status_code,
                reason,
            } => SipError::AuthFailed {
                status_code,
                reason,
            },
            Self::Rejected {
                status_code,
                reason,
            } => SipError::Rejected {
                status_code,
                reason,
            },
            Self::Timeout(msg) => SipError::Timeout(msg),
            Self::Protocol(msg) => SipError::Protocol(msg),
            Self::Transport(msg) => SipError::Closed(msg),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SipCallState {
    Dialing,
    Ringing,
    Connected {
        negotiated_dtmf_pt: Option<u8>,
    },
    Ended {
        reason: String,
        failure: Option<SipCallFailure>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SipCallEvent {
    Ringing,
    Connected {
        negotiated_dtmf_pt: Option<u8>,
    },
    HoldChanged {
        on_hold: bool,
        negotiated_dtmf_pt: Option<u8>,
    },
    Ended {
        reason: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InboundRtpAudioFrame {
    pub inbound_pcmu: [u8; PCMU_FRAME_BYTES],
    pub outbound_pcmu: [u8; PCMU_FRAME_BYTES],
    pub outbound_playing: bool,
    pub rtp_sequence: u16,
    pub rtp_timestamp: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutboundPlaybackSnapshot {
    pub outbound_playing: bool,
    pub current_outbound_pcmu: [u8; PCMU_FRAME_BYTES],
    pub cleared_frames: usize,
    pub discarded_frames: usize,
}

// ============================================================================
// Pure-Rust RFC 1321 MD5 + RFC 2617 / RFC 7616 Digest Authentication
// ============================================================================

#[must_use]
#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::excessive_cognitive_complexity,
        perfectionist::overly_long_function,
        perfectionist::too_many_local_bindings,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
pub fn md5_digest(data: &[u8]) -> [u8; 16] {
    const SHIFTS: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5,
        9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10,
        15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    const ROUND_CONSTANTS: [u32; 64] = [
        0xd76a_a478,
        0xe8c7_b756,
        0x2420_70db,
        0xc1bd_ceee,
        0xf57c_0faf,
        0x4787_c62a,
        0xa830_4613,
        0xfd46_9501,
        0x6980_98d8,
        0x8b44_f7af,
        0xffff_5bb1,
        0x895c_d7be,
        0x6b90_1122,
        0xfd98_7193,
        0xa679_438e,
        0x49b4_0821,
        0xf61e_2562,
        0xc040_b340,
        0x265e_5a51,
        0xe9b6_c7aa,
        0xd62f_105d,
        0x0244_1453,
        0xd8a1_e681,
        0xe7d3_fbc8,
        0x21e1_cde6,
        0xc337_07d6,
        0xf4d5_0d87,
        0x455a_14ed,
        0xa9e3_e905,
        0xfcef_a3f8,
        0x676f_02d9,
        0x8d2a_4c8a,
        0xfffa_3942,
        0x8771_f681,
        0x6d9d_6122,
        0xfde5_380c,
        0xa4be_ea44,
        0x4bde_cfa9,
        0xf6bb_4b60,
        0xbebf_bc70,
        0x289b_7ec6,
        0xeaa1_27fa,
        0xd4ef_3085,
        0x0488_1d05,
        0xd9d4_d039,
        0xe6db_99e5,
        0x1fa2_7cf8,
        0xc4ac_5665,
        0xf429_2244,
        0x432a_ff97,
        0xab94_23a7,
        0xfc93_a039,
        0x655b_59c3,
        0x8f0c_cc92,
        0xffef_f47d,
        0x8584_5dd1,
        0x6fa8_7e4f,
        0xfe2c_e6e0,
        0xa301_4314,
        0x4e08_11a1,
        0xf753_7e82,
        0xbd3a_f235,
        0x2ad7_d2bb,
        0xeb86_d391,
    ];

    let bit_len = u64::try_from(data.len())
        .unwrap_or(u64::MAX)
        .wrapping_mul(8);
    let rem = (data.len().wrapping_add(1)) % 64;
    let zero_pad = if rem <= 56 { 56 - rem } else { 120 - rem };
    let mut padded = Vec::with_capacity(data.len() + 1 + zero_pad + 8);
    padded.extend_from_slice(data);
    padded.push(0x80);
    padded.resize(padded.len() + zero_pad, 0);
    padded.extend_from_slice(&bit_len.to_le_bytes());

    let mut a0: u32 = 0x6745_2301;
    let mut b0: u32 = 0xefcd_ab89;
    let mut c0: u32 = 0x98ba_dcfe;
    let mut d0: u32 = 0x1032_5476;

    for chunk in padded.chunks_exact(64) {
        let mut words = [0_u32; 16];
        for (word_slot, word_bytes) in words.iter_mut().zip(chunk.chunks_exact(4)) {
            if let [w0, w1, w2, w3] = *word_bytes {
                *word_slot = u32::from_le_bytes([w0, w1, w2, w3]);
            }
        }

        let mut aa = a0;
        let mut bb = b0;
        let mut cc = c0;
        let mut dd = d0;

        for (round, (&k_val, &s_val)) in ROUND_CONSTANTS.iter().zip(SHIFTS.iter()).enumerate() {
            let (mix, word_idx) = if round < 16 {
                ((bb & cc) | ((!bb) & dd), round)
            } else if round < 32 {
                (
                    (dd & bb) | ((!dd) & cc),
                    (5_usize.wrapping_mul(round) + 1) % 16,
                )
            } else if round < 48 {
                (bb ^ cc ^ dd, (3_usize.wrapping_mul(round) + 5) % 16)
            } else {
                (cc ^ (bb | (!dd)), (7_usize.wrapping_mul(round)) % 16)
            };
            let word_val = words.get(word_idx).copied().unwrap_or(0);
            let sum = aa
                .wrapping_add(mix)
                .wrapping_add(k_val)
                .wrapping_add(word_val);
            let next_bb = bb.wrapping_add(sum.rotate_left(s_val));
            aa = dd;
            dd = cc;
            cc = bb;
            bb = next_bb;
        }

        a0 = a0.wrapping_add(aa);
        b0 = b0.wrapping_add(bb);
        c0 = c0.wrapping_add(cc);
        d0 = d0.wrapping_add(dd);
    }

    let [r0, r1, r2, r3] = a0.to_le_bytes();
    let [r4, r5, r6, r7] = b0.to_le_bytes();
    let [r8, r9, r10, r11] = c0.to_le_bytes();
    let [r12, r13, r14, r15] = d0.to_le_bytes();
    [
        r0, r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11, r12, r13, r14, r15,
    ]
}

#[must_use]
pub fn bytes_to_lower_hex(bytes: &[u8]) -> String {
    const HEX: [u8; 16] = *b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len().saturating_mul(2));
    for &byte in bytes {
        let hi = usize::from(byte >> 4);
        let lo = usize::from(byte & 0x0F);
        if let Some(&ch) = HEX.get(hi) {
            out.push(char::from(ch));
        }
        if let Some(&ch) = HEX.get(lo) {
            out.push(char::from(ch));
        }
    }
    out
}

#[must_use]
pub fn md5_hex(data: &[u8]) -> String {
    bytes_to_lower_hex(&md5_digest(data))
}

#[must_use]
pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    let digest = hasher.finalize();
    bytes_to_lower_hex(&digest)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DigestAlgorithm {
    Md5,
    Md5Sess,
    Sha256,
    Sha256Sess,
}

impl DigestAlgorithm {
    #[must_use]
    pub const fn header_token(self) -> &'static str {
        match self {
            Self::Md5 => "MD5",
            Self::Md5Sess => "MD5-sess",
            Self::Sha256 => "SHA-256",
            Self::Sha256Sess => "SHA-256-sess",
        }
    }

    #[must_use]
    pub fn hash_hex(self, data: &[u8]) -> String {
        match self {
            Self::Md5 | Self::Md5Sess => md5_hex(data),
            Self::Sha256 | Self::Sha256Sess => sha256_hex(data),
        }
    }

    #[must_use]
    pub const fn is_session_variant(self) -> bool {
        matches!(self, Self::Md5Sess | Self::Sha256Sess)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DigestChallenge {
    pub realm: String,
    pub nonce: String,
    pub opaque: Option<String>,
    pub qop_options: Vec<String>,
    pub algorithm: DigestAlgorithm,
    pub stale: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct DigestCredentials<'a> {
    pub username: &'a str,
    pub password: &'a str,
    pub method: &'a str,
    pub digest_uri: &'a str,
    pub entity_body: &'a [u8],
    pub cnonce: &'a str,
    pub nonce_count: u32,
}

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::excessive_cognitive_complexity,
        perfectionist::excessive_nesting,
        perfectionist::overly_long_function,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
pub fn parse_digest_challenge(header_value: &str) -> Result<DigestChallenge, SipError> {
    let trimmed = header_value.trim();
    let rest = strip_ascii_prefix_ignore_case(trimmed, "Digest")
        .ok_or_else(|| SipError::Protocol("authenticate header is not Digest".to_owned()))?
        .trim_start();
    if rest.is_empty() {
        return Err(SipError::Protocol("empty Digest challenge".to_owned()));
    }

    let mut realm: Option<String> = None;
    let mut nonce: Option<String> = None;
    let mut opaque: Option<String> = None;
    let mut qop_options: Vec<String> = Vec::new();
    let mut algorithm = DigestAlgorithm::Md5;
    let mut stale = false;

    for (key, value) in parse_digest_kv_pairs(rest) {
        if key.eq_ignore_ascii_case("realm") {
            realm = Some(value);
        } else if key.eq_ignore_ascii_case("nonce") {
            nonce = Some(value);
        } else if key.eq_ignore_ascii_case("opaque") {
            opaque = Some(value);
        } else if key.eq_ignore_ascii_case("qop") {
            for opt in value.split(',') {
                let tok = opt.trim();
                if !tok.is_empty() {
                    qop_options.push(tok.to_ascii_lowercase());
                }
            }
        } else if key.eq_ignore_ascii_case("algorithm") {
            algorithm = if value.eq_ignore_ascii_case("MD5") {
                DigestAlgorithm::Md5
            } else if value.eq_ignore_ascii_case("MD5-sess") {
                DigestAlgorithm::Md5Sess
            } else if value.eq_ignore_ascii_case("SHA-256") {
                DigestAlgorithm::Sha256
            } else if value.eq_ignore_ascii_case("SHA-256-sess") {
                DigestAlgorithm::Sha256Sess
            } else {
                return Err(SipError::Protocol(format!(
                    "unsupported Digest algorithm '{value}'",
                )));
            };
        } else if key.eq_ignore_ascii_case("stale") {
            stale = value.eq_ignore_ascii_case("true");
        }
    }

    let realm =
        realm.ok_or_else(|| SipError::Protocol("Digest challenge missing realm".to_owned()))?;
    let nonce =
        nonce.ok_or_else(|| SipError::Protocol("Digest challenge missing nonce".to_owned()))?;

    Ok(DigestChallenge {
        realm,
        nonce,
        opaque,
        qop_options,
        algorithm,
        stale,
    })
}

pub fn compute_digest_response(
    challenge: &DigestChallenge,
    creds: &DigestCredentials<'_>,
) -> Result<(String, Option<&'static str>), SipError> {
    let selected_qop = if challenge.qop_options.is_empty() {
        None
    } else if challenge.qop_options.iter().any(|qop| qop == "auth") {
        Some("auth")
    } else if challenge.qop_options.iter().any(|qop| qop == "auth-int") {
        Some("auth-int")
    } else {
        return Err(SipError::Protocol(format!(
            "unsupported Digest qop options: {:?}",
            challenge.qop_options,
        )));
    };

    if (challenge.algorithm.is_session_variant() || selected_qop.is_some())
        && creds.cnonce.is_empty()
    {
        return Err(SipError::InvalidConfig(
            "cnonce must not be empty for session or qop Digest auth".to_owned(),
        ));
    }

    let alg = challenge.algorithm;
    let ha1_base = alg
        .hash_hex(format!("{}:{}:{}", creds.username, challenge.realm, creds.password).as_bytes());
    let ha1 = if alg.is_session_variant() {
        alg.hash_hex(format!("{ha1_base}:{}:{}", challenge.nonce, creds.cnonce).as_bytes())
    } else {
        ha1_base
    };

    let ha2 = if selected_qop == Some("auth-int") {
        let body_hash = alg.hash_hex(creds.entity_body);
        alg.hash_hex(format!("{}:{}:{body_hash}", creds.method, creds.digest_uri).as_bytes())
    } else {
        alg.hash_hex(format!("{}:{}", creds.method, creds.digest_uri).as_bytes())
    };

    let response = if let Some(qop) = selected_qop {
        let nc = format!("{:08x}", creds.nonce_count);
        alg.hash_hex(
            format!(
                "{ha1}:{}:{nc}:{}:{qop}:{ha2}",
                challenge.nonce, creds.cnonce,
            )
            .as_bytes(),
        )
    } else {
        alg.hash_hex(format!("{ha1}:{}:{ha2}", challenge.nonce).as_bytes())
    };

    Ok((response, selected_qop))
}

pub fn build_digest_authorization_header(
    challenge: &DigestChallenge,
    creds: &DigestCredentials<'_>,
) -> Result<String, SipError> {
    let (response, selected_qop) = compute_digest_response(challenge, creds)?;
    let mut header = format!(
        r#"Digest username="{}", realm="{}", nonce="{}", uri="{}", response="{}", algorithm={}"#,
        escape_quoted_string(creds.username),
        escape_quoted_string(&challenge.realm),
        escape_quoted_string(&challenge.nonce),
        escape_quoted_string(creds.digest_uri),
        response,
        challenge.algorithm.header_token(),
    );

    if let Some(qop) = selected_qop {
        header.push_str(&format!(
            r#", cnonce="{}", qop={qop}, nc={:08x}"#,
            escape_quoted_string(creds.cnonce),
            creds.nonce_count,
        ));
    } else if challenge.algorithm.is_session_variant() {
        header.push_str(&format!(
            r#", cnonce="{}""#,
            escape_quoted_string(creds.cnonce),
        ));
    }

    if let Some(opaque) = &challenge.opaque {
        header.push_str(&format!(r#", opaque="{}""#, escape_quoted_string(opaque)));
    }

    Ok(header)
}

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::excessive_cognitive_complexity,
        perfectionist::excessive_nesting,
        perfectionist::overly_long_function,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
fn parse_digest_kv_pairs(input: &str) -> Vec<(String, String)> {
    let bytes = input.as_bytes();
    let len = bytes.len();
    let mut idx = 0_usize;
    let mut out = Vec::new();

    while idx < len {
        while let Some(&b) = bytes.get(idx) {
            if b.is_ascii_whitespace() || b == b',' {
                idx += 1;
            } else {
                break;
            }
        }
        let key_start = idx;
        while let Some(&b) = bytes.get(idx) {
            if b == b'=' || b == b',' || b.is_ascii_whitespace() {
                break;
            }
            idx += 1;
        }
        let key = input.get(key_start..idx).unwrap_or("").trim().to_owned();
        while let Some(&b) = bytes.get(idx) {
            if b.is_ascii_whitespace() {
                idx += 1;
            } else {
                break;
            }
        }
        if bytes.get(idx) != Some(&b'=') {
            while let Some(&b) = bytes.get(idx) {
                idx += 1;
                if b == b',' {
                    break;
                }
            }
            continue;
        }
        idx += 1;
        while let Some(&b) = bytes.get(idx) {
            if b.is_ascii_whitespace() {
                idx += 1;
            } else {
                break;
            }
        }

        let value = if bytes.get(idx) == Some(&b'"') {
            idx += 1;
            let mut unescaped = String::new();
            while let Some(&b) = bytes.get(idx) {
                idx += 1;
                if b == b'\\' {
                    if let Some(&escaped) = bytes.get(idx) {
                        unescaped.push(char::from(escaped));
                        idx += 1;
                    }
                } else if b == b'"' {
                    break;
                } else {
                    unescaped.push(char::from(b));
                }
            }
            while let Some(&b) = bytes.get(idx) {
                if b == b',' {
                    idx += 1;
                    break;
                }
                idx += 1;
            }
            unescaped
        } else {
            let val_start = idx;
            while let Some(&b) = bytes.get(idx) {
                if b == b',' {
                    break;
                }
                idx += 1;
            }
            let raw = input.get(val_start..idx).unwrap_or("").trim().to_owned();
            if bytes.get(idx) == Some(&b',') {
                idx += 1;
            }
            raw
        };

        if !key.is_empty() {
            out.push((key, value));
        }
    }

    out
}

// ============================================================================
// SDP Offer / Answer & RTP Framing + 3-Packet Reorder Buffer
// ============================================================================

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SdpAnswer {
    pub remote_media_ip: IpAddr,
    pub remote_audio_port: u16,
    pub negotiated_dtmf_pt: Option<u8>,
    direction: SdpDirection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum SdpDirection {
    #[default]
    SendRecv,
    SendOnly,
    RecvOnly,
    Inactive,
}

impl SdpDirection {
    fn answer(self) -> &'static str {
        match self {
            Self::SendRecv => "sendrecv",
            Self::SendOnly => "recvonly",
            Self::RecvOnly => "sendonly",
            Self::Inactive => "inactive",
        }
    }
}

impl SdpAnswer {
    fn on_hold(&self) -> bool {
        self.remote_media_ip.is_unspecified() || self.direction != SdpDirection::SendRecv
    }
}

#[must_use]
pub fn build_sdp_offer(local_ip: IpAddr, local_rtp_port: u16, session_id: u64) -> String {
    let addr_family = match local_ip {
        IpAddr::V4(_) => "IP4",
        IpAddr::V6(_) => "IP6",
    };
    format!(
        "v=0\r\n\
         o=- {session_id} {session_id} IN {addr_family} {local_ip}\r\n\
         s=DapperCode\r\n\
         c=IN {addr_family} {local_ip}\r\n\
         t=0 0\r\n\
         m=audio {local_rtp_port} RTP/AVP 0 101\r\n\
         a=rtpmap:0 PCMU/8000\r\n\
         a=rtpmap:101 telephone-event/8000\r\n\
         a=fmtp:101 0-15\r\n\
         a=ptime:20\r\n\
         a=sendrecv\r\n",
    )
}

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::excessive_cognitive_complexity,
        perfectionist::excessive_nesting,
        perfectionist::overly_long_function,
        perfectionist::too_many_local_bindings,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
pub fn parse_sdp_answer(sdp: &str) -> Result<SdpAnswer, SipError> {
    let mut session_ip: Option<IpAddr> = None;
    let mut audio_ip: Option<IpAddr> = None;
    let mut audio_port: Option<u16> = None;
    let mut audio_formats: Vec<u8> = Vec::new();
    let mut rtpmap_dtmf_pts: Vec<u8> = Vec::new();
    let mut in_audio_section = false;
    let mut in_media_section = false;
    let mut session_direction = SdpDirection::SendRecv;
    let mut audio_direction = None;

    for raw_line in sdp.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("m=") {
            in_media_section = true;
            if let Some(audio_rest) = rest.strip_prefix("audio ") {
                in_audio_section = true;
                let mut parts = audio_rest.split_whitespace();
                let port_str = parts
                    .next()
                    .ok_or_else(|| SipError::Protocol("SDP m=audio missing port".to_owned()))?;
                let parsed_port = port_str.parse::<u16>().map_err(|_| {
                    SipError::Protocol(format!("invalid SDP audio port '{port_str}'"))
                })?;
                if parsed_port == 0 {
                    return Err(SipError::Protocol(
                        "remote SDP rejected audio stream (port 0)".to_owned(),
                    ));
                }
                audio_port = Some(parsed_port);
                let _proto = parts.next();
                audio_formats.clear();
                for fmt_tok in parts {
                    if let Ok(pt) = fmt_tok.parse::<u8>() {
                        audio_formats.push(pt);
                    }
                }
            } else {
                in_audio_section = false;
            }
        } else if let Some(conn) = line.strip_prefix("c=") {
            if let Some(ip) = parse_sdp_connection_ip(conn) {
                if in_audio_section {
                    audio_ip = Some(ip);
                } else if !in_media_section {
                    session_ip = Some(ip);
                }
            }
        } else if let Some(direction) = match line {
            "a=sendrecv" => Some(SdpDirection::SendRecv),
            "a=sendonly" => Some(SdpDirection::SendOnly),
            "a=recvonly" => Some(SdpDirection::RecvOnly),
            "a=inactive" => Some(SdpDirection::Inactive),
            _ => None,
        } {
            if in_audio_section {
                audio_direction = Some(direction);
            } else if !in_media_section {
                session_direction = direction;
            }
        } else if in_audio_section {
            if let Some(attr) = line.strip_prefix("a=rtpmap:") {
                if let Some((pt_str, codec_spec)) = attr.split_once(char::is_whitespace) {
                    if let Ok(pt) = pt_str.trim().parse::<u8>() {
                        let codec_norm = codec_spec.trim();
                        if codec_norm
                            .split('/')
                            .next()
                            .is_some_and(|name| name.eq_ignore_ascii_case("telephone-event"))
                        {
                            rtpmap_dtmf_pts.push(pt);
                        }
                    }
                }
            }
        }
    }

    let remote_media_ip = audio_ip
        .or(session_ip)
        .ok_or_else(|| SipError::Protocol("SDP answer missing c= connection IP".to_owned()))?;
    let remote_audio_port =
        audio_port.ok_or_else(|| SipError::Protocol("SDP answer missing m=audio".to_owned()))?;
    if !audio_formats.contains(&PCMU_PAYLOAD_TYPE) {
        return Err(SipError::Protocol(
            "SDP audio must support PCMU/8000".to_owned(),
        ));
    }

    let negotiated_dtmf_pt = rtpmap_dtmf_pts
        .into_iter()
        .find(|pt| audio_formats.contains(pt));

    Ok(SdpAnswer {
        remote_media_ip,
        remote_audio_port,
        negotiated_dtmf_pt,
        direction: audio_direction.unwrap_or(session_direction),
    })
}

fn parse_sdp_connection_ip(conn_value: &str) -> Option<IpAddr> {
    let mut parts = conn_value.split_whitespace();
    let nettype = parts.next()?;
    let addrtype = parts.next()?;
    let raw_addr = parts.next()?;
    if !nettype.eq_ignore_ascii_case("IN") {
        return None;
    }
    if !addrtype.eq_ignore_ascii_case("IP4") && !addrtype.eq_ignore_ascii_case("IP6") {
        return None;
    }
    let ip_part = raw_addr.split('/').next().unwrap_or(raw_addr);
    ip_part.parse::<IpAddr>().ok()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedRtpPacket<'a> {
    pub marker: bool,
    pub payload_type: u8,
    pub sequence_number: u16,
    pub timestamp: u32,
    pub ssrc: u32,
    pub payload: &'a [u8],
}

#[must_use]
pub fn build_rtp_packet(
    marker: bool,
    payload_type: u8,
    sequence_number: u16,
    timestamp: u32,
    ssrc: u32,
    payload: &[u8],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(RTP_HEADER_BYTES + payload.len());
    out.push(0x80);
    let m_bit = if marker { 0x80 } else { 0x00 };
    out.push(m_bit | (payload_type & 0x7F));
    out.extend_from_slice(&sequence_number.to_be_bytes());
    out.extend_from_slice(&timestamp.to_be_bytes());
    out.extend_from_slice(&ssrc.to_be_bytes());
    out.extend_from_slice(payload);
    out
}

#[must_use]
#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::too_many_local_bindings,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
pub fn parse_rtp_packet(packet: &[u8]) -> Option<ParsedRtpPacket<'_>> {
    let &[b0, b1, b2, b3, b4, b5, b6, b7, b8, b9, b10, b11, ..] = packet else {
        return None;
    };
    let version = (b0 >> 6) & 0x03;
    if version != 2 {
        return None;
    }
    let padding = (b0 & 0x20) != 0;
    let extension = (b0 & 0x10) != 0;
    let csrc_count = usize::from(b0 & 0x0F);

    let marker = (b1 & 0x80) != 0;
    let payload_type = b1 & 0x7F;
    let sequence_number = u16::from_be_bytes([b2, b3]);
    let timestamp = u32::from_be_bytes([b4, b5, b6, b7]);
    let ssrc = u32::from_be_bytes([b8, b9, b10, b11]);

    let mut offset = RTP_HEADER_BYTES.checked_add(csrc_count.checked_mul(4)?)?;
    if offset > packet.len() {
        return None;
    }

    if extension {
        let ext_hdr = packet.get(offset..offset.checked_add(4)?)?;
        let &[_, _, eh_hi, eh_lo] = ext_hdr else {
            return None;
        };
        let ext_words = usize::from(u16::from_be_bytes([eh_hi, eh_lo]));
        offset = offset
            .checked_add(4)?
            .checked_add(ext_words.checked_mul(4)?)?;
        if offset > packet.len() {
            return None;
        }
    }

    let mut end = packet.len();
    if padding {
        let pad_len = usize::from(*packet.last()?);
        if pad_len == 0 || offset.checked_add(pad_len)? > end {
            return None;
        }
        end -= pad_len;
    }

    let payload = packet.get(offset..end)?;
    Some(ParsedRtpPacket {
        marker,
        payload_type,
        sequence_number,
        timestamp,
        ssrc,
        payload,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OrderedInboundPayload {
    pub pcmu: [u8; PCMU_FRAME_BYTES],
    pub sequence_number: u16,
    pub timestamp: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReorderSlotEntry {
    Audio {
        pcmu: [u8; PCMU_FRAME_BYTES],
        timestamp: u32,
    },
    DroppedTelephoneEvent {
        timestamp: u32,
    },
}

#[derive(Debug, Clone)]
pub struct RtpReorderBuffer {
    next_seq: Option<u16>,
    last_timestamp: u32,
    negotiated_dtmf_pt: Option<u8>,
    slots: [Option<ReorderSlotEntry>; REORDER_WINDOW_SLOTS],
}

impl Default for RtpReorderBuffer {
    fn default() -> Self {
        Self::new(None)
    }
}

impl RtpReorderBuffer {
    #[must_use]
    pub const fn new(negotiated_dtmf_pt: Option<u8>) -> Self {
        Self {
            next_seq: None,
            last_timestamp: 0,
            negotiated_dtmf_pt,
            slots: [None; REORDER_WINDOW_SLOTS],
        }
    }

    #[must_use]
    pub fn has_pending(&self) -> bool {
        self.slots.iter().any(Option::is_some)
    }

    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::excessive_cognitive_complexity,
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    pub fn push_rtp_packet(&mut self, pkt: &ParsedRtpPacket<'_>) -> Vec<OrderedInboundPayload> {
        let is_dtmf = pkt.payload_type == DEFAULT_TELEPHONE_EVENT_PT
            || self.negotiated_dtmf_pt == Some(pkt.payload_type);

        let entry = if is_dtmf {
            ReorderSlotEntry::DroppedTelephoneEvent {
                timestamp: pkt.timestamp,
            }
        } else if pkt.payload_type == COMFORT_NOISE_PAYLOAD_TYPE {
            ReorderSlotEntry::Audio {
                pcmu: [PCMU_SILENCE_BYTE; PCMU_FRAME_BYTES],
                timestamp: pkt.timestamp,
            }
        } else if pkt.payload_type == PCMU_PAYLOAD_TYPE {
            let mut pcmu = [PCMU_SILENCE_BYTE; PCMU_FRAME_BYTES];
            let copy_len = pkt.payload.len().min(PCMU_FRAME_BYTES);
            if let (Some(dst), Some(src)) = (pcmu.get_mut(..copy_len), pkt.payload.get(..copy_len))
            {
                dst.copy_from_slice(src);
            }
            ReorderSlotEntry::Audio {
                pcmu,
                timestamp: pkt.timestamp,
            }
        } else {
            return Vec::new();
        };

        let mut ready = Vec::new();
        let Some(mut expected) = self.next_seq else {
            self.next_seq = Some(pkt.sequence_number.wrapping_add(1));
            self.last_timestamp = pkt.timestamp;
            if let ReorderSlotEntry::Audio { pcmu, timestamp } = entry {
                ready.push(OrderedInboundPayload {
                    pcmu,
                    sequence_number: pkt.sequence_number,
                    timestamp,
                });
            }
            return ready;
        };

        let delta = pkt.sequence_number.wrapping_sub(expected);
        if delta >= 0x8000 {
            // Late or duplicate packet behind `expected`.
            return ready;
        }

        let delta_usize = usize::from(delta);
        if delta_usize < REORDER_WINDOW_SLOTS {
            if let Some(slot) = self.slots.get_mut(delta_usize) {
                if slot.is_none() {
                    *slot = Some(entry);
                }
            }
            self.drain_ready(&mut ready);
            return ready;
        }

        if delta <= MAX_SILENCE_GAP_FILL {
            // Advance window until `pkt.sequence_number` lands at the last slot,
            // synthesizing `[0xFF; 160]` silence for genuinely missing sequence numbers.
            while usize::from(pkt.sequence_number.wrapping_sub(expected)) >= REORDER_WINDOW_SLOTS {
                self.advance_one_step(&mut ready);
                expected = self.next_seq.unwrap_or(pkt.sequence_number);
            }
            let new_delta = usize::from(pkt.sequence_number.wrapping_sub(expected));
            if let Some(slot) = self.slots.get_mut(new_delta) {
                *slot = Some(entry);
            }
            self.drain_ready(&mut ready);
            return ready;
        }

        // Large sequence jump / stream reset: flush any buffered frames and resync.
        while self.has_pending() {
            self.advance_one_step(&mut ready);
        }
        self.next_seq = Some(pkt.sequence_number.wrapping_add(1));
        self.last_timestamp = pkt.timestamp;
        if let ReorderSlotEntry::Audio { pcmu, timestamp } = entry {
            ready.push(OrderedInboundPayload {
                pcmu,
                sequence_number: pkt.sequence_number,
                timestamp,
            });
        }
        ready
    }

    pub fn flush_expired(&mut self) -> Vec<OrderedInboundPayload> {
        let mut ready = Vec::new();
        if self.has_pending() {
            self.advance_one_step(&mut ready);
            self.drain_ready(&mut ready);
        }
        ready
    }

    fn drain_ready(&mut self, ready: &mut Vec<OrderedInboundPayload>) {
        while let Some(front) = self.slots.first().copied().flatten() {
            let seq = self.next_seq.unwrap_or(0);
            self.shift_slots_left();
            self.next_seq = Some(seq.wrapping_add(1));
            match front {
                ReorderSlotEntry::Audio { pcmu, timestamp } => {
                    self.last_timestamp = timestamp;
                    ready.push(OrderedInboundPayload {
                        pcmu,
                        sequence_number: seq,
                        timestamp,
                    });
                }
                ReorderSlotEntry::DroppedTelephoneEvent { timestamp } => {
                    self.last_timestamp = timestamp;
                }
            }
        }
    }

    fn advance_one_step(&mut self, ready: &mut Vec<OrderedInboundPayload>) {
        let seq = self.next_seq.unwrap_or(0);
        let front = self.slots.first().copied().flatten();
        self.shift_slots_left();
        self.next_seq = Some(seq.wrapping_add(1));
        match front {
            Some(ReorderSlotEntry::Audio { pcmu, timestamp }) => {
                self.last_timestamp = timestamp;
                ready.push(OrderedInboundPayload {
                    pcmu,
                    sequence_number: seq,
                    timestamp,
                });
            }
            Some(ReorderSlotEntry::DroppedTelephoneEvent { timestamp }) => {
                self.last_timestamp = timestamp;
            }
            None => {
                let synth_ts = self.last_timestamp.wrapping_add(RTP_TIMESTAMP_STEP);
                self.last_timestamp = synth_ts;
                ready.push(OrderedInboundPayload {
                    pcmu: [PCMU_SILENCE_BYTE; PCMU_FRAME_BYTES],
                    sequence_number: seq,
                    timestamp: synth_ts,
                });
            }
        }
    }

    fn shift_slots_left(&mut self) {
        self.slots.rotate_left(1);
        if let Some(last) = self.slots.last_mut() {
            *last = None;
        }
    }
}

// ============================================================================
// SIP Wire Parser & Transport (UDP + Content-Length-Framed TLS)
// ============================================================================

#[derive(Debug, Clone, PartialEq, Eq)]
enum SipStartLine {
    Response { status_code: u16, reason: String },
    Request { method: String, uri: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SipMessage {
    start_line: SipStartLine,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl SipMessage {
    fn first_header(&self, name: &str) -> Option<&str> {
        let compact = compact_header_alias(name);
        self.headers
            .iter()
            .find(|(k, _)| {
                k.eq_ignore_ascii_case(name)
                    || compact.is_some_and(|alias| k.eq_ignore_ascii_case(alias))
            })
            .map(|(_, v)| v.as_str())
    }

    fn headers_named<'a>(&'a self, name: &'a str) -> Vec<&'a str> {
        let compact = compact_header_alias(name);
        self.headers
            .iter()
            .filter(|(k, _)| {
                k.eq_ignore_ascii_case(name)
                    || compact.is_some_and(|alias| k.eq_ignore_ascii_case(alias))
            })
            .map(|(_, v)| v.as_str())
            .collect()
    }

    fn cseq(&self) -> Option<(u32, &str)> {
        let val = self.first_header("CSeq")?;
        let mut parts = val.split_whitespace();
        let num = parts.next()?.parse::<u32>().ok()?;
        let method = parts.next()?;
        Some((num, method))
    }
}

fn compact_header_alias(name: &str) -> Option<&'static str> {
    if name.eq_ignore_ascii_case("Via") {
        Some("v")
    } else if name.eq_ignore_ascii_case("From") {
        Some("f")
    } else if name.eq_ignore_ascii_case("To") {
        Some("t")
    } else if name.eq_ignore_ascii_case("Call-ID") {
        Some("i")
    } else if name.eq_ignore_ascii_case("Contact") {
        Some("m")
    } else if name.eq_ignore_ascii_case("Content-Type") {
        Some("c")
    } else if name.eq_ignore_ascii_case("Content-Length") {
        Some("l")
    } else {
        None
    }
}

struct ParsedSipHeaders {
    start_line: SipStartLine,
    headers: Vec<(String, String)>,
    content_length: Option<usize>,
}

fn parse_sip_datagram(raw: &[u8]) -> Result<Option<SipMessage>, SipError> {
    let trimmed = strip_leading_crlf(raw);
    if trimmed.is_empty() {
        return Ok(None);
    }
    let Some((header_bytes, remainder)) = split_headers_and_body(trimmed) else {
        return Err(SipError::Protocol(
            "SIP datagram missing CRLFCRLF header terminator".to_owned(),
        ));
    };
    let parsed = parse_sip_headers_section(header_bytes)?;
    let body = if let Some(cl) = parsed.content_length {
        let take_len = cl.min(remainder.len());
        remainder.get(..take_len).unwrap_or(&[]).to_vec()
    } else {
        remainder.to_vec()
    };
    Ok(Some(SipMessage {
        start_line: parsed.start_line,
        headers: parsed.headers,
        body,
    }))
}

fn try_extract_stream_sip_message(buf: &mut Vec<u8>) -> Result<Option<SipMessage>, SipError> {
    let leading_ws = buf
        .iter()
        .take_while(|&&b| b == b'\r' || b == b'\n')
        .count();
    if leading_ws > 0 {
        buf.drain(..leading_ws);
    }
    if buf.is_empty() {
        return Ok(None);
    }

    let Some((header_end, delim_len)) = find_header_terminator(buf) else {
        if buf.len() > MAX_SIP_HEADER_BYTES {
            return Err(SipError::Protocol(
                "SIP stream headers exceed maximum size".to_owned(),
            ));
        }
        return Ok(None);
    };
    if header_end > MAX_SIP_HEADER_BYTES {
        return Err(SipError::Protocol(
            "SIP stream headers exceed maximum size".to_owned(),
        ));
    }

    let header_slice = buf.get(..header_end).unwrap_or(&[]);
    let parsed = parse_sip_headers_section(header_slice)?;
    let body_len = parsed.content_length.ok_or_else(|| {
        SipError::Protocol("SIP stream message missing Content-Length header".to_owned())
    })?;
    if body_len > MAX_SIP_BODY_BYTES {
        return Err(SipError::Protocol(format!(
            "SIP stream Content-Length {body_len} exceeds maximum",
        )));
    }

    let total_len = header_end
        .checked_add(delim_len)
        .and_then(|n| n.checked_add(body_len))
        .ok_or_else(|| SipError::Protocol("SIP message length overflow".to_owned()))?;
    if buf.len() < total_len {
        return Ok(None);
    }

    let body_start = header_end + delim_len;
    let body = buf.get(body_start..total_len).unwrap_or(&[]).to_vec();
    buf.drain(..total_len);

    Ok(Some(SipMessage {
        start_line: parsed.start_line,
        headers: parsed.headers,
        body,
    }))
}

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::too_many_local_bindings,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
fn parse_sip_headers_section(header_bytes: &[u8]) -> Result<ParsedSipHeaders, SipError> {
    let header_text = std::str::from_utf8(header_bytes)
        .map_err(|_| SipError::Protocol("SIP headers contain invalid UTF-8".to_owned()))?;
    let mut raw_lines = header_text.lines();
    let first_line = raw_lines
        .next()
        .map(|line| line.trim_end_matches('\r'))
        .ok_or_else(|| SipError::Protocol("empty SIP message".to_owned()))?;

    let start_line = parse_sip_start_line(first_line)?;
    let mut unfolded_lines: Vec<String> = Vec::new();
    for raw_line in raw_lines {
        let clean = raw_line.trim_end_matches('\r');
        if clean.starts_with(' ') || clean.starts_with('\t') {
            if let Some(prev) = unfolded_lines.last_mut() {
                prev.push(' ');
                prev.push_str(clean.trim());
            }
        } else if !clean.is_empty() {
            unfolded_lines.push(clean.to_owned());
        }
    }

    let mut headers = Vec::with_capacity(unfolded_lines.len());
    let mut content_length: Option<usize> = None;
    for line in unfolded_lines {
        let Some((name, val)) = line.split_once(':') else {
            continue;
        };
        let header_name = name.trim().to_owned();
        let header_val = val.trim().to_owned();
        if header_name.eq_ignore_ascii_case("Content-Length")
            || header_name.eq_ignore_ascii_case("l")
        {
            let parsed_len = header_val.parse::<usize>().map_err(|_| {
                SipError::Protocol(format!("invalid Content-Length '{header_val}'"))
            })?;
            content_length = Some(parsed_len);
        }
        headers.push((header_name, header_val));
    }

    Ok(ParsedSipHeaders {
        start_line,
        headers,
        content_length,
    })
}

fn parse_sip_start_line(line: &str) -> Result<SipStartLine, SipError> {
    if let Some(rest) = line.strip_prefix("SIP/2.0 ") {
        let rest_trimmed = rest.trim_start();
        let (code_str, reason) = match rest_trimmed.split_once(char::is_whitespace) {
            Some((c, r)) => (c, r.trim()),
            None => (rest_trimmed, ""),
        };
        let status_code = code_str
            .parse::<u16>()
            .map_err(|_| SipError::Protocol(format!("invalid SIP status code '{code_str}'")))?;
        return Ok(SipStartLine::Response {
            status_code,
            reason: reason.to_owned(),
        });
    }

    let mut parts = line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| SipError::Protocol("missing SIP request method".to_owned()))?;
    let uri = parts
        .next()
        .ok_or_else(|| SipError::Protocol("missing SIP request URI".to_owned()))?;
    let version = parts
        .next()
        .ok_or_else(|| SipError::Protocol("missing SIP version".to_owned()))?;
    if version != "SIP/2.0" {
        return Err(SipError::Protocol(format!(
            "unsupported SIP version '{version}'",
        )));
    }
    Ok(SipStartLine::Request {
        method: method.to_owned(),
        uri: uri.to_owned(),
    })
}

fn strip_leading_crlf(bytes: &[u8]) -> &[u8] {
    let skip = bytes
        .iter()
        .take_while(|&&b| b == b'\r' || b == b'\n')
        .count();
    bytes.get(skip..).unwrap_or(&[])
}

fn find_header_terminator(bytes: &[u8]) -> Option<(usize, usize)> {
    for (idx, window) in bytes.windows(4).enumerate() {
        if window == b"\r\n\r\n" {
            return Some((idx, 4));
        }
    }
    for (idx, window) in bytes.windows(2).enumerate() {
        if window == b"\n\n" {
            return Some((idx, 2));
        }
    }
    None
}

fn split_headers_and_body(bytes: &[u8]) -> Option<(&[u8], &[u8])> {
    let (hdr_end, delim_len) = find_header_terminator(bytes)?;
    let headers = bytes.get(..hdr_end)?;
    let body = bytes.get(hdr_end + delim_len..)?;
    Some((headers, body))
}

enum SipTransport {
    Udp {
        socket: UdpSocket,
        scratch: Vec<u8>,
    },
    Tls {
        stream: Box<TlsStream<TcpStream>>,
        read_buf: Vec<u8>,
        scratch: Vec<u8>,
    },
}

impl SipTransport {
    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    async fn connect(config: &SipDialConfig) -> Result<(Self, SocketAddr, SocketAddr), SipError> {
        let mut resolved = lookup_host((config.server_host.as_str(), config.server_port))
            .await
            .map_err(SipError::Io)?;
        let remote_addr = resolved.next().ok_or_else(|| {
            SipError::InvalidConfig(format!(
                "failed to resolve SIP server {}:{}",
                config.server_host, config.server_port,
            ))
        })?;

        match config.transport {
            SipTransportKind::Udp => {
                let bind_ip = match remote_addr.ip() {
                    IpAddr::V4(ip) if ip.is_loopback() => IpAddr::V4(Ipv4Addr::LOCALHOST),
                    IpAddr::V4(_) => IpAddr::V4(Ipv4Addr::UNSPECIFIED),
                    IpAddr::V6(ip) if ip.is_loopback() => IpAddr::V6(Ipv6Addr::LOCALHOST),
                    IpAddr::V6(_) => IpAddr::V6(Ipv6Addr::UNSPECIFIED),
                };
                let socket = UdpSocket::bind(SocketAddr::new(bind_ip, 0)).await?;
                socket.connect(remote_addr).await?;
                let local_addr = socket.local_addr()?;
                Ok((
                    Self::Udp {
                        socket,
                        scratch: vec![0_u8; 65535],
                    },
                    local_addr,
                    remote_addr,
                ))
            }
            SipTransportKind::Tls => {
                let tcp_stream = TcpStream::connect(remote_addr).await?;
                let _ = tcp_stream.set_nodelay(true);
                let local_addr = tcp_stream.local_addr()?;

                let tls_config = match &config.custom_tls_config {
                    Some(custom) => Arc::clone(custom),
                    None => default_rustls_client_config()?,
                };
                let sni_name = config
                    .tls_server_name
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| config.server_host.trim());
                let server_name = ServerName::try_from(sni_name.to_owned()).map_err(|err| {
                    SipError::Tls(format!("invalid TLS server name '{sni_name}': {err}"))
                })?;

                let connector = TlsConnector::from(tls_config);
                let tls_stream = connector
                    .connect(server_name, tcp_stream)
                    .await
                    .map_err(|err| SipError::Tls(format!("TLS handshake failed: {err}")))?;

                Ok((
                    Self::Tls {
                        stream: Box::new(tls_stream),
                        read_buf: Vec::with_capacity(8192),
                        scratch: vec![0_u8; 8192],
                    },
                    local_addr,
                    remote_addr,
                ))
            }
        }
    }

    async fn send(&mut self, bytes: &[u8]) -> Result<(), SipError> {
        match self {
            Self::Udp { socket, .. } => {
                socket.send(bytes).await?;
                Ok(())
            }
            Self::Tls { stream, .. } => {
                stream.write_all(bytes).await?;
                stream.flush().await?;
                Ok(())
            }
        }
    }

    /// Cancel-safe receive of the next SIP message.
    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::excessive_cognitive_complexity,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    async fn recv_message(&mut self) -> Result<SipMessage, SipError> {
        match self {
            Self::Udp { socket, scratch } => loop {
                let n = socket.recv(scratch).await?;
                let slice = scratch.get(..n).unwrap_or(&[]);
                if let Some(msg) = parse_sip_datagram(slice)? {
                    return Ok(msg);
                }
            },
            Self::Tls {
                stream,
                read_buf,
                scratch,
            } => loop {
                if let Some(msg) = try_extract_stream_sip_message(read_buf)? {
                    return Ok(msg);
                }
                let n = stream.read(scratch).await?;
                if n == 0 {
                    return Err(SipError::Closed("SIP TLS stream closed by peer".to_owned()));
                }
                if let Some(slice) = scratch.get(..n) {
                    read_buf.extend_from_slice(slice);
                }
            },
        }
    }
}

// ============================================================================
// Shared Outbound Media Queue & 20 ms Drift-Free RTP Engine
// ============================================================================

#[derive(Debug, Clone, Copy)]
enum QueuedDtmfStep {
    Packet {
        payload_type: u8,
        payload: [u8; 4],
        first_of_digit: bool,
    },
    InterDigitSilence,
}

#[derive(Debug)]
struct OutboundMediaState {
    voice_queue: VecDeque<[u8; PCMU_FRAME_BYTES]>,
    dtmf_queue: VecDeque<QueuedDtmfStep>,
    outbound_playing: bool,
    was_playing_voice: bool,
    current_outbound_pcmu: [u8; PCMU_FRAME_BYTES],
    active_dtmf_timestamp: Option<u32>,
    remote_media: Option<SdpAnswer>,
    discarded_voice_frames: usize,
}

impl Default for OutboundMediaState {
    fn default() -> Self {
        Self {
            voice_queue: VecDeque::new(),
            dtmf_queue: VecDeque::new(),
            outbound_playing: false,
            was_playing_voice: false,
            current_outbound_pcmu: [PCMU_SILENCE_BYTE; PCMU_FRAME_BYTES],
            active_dtmf_timestamp: None,
            remote_media: None,
            discarded_voice_frames: 0,
        }
    }
}

fn lock_unpoisoned<State>(mutex: &Mutex<State>) -> std::sync::MutexGuard<'_, State> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::excessive_cognitive_complexity,
        perfectionist::excessive_nesting,
        perfectionist::overly_long_function,
        perfectionist::too_many_local_bindings,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
fn spawn_rtp_media_tasks(
    rtp_socket: Arc<UdpSocket>,
    remote_rtp_addr: SocketAddr,
    negotiated_dtmf_pt: Option<u8>,
    media_state: Arc<Mutex<OutboundMediaState>>,
    inbound_audio_tx: mpsc::Sender<InboundRtpAudioFrame>,
    sent_rtp_packets: Arc<AtomicU64>,
    cancel: CancellationToken,
) -> (JoinHandle<()>, JoinHandle<()>) {
    let mut rand_bytes = [0_u8; 10];
    let _ = fill_random(&mut rand_bytes);
    let initial_seq = u16::from_be_bytes([rand_bytes[0], rand_bytes[1]]);
    let initial_ts =
        u32::from_be_bytes([rand_bytes[2], rand_bytes[3], rand_bytes[4], rand_bytes[5]]);
    let raw_ssrc = u32::from_be_bytes([rand_bytes[6], rand_bytes[7], rand_bytes[8], rand_bytes[9]]);
    let ssrc = if raw_ssrc == 0 { 1 } else { raw_ssrc };

    let tx_socket = Arc::clone(&rtp_socket);
    let tx_state = Arc::clone(&media_state);
    let tx_cancel = cancel.clone();
    let tx_counter = Arc::clone(&sent_rtp_packets);

    let sender_task = tokio::spawn(async move {
        let start_instant = Instant::now();
        let frame_ms = u64::try_from(RTP_FRAME_INTERVAL.as_millis()).unwrap_or(20);
        let mut packet_index: u64 = 0;
        let mut seq = initial_seq;
        let mut stream_ts = initial_ts;

        loop {
            let deadline =
                start_instant + Duration::from_millis(packet_index.saturating_mul(frame_ms));
            tokio::select! {
                biased;
                () = tx_cancel.cancelled() => break,
                () = tokio::time::sleep_until(deadline) => {}
            }

            let (packet_bytes, destination, held) = {
                let mut state = lock_unpoisoned(&tx_state);
                let destination = state
                    .remote_media
                    .as_ref()
                    .map_or(remote_rtp_addr, |remote| {
                        SocketAddr::new(remote.remote_media_ip, remote.remote_audio_port)
                    });
                let held = state.remote_media.as_ref().is_some_and(SdpAnswer::on_hold);
                let packet = if let Some(dtmf_step) = state.dtmf_queue.pop_front() {
                    state.outbound_playing = false;
                    state.was_playing_voice = false;
                    state.current_outbound_pcmu = [PCMU_SILENCE_BYTE; PCMU_FRAME_BYTES];

                    match dtmf_step {
                        QueuedDtmfStep::Packet {
                            payload_type,
                            payload,
                            first_of_digit,
                        } => {
                            let event_ts = if first_of_digit {
                                state.active_dtmf_timestamp = Some(stream_ts);
                                stream_ts
                            } else {
                                state.active_dtmf_timestamp.unwrap_or(stream_ts)
                            };
                            build_rtp_packet(
                                first_of_digit,
                                payload_type,
                                seq,
                                event_ts,
                                ssrc,
                                &payload,
                            )
                        }
                        QueuedDtmfStep::InterDigitSilence => {
                            state.active_dtmf_timestamp = None;
                            build_rtp_packet(
                                false,
                                PCMU_PAYLOAD_TYPE,
                                seq,
                                stream_ts,
                                ssrc,
                                &[PCMU_SILENCE_BYTE; PCMU_FRAME_BYTES],
                            )
                        }
                    }
                } else if let Some(voice_frame) = state.voice_queue.pop_front() {
                    state.active_dtmf_timestamp = None;
                    let marker = !state.was_playing_voice;
                    state.was_playing_voice = true;
                    state.outbound_playing = true;
                    state.current_outbound_pcmu = voice_frame;
                    build_rtp_packet(
                        marker,
                        PCMU_PAYLOAD_TYPE,
                        seq,
                        stream_ts,
                        ssrc,
                        &voice_frame,
                    )
                } else {
                    state.active_dtmf_timestamp = None;
                    state.was_playing_voice = false;
                    state.outbound_playing = false;
                    state.current_outbound_pcmu = [PCMU_SILENCE_BYTE; PCMU_FRAME_BYTES];
                    build_rtp_packet(
                        false,
                        PCMU_PAYLOAD_TYPE,
                        seq,
                        stream_ts,
                        ssrc,
                        &[PCMU_SILENCE_BYTE; PCMU_FRAME_BYTES],
                    )
                };
                (packet, destination, held)
            };

            if !held {
                let _ = tx_socket.send_to(&packet_bytes, destination).await;
                tx_counter.fetch_add(1, Ordering::Relaxed);
            }
            seq = seq.wrapping_add(1);
            stream_ts = stream_ts.wrapping_add(RTP_TIMESTAMP_STEP);
            packet_index = packet_index.saturating_add(1);
        }
    });

    let rx_socket = rtp_socket;
    let rx_state = media_state;
    let rx_cancel = cancel;
    let receiver_task = tokio::spawn(async move {
        let mut reorder = RtpReorderBuffer::new(negotiated_dtmf_pt);
        let mut scratch = vec![0_u8; 2048];

        loop {
            let has_pending = reorder.has_pending();
            let ready_frames = tokio::select! {
                biased;
                () = rx_cancel.cancelled() => break,
                recv_res = rx_socket.recv_from(&mut scratch) => {
                    match recv_res {
                        Ok((n, _peer)) => {
                            let slice = scratch.get(..n).unwrap_or(&[]);
                            if let Some(parsed) = parse_rtp_packet(slice) {
                                let state = lock_unpoisoned(&rx_state);
                                if let Some(remote) = &state.remote_media {
                                    reorder.negotiated_dtmf_pt = remote.negotiated_dtmf_pt;
                                    if remote.direction == SdpDirection::Inactive
                                        || remote.remote_media_ip.is_unspecified()
                                    {
                                        continue;
                                    }
                                }
                                reorder.push_rtp_packet(&parsed)
                            } else {
                                Vec::new()
                            }
                        }
                        Err(_) => break,
                    }
                }
                () = tokio::time::sleep(REORDER_FLUSH_TIMEOUT), if has_pending => {
                    reorder.flush_expired()
                }
            };

            if !ready_frames.is_empty() {
                let (outbound_playing, outbound_pcmu) = {
                    let state = lock_unpoisoned(&rx_state);
                    (state.outbound_playing, state.current_outbound_pcmu)
                };
                for ordered in ready_frames {
                    let _ = inbound_audio_tx.try_send(InboundRtpAudioFrame {
                        inbound_pcmu: ordered.pcmu,
                        outbound_pcmu,
                        outbound_playing,
                        rtp_sequence: ordered.sequence_number,
                        rtp_timestamp: ordered.timestamp,
                    });
                }
            }
        }
    });

    (sender_task, receiver_task)
}

// ============================================================================
// SIP UAC Session & Control Handle
// ============================================================================

enum SignalingCommand {
    Hangup(oneshot::Sender<Result<(), SipError>>),
}

#[derive(Debug)]
struct SessionLifeline {
    cancel: CancellationToken,
}

impl Drop for SessionLifeline {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

#[derive(Clone, Debug)]
pub struct SipCallHandle {
    #[cfg(test)]
    call_id: String,
    #[cfg(test)]
    local_sip_addr: SocketAddr,
    #[cfg(test)]
    local_rtp_addr: SocketAddr,
    media_state: Arc<Mutex<OutboundMediaState>>,
    cmd_tx: mpsc::Sender<SignalingCommand>,
    state_rx: watch::Receiver<SipCallState>,
    #[cfg(test)]
    discarded_early_rtp: Arc<AtomicU64>,
    #[cfg(test)]
    sent_rtp_packets: Arc<AtomicU64>,
    _lifeline: Arc<SessionLifeline>,
}

impl SipCallHandle {
    #[cfg(test)]
    #[must_use]
    pub fn call_id(&self) -> &str {
        &self.call_id
    }

    #[cfg(test)]
    #[must_use]
    pub const fn local_sip_addr(&self) -> SocketAddr {
        self.local_sip_addr
    }

    #[cfg(test)]
    #[must_use]
    pub const fn local_rtp_addr(&self) -> SocketAddr {
        self.local_rtp_addr
    }

    #[must_use]
    pub fn state(&self) -> SipCallState {
        self.state_rx.borrow().clone()
    }

    #[cfg(test)]
    #[must_use]
    pub fn subscribe_state(&self) -> watch::Receiver<SipCallState> {
        self.state_rx.clone()
    }

    #[cfg(test)]
    #[must_use]
    pub fn discarded_early_rtp_packets(&self) -> u64 {
        self.discarded_early_rtp.load(Ordering::Relaxed)
    }

    #[cfg(test)]
    #[must_use]
    pub fn sent_rtp_packets(&self) -> u64 {
        self.sent_rtp_packets.load(Ordering::Relaxed)
    }

    pub fn enqueue_pcmu_frames(&self, frames: Vec<[u8; PCMU_FRAME_BYTES]>) {
        if frames.is_empty() {
            return;
        }
        let mut state = lock_unpoisoned(&self.media_state);
        if state.remote_media.as_ref().is_some_and(SdpAnswer::on_hold) {
            state.discarded_voice_frames =
                state.discarded_voice_frames.saturating_add(frames.len());
            return;
        }
        state.voice_queue.extend(frames);
    }

    pub fn clear_outbound_audio(&self) -> OutboundPlaybackSnapshot {
        let mut state = lock_unpoisoned(&self.media_state);
        let cleared_frames = state.voice_queue.len();
        let prev_playing = state.outbound_playing;
        let prev_frame = state.current_outbound_pcmu;
        state.discarded_voice_frames = state.discarded_voice_frames.saturating_add(cleared_frames);
        state.voice_queue.clear();
        state.outbound_playing = false;
        state.was_playing_voice = false;
        state.current_outbound_pcmu = [PCMU_SILENCE_BYTE; PCMU_FRAME_BYTES];
        OutboundPlaybackSnapshot {
            outbound_playing: prev_playing,
            current_outbound_pcmu: prev_frame,
            cleared_frames,
            discarded_frames: state.discarded_voice_frames,
        }
    }

    #[must_use]
    pub fn outbound_playback_state(&self) -> OutboundPlaybackSnapshot {
        let state = lock_unpoisoned(&self.media_state);
        OutboundPlaybackSnapshot {
            outbound_playing: state.outbound_playing,
            current_outbound_pcmu: state.current_outbound_pcmu,
            cleared_frames: state.voice_queue.len(),
            discarded_frames: state.discarded_voice_frames,
        }
    }

    pub fn trim_outbound_audio(
        &self,
        total_frames: usize,
        discarded_base: usize,
        sentence_end: usize,
    ) {
        let mut state = lock_unpoisoned(&self.media_state);
        let played = total_frames
            .saturating_sub(state.discarded_voice_frames.saturating_sub(discarded_base))
            .saturating_sub(state.voice_queue.len());
        let keep_frames = sentence_end.saturating_sub(played);
        let removed = state.voice_queue.len().saturating_sub(keep_frames);
        state.voice_queue.truncate(keep_frames);
        state.discarded_voice_frames = state.discarded_voice_frames.saturating_add(removed);
    }

    #[must_use]
    pub fn has_pending_outbound_media(&self) -> bool {
        let state = lock_unpoisoned(&self.media_state);
        state.outbound_playing || !state.voice_queue.is_empty() || !state.dtmf_queue.is_empty()
    }

    pub fn enqueue_rfc4733_dtmf(&self, payload_type: u8, packets: Vec<[u8; 4]>) {
        if packets.is_empty() {
            return;
        }
        let mut state = lock_unpoisoned(&self.media_state);
        let mut start_of_digit = true;
        for (idx, pkt) in packets.iter().copied().enumerate() {
            let is_end = (pkt[1] & 0x80) != 0;
            state.dtmf_queue.push_back(QueuedDtmfStep::Packet {
                payload_type,
                payload: pkt,
                first_of_digit: start_of_digit,
            });
            start_of_digit = false;

            let next_starts_new_digit = packets
                .get(idx + 1)
                .is_some_and(|next_pkt| is_end && (next_pkt[1] & 0x80) == 0);
            if next_starts_new_digit {
                for _ in 0..DTMF_INTER_DIGIT_GAP_TICKS {
                    state
                        .dtmf_queue
                        .push_back(QueuedDtmfStep::InterDigitSilence);
                }
                start_of_digit = true;
            }
        }
        for _ in 0..DTMF_INTER_DIGIT_GAP_TICKS {
            state
                .dtmf_queue
                .push_back(QueuedDtmfStep::InterDigitSilence);
        }
    }

    #[cfg(test)]
    pub async fn wait_for_connected(&self) -> Result<Option<u8>, SipError> {
        let mut rx = self.state_rx.clone();
        loop {
            let current = rx.borrow_and_update().clone();
            match current {
                SipCallState::Connected { negotiated_dtmf_pt } => return Ok(negotiated_dtmf_pt),
                SipCallState::Ended { reason, failure } => {
                    if let Some(fail) = failure {
                        return Err(fail.into_sip_error());
                    }
                    return Err(SipError::Closed(reason));
                }
                SipCallState::Dialing | SipCallState::Ringing => {}
            }
            if rx.changed().await.is_err() {
                return Err(SipError::Closed("SIP signaling task exited".to_owned()));
            }
        }
    }

    pub async fn hangup(&self) -> Result<(), SipError> {
        if matches!(*self.state_rx.borrow(), SipCallState::Ended { .. }) {
            return Ok(());
        }
        let (reply_tx, reply_rx) = oneshot::channel();
        if self
            .cmd_tx
            .send(SignalingCommand::Hangup(reply_tx))
            .await
            .is_err()
        {
            return Ok(());
        }
        reply_rx.await.unwrap_or(Ok(()))
    }
}

#[derive(Debug)]
pub struct SipCallSession {
    handle: SipCallHandle,
    event_rx: Option<mpsc::Receiver<SipCallEvent>>,
    inbound_audio_rx: Option<mpsc::Receiver<InboundRtpAudioFrame>>,
    _signaling_task: JoinHandle<()>,
}

impl SipCallSession {
    #[cfg_attr(
        dylint_lib = "perfectionist",
        expect(
            perfectionist::overly_long_function,
            perfectionist::too_many_local_bindings,
            reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
        )
    )]
    pub async fn dial(config: SipDialConfig) -> Result<Self, SipError> {
        config.validate()?;
        let (mut transport, local_sip_addr, _remote_sip_addr) =
            SipTransport::connect(&config).await?;

        let rtp_socket = Arc::new(UdpSocket::bind(SocketAddr::new(local_sip_addr.ip(), 0)).await?);
        let local_rtp_addr = rtp_socket.local_addr()?;

        let call_id = format!("{}@{}", Uuid::new_v4(), local_sip_addr.ip());
        let from_tag = random_hex_token(8);
        let sdp_session_id = random_u64();
        let sdp_offer = build_sdp_offer(local_rtp_addr.ip(), local_rtp_addr.port(), sdp_session_id);

        let domain = config.effective_domain().to_owned();
        let request_uri = format!("sip:{}@{domain}", config.target_number.trim());
        let active_cseq: u32 = 1;
        let active_branch = format!("z9hG4bK{}", random_hex_token(12));

        let initial_invite = build_invite_request(&InviteParams {
            config: &config,
            domain: &domain,
            request_uri: &request_uri,
            local_sip_addr,
            branch: &active_branch,
            from_tag: &from_tag,
            call_id: &call_id,
            cseq: active_cseq,
            auth_headers: &[],
            sdp_offer: &sdp_offer,
        });
        transport.send(initial_invite.as_bytes()).await?;

        let media_state = Arc::new(Mutex::new(OutboundMediaState::default()));
        let (cmd_tx, cmd_rx) = mpsc::channel(16);
        let (event_tx, event_rx) = mpsc::channel(CALL_EVENT_CHANNEL_CAPACITY);
        let (inbound_audio_tx, inbound_audio_rx) = mpsc::channel(INBOUND_AUDIO_CHANNEL_CAPACITY);
        let (state_tx, state_rx) = watch::channel(SipCallState::Dialing);
        let discarded_early_rtp = Arc::new(AtomicU64::new(0));
        let sent_rtp_packets = Arc::new(AtomicU64::new(0));
        let cancel = CancellationToken::new();
        let lifeline = Arc::new(SessionLifeline {
            cancel: cancel.clone(),
        });

        let loop_ctx = SignalingLoopContext {
            config,
            domain,
            request_uri,
            local_sip_addr,
            call_id: call_id.clone(),
            from_tag,
            sdp_offer,
            initial_invite_bytes: initial_invite.into_bytes(),
            active_cseq,
            active_branch,
            rtp_socket,
            media_state: Arc::clone(&media_state),
            cmd_rx,
            event_tx,
            inbound_audio_tx,
            state_tx,
            discarded_early_rtp: Arc::clone(&discarded_early_rtp),
            sent_rtp_packets: Arc::clone(&sent_rtp_packets),
            cancel,
        };

        let signaling_task = tokio::spawn(async move {
            Box::pin(run_signaling_loop(transport, loop_ctx)).await;
        });

        let handle = SipCallHandle {
            #[cfg(test)]
            call_id,
            #[cfg(test)]
            local_sip_addr,
            #[cfg(test)]
            local_rtp_addr,
            media_state,
            cmd_tx,
            state_rx,
            #[cfg(test)]
            discarded_early_rtp,
            #[cfg(test)]
            sent_rtp_packets,
            _lifeline: lifeline,
        };

        Ok(Self {
            handle,
            event_rx: Some(event_rx),
            inbound_audio_rx: Some(inbound_audio_rx),
            _signaling_task: signaling_task,
        })
    }

    #[must_use]
    pub fn control_handle(&self) -> SipCallHandle {
        self.handle.clone()
    }

    #[cfg(test)]
    #[must_use]
    pub fn call_id(&self) -> &str {
        self.handle.call_id()
    }

    #[cfg(test)]
    #[must_use]
    pub const fn local_sip_addr(&self) -> SocketAddr {
        self.handle.local_sip_addr()
    }

    #[cfg(test)]
    #[must_use]
    pub const fn local_rtp_addr(&self) -> SocketAddr {
        self.handle.local_rtp_addr()
    }

    #[must_use]
    pub fn state(&self) -> SipCallState {
        self.handle.state()
    }

    #[cfg(test)]
    #[must_use]
    pub fn subscribe_state(&self) -> watch::Receiver<SipCallState> {
        self.handle.subscribe_state()
    }

    #[cfg(test)]
    #[must_use]
    pub fn discarded_early_rtp_packets(&self) -> u64 {
        self.handle.discarded_early_rtp_packets()
    }

    #[cfg(test)]
    #[must_use]
    pub fn sent_rtp_packets(&self) -> u64 {
        self.handle.sent_rtp_packets()
    }

    pub fn take_event_receiver(&mut self) -> Option<mpsc::Receiver<SipCallEvent>> {
        self.event_rx.take()
    }

    pub async fn next_event(&mut self) -> Option<SipCallEvent> {
        let rx = self.event_rx.as_mut()?;
        rx.recv().await
    }

    pub fn take_inbound_audio_receiver(&mut self) -> Option<mpsc::Receiver<InboundRtpAudioFrame>> {
        self.inbound_audio_rx.take()
    }

    #[cfg(test)]
    pub async fn next_inbound_audio(&mut self) -> Option<InboundRtpAudioFrame> {
        let rx = self.inbound_audio_rx.as_mut()?;
        rx.recv().await
    }

    #[cfg(test)]
    pub fn enqueue_pcmu_frames(&self, frames: Vec<[u8; PCMU_FRAME_BYTES]>) {
        self.handle.enqueue_pcmu_frames(frames);
    }

    #[cfg(test)]
    pub fn clear_outbound_audio(&self) -> OutboundPlaybackSnapshot {
        self.handle.clear_outbound_audio()
    }

    #[cfg(test)]
    #[must_use]
    pub fn outbound_playback_state(&self) -> OutboundPlaybackSnapshot {
        self.handle.outbound_playback_state()
    }

    #[cfg(test)]
    pub fn enqueue_rfc4733_dtmf(&self, payload_type: u8, packets: Vec<[u8; 4]>) {
        self.handle.enqueue_rfc4733_dtmf(payload_type, packets);
    }

    #[cfg(test)]
    pub async fn wait_for_connected(&self) -> Result<Option<u8>, SipError> {
        self.handle.wait_for_connected().await
    }

    pub async fn hangup(&self) -> Result<(), SipError> {
        self.handle.hangup().await
    }
}

// ============================================================================
// SIP UAC Signaling State Machine
// ============================================================================

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::too_many_struct_fields,
        reason = "existing protocol, configuration, or runtime state struct predates perfectionist field cap"
    )
)]
struct SignalingLoopContext {
    config: SipDialConfig,
    domain: String,
    request_uri: String,
    local_sip_addr: SocketAddr,
    call_id: String,
    from_tag: String,
    sdp_offer: String,
    initial_invite_bytes: Vec<u8>,
    active_cseq: u32,
    active_branch: String,
    rtp_socket: Arc<UdpSocket>,
    media_state: Arc<Mutex<OutboundMediaState>>,
    cmd_rx: mpsc::Receiver<SignalingCommand>,
    event_tx: mpsc::Sender<SipCallEvent>,
    inbound_audio_tx: mpsc::Sender<InboundRtpAudioFrame>,
    state_tx: watch::Sender<SipCallState>,
    discarded_early_rtp: Arc<AtomicU64>,
    sent_rtp_packets: Arc<AtomicU64>,
    cancel: CancellationToken,
}

#[derive(Debug, Clone)]
struct ConnectedDialog {
    remote_target_uri: String,
    remote_to_header: String,
    route_set: Vec<String>,
    ack_200_bytes: Vec<u8>,
}

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::excessive_cognitive_complexity,
        perfectionist::excessive_nesting,
        perfectionist::overly_long_function,
        perfectionist::too_many_local_bindings,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
async fn run_signaling_loop(mut transport: SipTransport, mut ctx: SignalingLoopContext) {
    let dial_started = Instant::now();
    let ring_deadline = dial_started + ctx.config.ring_timeout;
    let mut invite_resp_deadline = dial_started + ctx.config.invite_response_timeout;

    let is_udp = ctx.config.transport == SipTransportKind::Udp;
    let mut udp_retransmit_delay = SIP_UDP_T1_RETRANSMIT;
    let mut next_udp_retransmit = dial_started + udp_retransmit_delay;
    let mut current_invite_bytes = ctx.initial_invite_bytes.clone();
    let mut got_response_for_current_invite = false;
    let mut emitted_ringing = false;
    let mut auth_attempts: usize = 0;

    let mut dialog: Option<ConnectedDialog> = None;
    let mut last_remote_offer: Option<(u32, String, Vec<u8>)> = None;
    let mut awaiting_ack_answer: Option<u32> = None;
    let rtp_cancel = CancellationToken::new();
    let mut rtp_tasks: Option<(JoinHandle<()>, JoinHandle<()>)> = None;

    let keepalive_period = if ctx.config.keepalive_interval.is_zero() {
        SIP_KEEPALIVE_INTERVAL
    } else {
        ctx.config.keepalive_interval
    };
    let mut keepalive_interval =
        tokio::time::interval_at(Instant::now() + keepalive_period, keepalive_period);
    keepalive_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);

    let mut early_rtp_scratch = vec![0_u8; 2048];

    let (end_reason, end_failure): (String, Option<SipCallFailure>) = loop {
        let is_connected = dialog.is_some();
        let enable_udp_retransmit = is_udp && !is_connected && !got_response_for_current_invite;
        let enable_invite_resp_timeout = !is_connected && !got_response_for_current_invite;

        tokio::select! {
            biased;
            () = ctx.cancel.cancelled() => {
                break ("cancelled".to_owned(), None);
            }
            cmd_opt = ctx.cmd_rx.recv() => {
                let Some(SignalingCommand::Hangup(reply_tx)) = cmd_opt else {
                    break ("closed".to_owned(), None);
                };
                let res = perform_local_hangup(
                    &mut transport,
                    &mut ctx,
                    dialog.as_ref(),
                    &rtp_cancel,
                ).await;
                let _ = reply_tx.send(res);
                break ("local_hangup".to_owned(), None);
            }
            early_res = ctx.rtp_socket.recv_from(&mut early_rtp_scratch), if !is_connected => {
                if early_res.is_ok() {
                    ctx.discarded_early_rtp.fetch_add(1, Ordering::Relaxed);
                }
            }
            () = tokio::time::sleep_until(next_udp_retransmit), if enable_udp_retransmit => {
                let _ = transport.send(&current_invite_bytes).await;
                udp_retransmit_delay = (udp_retransmit_delay.saturating_mul(2)).min(SIP_UDP_MAX_RETRANSMIT);
                next_udp_retransmit = Instant::now() + udp_retransmit_delay;
            }
            () = tokio::time::sleep_until(invite_resp_deadline), if enable_invite_resp_timeout => {
                let msg = "invite_timeout: no SIP response from server".to_owned();
                break (msg.clone(), Some(SipCallFailure::Timeout(msg)));
            }
            () = tokio::time::sleep_until(ring_deadline), if !is_connected => {
                let _ = send_cancel(&mut transport, &ctx).await;
                let msg = "ring_timeout".to_owned();
                break (msg.clone(), Some(SipCallFailure::Timeout(msg)));
            }
            _ = keepalive_interval.tick() => {
                let _ = transport.send(b"\r\n\r\n").await;
            }
            msg_res = transport.recv_message() => {
                let msg = match msg_res {
                    Ok(m) => m,
                    Err(err) => {
                        let text = format!("transport_error: {err}");
                        break (text.clone(), Some(SipCallFailure::Transport(text)));
                    }
                };

                match &msg.start_line {
                    SipStartLine::Response { status_code, reason } => {
                        let code = *status_code;
                        let reason_text = reason.clone();
                        let Some((resp_cseq, resp_method)) = msg.cseq() else {
                            continue;
                        };
                        if !resp_method.eq_ignore_ascii_case("INVITE") || resp_cseq != ctx.active_cseq {
                            continue;
                        }
                        got_response_for_current_invite = true;

                        if (100..200).contains(&code) {
                            if (code == 180 || code == 183) && !emitted_ringing && dialog.is_none() {
                                emitted_ringing = true;
                                let _ = ctx.state_tx.send(SipCallState::Ringing);
                                let _ = ctx.event_tx.send(SipCallEvent::Ringing).await;
                            }
                        } else if (200..300).contains(&code) {
                            if let Some(existing_dialog) = &dialog {
                                // Duplicate 200 OK over UDP -> re-send ACK without restarting RTP.
                                let _ = transport.send(&existing_dialog.ack_200_bytes).await;
                                continue;
                            }

                            match handle_invite_200_ok(&mut transport, &ctx, &msg, &mut early_rtp_scratch, &rtp_cancel).await {
                                Ok((established_dialog, negotiated_dtmf_pt, tasks)) => {
                                    dialog = Some(established_dialog);
                                    rtp_tasks = Some(tasks);
                                    let _ = ctx.state_tx.send(SipCallState::Connected { negotiated_dtmf_pt });
                                    let _ = ctx.event_tx.send(SipCallEvent::Connected { negotiated_dtmf_pt }).await;
                                    let held = lock_unpoisoned(&ctx.media_state)
                                        .remote_media.as_ref().is_some_and(SdpAnswer::on_hold);
                                    if held {
                                        let _ = ctx.event_tx.send(SipCallEvent::HoldChanged {
                                            on_hold: true, negotiated_dtmf_pt,
                                        }).await;
                                    }
                                }
                                Err(err) => {
                                    let text = format!("sdp_error: {err}");
                                    break (text.clone(), Some(SipCallFailure::Protocol(text)));
                                }
                            }
                        } else if code == 401 || code == 407 {
                            let to_hdr = msg
                                .first_header("To")
                                .map(ToOwned::to_owned)
                                .unwrap_or_else(|| format!("<{}>", ctx.request_uri));
                            let ack = build_non_2xx_ack(&ctx, &to_hdr);
                            let _ = transport.send(ack.as_bytes()).await;

                            if ctx.config.username.is_empty() || auth_attempts >= MAX_AUTH_ATTEMPTS {
                                break (
                                    format!("auth_failed: {code} {reason_text}"),
                                    Some(SipCallFailure::AuthFailed {
                                        status_code: code,
                                        reason: reason_text,
                                    }),
                                );
                            }

                            let challenge_header_name = if code == 401 {
                                "WWW-Authenticate"
                            } else {
                                "Proxy-Authenticate"
                            };
                            let auth_header_name = if code == 401 {
                                "Authorization"
                            } else {
                                "Proxy-Authorization"
                            };

                            let challenges = msg.headers_named(challenge_header_name);
                            let Some(parsed_challenge) = select_supported_challenge(&challenges) else {
                                break (
                                    format!("auth_failed: {code} missing supported Digest challenge"),
                                    Some(SipCallFailure::AuthFailed {
                                        status_code: code,
                                        reason: "missing supported Digest challenge".to_owned(),
                                    }),
                                );
                            };
                            if auth_attempts > 0 && !parsed_challenge.stale {
                                break (
                                    format!("auth_failed: {code} {reason_text}"),
                                    Some(SipCallFailure::AuthFailed {
                                        status_code: code,
                                        reason: reason_text,
                                    }),
                                );
                            }

                            auth_attempts += 1;
                            ctx.active_cseq = ctx.active_cseq.saturating_add(1);
                            ctx.active_branch = format!("z9hG4bK{}", random_hex_token(12));
                            let cnonce = random_hex_token(8);
                            let creds = DigestCredentials {
                                username: ctx.config.username.trim(),
                                password: &ctx.config.password,
                                method: "INVITE",
                                digest_uri: &ctx.request_uri,
                                entity_body: ctx.sdp_offer.as_bytes(),
                                cnonce: &cnonce,
                                nonce_count: 1,
                            };
                            let auth_val = match build_digest_authorization_header(&parsed_challenge, &creds) {
                                Ok(v) => v,
                                Err(err) => {
                                    let text = format!("auth_failed: {err}");
                                    break (
                                        text,
                                        Some(SipCallFailure::AuthFailed {
                                            status_code: code,
                                            reason: err.to_string(),
                                        }),
                                    );
                                }
                            };

                            let auth_headers = vec![(auth_header_name.to_owned(), auth_val)];
                            let authed_invite = build_invite_request(&InviteParams {
                                config: &ctx.config,
                                domain: &ctx.domain,
                                request_uri: &ctx.request_uri,
                                local_sip_addr: ctx.local_sip_addr,
                                branch: &ctx.active_branch,
                                from_tag: &ctx.from_tag,
                                call_id: &ctx.call_id,
                                cseq: ctx.active_cseq,
                                auth_headers: &auth_headers,
                                sdp_offer: &ctx.sdp_offer,
                            });
                            if let Err(err) = transport.send(authed_invite.as_bytes()).await {
                                let text = format!("transport_error: {err}");
                                break (text.clone(), Some(SipCallFailure::Transport(text)));
                            }
                            current_invite_bytes = authed_invite.into_bytes();
                            got_response_for_current_invite = false;
                            udp_retransmit_delay = SIP_UDP_T1_RETRANSMIT;
                            let now = Instant::now();
                            next_udp_retransmit = now + udp_retransmit_delay;
                            invite_resp_deadline = now + ctx.config.invite_response_timeout;
                        } else if code >= 300 {
                            let to_hdr = msg
                                .first_header("To")
                                .map(ToOwned::to_owned)
                                .unwrap_or_else(|| format!("<{}>", ctx.request_uri));
                            let ack = build_non_2xx_ack(&ctx, &to_hdr);
                            let _ = transport.send(ack.as_bytes()).await;
                            break (
                                format!("rejected: {code} {reason_text}"),
                                Some(SipCallFailure::Rejected {
                                    status_code: code,
                                    reason: reason_text,
                                }),
                            );
                        }
                    }
                    SipStartLine::Request { method, .. } => {
                        if method.eq_ignore_ascii_case("INVITE") || method.eq_ignore_ascii_case("UPDATE") {
                            let Some(dlg) = &mut dialog else { continue; };
                            let (code, reason) = if msg.first_header("Call-ID") != Some(ctx.call_id.as_str())
                                || header_tag(msg.first_header("To").unwrap_or("")) != Some(ctx.from_tag.as_str())
                                || header_tag(msg.first_header("From").unwrap_or("")) != header_tag(&dlg.remote_to_header)
                            { (481, "Call/Transaction Does Not Exist") } else { (200, "OK") };
                            if code != 200 {
                                let response = build_response_for_request(&ctx, &msg, code, reason, None);
                                if let Err(error) = transport.send(response.as_bytes()).await {
                                    eprintln!("SIP dialog rejection response failed: {error}");
                                }
                                continue;
                            }
                            let Some((cseq, _)) = msg.cseq() else { continue; };
                            if let Some((previous, previous_method, response)) = &last_remote_offer {
                                if cseq == *previous && method == previous_method {
                                    if let Err(error) = transport.send(response).await {
                                        eprintln!("SIP offer retransmission response failed: {error}");
                                    }
                                    continue;
                                }
                                if cseq <= *previous {
                                    let response = build_response_for_request(&ctx, &msg, 500, "CSeq Out of Order", None);
                                    if let Err(error) = transport.send(response.as_bytes()).await {
                                        eprintln!("SIP CSeq rejection response failed: {error}");
                                    }
                                    continue;
                                }
                            }
                            let local_rtp = match ctx.rtp_socket.local_addr() {
                                Ok(addr) => addr,
                                Err(error) => break (error.to_string(), Some(SipCallFailure::Transport(error.to_string()))),
                            };
                            // An offerless UPDATE is a session refresh. An offerless re-INVITE
                            // requires an offer in the 2xx and carries the answer in the ACK
                            // (RFC 3261 section 14.2).
                            if msg.body.is_empty() {
                                let offer = method.eq_ignore_ascii_case("INVITE").then(|| {
                                    build_sdp_offer(ctx.local_sip_addr.ip(), local_rtp.port(), u64::from(cseq))
                                });
                                let response = build_response_for_request(&ctx, &msg, 200, "OK", offer.as_deref());
                                if let Err(error) = transport.send(response.as_bytes()).await {
                                    eprintln!("SIP offerless request response failed: {error}");
                                }
                                if offer.is_some() {
                                    awaiting_ack_answer = Some(cseq);
                                    if let Some(target) = msg.first_header("Contact").and_then(extract_sip_uri) {
                                        dlg.remote_target_uri = target;
                                    }
                                }
                                last_remote_offer = Some((cseq, method.clone(), response.into_bytes()));
                                continue;
                            }
                            let offer = std::str::from_utf8(&msg.body).ok()
                                .map(parse_sdp_answer).and_then(Result::ok);
                            let Some(offer) = offer else {
                                let response = build_response_for_request(&ctx, &msg, 488, "Not Acceptable Here", None);
                                if let Err(error) = transport.send(response.as_bytes()).await {
                                    eprintln!("SIP unsupported SDP response failed: {error}");
                                }
                                continue;
                            };
                            let mut answer = build_sdp_offer(ctx.local_sip_addr.ip(), local_rtp.port(), u64::from(cseq));
                            answer = answer.replace("a=sendrecv", &format!("a={}", offer.direction.answer()));
                            answer = match offer.negotiated_dtmf_pt {
                                Some(pt) => answer
                                    .replace("RTP/AVP 0 101", &format!("RTP/AVP 0 {pt}"))
                                    .replace("a=rtpmap:101 ", &format!("a=rtpmap:{pt} "))
                                    .replace("a=fmtp:101 ", &format!("a=fmtp:{pt} ")),
                                None => answer
                                    .replace("RTP/AVP 0 101", "RTP/AVP 0")
                                    .replace("a=rtpmap:101 telephone-event/8000\r\n", "")
                                    .replace("a=fmtp:101 0-15\r\n", ""),
                            };
                            let response = build_response_for_request(&ctx, &msg, 200, "OK", Some(&answer));
                            if let Err(error) = transport.send(response.as_bytes()).await {
                                break (error.to_string(), Some(SipCallFailure::Transport(error.to_string())));
                            }
                            awaiting_ack_answer = None;
                            let hold_changed = apply_remote_media(&ctx.media_state, offer);
                            if let Some(target) = msg.first_header("Contact").and_then(extract_sip_uri) {
                                dlg.remote_target_uri = target;
                            }
                            last_remote_offer = Some((cseq, method.clone(), response.into_bytes()));
                            let _ = ctx.event_tx.send(hold_changed).await;
                        } else if method.eq_ignore_ascii_case("ACK") {
                            let acks_offer = awaiting_ack_answer.is_some()
                                && msg.first_header("Call-ID") == Some(ctx.call_id.as_str())
                                && msg.cseq().map(|(cseq, _)| cseq) == awaiting_ack_answer;
                            if !acks_offer {
                                continue;
                            }
                            awaiting_ack_answer = None;
                            // Without an acceptable answer the previously negotiated media stays active.
                            let answer = std::str::from_utf8(&msg.body).ok()
                                .map(parse_sdp_answer).and_then(Result::ok);
                            match answer {
                                Some(answer) => {
                                    let hold_changed = apply_remote_media(&ctx.media_state, answer);
                                    let _ = ctx.event_tx.send(hold_changed).await;
                                }
                                None => eprintln!("SIP ACK did not carry an acceptable SDP answer; keeping current media"),
                            }
                        } else if method.eq_ignore_ascii_case("BYE") {
                            let ok_resp = build_200_ok_for_request(&ctx, &msg);
                            let _ = transport.send(ok_resp.as_bytes()).await;
                            break ("remote_bye".to_owned(), None);
                        } else if method.eq_ignore_ascii_case("OPTIONS") {
                            let ok_resp = build_200_ok_for_request(&ctx, &msg);
                            let _ = transport.send(ok_resp.as_bytes()).await;
                        }
                    }
                }
            }
        }
    };

    rtp_cancel.cancel();
    if let Some((sender_handle, receiver_handle)) = rtp_tasks {
        let _ = sender_handle.await;
        let _ = receiver_handle.await;
    }

    let _ = ctx.state_tx.send(SipCallState::Ended {
        reason: end_reason.clone(),
        failure: end_failure,
    });
    let _ = ctx
        .event_tx
        .send(SipCallEvent::Ended { reason: end_reason })
        .await;
}

async fn handle_invite_200_ok(
    transport: &mut SipTransport,
    ctx: &SignalingLoopContext,
    msg: &SipMessage,
    early_rtp_scratch: &mut [u8],
    rtp_cancel: &CancellationToken,
) -> Result<
    (
        ConnectedDialog,
        Option<u8>,
        (JoinHandle<()>, JoinHandle<()>),
    ),
    SipError,
> {
    let sdp_str = std::str::from_utf8(&msg.body)
        .map_err(|_| SipError::Protocol("200 OK SDP body is not valid UTF-8".to_owned()))?;
    let sdp_answer = parse_sdp_answer(sdp_str)?;
    let remote_rtp_addr = SocketAddr::new(sdp_answer.remote_media_ip, sdp_answer.remote_audio_port);

    let remote_target_uri = msg
        .first_header("Contact")
        .and_then(extract_sip_uri)
        .unwrap_or_else(|| ctx.request_uri.clone());

    let remote_to_header = msg
        .first_header("To")
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("<{}>", ctx.request_uri));

    let route_set = extract_reversed_record_routes(msg);
    let ack_branch = format!("z9hG4bK{}", random_hex_token(12));
    let ack_text = build_2xx_ack(
        ctx,
        &remote_target_uri,
        &ack_branch,
        &remote_to_header,
        &route_set,
    );
    let ack_200_bytes = ack_text.into_bytes();
    transport.send(&ack_200_bytes).await?;

    // Flush any early-media RTP packets buffered in the OS kernel socket before `200 OK`.
    while ctx.rtp_socket.try_recv_from(early_rtp_scratch).is_ok() {
        ctx.discarded_early_rtp.fetch_add(1, Ordering::Relaxed);
    }

    let _ = apply_remote_media(&ctx.media_state, sdp_answer.clone());
    let tasks = spawn_rtp_media_tasks(
        Arc::clone(&ctx.rtp_socket),
        remote_rtp_addr,
        sdp_answer.negotiated_dtmf_pt,
        Arc::clone(&ctx.media_state),
        ctx.inbound_audio_tx.clone(),
        Arc::clone(&ctx.sent_rtp_packets),
        rtp_cancel.clone(),
    );

    Ok((
        ConnectedDialog {
            remote_target_uri,
            remote_to_header,
            route_set,
            ack_200_bytes,
        },
        sdp_answer.negotiated_dtmf_pt,
        tasks,
    ))
}

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::excessive_cognitive_complexity,
        perfectionist::excessive_nesting,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
async fn perform_local_hangup(
    transport: &mut SipTransport,
    ctx: &mut SignalingLoopContext,
    dialog: Option<&ConnectedDialog>,
    rtp_cancel: &CancellationToken,
) -> Result<(), SipError> {
    rtp_cancel.cancel();
    if let Some(dlg) = dialog {
        ctx.active_cseq = ctx.active_cseq.saturating_add(1);
        let bye_branch = format!("z9hG4bK{}", random_hex_token(12));
        let bye_msg = build_bye_request(
            ctx,
            &dlg.remote_target_uri,
            &bye_branch,
            &dlg.remote_to_header,
            &dlg.route_set,
            ctx.active_cseq,
        );
        transport.send(bye_msg.as_bytes()).await?;

        let deadline = Instant::now() + SIP_TEARDOWN_DRAIN_TIMEOUT;
        while let Ok(Ok(msg)) = tokio::time::timeout_at(deadline, transport.recv_message()).await {
            if let SipStartLine::Response { status_code, .. } = msg.start_line {
                if (200..300).contains(&status_code)
                    && msg
                        .cseq()
                        .is_some_and(|(_, m)| m.eq_ignore_ascii_case("BYE"))
                {
                    break;
                }
            }
        }
        Ok(())
    } else {
        send_cancel(transport, ctx).await?;
        let deadline = Instant::now() + SIP_TEARDOWN_DRAIN_TIMEOUT;
        while let Ok(Ok(msg)) = tokio::time::timeout_at(deadline, transport.recv_message()).await {
            if let SipStartLine::Response { status_code, .. } = msg.start_line {
                if status_code >= 300
                    && msg
                        .cseq()
                        .is_some_and(|(_, m)| m.eq_ignore_ascii_case("INVITE"))
                {
                    let to_hdr = msg
                        .first_header("To")
                        .map(ToOwned::to_owned)
                        .unwrap_or_else(|| format!("<{}>", ctx.request_uri));
                    let ack = build_non_2xx_ack(ctx, &to_hdr);
                    let _ = transport.send(ack.as_bytes()).await;
                    break;
                }
            }
        }
        Ok(())
    }
}

async fn send_cancel(
    transport: &mut SipTransport,
    ctx: &SignalingLoopContext,
) -> Result<(), SipError> {
    let cancel_msg = format!(
        "CANCEL {} SIP/2.0\r\n\
         Via: {} {};rport;branch={}\r\n\
         Max-Forwards: 70\r\n\
         From: {}\r\n\
         To: <{}>\r\n\
         Call-ID: {}\r\n\
         CSeq: {} CANCEL\r\n\
         Content-Length: 0\r\n\r\n",
        ctx.request_uri,
        ctx.config.transport.via_protocol(),
        ctx.local_sip_addr,
        ctx.active_branch,
        format_from_header(&ctx.config, &ctx.domain, &ctx.from_tag),
        ctx.request_uri,
        ctx.call_id,
        ctx.active_cseq,
    );
    transport.send(cancel_msg.as_bytes()).await
}

struct InviteParams<'a> {
    config: &'a SipDialConfig,
    domain: &'a str,
    request_uri: &'a str,
    local_sip_addr: SocketAddr,
    branch: &'a str,
    from_tag: &'a str,
    call_id: &'a str,
    cseq: u32,
    auth_headers: &'a [(String, String)],
    sdp_offer: &'a str,
}

fn build_invite_request(params: &InviteParams<'_>) -> String {
    let mut msg = format!(
        "INVITE {} SIP/2.0\r\n\
         Via: {} {};rport;branch={}\r\n\
         Max-Forwards: 70\r\n\
         From: {}\r\n\
         To: <{}>\r\n\
         Call-ID: {}\r\n\
         CSeq: {} INVITE\r\n\
         Contact: <sip:{}@{}{}>\r\n\
         User-Agent: DapperCode-Bridge/0.1\r\n\
         Allow: INVITE, ACK, CANCEL, BYE, OPTIONS\r\n",
        params.request_uri,
        params.config.transport.via_protocol(),
        params.local_sip_addr,
        params.branch,
        format_from_header(params.config, params.domain, params.from_tag),
        params.request_uri,
        params.call_id,
        params.cseq,
        params.config.caller_id.trim(),
        params.local_sip_addr,
        params.config.transport.contact_transport_param(),
    );
    for (hdr_name, hdr_val) in params.auth_headers {
        msg.push_str(&format!("{hdr_name}: {hdr_val}\r\n"));
    }
    msg.push_str(&format!(
        "Content-Type: application/sdp\r\n\
         Content-Length: {}\r\n\r\n{}",
        params.sdp_offer.len(),
        params.sdp_offer,
    ));
    msg
}

fn build_non_2xx_ack(ctx: &SignalingLoopContext, remote_to_header: &str) -> String {
    format!(
        "ACK {} SIP/2.0\r\n\
         Via: {} {};rport;branch={}\r\n\
         Max-Forwards: 70\r\n\
         From: {}\r\n\
         To: {remote_to_header}\r\n\
         Call-ID: {}\r\n\
         CSeq: {} ACK\r\n\
         Content-Length: 0\r\n\r\n",
        ctx.request_uri,
        ctx.config.transport.via_protocol(),
        ctx.local_sip_addr,
        ctx.active_branch,
        format_from_header(&ctx.config, &ctx.domain, &ctx.from_tag),
        ctx.call_id,
        ctx.active_cseq,
    )
}

fn build_2xx_ack(
    ctx: &SignalingLoopContext,
    remote_target_uri: &str,
    branch: &str,
    remote_to_header: &str,
    route_set: &[String],
) -> String {
    let mut msg = format!(
        "ACK {remote_target_uri} SIP/2.0\r\n\
         Via: {} {};rport;branch={branch}\r\n\
         Max-Forwards: 70\r\n",
        ctx.config.transport.via_protocol(),
        ctx.local_sip_addr,
    );
    for route in route_set {
        msg.push_str(&format!("Route: {route}\r\n"));
    }
    msg.push_str(&format!(
        "From: {}\r\n\
         To: {remote_to_header}\r\n\
         Call-ID: {}\r\n\
         CSeq: {} ACK\r\n\
         Contact: <sip:{}@{}{}>\r\n\
         Content-Length: 0\r\n\r\n",
        format_from_header(&ctx.config, &ctx.domain, &ctx.from_tag),
        ctx.call_id,
        ctx.active_cseq,
        ctx.config.caller_id.trim(),
        ctx.local_sip_addr,
        ctx.config.transport.contact_transport_param(),
    ));
    msg
}

fn build_bye_request(
    ctx: &SignalingLoopContext,
    remote_target_uri: &str,
    branch: &str,
    remote_to_header: &str,
    route_set: &[String],
    cseq: u32,
) -> String {
    let mut msg = format!(
        "BYE {remote_target_uri} SIP/2.0\r\n\
         Via: {} {};rport;branch={branch}\r\n\
         Max-Forwards: 70\r\n",
        ctx.config.transport.via_protocol(),
        ctx.local_sip_addr,
    );
    for route in route_set {
        msg.push_str(&format!("Route: {route}\r\n"));
    }
    msg.push_str(&format!(
        "From: {}\r\n\
         To: {remote_to_header}\r\n\
         Call-ID: {}\r\n\
         CSeq: {cseq} BYE\r\n\
         Content-Length: 0\r\n\r\n",
        format_from_header(&ctx.config, &ctx.domain, &ctx.from_tag),
        ctx.call_id,
    ));
    msg
}

fn build_200_ok_for_request(ctx: &SignalingLoopContext, req: &SipMessage) -> String {
    build_response_for_request(ctx, req, 200, "OK", None)
}

fn header_tag(header: &str) -> Option<&str> {
    header
        .split(';')
        .map(str::trim)
        .find_map(|param| param.strip_prefix("tag="))
}

fn apply_remote_media(state: &Mutex<OutboundMediaState>, offer: SdpAnswer) -> SipCallEvent {
    let hold_changed = SipCallEvent::HoldChanged {
        on_hold: offer.on_hold(),
        negotiated_dtmf_pt: offer.negotiated_dtmf_pt,
    };
    let mut state = lock_unpoisoned(state);
    if offer.on_hold() {
        state.discarded_voice_frames = state
            .discarded_voice_frames
            .saturating_add(state.voice_queue.len());
        state.voice_queue.clear();
        state.dtmf_queue.clear();
        state.outbound_playing = false;
        state.was_playing_voice = false;
        state.current_outbound_pcmu = [PCMU_SILENCE_BYTE; PCMU_FRAME_BYTES];
    }
    state.remote_media = Some(offer);
    hold_changed
}

fn build_response_for_request(
    ctx: &SignalingLoopContext,
    req: &SipMessage,
    code: u16,
    reason: &str,
    body: Option<&str>,
) -> String {
    let mut resp = format!("SIP/2.0 {code} {reason}\r\n");
    for via in req.headers_named("Via") {
        resp.push_str(&format!("Via: {via}\r\n"));
    }
    if let Some(from_hdr) = req.first_header("From") {
        resp.push_str(&format!("From: {from_hdr}\r\n"));
    }
    if let Some(to_hdr) = req.first_header("To") {
        if has_tag_param(to_hdr) {
            resp.push_str(&format!("To: {to_hdr}\r\n"));
        } else {
            resp.push_str(&format!("To: {to_hdr};tag={}\r\n", ctx.from_tag));
        }
    }
    if let Some(call_id) = req.first_header("Call-ID") {
        resp.push_str(&format!("Call-ID: {call_id}\r\n"));
    }
    if let Some(cseq) = req.first_header("CSeq") {
        resp.push_str(&format!("CSeq: {cseq}\r\n"));
    }
    resp.push_str(&format!(
        "Contact: <sip:{}@{}{}>\r\n",
        ctx.config.caller_id.trim(),
        ctx.local_sip_addr,
        ctx.config.transport.contact_transport_param(),
    ));
    if let Some(sdp) = body {
        resp.push_str(&format!(
            "Content-Type: application/sdp\r\nContent-Length: {}\r\n\r\n{sdp}",
            sdp.len(),
        ));
    } else {
        resp.push_str("Content-Length: 0\r\n\r\n");
    }
    resp
}

fn format_from_header(config: &SipDialConfig, domain: &str, from_tag: &str) -> String {
    let caller = config.caller_id.trim();
    let display = config.display_name.trim();
    if display.is_empty() {
        format!("<sip:{caller}@{domain}>;tag={from_tag}")
    } else {
        format!(
            r#""{}" <sip:{caller}@{domain}>;tag={from_tag}"#,
            escape_quoted_string(display),
        )
    }
}

fn select_supported_challenge(raw_headers: &[&str]) -> Option<DigestChallenge> {
    let mut parsed_list: Vec<DigestChallenge> = raw_headers
        .iter()
        .copied()
        .map(parse_digest_challenge)
        .filter_map(Result::ok)
        .collect();
    if let Some(pos) = parsed_list.iter().position(|challenge| {
        matches!(
            challenge.algorithm,
            DigestAlgorithm::Sha256 | DigestAlgorithm::Sha256Sess,
        )
    }) {
        return Some(parsed_list.swap_remove(pos));
    }
    parsed_list.into_iter().next()
}

fn extract_sip_uri(header_value: &str) -> Option<String> {
    if let Some(lt_idx) = header_value.find('<') {
        let after_lt = header_value.get(lt_idx + 1..)?;
        let gt_idx = after_lt.find('>')?;
        let uri = after_lt.get(..gt_idx)?.trim();
        if !uri.is_empty() {
            return Some(uri.to_owned());
        }
    }
    let trimmed = header_value.trim();
    let uri = trimmed.split(';').next()?.trim();
    if uri.starts_with("sip:") || uri.starts_with("sips:") {
        Some(uri.to_owned())
    } else {
        None
    }
}

fn extract_reversed_record_routes(msg: &SipMessage) -> Vec<String> {
    let mut routes = Vec::new();
    for raw in msg.headers_named("Record-Route") {
        for item in split_comma_outside_angles(raw) {
            let trimmed = item.trim();
            if !trimmed.is_empty() {
                routes.push(trimmed.to_owned());
            }
        }
    }
    routes.reverse();
    routes
}

#[cfg_attr(
    dylint_lib = "perfectionist",
    expect(
        perfectionist::excessive_cognitive_complexity,
        reason = "existing bridge function predates perfectionist structural caps; keep ratcheted until split"
    )
)]
fn split_comma_outside_angles(value: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut in_angles = false;
    let mut in_quotes = false;
    let mut start = 0_usize;
    let bytes = value.as_bytes();
    let mut idx = 0_usize;
    while let Some(&b) = bytes.get(idx) {
        if b == b'\\' && in_quotes {
            idx = idx.saturating_add(2);
            continue;
        }
        if b == b'"' {
            in_quotes = !in_quotes;
        } else if !in_quotes && b == b'<' {
            in_angles = true;
        } else if !in_quotes && b == b'>' {
            in_angles = false;
        } else if !in_quotes && !in_angles && b == b',' {
            if let Some(part) = value.get(start..idx) {
                out.push(part);
            }
            start = idx + 1;
        }
        idx += 1;
    }
    if let Some(tail) = value.get(start..) {
        out.push(tail);
    }
    out
}

fn has_tag_param(header_val: &str) -> bool {
    let params_part = match header_val.rfind('>') {
        Some(gt_pos) => header_val.get(gt_pos + 1..).unwrap_or(""),
        None => header_val,
    };
    params_part.split(';').skip(1).any(|param| {
        param
            .trim_start()
            .get(..4)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("tag="))
    })
}

fn strip_ascii_prefix_ignore_case<'a>(input: &'a str, prefix: &str) -> Option<&'a str> {
    let head = input.get(..prefix.len())?;
    if head.eq_ignore_ascii_case(prefix) {
        input.get(prefix.len()..)
    } else {
        None
    }
}

fn escape_quoted_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if ch == '"' || ch == '\\' {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

fn contains_header_control_chars(value: &str) -> bool {
    value
        .bytes()
        .any(|byte| byte == b'\r' || byte == b'\n' || byte == 0)
}

fn random_hex_token(byte_len: usize) -> String {
    let mut buf = vec![0_u8; byte_len];
    let _ = fill_random(&mut buf);
    bytes_to_lower_hex(&buf)
}

fn random_u64() -> u64 {
    let mut buf = [0_u8; 8];
    let _ = fill_random(&mut buf);
    u64::from_be_bytes(buf) & 0x7FFF_FFFF_FFFF_FFFF
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "sip_tests.rs"]
mod tests;
