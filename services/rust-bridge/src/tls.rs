use std::sync::Arc;

pub(crate) fn webpki_client_config() -> Result<rustls::ClientConfig, rustls::Error> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    Ok(rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .with_root_certificates(roots)
    .with_no_client_auth())
}

pub(crate) fn http_client_builder() -> reqwest::ClientBuilder {
    // Reqwest 0.13 defaults to platform roots; retain the bridge's WebPKI-only trust.
    let tls = webpki_client_config().expect("ring supports the default TLS protocol versions");
    reqwest::Client::builder().tls_backend_preconfigured(tls)
}

pub(crate) fn http_client() -> reqwest::Client {
    http_client_builder()
        .build()
        .expect("failed to build WebPKI HTTP client")
}

pub(crate) fn preview_client_builder() -> reqwest::ClientBuilder {
    // Use platform trust for local development CAs, with certificate and hostname checks enabled.
    // Reqwest's platform verifier needs a process-default provider.
    if rustls::crypto::ring::default_provider()
        .install_default()
        .is_err()
    {
        rustls::crypto::CryptoProvider::get_default()
            .expect("a TLS provider was installed concurrently");
    }
    reqwest::Client::builder()
}
