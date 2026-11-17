use super::{proxy_http_client, worker_http_client};
use axum::{body::Body, routing::get, Json, Router};
use rustls::pki_types::{pem::PemObject, CertificateDer, PrivateKeyDer};
use std::{io::Read, sync::Arc, time::Duration};

// Disposable, self-signed localhost certificate/key; never installed in a system trust store.
const CERTIFICATE: &str = "-----BEGIN CERTIFICATE-----
MIIBlTCCATygAwIBAgIUaEZRZ/UAmyjDfJWbIdQlpwzXofQwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTExNTAzNDUxNFoYDzIxMjYxMDIy
MDM0NTE0WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAASLtslm4ffkEkooyYDplPdRBDzYW7Y9ISnziYTDymNkMOKa3bykamnY
qirS7O0uOkkbIWS5Vh+iC4Ql1T2YHo2vo2owaDAdBgNVHQ4EFgQUcbCA5ajCd/7A
kKG3PSZPi38yRGQwFAYDVR0RBA0wC4IJbG9jYWxob3N0MAwGA1UdEwEB/wQCMAAw
DgYDVR0PAQH/BAQDAgeAMBMGA1UdJQQMMAoGCCsGAQUFBwMBMAoGCCqGSM49BAMC
A0cAMEQCIF4VtQehguUP0c4Y2CinIoRnQvsmxmxvwvuJ9xCa+7tDAiAJzE8ZqVlq
nj7O3iG5Am0IwSW+3UzR2IEFbdmZXytMoQ==
-----END CERTIFICATE-----";
const PRIVATE_KEY: &str = "-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg0RO3snBwap00xzWM
BMWF01eilh3hC4ORmkNL7nkeB6GhRANCAASLtslm4ffkEkooyYDplPdRBDzYW7Y9
ISnziYTDymNkMOKa3bykamnYqirS7O0uOkkbIWS5Vh+iC4Ql1T2YHo2v
-----END PRIVATE KEY-----";

#[tokio::test]
async fn dependency_upgrade_clients_preserve_loopback_json_streaming_and_no_redirects() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route(
            "/status",
            get(|| async { Json(serde_json::json!({"status": "ok"})) }),
        )
        .route(
            "/redirect",
            get(|| async { (axum::http::StatusCode::FOUND, [("location", "/status")]) }),
        )
        .route(
            "/stream",
            get(|| async {
                Body::from_stream(futures_util::stream::iter([
                    Ok::<_, std::io::Error>("first"),
                    Ok("second"),
                ]))
            }),
        );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    for client in [worker_http_client().unwrap(), proxy_http_client().unwrap()] {
        let status: serde_json::Value = client
            .get(format!("http://{address}/status"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(status["status"], "ok");
        assert_eq!(
            client
                .get(format!("http://{address}/redirect"))
                .send()
                .await
                .unwrap()
                .status(),
            axum::http::StatusCode::FOUND
        );
        assert_eq!(
            client
                .get(format!("http://{address}/stream"))
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "firstsecond"
        );
    }
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
}

#[tokio::test]
async fn dependency_upgrade_clients_reject_self_signed_tls_with_webpki_unknown_issuer() {
    let clients = [worker_http_client().unwrap(), proxy_http_client().unwrap()];
    let tls = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![CertificateDer::from_pem_slice(CERTIFICATE.as_bytes()).unwrap()],
        PrivateKeyDer::from_pem_slice(PRIVATE_KEY.as_bytes()).unwrap(),
    )
    .unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        for _ in 0..2 {
            let (socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            socket
                .set_write_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let connection = rustls::ServerConnection::new(Arc::new(tls.clone())).unwrap();
            let mut stream = rustls::StreamOwned::new(connection, socket);
            let mut request = [0_u8; 1024];
            assert!(
                stream.read(&mut request).is_err(),
                "untrusted TLS must not deliver HTTP"
            );
        }
    });
    let mut errors = Vec::new();
    for client in clients {
        errors.push(
            client
                .get(format!("https://localhost:{}/", address.port()))
                .timeout(Duration::from_secs(3))
                .send()
                .await
                .unwrap_err(),
        );
    }
    server.join().unwrap();
    for error in errors {
        assert!(format!("{error:?}").contains("UnknownIssuer"), "{error:?}");
    }
}
