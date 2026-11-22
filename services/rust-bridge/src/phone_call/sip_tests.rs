use super::{
    apply_remote_media, build_digest_authorization_header, build_rtp_packet, build_sdp_offer,
    compute_digest_response, default_rustls_client_config, escape_quoted_string,
    extract_reversed_record_routes, extract_sip_uri, header_tag, lock_unpoisoned, md5_digest,
    md5_hex, mpsc, parse_digest_challenge, parse_digest_kv_pairs, parse_rtp_packet,
    parse_sdp_answer, parse_sdp_connection_ip, parse_sip_datagram, parse_sip_headers_section,
    parse_sip_start_line, random_hex_token, sha256_hex, split_comma_outside_angles,
    try_extract_stream_sip_message, watch, Arc, AsyncReadExt, AtomicU64, CancellationToken,
    DigestAlgorithm, DigestChallenge, DigestCredentials, Duration, IpAddr, Ipv4Addr, Ipv6Addr,
    Mutex, OrderedInboundPayload, OutboundMediaState, QueuedDtmfStep, RtpReorderBuffer,
    SessionLifeline, SignalingCommand, SipCallEvent, SipCallHandle, SipCallSession, SipCallState,
    SipDialConfig, SipError, SipMessage, SipStartLine, SipTransport, SipTransportKind, SocketAddr,
    UdpSocket, COMFORT_NOISE_PAYLOAD_TYPE, DEFAULT_TELEPHONE_EVENT_PT, MAX_SIP_BODY_BYTES,
    MAX_SIP_HEADER_BYTES, PCMU_FRAME_BYTES, PCMU_PAYLOAD_TYPE, PCMU_SILENCE_BYTE,
    RTP_TIMESTAMP_STEP,
};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use rustls_pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::time::timeout;
use tokio_rustls::TlsAcceptor;

const TEST_TIMEOUT: Duration = Duration::from_secs(5);

#[test]
fn sdp_hold_direction_and_legacy_zero_address_are_negotiated_per_audio_stream() {
    let sdp = "v=0\r\nc=IN IP4 127.0.0.1\r\na=sendonly\r\nm=audio 4000 RTP/AVP 0\r\n";
    assert!(parse_sdp_answer(sdp).unwrap().on_hold());
    let resumed =
        format!("{sdp}a=sendrecv\r\nm=video 5000 RTP/AVP 96\r\nc=IN IP4 0.0.0.0\r\na=inactive\r\n");
    let answer = parse_sdp_answer(&resumed).unwrap();
    assert!(!answer.on_hold(), "video hold must not affect audio");
    assert_eq!(answer.remote_media_ip, IpAddr::V4(Ipv4Addr::LOCALHOST));
    for direction in ["sendonly", "recvonly", "inactive"] {
        let held = resumed.replace("a=sendrecv", &format!("a={direction}"));
        assert!(parse_sdp_answer(&held).unwrap().on_hold());
    }
    let legacy = resumed.replacen("c=IN IP4 127.0.0.1", "c=IN IP4 0.0.0.0", 1);
    assert!(parse_sdp_answer(&legacy).unwrap().on_hold());
    assert!(parse_sdp_answer(&sdp.replace("RTP/AVP 0", "RTP/AVP 8")).is_err());
}

const TEST_LOCALHOST_PKCS8_B64: &str = concat!(
    "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgjbDgrvcbfh61sPBy",
    "KOlEFBgX1e8MNjp5uR+1s1Qe9OChRANCAAT7U/SOyUB5dj8Ca+cyLfuYura8QwSH",
    "GUvb0k7/GVlfRBO04uRZ+yRKrSRk4xcSI2DejpPldxs6yyXvStqNmQ6P",
);

const TEST_LOCALHOST_CERT_B64: &str = concat!(
    "MIIBhDCCASqgAwIBAgIUIFW1RzjvDPV9lWrrd5Vbni1Sk1YwCgYIKoZIzj0EAwIw",
    "FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTExMzA1MTcyOFoYDzIxMjYxMDIw",
    "MDUxNzI4WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO",
    "PQMBBwNCAAT7U/SOyUB5dj8Ca+cyLfuYura8QwSHGUvb0k7/GVlfRBO04uRZ+yRK",
    "rSRk4xcSI2DejpPldxs6yyXvStqNmQ6Po1gwVjAdBgNVHQ4EFgQU9BktV0vhNBrC",
    "qt/ldfH2346H2xwwDAYDVR0TAQH/BAIwADALBgNVHQ8EBAMCB4AwGgYDVR0RBBMw",
    "EYIJbG9jYWxob3N0hwR/AAABMAoGCCqGSM49BAMCA0gAMEUCIQCUgYTh77a+0pEZ",
    "8mnWNiYqR0h6CYsUdGL1Ie6rCiX0NQIgPPHBaRQmCjA+kqa+IkSb6eXswq7wM/Ri",
    "MnrbbINy7ww=",
);

#[tokio::test]
async fn http_tls_verifies_preview_certificates_and_preserves_webpki() {
    let mut params =
        rcgen::CertificateParams::new(vec!["localhost".to_string(), "127.0.0.1".to_string()])
            .expect("localhost certificate parameters");
    params.not_before = std::time::SystemTime::now().into();
    params.not_after = params.not_before + Duration::from_secs(86_400);
    params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
    let key_pair = rcgen::KeyPair::generate().expect("generate test key");
    let cert = params
        .self_signed(&key_pair)
        .expect("sign localhost certificate");
    let cert = cert.der().clone();
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_pair.serialize_der()));
    let trusted_certificate = reqwest::Certificate::from_der(&cert).expect("preview trust anchor");
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .expect("server TLS versions")
    .with_no_client_auth()
    .with_single_cert(vec![cert], key)
    .expect("server certificate");
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind TLS listener");
    let address = listener.local_addr().expect("TLS address");
    let server = tokio::spawn(async move {
        let acceptor = TlsAcceptor::from(Arc::new(config));
        let mut handshakes = Vec::new();
        for _ in 0..4 {
            let (stream, _) = listener.accept().await.expect("accept TLS client");
            match acceptor.accept(stream).await {
                Ok(mut stream) => {
                    handshakes.push(true);
                    let mut request = [0_u8; 1024];
                    assert!(stream.read(&mut request).await.expect("read request") > 0);
                    stream
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                        )
                        .await
                        .expect("write response");
                }
                Err(_) => handshakes.push(false),
            }
        }
        handshakes
    });
    let url = format!("https://{address}/");
    let client = crate::tls::http_client_builder()
        .no_proxy()
        .build()
        .expect("build HTTP client");
    let result = timeout(TEST_TIMEOUT, client.get(&url).send())
        .await
        .expect("TLS request finishes");
    assert!(result.is_err(), "untrusted certificate must be rejected");
    let preview = crate::preview::BrowserPreviewService::new(0, 0, None, None).http;
    let result = timeout(TEST_TIMEOUT, preview.get(&url).send())
        .await
        .expect("untrusted preview request finishes");
    assert!(
        result.is_err(),
        "preview must reject untrusted certificates",
    );

    let trusted_preview = crate::tls::preview_client_builder()
        .tls_certs_merge([trusted_certificate])
        .resolve("wrong-host.test", address)
        .no_proxy()
        .build()
        .expect("build trusted preview client");
    let result = timeout(
        TEST_TIMEOUT,
        trusted_preview
            .get(format!("https://wrong-host.test:{}/", address.port()))
            .send(),
    )
    .await
    .expect("wrong-host preview request finishes");
    assert!(
        result.is_err(),
        "preview must verify the certificate hostname",
    );
    let response = timeout(TEST_TIMEOUT, trusted_preview.get(&url).send())
        .await
        .expect("trusted preview request finishes")
        .expect("preview accepts a valid explicitly trusted certificate");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(response.text().await.expect("read preview response"), "ok");
    let handshakes = timeout(TEST_TIMEOUT, server)
        .await
        .expect("TLS server finishes")
        .expect("TLS server task");
    assert_eq!(handshakes, [false, false, false, true]);
}

#[test]
fn md5_matches_rfc1321_test_vectors() {
    let vectors = [
        ("", "d41d8cd98f00b204e9800998ecf8427e"),
        ("a", "0cc175b9c0f1b6a831c399e269772661"),
        ("abc", "900150983cd24fb0d6963f7d28e17f72"),
        ("message digest", "f96b697d7cb7938d525a2f31aaf161d0"),
        (
            "abcdefghijklmnopqrstuvwxyz",
            "c3fcd3d76192e4007dfb496cca67e13b",
        ),
        (
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
            "d174ab98d277d9f5a5611c2c9f419d9f",
        ),
        (
            "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
            "57edf4a22be3c955ac49da2e2107b67a",
        ),
    ];

    for (input, expected_hex) in vectors {
        assert_eq!(md5_hex(input.as_bytes()), expected_hex, "input={input:?}");
    }
    assert_eq!(md5_digest(b"").len(), 16);
}

#[test]
fn digest_auth_supports_md5_md5_sess_and_sha256_qop_auth() {
    let rfc2617_header = r#"Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41""#;
    let challenge = parse_digest_challenge(rfc2617_header).expect("valid MD5 challenge");
    assert_eq!(challenge.algorithm, DigestAlgorithm::Md5);
    assert_eq!(challenge.realm, "testrealm@host.com");
    assert_eq!(
        challenge.opaque.as_deref(),
        Some("5ccc069c403ebaf9f0171e9517f40e41"),
    );

    let creds = DigestCredentials {
        username: "Mufasa",
        password: "Circle Of Life",
        method: "GET",
        digest_uri: "/dir/index.html",
        entity_body: b"",
        cnonce: "0a4f113b",
        nonce_count: 1,
    };
    let (resp_md5, qop_md5) = compute_digest_response(&challenge, &creds).expect("MD5 digest");
    assert_eq!(qop_md5, Some("auth"));
    assert_eq!(resp_md5, "6629fae49393a05397450978507c4ef1");

    let formatted_md5 =
        build_digest_authorization_header(&challenge, &creds).expect("MD5 header string");
    assert!(formatted_md5.contains(r#"response="6629fae49393a05397450978507c4ef1""#));
    assert!(formatted_md5.contains("qop=auth"));
    assert!(formatted_md5.contains("nc=00000001"));
    assert!(formatted_md5.contains(r#"opaque="5ccc069c403ebaf9f0171e9517f40e41""#));

    let md5_sess_hdr =
        r#"Digest realm="sip.example.org", nonce="abcdef123456", qop="auth", algorithm=MD5-sess"#;
    let sess_challenge = parse_digest_challenge(md5_sess_hdr).expect("valid MD5-sess challenge");
    assert_eq!(sess_challenge.algorithm, DigestAlgorithm::Md5Sess);
    let sip_creds = DigestCredentials {
        username: "alice",
        password: "secret-password",
        method: "INVITE",
        digest_uri: "sip:+15551234567@sip.example.org",
        entity_body: b"v=0\r\n",
        cnonce: "deadbeef01",
        nonce_count: 1,
    };
    let (sess_resp, _) =
        compute_digest_response(&sess_challenge, &sip_creds).expect("MD5-sess digest");
    let expected_ha1_base = md5_hex(b"alice:sip.example.org:secret-password");
    let expected_ha1 = md5_hex(format!("{expected_ha1_base}:abcdef123456:deadbeef01").as_bytes());
    let expected_ha2 = md5_hex(b"INVITE:sip:+15551234567@sip.example.org");
    let expected_sess = md5_hex(
        format!("{expected_ha1}:abcdef123456:00000001:deadbeef01:auth:{expected_ha2}").as_bytes(),
    );
    assert_eq!(sess_resp, expected_sess);

    let sha256_hdr = r#"Digest realm="http-auth@example.org", qop="auth, auth-int", algorithm=SHA-256, nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v", opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS""#;
    let sha_challenge = parse_digest_challenge(sha256_hdr).expect("valid SHA-256 challenge");
    assert_eq!(sha_challenge.algorithm, DigestAlgorithm::Sha256);
    let sha_creds = DigestCredentials {
        username: "Mufasa",
        password: "Circle of Life",
        method: "GET",
        digest_uri: "/dir/index.html",
        entity_body: b"",
        cnonce: "f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ",
        nonce_count: 1,
    };
    let (sha_resp, sha_qop) =
        compute_digest_response(&sha_challenge, &sha_creds).expect("SHA-256 digest");
    assert_eq!(sha_qop, Some("auth"));
    let expected_sha_ha1 = sha256_hex(b"Mufasa:http-auth@example.org:Circle of Life");
    let expected_sha_ha2 = sha256_hex(b"GET:/dir/index.html");
    let expected_sha_resp = sha256_hex(
        format!(
            "{expected_sha_ha1}:7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v:00000001:f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ:auth:{expected_sha_ha2}",
        )
        .as_bytes(),
    );
    assert_eq!(sha_resp, expected_sha_resp);
    assert_eq!(
        sha_resp,
        "753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1",
    );
    let formatted_sha =
        build_digest_authorization_header(&sha_challenge, &sha_creds).expect("SHA-256 header");
    assert!(formatted_sha.contains("algorithm=SHA-256"));
    assert!(formatted_sha.contains("qop=auth"));
}

#[test]
fn sdp_and_rtp_reorder_buffer_handle_gaps_cn_dtmf_and_wraparound() {
    let offer = build_sdp_offer(IpAddr::V4(Ipv4Addr::LOCALHOST), 40120, 99);
    assert!(offer.contains("m=audio 40120 RTP/AVP 0 101\r\n"));
    assert!(offer.contains("a=rtpmap:0 PCMU/8000\r\n"));
    assert!(offer.contains("a=rtpmap:101 telephone-event/8000\r\n"));
    assert!(offer.contains("a=ptime:20\r\n"));
    assert!(offer.contains("a=sendrecv\r\n"));

    let answer_raw = "v=0\r\n\
        o=- 1 1 IN IP4 198.51.100.20\r\n\
        s=-\r\n\
        c=IN IP4 198.51.100.20\r\n\
        t=0 0\r\n\
        m=audio 34560 RTP/AVP 0 96\r\n\
        c=IN IP4 127.0.0.1\r\n\
        a=rtpmap:0 PCMU/8000\r\n\
        a=rtpmap:96 telephone-event/8000\r\n";
    let parsed_sdp = parse_sdp_answer(answer_raw).expect("valid SDP answer");
    assert_eq!(parsed_sdp.remote_media_ip, IpAddr::V4(Ipv4Addr::LOCALHOST));
    assert_eq!(parsed_sdp.remote_audio_port, 34560);
    assert_eq!(parsed_sdp.negotiated_dtmf_pt, Some(96));

    let mut reorder = RtpReorderBuffer::new(Some(96));

    let send_pkt = |pt: u8, seq: u16, ts: u32, byte_val: u8, len: usize| -> Vec<u8> {
        build_rtp_packet(false, pt, seq, ts, 0x1234_5678, &vec![byte_val; len])
    };

    let p_65535 = send_pkt(PCMU_PAYLOAD_TYPE, 65535, 1600, 0x10, PCMU_FRAME_BYTES);
    let out0 = reorder.push_rtp_packet(&parse_rtp_packet(&p_65535).expect("valid pkt"));
    assert_eq!(out0.len(), 1);
    assert_eq!(out0[0].sequence_number, 65535);
    assert_eq!(out0[0].pcmu, [0x10; PCMU_FRAME_BYTES]);

    let p_2 = send_pkt(PCMU_PAYLOAD_TYPE, 2, 2080, 0x22, PCMU_FRAME_BYTES);
    let p_1_cn = send_pkt(COMFORT_NOISE_PAYLOAD_TYPE, 1, 1920, 0x05, 4);
    let p_0 = send_pkt(PCMU_PAYLOAD_TYPE, 0, 1760, 0x20, PCMU_FRAME_BYTES);

    assert!(reorder
        .push_rtp_packet(&parse_rtp_packet(&p_2).expect("pkt"))
        .is_empty());
    assert!(reorder.has_pending());
    assert!(reorder
        .push_rtp_packet(&parse_rtp_packet(&p_1_cn).expect("pkt"))
        .is_empty());
    let burst = reorder.push_rtp_packet(&parse_rtp_packet(&p_0).expect("pkt"));
    assert_eq!(burst.len(), 3);
    assert_eq!(burst[0].sequence_number, 0);
    assert_eq!(burst[0].pcmu, [0x20; PCMU_FRAME_BYTES]);
    assert_eq!(burst[1].sequence_number, 1);
    assert_eq!(burst[1].pcmu, [PCMU_SILENCE_BYTE; PCMU_FRAME_BYTES]);
    assert_eq!(burst[2].sequence_number, 2);
    assert_eq!(burst[2].pcmu, [0x22; PCMU_FRAME_BYTES]);

    let p_3_dtmf = send_pkt(96, 3, 2240, 0x01, 4);
    assert!(reorder
        .push_rtp_packet(&parse_rtp_packet(&p_3_dtmf).expect("dtmf pkt"))
        .is_empty());
    assert!(!reorder.has_pending());

    let p_5 = send_pkt(PCMU_PAYLOAD_TYPE, 5, 2560, 0x55, PCMU_FRAME_BYTES);
    let p_6 = send_pkt(PCMU_PAYLOAD_TYPE, 6, 2720, 0x66, PCMU_FRAME_BYTES);
    let p_7 = send_pkt(PCMU_PAYLOAD_TYPE, 7, 2880, 0x77, PCMU_FRAME_BYTES);
    assert!(reorder
        .push_rtp_packet(&parse_rtp_packet(&p_5).expect("pkt"))
        .is_empty());
    assert!(reorder
        .push_rtp_packet(&parse_rtp_packet(&p_6).expect("pkt"))
        .is_empty());
    let gap_filled = reorder.push_rtp_packet(&parse_rtp_packet(&p_7).expect("pkt"));
    assert_eq!(gap_filled.len(), 4);
    assert_eq!(gap_filled[0].sequence_number, 4);
    assert_eq!(gap_filled[0].pcmu, [PCMU_SILENCE_BYTE; PCMU_FRAME_BYTES]);
    assert_eq!(gap_filled[1].sequence_number, 5);
    assert_eq!(gap_filled[1].pcmu, [0x55; PCMU_FRAME_BYTES]);
    assert_eq!(gap_filled[2].sequence_number, 6);
    assert_eq!(gap_filled[3].sequence_number, 7);
}

#[tokio::test]
async fn udp_trunk_full_call_lifecycle_407_early_media_gate_200_ok_rtp_barge_in_dtmf_and_bye() {
    let trunk_sip = UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("bind mock trunk SIP UDP");
    let trunk_sip_addr = trunk_sip.local_addr().expect("trunk SIP local_addr");

    let trunk_rtp = Arc::new(
        UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .await
            .expect("bind mock trunk RTP UDP"),
    );
    let trunk_rtp_addr = trunk_rtp.local_addr().expect("trunk RTP local_addr");

    let trunk_rtp_for_server = Arc::clone(&trunk_rtp);
    let server_task = tokio::spawn(async move {
        let mut buf = vec![0_u8; 65535];

        let (n1, client_sip_addr) = timeout(TEST_TIMEOUT, trunk_sip.recv_from(&mut buf))
            .await
            .expect("recv initial INVITE timeout")
            .expect("recv initial INVITE");
        let invite1 = std::str::from_utf8(&buf[..n1]).expect("INVITE1 utf8");
        assert!(invite1.starts_with("INVITE sip:+15559876543@trunk.test SIP/2.0\r\n"));
        assert!(invite1.contains("CSeq: 1 INVITE\r\n"));
        assert!(invite1.contains("Max-Forwards: 70\r\n"));
        assert!(invite1.contains(r#""Dapper Agent" <sip:+15551112222@trunk.test>;tag="#));
        assert!(invite1.contains("Content-Type: application/sdp\r\n"));
        assert!(invite1.contains("a=rtpmap:0 PCMU/8000\r\n"));
        assert!(invite1.contains("a=rtpmap:101 telephone-event/8000\r\n"));

        let via1 = extract_header(invite1, "Via:");
        let from1 = extract_header(invite1, "From:");
        let to1 = extract_header(invite1, "To:");
        let call_id = extract_header(invite1, "Call-ID:");
        let client_rtp_port = extract_sdp_audio_port(invite1);
        let client_rtp_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), client_rtp_port);

        let resp_407 = format!(
            "SIP/2.0 407 Proxy Authentication Required\r\n\
             Via: {via1}\r\n\
             From: {from1}\r\n\
             To: {to1};tag=chaltag1\r\n\
             Call-ID: {call_id}\r\n\
             CSeq: 1 INVITE\r\n\
             Proxy-Authenticate: Digest realm=\"trunk.test\", nonce=\"nonce407xyz\", opaque=\"opq99\", qop=\"auth\", algorithm=MD5\r\n\
             Content-Length: 0\r\n\r\n",
        );
        trunk_sip
            .send_to(resp_407.as_bytes(), client_sip_addr)
            .await
            .expect("send 407");

        let (n_ack1, _) = timeout(TEST_TIMEOUT, trunk_sip.recv_from(&mut buf))
            .await
            .expect("recv 407 ACK timeout")
            .expect("recv 407 ACK");
        let ack1 = std::str::from_utf8(&buf[..n_ack1]).expect("ACK1 utf8");
        assert!(ack1.starts_with("ACK sip:+15559876543@trunk.test SIP/2.0\r\n"));
        assert!(ack1.contains("CSeq: 1 ACK\r\n"));
        assert_eq!(extract_header(ack1, "Via:"), via1);

        let (n2, _) = timeout(TEST_TIMEOUT, trunk_sip.recv_from(&mut buf))
            .await
            .expect("recv authed INVITE timeout")
            .expect("recv authed INVITE");
        let invite2 = std::str::from_utf8(&buf[..n2]).expect("INVITE2 utf8");
        assert!(invite2.starts_with("INVITE sip:+15559876543@trunk.test SIP/2.0\r\n"));
        assert!(invite2.contains("CSeq: 2 INVITE\r\n"));
        let proxy_auth = extract_header(invite2, "Proxy-Authorization:");
        assert!(proxy_auth.contains(r#"username="trunk-user""#));
        assert!(proxy_auth.contains(r#"realm="trunk.test""#));
        assert!(proxy_auth.contains(r#"nonce="nonce407xyz""#));
        assert!(proxy_auth.contains(r#"opaque="opq99""#));
        assert!(proxy_auth.contains("qop=auth"));

        let via2 = extract_header(invite2, "Via:");
        assert_ne!(
            via2, via1,
            "authenticated INVITE must use a fresh Via branch",
        );

        let trying = format!(
            "SIP/2.0 100 Trying\r\nVia: {via2}\r\nFrom: {from1}\r\nTo: {to1}\r\nCall-ID: {call_id}\r\nCSeq: 2 INVITE\r\nContent-Length: 0\r\n\r\n",
        );
        let ringing = format!(
            "SIP/2.0 180 Ringing\r\nVia: {via2}\r\nFrom: {from1}\r\nTo: {to1};tag=uas200tag\r\nCall-ID: {call_id}\r\nCSeq: 2 INVITE\r\nContent-Length: 0\r\n\r\n",
        );
        let sdp_answer = format!(
            "v=0\r\n\
             o=trunk 100 100 IN IP4 127.0.0.1\r\n\
             s=Trunk\r\n\
             c=IN IP4 127.0.0.1\r\n\
             t=0 0\r\n\
             m=audio {} RTP/AVP 0 101\r\n\
             a=rtpmap:0 PCMU/8000\r\n\
             a=rtpmap:101 telephone-event/8000\r\n\
             a=ptime:20\r\n\
             a=sendrecv\r\n",
            trunk_rtp_addr.port(),
        );
        let progress = format!(
            "SIP/2.0 183 Session Progress\r\n\
             Via: {via2}\r\n\
             From: {from1}\r\n\
             To: {to1};tag=uas200tag\r\n\
             Call-ID: {call_id}\r\n\
             CSeq: 2 INVITE\r\n\
             Content-Type: application/sdp\r\n\
             Content-Length: {}\r\n\r\n{sdp_answer}",
            sdp_answer.len(),
        );

        trunk_sip
            .send_to(trying.as_bytes(), client_sip_addr)
            .await
            .expect("send 100");
        trunk_sip
            .send_to(ringing.as_bytes(), client_sip_addr)
            .await
            .expect("send 180");
        trunk_sip
            .send_to(progress.as_bytes(), client_sip_addr)
            .await
            .expect("send 183");

        for early_seq in 0_u16..4 {
            let early_pkt = build_rtp_packet(
                early_seq == 0,
                PCMU_PAYLOAD_TYPE,
                500 + early_seq,
                u32::from(early_seq) * 160,
                0xAABB_CCDD,
                &[0x42; PCMU_FRAME_BYTES],
            );
            trunk_rtp_for_server
                .send_to(&early_pkt, client_rtp_addr)
                .await
                .expect("send early media RTP");
        }

        tokio::time::sleep(Duration::from_millis(70)).await;

        let ok_200 = format!(
            "SIP/2.0 200 OK\r\n\
             Via: {via2}\r\n\
             Record-Route: <sip:proxy1.trunk.test:5060;lr>, <sip:proxy2.trunk.test:5060;lr>\r\n\
             From: {from1}\r\n\
             To: {to1};tag=uas200tag\r\n\
             Call-ID: {call_id}\r\n\
             CSeq: 2 INVITE\r\n\
             Contact: <sip:uas@{trunk_sip_addr}>\r\n\
             Content-Type: application/sdp\r\n\
             Content-Length: {}\r\n\r\n{sdp_answer}",
            sdp_answer.len(),
        );
        trunk_sip
            .send_to(ok_200.as_bytes(), client_sip_addr)
            .await
            .expect("send 200 OK");

        let (n_ack200, _) = timeout(TEST_TIMEOUT, trunk_sip.recv_from(&mut buf))
            .await
            .expect("recv 200 ACK timeout")
            .expect("recv 200 ACK");
        let ack200 = std::str::from_utf8(&buf[..n_ack200]).expect("ACK 200 utf8");
        assert!(ack200.starts_with(&format!("ACK sip:uas@{trunk_sip_addr} SIP/2.0\r\n")));
        assert!(ack200.contains("CSeq: 2 ACK\r\n"));
        let proxy2_pos = ack200
            .find("Route: <sip:proxy2.trunk.test:5060;lr>")
            .expect("route 2");
        let proxy1_pos = ack200
            .find("Route: <sip:proxy1.trunk.test:5060;lr>")
            .expect("route 1");
        assert!(
            proxy2_pos < proxy1_pos,
            "Route set must reverse Record-Route order",
        );

        trunk_sip
            .send_to(ok_200.as_bytes(), client_sip_addr)
            .await
            .expect("send duplicate 200 OK");
        let (n_dup_ack, _) = timeout(TEST_TIMEOUT, trunk_sip.recv_from(&mut buf))
            .await
            .expect("recv dup ACK timeout")
            .expect("recv dup ACK");
        let dup_ack = std::str::from_utf8(&buf[..n_dup_ack]).expect("dup ACK utf8");
        assert!(dup_ack.starts_with(&format!("ACK sip:uas@{trunk_sip_addr} SIP/2.0\r\n")));

        let (n_bye, _) = timeout(TEST_TIMEOUT, trunk_sip.recv_from(&mut buf))
            .await
            .expect("recv BYE timeout")
            .expect("recv BYE");
        let bye_req = std::str::from_utf8(&buf[..n_bye]).expect("BYE utf8");
        assert!(bye_req.starts_with(&format!("BYE sip:uas@{trunk_sip_addr} SIP/2.0\r\n")));
        assert!(bye_req.contains("CSeq: 3 BYE\r\n"));
        assert!(bye_req.contains("Route: <sip:proxy2.trunk.test:5060;lr>\r\n"));
        let bye_via = extract_header(bye_req, "Via:");
        let bye_ok = format!(
            "SIP/2.0 200 OK\r\nVia: {bye_via}\r\nFrom: {from1}\r\nTo: {to1};tag=uas200tag\r\nCall-ID: {call_id}\r\nCSeq: 3 BYE\r\nContent-Length: 0\r\n\r\n",
        );
        trunk_sip
            .send_to(bye_ok.as_bytes(), client_sip_addr)
            .await
            .expect("send 200 OK for BYE");

        client_rtp_addr
    });

    let trunk_secret = random_hex_token(16);
    let config = SipDialConfig::new(
        "127.0.0.1",
        trunk_sip_addr.port(),
        SipTransportKind::Udp,
        "+15551112222",
        "+15559876543",
    )
    .with_domain("trunk.test")
    .with_display_name("Dapper Agent")
    .with_credentials("trunk-user", &trunk_secret);

    let debug_text = format!("{config:?}");
    assert!(
        !debug_text.contains(&trunk_secret),
        "Debug impl must redact password",
    );

    let mut session = SipCallSession::dial(config).await.expect("dial UDP trunk");
    let client_rtp_addr = session.local_rtp_addr();

    let ev1 = timeout(TEST_TIMEOUT, session.next_event())
        .await
        .expect("event 1 timeout")
        .expect("event 1");
    assert_eq!(ev1, SipCallEvent::Ringing);

    let ev2 = timeout(TEST_TIMEOUT, session.next_event())
        .await
        .expect("event 2 timeout")
        .expect("event 2");
    assert_eq!(
        ev2,
        SipCallEvent::Connected {
            negotiated_dtmf_pt: Some(DEFAULT_TELEPHONE_EVENT_PT)
        },
    );
    assert!(
        session.discarded_early_rtp_packets() >= 1,
        "early-media RTP packets before 200 OK must be drained and discarded",
    );

    let mut rtp_buf = vec![0_u8; 2048];
    for _ in 0..3 {
        let (n_rtp, from_rtp) = timeout(TEST_TIMEOUT, trunk_rtp.recv_from(&mut rtp_buf))
            .await
            .expect("recv silence keepalive RTP timeout")
            .expect("recv silence keepalive RTP");
        assert_eq!(from_rtp, client_rtp_addr);
        let parsed = parse_rtp_packet(&rtp_buf[..n_rtp]).expect("valid RTP packet");
        assert_eq!(parsed.payload_type, PCMU_PAYLOAD_TYPE);
        assert!(!parsed.marker);
        assert_eq!(parsed.payload, &[PCMU_SILENCE_BYTE; PCMU_FRAME_BYTES]);
    }

    session.enqueue_pcmu_frames(vec![[0x33; PCMU_FRAME_BYTES]; 30]);

    let mut saw_first_voice = false;
    for _ in 0..10 {
        let (n_rtp, _) = timeout(TEST_TIMEOUT, trunk_rtp.recv_from(&mut rtp_buf))
            .await
            .expect("recv voice RTP timeout")
            .expect("recv voice RTP");
        let parsed = parse_rtp_packet(&rtp_buf[..n_rtp]).expect("valid voice RTP");
        if parsed.payload == [0x33; PCMU_FRAME_BYTES] {
            assert!(
                parsed.marker,
                "first voice RTP packet after silence must set Marker bit M=1",
            );
            saw_first_voice = true;
            break;
        }
    }
    assert!(saw_first_voice, "expected voice RTP packet 0x33");

    let (n_next_voice, _) = timeout(TEST_TIMEOUT, trunk_rtp.recv_from(&mut rtp_buf))
        .await
        .expect("recv second voice RTP timeout")
        .expect("recv second voice RTP");
    let parsed_second = parse_rtp_packet(&rtp_buf[..n_next_voice]).expect("valid second voice");
    assert_eq!(parsed_second.payload, &[0x33; PCMU_FRAME_BYTES]);
    assert!(!parsed_second.marker);

    let snapshot = session.clear_outbound_audio();
    assert!(snapshot.outbound_playing);
    assert_eq!(snapshot.current_outbound_pcmu, [0x33; PCMU_FRAME_BYTES]);
    assert!(snapshot.cleared_frames >= 20);

    let mut reverted_to_silence = false;
    for _ in 0..3 {
        let (n_sil, _) = timeout(TEST_TIMEOUT, trunk_rtp.recv_from(&mut rtp_buf))
            .await
            .expect("recv post-clear RTP timeout")
            .expect("recv post-clear RTP");
        let parsed_sil = parse_rtp_packet(&rtp_buf[..n_sil]).expect("valid post-clear RTP");
        if parsed_sil.payload == [PCMU_SILENCE_BYTE; PCMU_FRAME_BYTES] {
            reverted_to_silence = true;
            break;
        }
    }
    assert!(
        reverted_to_silence,
        "clear_outbound_audio must immediately revert RTP stream to 0xFF silence",
    );

    let dtmf_packets = vec![
        [5, 10, 0x00, 0xA0],
        [5, 10, 0x01, 0x40],
        [5, 0x80 | 10, 0x01, 0xE0],
    ];
    session.enqueue_rfc4733_dtmf(DEFAULT_TELEPHONE_EVENT_PT, dtmf_packets);

    let mut received_dtmf = Vec::new();
    for _ in 0..12 {
        let (n_pkt, _) = timeout(TEST_TIMEOUT, trunk_rtp.recv_from(&mut rtp_buf))
            .await
            .expect("recv DTMF RTP timeout")
            .expect("recv DTMF RTP");
        let parsed = parse_rtp_packet(&rtp_buf[..n_pkt]).expect("valid RTP");
        if parsed.payload_type == DEFAULT_TELEPHONE_EVENT_PT {
            received_dtmf.push((
                parsed.marker,
                parsed.sequence_number,
                parsed.timestamp,
                parsed.payload.to_vec(),
            ));
            if received_dtmf.len() == 3 {
                break;
            }
        }
    }
    assert_eq!(received_dtmf.len(), 3);
    assert!(received_dtmf[0].0, "first DTMF packet must set M=1");
    assert!(!received_dtmf[1].0, "continuation DTMF packet must set M=0");
    assert!(!received_dtmf[2].0, "end DTMF packet must set M=0");
    assert_eq!(
        received_dtmf[0].2, received_dtmf[1].2,
        "RFC 4733 packets for one digit must share fixed start timestamp",
    );
    assert_eq!(received_dtmf[1].2, received_dtmf[2].2);
    assert_eq!(
        received_dtmf[2].3[1] & 0x80,
        0x80,
        "third DTMF packet must carry E=1",
    );

    let in_200 = build_rtp_packet(
        true,
        PCMU_PAYLOAD_TYPE,
        200,
        8000,
        0x5566_7788,
        &[0xA0; 160],
    );
    let in_202 = build_rtp_packet(
        false,
        PCMU_PAYLOAD_TYPE,
        202,
        8320,
        0x5566_7788,
        &[0xA2; 160],
    );
    let in_201 = build_rtp_packet(
        false,
        PCMU_PAYLOAD_TYPE,
        201,
        8160,
        0x5566_7788,
        &[0xA1; 160],
    );
    trunk_rtp
        .send_to(&in_200, client_rtp_addr)
        .await
        .expect("send in_200");
    trunk_rtp
        .send_to(&in_202, client_rtp_addr)
        .await
        .expect("send in_202");
    trunk_rtp
        .send_to(&in_201, client_rtp_addr)
        .await
        .expect("send in_201");

    let f0 = timeout(TEST_TIMEOUT, session.next_inbound_audio())
        .await
        .expect("inbound f0 timeout")
        .expect("inbound f0");
    let f1 = timeout(TEST_TIMEOUT, session.next_inbound_audio())
        .await
        .expect("inbound f1 timeout")
        .expect("inbound f1");
    let f2 = timeout(TEST_TIMEOUT, session.next_inbound_audio())
        .await
        .expect("inbound f2 timeout")
        .expect("inbound f2");

    assert_eq!(f0.rtp_sequence, 200);
    assert_eq!(f0.inbound_pcmu, [0xA0; PCMU_FRAME_BYTES]);
    assert_eq!(f1.rtp_sequence, 201);
    assert_eq!(f1.inbound_pcmu, [0xA1; PCMU_FRAME_BYTES]);
    assert_eq!(f2.rtp_sequence, 202);
    assert_eq!(f2.inbound_pcmu, [0xA2; PCMU_FRAME_BYTES]);

    session.hangup().await.expect("clean hangup BYE");
    let ended_ev = timeout(TEST_TIMEOUT, session.next_event())
        .await
        .expect("ended event timeout")
        .expect("ended event");
    assert_eq!(
        ended_ev,
        SipCallEvent::Ended {
            reason: "local_hangup".to_owned()
        },
    );

    let recorded_client_rtp = server_task.await.expect("mock trunk server completed");
    assert_eq!(recorded_client_rtp, client_rtp_addr);
}

#[tokio::test]
async fn pre_answer_hangup_sends_rfc3261_cancel_and_acks_487() {
    let trunk_sip = UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("bind trunk SIP");
    let trunk_sip_addr = trunk_sip.local_addr().expect("trunk addr");

    let server_task = tokio::spawn(async move {
        let mut buf = vec![0_u8; 65535];
        let (n_inv, client_addr) = timeout(TEST_TIMEOUT, trunk_sip.recv_from(&mut buf))
            .await
            .expect("recv INVITE timeout")
            .expect("recv INVITE");
        let invite = std::str::from_utf8(&buf[..n_inv]).expect("INVITE utf8");
        let via = extract_header(invite, "Via:");
        let from = extract_header(invite, "From:");
        let to = extract_header(invite, "To:");
        let call_id = extract_header(invite, "Call-ID:");

        let ringing = format!(
            "SIP/2.0 180 Ringing\r\nVia: {via}\r\nFrom: {from}\r\nTo: {to};tag=ringtag\r\nCall-ID: {call_id}\r\nCSeq: 1 INVITE\r\nContent-Length: 0\r\n\r\n",
        );
        trunk_sip
            .send_to(ringing.as_bytes(), client_addr)
            .await
            .expect("send 180");

        let (n_cancel, _) = timeout(TEST_TIMEOUT, trunk_sip.recv_from(&mut buf))
            .await
            .expect("recv CANCEL timeout")
            .expect("recv CANCEL");
        let cancel = std::str::from_utf8(&buf[..n_cancel]).expect("CANCEL utf8");
        assert!(cancel.starts_with("CANCEL sip:+15550009999@127.0.0.1 SIP/2.0\r\n"));
        assert!(cancel.contains("CSeq: 1 CANCEL\r\n"));
        assert_eq!(
            extract_header(cancel, "Via:"),
            via,
            "CANCEL must reuse exact INVITE Via branch",
        );

        let ok_cancel = format!(
            "SIP/2.0 200 OK\r\nVia: {via}\r\nFrom: {from}\r\nTo: {to};tag=ringtag\r\nCall-ID: {call_id}\r\nCSeq: 1 CANCEL\r\nContent-Length: 0\r\n\r\n",
        );
        let term_487 = format!(
            "SIP/2.0 487 Request Terminated\r\nVia: {via}\r\nFrom: {from}\r\nTo: {to};tag=ringtag\r\nCall-ID: {call_id}\r\nCSeq: 1 INVITE\r\nContent-Length: 0\r\n\r\n",
        );
        trunk_sip
            .send_to(ok_cancel.as_bytes(), client_addr)
            .await
            .expect("send 200 OK CANCEL");
        trunk_sip
            .send_to(term_487.as_bytes(), client_addr)
            .await
            .expect("send 487");

        let (n_ack, _) = timeout(TEST_TIMEOUT, trunk_sip.recv_from(&mut buf))
            .await
            .expect("recv 487 ACK timeout")
            .expect("recv 487 ACK");
        let ack = std::str::from_utf8(&buf[..n_ack]).expect("ACK utf8");
        assert!(ack.contains("CSeq: 1 ACK\r\n"));
    });

    let config = SipDialConfig::new(
        "127.0.0.1",
        trunk_sip_addr.port(),
        SipTransportKind::Udp,
        "+15551110000",
        "+15550009999",
    );
    let mut session = SipCallSession::dial(config).await.expect("dial");
    let ev = timeout(TEST_TIMEOUT, session.next_event())
        .await
        .expect("ringing timeout")
        .expect("ringing event");
    assert_eq!(ev, SipCallEvent::Ringing);
    assert_eq!(session.state(), SipCallState::Ringing);

    let handle = session.control_handle();
    handle.hangup().await.expect("pre-answer CANCEL hangup");

    server_task
        .await
        .expect("mock server verified CANCEL + 487 ACK");
}

#[tokio::test]
async fn tls_transport_sha256_401_auth_chunked_stream_keepalive_and_remote_bye() {
    let _default_cfg = default_rustls_client_config().expect("webpki-roots default TLS config");
    assert_eq!(SipTransportKind::Udp.default_port(), 5060);
    assert_eq!(SipTransportKind::Tls.default_port(), 5061);

    let cert = CertificateDer::from(
        BASE64_STANDARD
            .decode(TEST_LOCALHOST_CERT_B64)
            .expect("decode test cert DER"),
    );
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
        BASE64_STANDARD
            .decode(TEST_LOCALHOST_PKCS8_B64)
            .expect("decode test key DER"),
    ));

    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let server_tls_cfg = rustls::ServerConfig::builder_with_provider(Arc::clone(&provider))
        .with_safe_default_protocol_versions()
        .expect("server TLS versions")
        .with_no_client_auth()
        .with_single_cert(vec![cert.clone()], key)
        .expect("server single cert");
    let acceptor = TlsAcceptor::from(Arc::new(server_tls_cfg));

    let mut root_store = rustls::RootCertStore::empty();
    root_store.add(cert).expect("add custom root cert");
    let client_tls_cfg = Arc::new(
        rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .expect("client TLS versions")
            .with_root_certificates(root_store)
            .with_no_client_auth(),
    );

    let tcp_listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("bind TLS TCP listener");
    let server_addr = tcp_listener.local_addr().expect("TLS listener addr");

    let trunk_rtp = UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("bind TLS trunk RTP");
    let trunk_rtp_port = trunk_rtp.local_addr().expect("RTP addr").port();

    let server_task = tokio::spawn(async move {
        let (tcp_conn, _) = timeout(TEST_TIMEOUT, tcp_listener.accept())
            .await
            .expect("accept timeout")
            .expect("accept TCP");
        let mut tls_stream = timeout(TEST_TIMEOUT, acceptor.accept(tcp_conn))
            .await
            .expect("TLS accept timeout")
            .expect("TLS accept");

        let mut stream_buf = Vec::new();
        let invite1 = read_one_tls_sip_message(&mut tls_stream, &mut stream_buf).await;
        assert!(invite1.starts_with("INVITE sip:+15557778888@localhost SIP/2.0\r\n"));
        assert!(invite1.contains("Via: SIP/2.0/TLS "));

        let via1 = extract_header(&invite1, "Via:");
        let from1 = extract_header(&invite1, "From:");
        let to1 = extract_header(&invite1, "To:");
        let call_id = extract_header(&invite1, "Call-ID:");

        let resp_401 = format!(
            "SIP/2.0 401 Unauthorized\r\n\
             Via: {via1}\r\n\
             From: {from1}\r\n\
             To: {to1};tag=tls401\r\n\
             Call-ID: {call_id}\r\n\
             CSeq: 1 INVITE\r\n\
             WWW-Authenticate: Digest realm=\"tls.trunk\", nonce=\"shanonce1\", qop=\"auth\", algorithm=SHA-256\r\n\
             Content-Length: 0\r\n\r\n",
        );
        let split_at = resp_401.len() / 2;
        tls_stream
            .write_all(&resp_401.as_bytes()[..split_at])
            .await
            .expect("write half 1");
        tls_stream.flush().await.expect("flush 1");
        tokio::time::sleep(Duration::from_millis(10)).await;
        tls_stream
            .write_all(&resp_401.as_bytes()[split_at..])
            .await
            .expect("write half 2");
        tls_stream.flush().await.expect("flush 2");

        let ack1 = read_one_tls_sip_message(&mut tls_stream, &mut stream_buf).await;
        assert!(ack1.contains("CSeq: 1 ACK\r\n"));

        let invite2 = read_one_tls_sip_message(&mut tls_stream, &mut stream_buf).await;
        assert!(invite2.contains("CSeq: 2 INVITE\r\n"));
        let auth_hdr = extract_header(&invite2, "Authorization:");
        assert!(auth_hdr.contains("algorithm=SHA-256"));
        assert!(auth_hdr.contains(r#"username="tls-alice""#));

        let via2 = extract_header(&invite2, "Via:");
        let sdp_body = format!(
            "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio {trunk_rtp_port} RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n",
        );
        let ok_200 = format!(
            "\r\n\r\nSIP/2.0 200 OK\r\n\
             Via: {via2}\r\n\
             From: {from1}\r\n\
             To: {to1};tag=tlsuas\r\n\
             Call-ID: {call_id}\r\n\
             CSeq: 2 INVITE\r\n\
             Contact: <sip:uas@127.0.0.1:{};transport=tls>\r\n\
             Content-Type: application/sdp\r\n\
             Content-Length: {}\r\n\r\n{sdp_body}",
            server_addr.port(),
            sdp_body.len(),
        );
        let hdr_split = ok_200.len() - (sdp_body.len() / 2);
        tls_stream
            .write_all(&ok_200.as_bytes()[..hdr_split])
            .await
            .expect("write 200 part 1");
        tls_stream.flush().await.expect("flush 200 part 1");
        tokio::time::sleep(Duration::from_millis(10)).await;
        tls_stream
            .write_all(&ok_200.as_bytes()[hdr_split..])
            .await
            .expect("write 200 part 2");
        tls_stream.flush().await.expect("flush 200 part 2");

        let ack200 = read_one_tls_sip_message(&mut tls_stream, &mut stream_buf).await;
        assert!(ack200.contains("CSeq: 2 ACK\r\n"));

        let mut saw_crlf_keepalive = false;
        let mut tmp = [0_u8; 512];
        let n_ka = timeout(TEST_TIMEOUT, tls_stream.read(&mut tmp))
            .await
            .expect("keepalive read timeout")
            .expect("keepalive read");
        if tmp[..n_ka].windows(4).any(|window| window == b"\r\n\r\n") {
            saw_crlf_keepalive = true;
        }
        assert!(saw_crlf_keepalive, "expected CRLF keepalive ping over TLS");

        let remote_bye = format!(
            "BYE sip:+15550001111@127.0.0.1 SIP/2.0\r\n\
             Via: SIP/2.0/TLS 127.0.0.1:{};branch=z9hG4bKremotebye1\r\n\
             From: {to1};tag=tlsuas\r\n\
             To: {from1}\r\n\
             Call-ID: {call_id}\r\n\
             CSeq: 10 BYE\r\n\
             Content-Length: 0\r\n\r\n",
            server_addr.port(),
        );
        tls_stream
            .write_all(remote_bye.as_bytes())
            .await
            .expect("write remote BYE");
        tls_stream.flush().await.expect("flush remote BYE");

        let bye_resp = read_one_tls_sip_message(&mut tls_stream, &mut stream_buf).await;
        assert!(bye_resp.starts_with("SIP/2.0 200 OK\r\n"));
        assert!(bye_resp.contains("CSeq: 10 BYE\r\n"));
    });

    let mut config = SipDialConfig::new(
        "127.0.0.1",
        server_addr.port(),
        SipTransportKind::Tls,
        "+15550001111",
        "+15557778888",
    )
    .with_domain("localhost")
    .with_tls_server_name("localhost")
    .with_credentials("tls-alice", random_hex_token(16))
    .with_custom_tls_config(client_tls_cfg);
    config.keepalive_interval = Duration::from_millis(50);

    let mut session = SipCallSession::dial(config).await.expect("dial TLS");
    let negotiated_pt = timeout(TEST_TIMEOUT, session.wait_for_connected())
        .await
        .expect("wait_for_connected timeout")
        .expect("connected over TLS");
    assert_eq!(negotiated_pt, None);

    let ev_conn = timeout(TEST_TIMEOUT, session.next_event())
        .await
        .expect("connected event timeout")
        .expect("connected event");
    assert_eq!(
        ev_conn,
        SipCallEvent::Connected {
            negotiated_dtmf_pt: None
        },
    );

    let ev_end = timeout(TEST_TIMEOUT, session.next_event())
        .await
        .expect("remote bye event timeout")
        .expect("remote bye event");
    assert_eq!(
        ev_end,
        SipCallEvent::Ended {
            reason: "remote_bye".to_owned()
        },
    );
    assert!(session.sent_rtp_packets() >= 1);
    let _ = session.outbound_playback_state();
    let _ = session.call_id();
    let _ = session.local_sip_addr();
    let _ = session.subscribe_state();
    let _ = session.take_inbound_audio_receiver();
    let _ = session.take_event_receiver();

    server_task.await.expect("TLS server finished");
}

#[tokio::test]
async fn busy_486_rejection_sends_ack_and_reports_rejected_reason() {
    let trunk_sip = UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("bind trunk UDP");
    let trunk_addr = trunk_sip.local_addr().expect("trunk addr");

    let server_task = tokio::spawn(async move {
        let mut buf = vec![0_u8; 65535];
        let (n, peer) = timeout(TEST_TIMEOUT, trunk_sip.recv_from(&mut buf))
            .await
            .expect("recv INVITE timeout")
            .expect("recv INVITE");
        let inv = std::str::from_utf8(&buf[..n]).expect("utf8");
        let via = extract_header(inv, "Via:");
        let from = extract_header(inv, "From:");
        let to = extract_header(inv, "To:");
        let call_id = extract_header(inv, "Call-ID:");

        let busy = format!(
            "SIP/2.0 486 Busy Here\r\nVia: {via}\r\nFrom: {from}\r\nTo: {to};tag=busy1\r\nCall-ID: {call_id}\r\nCSeq: 1 INVITE\r\nContent-Length: 0\r\n\r\n",
        );
        trunk_sip
            .send_to(busy.as_bytes(), peer)
            .await
            .expect("send 486");

        let (n_ack, _) = timeout(TEST_TIMEOUT, trunk_sip.recv_from(&mut buf))
            .await
            .expect("recv ACK timeout")
            .expect("recv ACK");
        let ack = std::str::from_utf8(&buf[..n_ack]).expect("ACK utf8");
        assert!(ack.contains("CSeq: 1 ACK\r\n"));
    });

    let config = SipDialConfig::new(
        "127.0.0.1",
        trunk_addr.port(),
        SipTransportKind::Udp,
        "+15551112222",
        "+15553334444",
    );
    let mut session = SipCallSession::dial(config).await.expect("dial");
    let err = timeout(TEST_TIMEOUT, session.wait_for_connected())
        .await
        .expect("wait timeout")
        .expect_err("expected 486 rejection error");
    assert!(
        matches!(
            err,
            SipError::Rejected {
                status_code: 486,
                ref reason
            } if reason == "Busy Here"
        ),
        "unexpected error: {err:?}",
    );

    let ev = timeout(TEST_TIMEOUT, session.next_event())
        .await
        .expect("event timeout")
        .expect("event");
    assert_eq!(
        ev,
        SipCallEvent::Ended {
            reason: "rejected: 486 Busy Here".to_owned()
        },
    );
    server_task.await.expect("server done");
}

#[tokio::test]
async fn offerless_reinvite_answers_with_offer_and_applies_answer_from_ack() {
    let trunk_sip = UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("bind trunk SIP");
    let trunk_addr = trunk_sip.local_addr().expect("trunk addr");
    let trunk_rtp = UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("bind trunk RTP");
    let rtp_port = trunk_rtp.local_addr().expect("trunk RTP addr").port();
    let sdp = move |direction: &str| {
        format!(
            "v=0\r\no=trunk 1 1 IN IP4 127.0.0.1\r\ns=-\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio {rtp_port} RTP/AVP 0 101\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:101 telephone-event/8000\r\na={direction}\r\n",
        )
    };

    let server_task = tokio::spawn(async move {
        let mut buf = vec![0_u8; 65535];
        let (n, client) = timeout(TEST_TIMEOUT, trunk_sip.recv_from(&mut buf))
            .await
            .expect("recv INVITE timeout")
            .expect("recv INVITE");
        let invite = std::str::from_utf8(&buf[..n]).expect("INVITE utf8");
        let via = extract_header(invite, "Via:");
        let from = extract_header(invite, "From:");
        let to = extract_header(invite, "To:");
        let call_id = extract_header(invite, "Call-ID:");
        let answer = sdp("sendrecv");
        let ok = format!(
            "SIP/2.0 200 OK\r\nVia: {via}\r\nFrom: {from}\r\nTo: {to};tag=uas1\r\nCall-ID: {call_id}\r\nCSeq: 1 INVITE\r\nContact: <sip:uas@{trunk_addr}>\r\nContent-Type: application/sdp\r\nContent-Length: {}\r\n\r\n{answer}",
            answer.len(),
        );
        trunk_sip
            .send_to(ok.as_bytes(), client)
            .await
            .expect("send 200");
        let (n_ack, _) = timeout(TEST_TIMEOUT, trunk_sip.recv_from(&mut buf))
            .await
            .expect("recv ACK timeout")
            .expect("recv ACK");
        assert!(std::str::from_utf8(&buf[..n_ack])
            .expect("ACK utf8")
            .starts_with("ACK "));

        let in_dialog = |method: &str, cseq: u32, body: &str| {
            let content_type = if body.is_empty() {
                ""
            } else {
                "Content-Type: application/sdp\r\n"
            };
            format!(
                "{method} sip:caller@{client} SIP/2.0\r\nVia: SIP/2.0/UDP {trunk_addr};branch=z9hG4bKoffer{cseq}{method}\r\nFrom: {to};tag=uas1\r\nTo: {from}\r\nCall-ID: {call_id}\r\nCSeq: {cseq} {method}\r\nContact: <sip:uas@{trunk_addr}>\r\n{content_type}Content-Length: {}\r\n\r\n{body}",
                body.len(),
            )
        };
        let reinvite = in_dialog("INVITE", 2, "");
        let mut responses = Vec::new();
        for _ in 0..2 {
            trunk_sip
                .send_to(reinvite.as_bytes(), client)
                .await
                .expect("send offerless re-INVITE");
            let (n_resp, _) = timeout(TEST_TIMEOUT, trunk_sip.recv_from(&mut buf))
                .await
                .expect("re-INVITE response timeout")
                .expect("re-INVITE response");
            responses.push(String::from_utf8(buf[..n_resp].to_vec()).expect("response utf8"));
        }
        let offer = &responses[0];
        assert!(offer.starts_with("SIP/2.0 200 OK\r\n"), "{offer}");
        assert!(offer.contains("CSeq: 2 INVITE\r\n"), "{offer}");
        assert!(
            offer.contains("Content-Type: application/sdp\r\n"),
            "{offer}",
        );
        assert!(offer.contains("m=audio "), "{offer}");
        assert!(offer.contains("a=sendrecv\r\n"), "{offer}");
        assert_eq!(
            responses[1], *offer,
            "a retransmission receives the cached offer",
        );

        let hold_answer = sdp("sendonly");
        trunk_sip
            .send_to(in_dialog("ACK", 2, &hold_answer).as_bytes(), client)
            .await
            .expect("send ACK with answer");
        trunk_sip
            .send_to(in_dialog("BYE", 3, "").as_bytes(), client)
            .await
            .expect("send BYE");
        let (n_bye, _) = timeout(TEST_TIMEOUT, trunk_sip.recv_from(&mut buf))
            .await
            .expect("BYE response timeout")
            .expect("BYE response");
        assert!(std::str::from_utf8(&buf[..n_bye])
            .expect("BYE response utf8")
            .starts_with("SIP/2.0 200 OK\r\n"));
    });

    let config = SipDialConfig::new(
        "127.0.0.1",
        trunk_addr.port(),
        SipTransportKind::Udp,
        "+15551112222",
        "+15553334444",
    );
    let mut session = SipCallSession::dial(config).await.expect("dial");
    let mut events = Vec::new();
    timeout(TEST_TIMEOUT, async {
        loop {
            let event = session.next_event().await.expect("event");
            let ended = matches!(event, SipCallEvent::Ended { .. });
            events.push(event);
            if ended {
                break;
            }
        }
    })
    .await
    .expect("call events timeout");
    assert_eq!(
        events,
        vec![
            SipCallEvent::Connected {
                negotiated_dtmf_pt: Some(101)
            },
            SipCallEvent::HoldChanged {
                on_hold: true,
                negotiated_dtmf_pt: Some(101)
            },
            SipCallEvent::Ended {
                reason: "remote_bye".to_owned()
            },
        ],
    );
    server_task
        .await
        .expect("mock trunk verified offer exchange");
}

fn extract_header(msg: &str, prefix: &str) -> String {
    msg.lines()
        .find_map(|line| {
            let trimmed = line.trim_end_matches('\r');
            let head = trimmed.get(..prefix.len())?;
            if head.eq_ignore_ascii_case(prefix) {
                Some(trimmed[prefix.len()..].trim().to_owned())
            } else {
                None
            }
        })
        .expect("expected SIP header present")
}

fn extract_sdp_audio_port(msg: &str) -> u16 {
    msg.lines()
        .find_map(|line| {
            let rest = line.trim().strip_prefix("m=audio ")?;
            rest.split_whitespace().next()?.parse::<u16>().ok()
        })
        .expect("expected m=audio port in SDP")
}

async fn read_one_tls_sip_message<Stream: AsyncReadExt + Unpin>(
    stream: &mut Stream,
    buf: &mut Vec<u8>,
) -> String {
    let mut scratch = [0_u8; 4096];
    loop {
        let skip = buf
            .iter()
            .take_while(|&&b| b == b'\r' || b == b'\n')
            .count();
        if skip > 0 {
            buf.drain(..skip);
        }
        if let Some(hdr_end) = buf.windows(4).position(|window| window == b"\r\n\r\n") {
            let hdr_str = std::str::from_utf8(&buf[..hdr_end]).expect("hdr utf8");
            let cl = hdr_str
                .lines()
                .find_map(|line| {
                    let (header_name, header_value) = line.split_once(':')?;
                    if header_name.trim().eq_ignore_ascii_case("Content-Length") {
                        header_value.trim().parse::<usize>().ok()
                    } else {
                        None
                    }
                })
                .unwrap_or(0);
            let total = hdr_end + 4 + cl;
            if buf.len() >= total {
                let msg = String::from_utf8(buf[..total].to_vec()).expect("msg utf8");
                buf.drain(..total);
                return msg;
            }
        }
        let n = timeout(TEST_TIMEOUT, stream.read(&mut scratch))
            .await
            .expect("TLS read timeout")
            .expect("TLS read");
        assert!(n > 0, "unexpected TLS EOF");
        buf.extend_from_slice(&scratch[..n]);
    }
}

async fn bind_loopback_udp() -> (UdpSocket, SocketAddr) {
    let socket = UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("bind loopback UDP");
    let addr = socket.local_addr().expect("loopback UDP addr");
    (socket, addr)
}

async fn send_udp_text(socket: &UdpSocket, text: &str, peer: SocketAddr) {
    socket
        .send_to(text.as_bytes(), peer)
        .await
        .expect("send mock trunk datagram");
}

async fn recv_udp_text(socket: &UdpSocket) -> (String, SocketAddr) {
    let mut buf = vec![0_u8; 65535];
    let (n, peer) = timeout(TEST_TIMEOUT, socket.recv_from(&mut buf))
        .await
        .expect("mock trunk recv timeout")
        .expect("mock trunk recv");
    (
        String::from_utf8(buf[..n].to_vec()).expect("SIP datagram utf8"),
        peer,
    )
}

fn trunk_sdp(ip: &str, rtp_port: u16, direction: &str) -> String {
    format!(
        "v=0\r\no=trunk 1 1 IN IP4 {ip}\r\ns=-\r\nc=IN IP4 {ip}\r\nt=0 0\r\nm=audio {rtp_port} RTP/AVP 0 101\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:101 telephone-event/8000\r\na={direction}\r\n",
    )
}

fn localhost_tls_configs() -> (TlsAcceptor, Arc<rustls::ClientConfig>) {
    let cert = CertificateDer::from(
        BASE64_STANDARD
            .decode(TEST_LOCALHOST_CERT_B64)
            .expect("decode test cert DER"),
    );
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
        BASE64_STANDARD
            .decode(TEST_LOCALHOST_PKCS8_B64)
            .expect("decode test key DER"),
    ));
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let server_cfg = rustls::ServerConfig::builder_with_provider(Arc::clone(&provider))
        .with_safe_default_protocol_versions()
        .expect("server TLS versions")
        .with_no_client_auth()
        .with_single_cert(vec![cert.clone()], key)
        .expect("server single cert");
    let mut roots = rustls::RootCertStore::empty();
    roots.add(cert).expect("add custom root cert");
    let client_cfg = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("client TLS versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
    (
        TlsAcceptor::from(Arc::new(server_cfg)),
        Arc::new(client_cfg),
    )
}

type ConfigMutation = fn(&mut SipDialConfig);

fn detached_call_handle() -> (
    SipCallHandle,
    mpsc::Receiver<SignalingCommand>,
    watch::Sender<SipCallState>,
) {
    let (cmd_tx, cmd_rx) = mpsc::channel(1);
    let (state_tx, state_rx) = watch::channel(SipCallState::Dialing);
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0);
    let handle = SipCallHandle {
        call_id: "detached".to_owned(),
        local_sip_addr: addr,
        local_rtp_addr: addr,
        media_state: Arc::new(Mutex::new(OutboundMediaState::default())),
        cmd_tx,
        state_rx,
        discarded_early_rtp: Arc::new(AtomicU64::new(0)),
        sent_rtp_packets: Arc::new(AtomicU64::new(0)),
        _lifeline: Arc::new(SessionLifeline {
            cancel: CancellationToken::new(),
        }),
    };
    (handle, cmd_rx, state_tx)
}

#[test]
fn late_voice_frames_are_discarded_while_remotely_held() {
    let (handle, _, _) = detached_call_handle();
    let offer =
        parse_sdp_answer("v=0\r\nc=IN IP4 127.0.0.1\r\nm=audio 9000 RTP/AVP 0\r\na=sendonly\r\n")
            .unwrap();
    apply_remote_media(&handle.media_state, offer);
    handle.enqueue_pcmu_frames(vec![[0x11; PCMU_FRAME_BYTES]; 5]);
    let snapshot = handle.clear_outbound_audio();
    assert_eq!(snapshot.cleared_frames, 0);
    assert_eq!(snapshot.discarded_frames, 5);
    assert!(!handle.has_pending_outbound_media());
}

#[test]
fn sentence_trim_uses_the_current_queue_position() {
    let (handle, _, _) = detached_call_handle();
    handle.enqueue_pcmu_frames(vec![[0x11; PCMU_FRAME_BYTES]; 5]);
    handle.enqueue_pcmu_frames(vec![[0x22; PCMU_FRAME_BYTES]; 5]);
    let snapshot = handle.outbound_playback_state();
    assert_eq!(snapshot.cleared_frames, 10);
    lock_unpoisoned(&handle.media_state).voice_queue.pop_front();
    handle.trim_outbound_audio(10, 0, 5);
    let state = lock_unpoisoned(&handle.media_state);
    assert_eq!(state.voice_queue.len(), 4);
    assert!(state
        .voice_queue
        .iter()
        .all(|frame| *frame == [0x11; PCMU_FRAME_BYTES]));
}

#[test]
fn dial_config_validation_rejects_blank_fields_and_header_injection() {
    let base = SipDialConfig::new(
        "sip.example.test",
        5060,
        SipTransportKind::Udp,
        "+15551112222",
        "+15553334444",
    );
    assert!(base.validate().is_ok());
    let mut blank_domain = base.clone();
    blank_domain.domain = "  ".to_owned();
    assert_eq!(blank_domain.effective_domain(), "sip.example.test");

    let cases: [(ConfigMutation, &str); 7] = [
        (
            |cfg| cfg.server_host = " ".to_owned(),
            "server_host must not be empty",
        ),
        (|cfg| cfg.server_port = 0, "server_port must be non-zero"),
        (
            |cfg| cfg.caller_id = String::new(),
            "caller_id must not be empty",
        ),
        (
            |cfg| cfg.target_number = "\t".to_owned(),
            "target_number must not be empty",
        ),
        (
            |cfg| cfg.username = "alice\r\nX-Injected: 1".to_owned(),
            "username contains forbidden control characters",
        ),
        (
            |cfg| cfg.display_name = "Agent\nBob".to_owned(),
            "display_name contains forbidden control characters",
        ),
        (
            |cfg| cfg.domain = "example.test\0".to_owned(),
            "domain contains forbidden control characters",
        ),
    ];
    for (mutate, expected) in cases {
        let mut config = base.clone();
        mutate(&mut config);
        let err = config.validate().expect_err(expected);
        assert!(
            matches!(err, SipError::InvalidConfig(ref msg) if msg == expected),
            "{err:?}",
        );
    }
}

#[test]
fn digest_kv_parser_handles_spacing_escapes_and_malformed_params() {
    let cases: [(&str, &[(&str, &str)]); 6] = [
        (
            r#"realm = "a\"b\\c" , nonce= n1,,opaque="o""#,
            &[("realm", r#"a"b\c"#), ("nonce", "n1"), ("opaque", "o")],
        ),
        (
            "flag stray, bare,=orphan, realm=r, tail ",
            &[("realm", "r")],
        ),
        (r#"realm="unterminated\"#, &[("realm", "unterminated")]),
        ("nonce=", &[("nonce", "")]),
        ("realm=x, foo", &[("realm", "x")]),
        ("realm=x, ", &[("realm", "x")]),
    ];
    for (input, expected) in cases {
        let expected: Vec<(String, String)> = expected
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        assert_eq!(parse_digest_kv_pairs(input), expected, "input={input:?}");
    }
}

#[test]
fn digest_challenge_parser_reads_sha256_sess_and_stale_and_rejects_unsupported() {
    let challenge = parse_digest_challenge(
        r#"digest realm="r", nonce="n", qop="auth,,auth-int", algorithm=sha-256-SESS, stale=TRUE, domain="sip:x""#,
    )
    .expect("valid SHA-256-sess challenge");
    assert_eq!(
        challenge,
        DigestChallenge {
            realm: "r".to_owned(),
            nonce: "n".to_owned(),
            opaque: None,
            qop_options: vec!["auth".to_owned(), "auth-int".to_owned()],
            algorithm: DigestAlgorithm::Sha256Sess,
            stale: true,
        },
    );
    let fresh = parse_digest_challenge(r#"Digest realm="r", nonce="n", stale=false"#)
        .expect("valid MD5 challenge");
    assert!(!fresh.stale);
    assert_eq!(fresh.algorithm, DigestAlgorithm::Md5);

    for (header, expected) in [
        ("Digest   ", "empty Digest challenge"),
        (r#"Basic realm="x""#, "authenticate header is not Digest"),
        ("Dig", "authenticate header is not Digest"),
        (
            r#"Digest realm="r", nonce="n", algorithm=SHA-512"#,
            "unsupported Digest algorithm 'SHA-512'",
        ),
        (r#"Digest nonce="n""#, "Digest challenge missing realm"),
        (r#"Digest realm="r""#, "Digest challenge missing nonce"),
    ] {
        let err = parse_digest_challenge(header).expect_err(header);
        assert!(
            matches!(err, SipError::Protocol(ref msg) if msg == expected),
            "{header}: {err:?}",
        );
    }
}

#[test]
fn digest_response_handles_legacy_session_and_auth_int_variants() {
    let secret = random_hex_token(16);
    let creds = DigestCredentials {
        username: "alice",
        password: &secret,
        method: "INVITE",
        digest_uri: "sip:bob@example.test",
        entity_body: b"v=0\r\n",
        cnonce: "c0ffee",
        nonce_count: 2,
    };
    let challenge = |qop: &[&str], algorithm: DigestAlgorithm| DigestChallenge {
        realm: "example.test".to_owned(),
        nonce: "n0nce".to_owned(),
        opaque: None,
        qop_options: qop.iter().map(|q| (*q).to_owned()).collect(),
        algorithm,
        stale: false,
    };
    let ha1 = md5_hex(format!("alice:example.test:{secret}").as_bytes());
    let ha2 = md5_hex(b"INVITE:sip:bob@example.test");

    let legacy = challenge(&[], DigestAlgorithm::Md5);
    let (legacy_resp, legacy_qop) =
        compute_digest_response(&legacy, &creds).expect("RFC 2069 digest");
    assert_eq!(legacy_qop, None);
    assert_eq!(
        legacy_resp,
        md5_hex(format!("{ha1}:n0nce:{ha2}").as_bytes()),
    );
    let legacy_header = build_digest_authorization_header(&legacy, &creds).expect("legacy header");
    assert!(
        legacy_header.ends_with(&format!(r#"response="{legacy_resp}", algorithm=MD5"#)),
        "{legacy_header}",
    );

    let sess = challenge(&[], DigestAlgorithm::Md5Sess);
    let sess_ha1 = md5_hex(format!("{ha1}:n0nce:c0ffee").as_bytes());
    let (sess_resp, sess_qop) = compute_digest_response(&sess, &creds).expect("MD5-sess digest");
    assert_eq!(sess_qop, None);
    assert_eq!(
        sess_resp,
        md5_hex(format!("{sess_ha1}:n0nce:{ha2}").as_bytes()),
    );
    let sess_header = build_digest_authorization_header(&sess, &creds).expect("sess header");
    assert!(
        sess_header.ends_with(r#", algorithm=MD5-sess, cnonce="c0ffee""#),
        "{sess_header}",
    );

    let auth_int = challenge(&["auth-int"], DigestAlgorithm::Sha256);
    let sha_ha1 = sha256_hex(format!("alice:example.test:{secret}").as_bytes());
    let sha_ha2 =
        sha256_hex(format!("INVITE:sip:bob@example.test:{}", sha256_hex(b"v=0\r\n")).as_bytes());
    let (int_resp, int_qop) = compute_digest_response(&auth_int, &creds).expect("auth-int digest");
    assert_eq!(int_qop, Some("auth-int"));
    assert_eq!(
        int_resp,
        sha256_hex(format!("{sha_ha1}:n0nce:00000002:c0ffee:auth-int:{sha_ha2}").as_bytes()),
    );

    let err = compute_digest_response(&challenge(&["auth-conf"], DigestAlgorithm::Md5), &creds)
        .expect_err("unsupported qop");
    assert!(
        matches!(err, SipError::Protocol(ref msg) if msg.contains("auth-conf")),
        "{err:?}",
    );
    let no_cnonce = DigestCredentials {
        cnonce: "",
        ..creds
    };
    let err = compute_digest_response(&challenge(&["auth"], DigestAlgorithm::Md5), &no_cnonce)
        .expect_err("qop requires cnonce");
    assert!(matches!(err, SipError::InvalidConfig(_)), "{err:?}");
    assert!(compute_digest_response(&legacy, &no_cnonce).is_ok());
}

#[test]
fn sdp_answer_parser_skips_malformed_lines_and_rejects_disabled_audio() {
    let answer = "v=0\r\n\r\n\
        c=ATM NSAP 47.0005\r\n\
        c=IN IPX 10.0.0.1\r\n\
        m=audio 4000 RTP/AVP 0 abc 101\r\n\
        c=IN IP6 ::1\r\n\
        a=rtpmap:abc telephone-event/8000\r\n\
        a=rtpmap:101\r\n\
        a=rtpmap:101 telephone-event/8000\r\n";
    let parsed = parse_sdp_answer(answer).expect("valid IPv6 SDP answer");
    assert_eq!(parsed.remote_media_ip, IpAddr::V6(Ipv6Addr::LOCALHOST));
    assert_eq!(parsed.remote_audio_port, 4000);
    assert_eq!(parsed.negotiated_dtmf_pt, Some(101));

    for (conn, expected) in [
        (
            "IN IP4 10.0.0.1/127",
            Some(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))),
        ),
        ("in ip6 ::1", Some(IpAddr::V6(Ipv6Addr::LOCALHOST))),
        ("ATM NSAP 47.0005", None),
        ("IN IPX 10.0.0.1", None),
        ("IN IP4", None),
        ("IN IP4 not-an-ip", None),
    ] {
        assert_eq!(parse_sdp_connection_ip(conn), expected, "c={conn}");
    }

    let rejected = parse_sdp_answer("v=0\r\nc=IN IP4 127.0.0.1\r\nm=audio 0 RTP/AVP 0\r\n")
        .expect_err("port 0 disables audio");
    assert!(
        matches!(rejected, SipError::Protocol(ref msg) if msg.contains("port 0")),
        "{rejected:?}",
    );
    let missing_ip = parse_sdp_answer("v=0\r\nc=ATM NSAP 1\r\nm=audio 4000 RTP/AVP 0\r\n")
        .expect_err("no usable connection address");
    assert!(
        matches!(missing_ip, SipError::Protocol(ref msg) if msg.contains("missing c=")),
        "{missing_ip:?}",
    );
}

#[test]
fn rtp_parser_honours_csrc_extension_and_padding_bounds() {
    let base = build_rtp_packet(true, PCMU_PAYLOAD_TYPE, 7, 160, 0xABCD, &[]);
    let with_header = |first: u8, tail: &[u8]| {
        let mut packet = base.clone();
        packet[0] = first;
        packet.extend_from_slice(tail);
        packet
    };

    let csrc = with_header(0x81, &[9, 9, 9, 9, 1, 2]);
    let parsed = parse_rtp_packet(&csrc).expect("CSRC packet");
    assert!(parsed.marker);
    assert_eq!(
        (
            parsed.payload_type,
            parsed.sequence_number,
            parsed.timestamp,
            parsed.ssrc
        ),
        (PCMU_PAYLOAD_TYPE, 7, 160, 0xABCD),
    );
    assert_eq!(parsed.payload, &[1, 2]);

    let valid: [(&str, Vec<u8>, &[u8]); 2] = [
        (
            "header extension",
            with_header(0x90, &[0xBE, 0xDE, 0, 1, 7, 7, 7, 7, 5, 6]),
            &[5, 6],
        ),
        ("padding", with_header(0xA0, &[5, 6, 0, 0, 3]), &[5, 6]),
    ];
    for (label, packet, payload) in valid {
        let parsed = parse_rtp_packet(&packet).expect(label);
        assert_eq!(parsed.payload, payload, "{label}");
    }

    let invalid: [(&str, Vec<u8>); 6] = [
        ("shorter than fixed header", base[..11].to_vec()),
        ("RTP version 1", with_header(0x40, &[1])),
        ("CSRC list past end", with_header(0x8F, &[1, 2, 3, 4])),
        (
            "truncated header extension",
            with_header(0x90, &[0xBE, 0xDE, 0, 2, 7, 7, 7, 7]),
        ),
        ("zero padding length", with_header(0xA0, &[5, 6, 0])),
        ("padding past payload", with_header(0xA0, &[5, 200])),
    ];
    for (label, packet) in invalid {
        assert_eq!(parse_rtp_packet(&packet), None, "{label}");
    }
}

#[test]
fn reorder_buffer_drops_unknown_late_and_duplicate_packets_and_resyncs_after_jumps() {
    let push = |reorder: &mut RtpReorderBuffer, pt: u8, seq: u16, byte: u8| {
        let packet = build_rtp_packet(
            false,
            pt,
            seq,
            u32::from(seq) * RTP_TIMESTAMP_STEP,
            7,
            &[byte; PCMU_FRAME_BYTES],
        );
        reorder
            .push_rtp_packet(&parse_rtp_packet(&packet).expect("valid RTP"))
            .iter()
            .map(|frame| (frame.sequence_number, frame.pcmu[0]))
            .collect::<Vec<_>>()
    };
    let drain = |frames: Vec<OrderedInboundPayload>| {
        frames
            .iter()
            .map(|frame| (frame.sequence_number, frame.pcmu[0]))
            .collect::<Vec<_>>()
    };
    let mut reorder = RtpReorderBuffer::default();

    assert!(
        push(&mut reorder, 8, 10, 0xAA).is_empty(),
        "PCMA is ignored",
    );
    assert!(!reorder.has_pending());
    assert!(
        push(&mut reorder, DEFAULT_TELEPHONE_EVENT_PT, 10, 0x01).is_empty(),
        "a leading telephone-event anchors the sequence without audio",
    );
    assert!(push(&mut reorder, PCMU_PAYLOAD_TYPE, 12, 0x12).is_empty());
    assert!(reorder.has_pending());
    assert!(push(&mut reorder, PCMU_PAYLOAD_TYPE, 12, 0x99).is_empty());
    assert!(push(&mut reorder, PCMU_PAYLOAD_TYPE, 9, 0x09).is_empty());

    assert_eq!(
        drain(reorder.flush_expired()),
        vec![(11, PCMU_SILENCE_BYTE), (12, 0x12)],
        "flush fills the gap and keeps the first copy of a duplicate",
    );
    assert!(reorder.flush_expired().is_empty());

    assert!(push(&mut reorder, PCMU_PAYLOAD_TYPE, 14, 0x14).is_empty());
    assert_eq!(
        push(&mut reorder, PCMU_PAYLOAD_TYPE, 100, 0x64),
        vec![(13, PCMU_SILENCE_BYTE), (14, 0x14), (100, 0x64)],
        "a large jump flushes buffered audio before resyncing",
    );
    assert!(push(&mut reorder, DEFAULT_TELEPHONE_EVENT_PT, 5000, 0x01).is_empty());
    assert!(!reorder.has_pending());
    assert_eq!(
        push(&mut reorder, PCMU_PAYLOAD_TYPE, 5001, 0x51),
        vec![(5001, 0x51)],
    );
}

#[test]
fn sip_parser_unfolds_headers_accepts_compact_forms_and_enforces_framing_limits() {
    assert_eq!(parse_sip_datagram(b"\r\n\r\n").expect("keepalive"), None);
    let unterminated = parse_sip_datagram(b"\r\nOPTIONS sip:a SIP/2.0\r\nVia: x");
    assert!(
        matches!(unterminated, Err(SipError::Protocol(ref msg)) if msg.contains("CRLFCRLF")),
        "{unterminated:?}",
    );

    let folded = parse_sip_datagram(
        b"\nMESSAGE sip:a@b SIP/2.0\nSubject: first\n  second\n\tthird\nmalformed-line\nc: text/plain\nl: 3\n\nhey-extra",
    )
    .expect("parse folded message")
    .expect("message present");
    assert_eq!(
        folded.start_line,
        SipStartLine::Request {
            method: "MESSAGE".to_owned(),
            uri: "sip:a@b".to_owned(),
        },
    );
    assert_eq!(folded.headers.len(), 3);
    assert_eq!(folded.first_header("Subject"), Some("first second third"));
    assert_eq!(folded.first_header("Content-Type"), Some("text/plain"));
    assert_eq!(folded.first_header("Content-Length"), Some("3"));
    assert_eq!(folded.body, b"hey");

    let unframed = parse_sip_datagram(b"OPTIONS sip:a SIP/2.0\r\nVia: x\r\n\r\nbody")
        .expect("parse")
        .expect("message present");
    assert_eq!(unframed.body, b"body");

    let orphan =
        parse_sip_headers_section(b"OPTIONS sip:a SIP/2.0\r\n orphan-continuation\r\n\r\nVia: x")
            .expect("headers");
    assert_eq!(orphan.headers, vec![("Via".to_owned(), "x".to_owned())]);
    assert_eq!(orphan.content_length, None);

    let version = parse_sip_start_line("OPTIONS sip:a SIP/3.0");
    assert!(
        matches!(version, Err(SipError::Protocol(ref msg)) if msg.contains("SIP/3.0")),
        "{version:?}",
    );

    let mut unterminated_stream = vec![b'a'; MAX_SIP_HEADER_BYTES + 1];
    let mut long_headers = b"OPTIONS sip:a SIP/2.0\r\nX-Pad: ".to_vec();
    long_headers.extend(vec![b'a'; MAX_SIP_HEADER_BYTES]);
    long_headers.extend_from_slice(b"\r\nContent-Length: 0\r\n\r\n");
    for (label, buf) in [
        ("unterminated", &mut unterminated_stream),
        ("terminated", &mut long_headers),
    ] {
        let result = try_extract_stream_sip_message(buf);
        assert!(
            matches!(result, Err(SipError::Protocol(ref msg)) if msg == "SIP stream headers exceed maximum size"),
            "{label}: {result:?}",
        );
    }
    let mut huge_body = format!(
        "OPTIONS sip:a SIP/2.0\r\nContent-Length: {}\r\n\r\n",
        MAX_SIP_BODY_BYTES + 1,
    )
    .into_bytes();
    let result = try_extract_stream_sip_message(&mut huge_body);
    assert!(
        matches!(result, Err(SipError::Protocol(ref msg)) if msg.contains("exceeds maximum")),
        "{result:?}",
    );
}

#[test]
fn header_helpers_split_quoted_lists_extract_uris_and_escape_values() {
    for (header, expected) in [
        (
            "<sip:alice@example.test>;tag=1",
            Some("sip:alice@example.test"),
        ),
        (
            r#""Bob" <sips:bob@example.test;transport=tls>"#,
            Some("sips:bob@example.test;transport=tls"),
        ),
        (
            "sip:carol@example.test;expires=60",
            Some("sip:carol@example.test"),
        ),
        ("sips:dave@example.test", Some("sips:dave@example.test")),
        ("<>", None),
        ("tel:+15551234567", None),
    ] {
        assert_eq!(
            extract_sip_uri(header).as_deref(),
            expected,
            "header={header:?}",
        );
    }

    assert_eq!(
        split_comma_outside_angles(r#""A, \"B\" <x>" <sip:a@x>,<sip:b,c@y>, sip:z\q"#),
        vec![r#""A, \"B\" <x>" <sip:a@x>"#, "<sip:b,c@y>", r" sip:z\q"],
    );

    let routed = SipMessage {
        start_line: SipStartLine::Response {
            status_code: 200,
            reason: "OK".to_owned(),
        },
        headers: vec![
            (
                "Record-Route".to_owned(),
                "<sip:p1;lr>, ,<sip:p2;lr>".to_owned(),
            ),
            ("Record-Route".to_owned(), "<sip:p3;lr>".to_owned()),
        ],
        body: Vec::new(),
    };
    assert_eq!(
        extract_reversed_record_routes(&routed),
        vec!["<sip:p3;lr>", "<sip:p2;lr>", "<sip:p1;lr>"],
    );

    assert_eq!(
        escape_quoted_string(r#"say "hi" \o/"#),
        r#"say \"hi\" \\o/"#,
    );
}

#[tokio::test]
async fn call_handle_spaces_dtmf_digits_and_tolerates_closed_signaling_channels() {
    let (handle, cmd_rx, state_tx) = detached_call_handle();
    handle.enqueue_pcmu_frames(Vec::new());
    handle.enqueue_rfc4733_dtmf(DEFAULT_TELEPHONE_EVENT_PT, Vec::new());
    assert!(!handle.has_pending_outbound_media());

    handle.enqueue_rfc4733_dtmf(
        DEFAULT_TELEPHONE_EVENT_PT,
        vec![
            [1, 10, 0x00, 0xA0],
            [1, 0x80 | 10, 0x01, 0x40],
            [2, 10, 0x00, 0xA0],
            [2, 0x80 | 10, 0x01, 0x40],
        ],
    );
    assert!(handle.has_pending_outbound_media());
    let steps: Vec<Option<(u8, bool)>> = lock_unpoisoned(&handle.media_state)
        .dtmf_queue
        .iter()
        .map(|step| match step {
            QueuedDtmfStep::Packet {
                payload,
                first_of_digit,
                ..
            } => Some((payload[0], *first_of_digit)),
            QueuedDtmfStep::InterDigitSilence => None,
        })
        .collect();
    assert_eq!(
        steps,
        vec![
            Some((1, true)),
            Some((1, false)),
            None,
            None,
            Some((2, true)),
            Some((2, false)),
            None,
            None,
        ],
        "each digit restarts its event and is separated by inter-digit silence",
    );

    drop(cmd_rx);
    handle
        .hangup()
        .await
        .expect("hangup after the signaling loop exited is a no-op");

    state_tx
        .send(SipCallState::Ended {
            reason: "remote_bye".to_owned(),
            failure: None,
        })
        .expect("publish ended state");
    let ended = handle
        .wait_for_connected()
        .await
        .expect_err("ended call never connects");
    assert!(
        matches!(ended, SipError::Closed(ref reason) if reason == "remote_bye"),
        "{ended:?}",
    );

    let (dialing, _dialing_cmd_rx, dialing_state_tx) = detached_call_handle();
    drop(dialing_state_tx);
    let exited = dialing
        .wait_for_connected()
        .await
        .expect_err("dropped state channel ends the wait");
    assert!(
        matches!(exited, SipError::Closed(ref reason) if reason == "SIP signaling task exited"),
        "{exited:?}",
    );
}

#[tokio::test]
async fn udp_transport_binds_loopback_only_for_loopback_servers() {
    for host in ["192.0.2.10", "2001:db8::10", "::1"] {
        let config = SipDialConfig::new(
            host,
            5060,
            SipTransportKind::Udp,
            "+15551112222",
            "+15553334444",
        );
        let expected_remote = SocketAddr::new(host.parse().expect("literal IP"), 5060);
        match SipTransport::connect(&config).await {
            Ok((_transport, local, remote)) => {
                assert_eq!(remote, expected_remote);
                assert_eq!(local.is_ipv6(), remote.is_ipv6(), "{host}");
                assert_eq!(
                    local.ip().is_loopback(),
                    remote.ip().is_loopback(),
                    "{host}",
                );
            }
            // Hosts without a route (or IPv6) for this family fail at bind/connect time.
            Err(err) => assert!(matches!(err, SipError::Io(_)), "{host}: {err:?}"),
        }
    }
}

#[tokio::test]
async fn tls_peer_close_before_answer_ends_call_with_transport_failure() {
    let (acceptor, client_tls_cfg) = localhost_tls_configs();
    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("bind TLS listener");
    let server_addr = listener.local_addr().expect("TLS listener addr");

    let server_task = tokio::spawn(async move {
        let (tcp, _) = timeout(TEST_TIMEOUT, listener.accept())
            .await
            .expect("accept timeout")
            .expect("accept TCP");
        let mut tls = timeout(TEST_TIMEOUT, acceptor.accept(tcp))
            .await
            .expect("TLS accept timeout")
            .expect("TLS accept");
        let mut buf = Vec::new();
        let invite = read_one_tls_sip_message(&mut tls, &mut buf).await;
        assert!(invite.starts_with("INVITE sip:+15557778888@localhost SIP/2.0\r\n"));
        tls.shutdown().await.expect("send TLS close_notify");
        tls
    });

    let config = SipDialConfig::new(
        "127.0.0.1",
        server_addr.port(),
        SipTransportKind::Tls,
        "+15550001111",
        "+15557778888",
    )
    .with_domain("localhost")
    .with_tls_server_name("localhost")
    .with_custom_tls_config(client_tls_cfg);
    let session = SipCallSession::dial(config).await.expect("dial TLS");
    let err = timeout(TEST_TIMEOUT, session.wait_for_connected())
        .await
        .expect("transport failure timeout")
        .expect_err("closed TLS stream ends the call");
    assert!(
        matches!(
            err,
            SipError::Closed(ref text)
                if text == "transport_error: SIP session closed: SIP TLS stream closed by peer"
        ),
        "{err:?}",
    );
    let _closed_server_stream = server_task.await.expect("TLS server finished");
}

async fn dial_against_challenges(
    username: &str,
    challenges: Vec<String>,
) -> (SipError, Vec<String>) {
    let (trunk_sip, trunk_addr) = bind_loopback_udp().await;
    let server_task = tokio::spawn(async move {
        let mut invites = Vec::new();
        for challenge in challenges {
            let (invite, client) = recv_udp_text(&trunk_sip).await;
            let response = format!(
                "SIP/2.0 {challenge}\r\nVia: {}\r\nFrom: {}\r\nTo: {};tag=auth\r\nCall-ID: {}\r\nCSeq: {}\r\nContent-Length: 0\r\n\r\n",
                extract_header(&invite, "Via:"),
                extract_header(&invite, "From:"),
                extract_header(&invite, "To:"),
                extract_header(&invite, "Call-ID:"),
                extract_header(&invite, "CSeq:"),
            );
            send_udp_text(&trunk_sip, &response, client).await;
            let (ack, _) = recv_udp_text(&trunk_sip).await;
            assert!(ack.starts_with("ACK "), "{ack}");
            invites.push(invite);
        }
        invites
    });
    let mut config = SipDialConfig::new(
        "127.0.0.1",
        trunk_addr.port(),
        SipTransportKind::Udp,
        "+15551112222",
        "+15553334444",
    );
    if !username.is_empty() {
        config = config.with_credentials(username, random_hex_token(16));
    }
    let session = SipCallSession::dial(config).await.expect("dial");
    let err = timeout(TEST_TIMEOUT, session.wait_for_connected())
        .await
        .expect("auth outcome timeout")
        .expect_err("authentication must fail");
    (err, server_task.await.expect("mock trunk"))
}

#[tokio::test]
async fn udp_digest_auth_stops_without_credentials_unsupported_schemes_or_repeated_challenges() {
    let digest = |nonce: &str, stale: bool| {
        format!(
            "401 Unauthorized\r\nWWW-Authenticate: Digest realm=\"trunk.test\", nonce=\"{nonce}\", qop=\"auth\", stale={stale}",
        )
    };
    let is_auth_failure = |err: &SipError, code: u16, expected_reason: &str| {
        matches!(
            err,
            SipError::AuthFailed { status_code, reason }
                if *status_code == code && reason == expected_reason,
        )
    };

    let (err, invites) = dial_against_challenges("", vec![digest("n1", false)]).await;
    assert!(is_auth_failure(&err, 401, "Unauthorized"), "{err:?}");
    assert_eq!(invites.len(), 1, "no credentials means no retry");

    let (err, invites) = dial_against_challenges(
        "alice",
        vec![
            "407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"trunk.test\""
                .to_owned(),
        ],
    )
    .await;
    assert!(
        is_auth_failure(&err, 407, "missing supported Digest challenge"),
        "{err:?}",
    );
    assert_eq!(invites.len(), 1);

    let (err, invites) =
        dial_against_challenges("alice", vec![digest("n1", false), digest("n2", false)]).await;
    assert!(is_auth_failure(&err, 401, "Unauthorized"), "{err:?}");
    assert_eq!(
        invites.len(),
        2,
        "a fresh challenge after credentials is final",
    );
    assert!(extract_header(&invites[1], "Authorization:").contains(r#"nonce="n1""#));

    let (err, invites) = dial_against_challenges(
        "alice",
        vec![digest("n1", false), digest("n2", true), digest("n3", true)],
    )
    .await;
    assert!(is_auth_failure(&err, 401, "Unauthorized"), "{err:?}");
    assert_eq!(
        invites.len(),
        3,
        "stale nonces retry until the attempt limit",
    );
    assert!(invites[2].contains("CSeq: 3 INVITE\r\n"));
    assert!(extract_header(&invites[2], "Authorization:").contains(r#"nonce="n2""#));
}

#[tokio::test]
async fn pre_answer_hangup_ignores_unrelated_cancel_drain_traffic_without_487() {
    let (trunk_sip, trunk_addr) = bind_loopback_udp().await;
    let server_task = tokio::spawn(async move {
        let (invite, client) = recv_udp_text(&trunk_sip).await;
        let via = extract_header(&invite, "Via:");
        let from = extract_header(&invite, "From:");
        let to = extract_header(&invite, "To:");
        let call_id = extract_header(&invite, "Call-ID:");
        send_udp_text(
            &trunk_sip,
            &format!("SIP/2.0 180 Ringing\r\nVia: {via}\r\nFrom: {from}\r\nTo: {to};tag=ring\r\nCall-ID: {call_id}\r\nCSeq: 1 INVITE\r\nContent-Length: 0\r\n\r\n"),
            client,
        )
        .await;
        let (cancel, _) = recv_udp_text(&trunk_sip).await;
        assert!(cancel.starts_with("CANCEL "), "{cancel}");
        send_udp_text(
            &trunk_sip,
            &format!("OPTIONS sip:caller@{client} SIP/2.0\r\nVia: SIP/2.0/UDP {trunk_addr};branch=z9hG4bKdrain\r\nCall-ID: {call_id}\r\nCSeq: 5 OPTIONS\r\nContent-Length: 0\r\n\r\n"),
            client,
        )
        .await;
        send_udp_text(
            &trunk_sip,
            &format!("SIP/2.0 481 Call/Transaction Does Not Exist\r\nVia: {via}\r\nFrom: {from}\r\nTo: {to};tag=ring\r\nCall-ID: {call_id}\r\nCSeq: 1 CANCEL\r\nContent-Length: 0\r\n\r\n"),
            client,
        )
        .await;
        let mut buf = vec![0_u8; 2048];
        assert!(
            timeout(Duration::from_millis(400), trunk_sip.recv_from(&mut buf))
                .await
                .is_err(),
            "without a final INVITE response there is nothing to ACK",
        );
    });

    let config = SipDialConfig::new(
        "127.0.0.1",
        trunk_addr.port(),
        SipTransportKind::Udp,
        "+15551110000",
        "+15550009999",
    );
    let mut session = SipCallSession::dial(config).await.expect("dial");
    let ringing = timeout(TEST_TIMEOUT, session.next_event())
        .await
        .expect("ringing timeout")
        .expect("ringing event");
    assert_eq!(ringing, SipCallEvent::Ringing);
    session
        .hangup()
        .await
        .expect("CANCEL drain tolerates a missing 487");
    let ended = timeout(TEST_TIMEOUT, session.next_event())
        .await
        .expect("ended timeout")
        .expect("ended event");
    assert_eq!(
        ended,
        SipCallEvent::Ended {
            reason: "local_hangup".to_owned()
        },
    );
    assert_eq!(
        session.state(),
        SipCallState::Ended {
            reason: "local_hangup".to_owned(),
            failure: None
        },
    );
    server_task.await.expect("mock trunk verified CANCEL drain");
}

#[tokio::test]
async fn udp_dialog_ignores_stray_traffic_rejects_mismatched_requests_and_tracks_media_hold() {
    let (trunk_sip, trunk_addr) = bind_loopback_udp().await;
    let (trunk_rtp, trunk_rtp_addr) = bind_loopback_udp().await;
    let rtp_port = trunk_rtp_addr.port();

    let server_task = tokio::spawn(async move {
        let (invite, client) = recv_udp_text(&trunk_sip).await;
        let via = extract_header(&invite, "Via:");
        let from = extract_header(&invite, "From:");
        let to = extract_header(&invite, "To:");
        let call_id = extract_header(&invite, "Call-ID:");
        let from_tag = header_tag(&from).expect("INVITE From tag").to_owned();
        let client_rtp = SocketAddr::new(
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            extract_sdp_audio_port(&invite),
        );
        let response = |status: &str, cseq: &str, body: &str| {
            let content_type = if body.is_empty() {
                ""
            } else {
                "Content-Type: application/sdp\r\n"
            };
            format!(
                "SIP/2.0 {status}\r\nVia: {via}\r\nFrom: {from}\r\nTo: {to};tag=uas1\r\nCall-ID: {call_id}\r\nCSeq: {cseq}\r\nContact: <sip:uas@{trunk_addr}>\r\n{content_type}Content-Length: {}\r\n\r\n{body}",
                body.len(),
            )
        };
        let request = |method: &str, cseq: u32, contact: &str, body: &str| {
            let content_type = if body.is_empty() {
                ""
            } else {
                "Content-Type: application/sdp\r\n"
            };
            format!(
                "{method} sip:caller@{client} SIP/2.0\r\nVia: SIP/2.0/UDP {trunk_addr};branch=z9hG4bK{method}{cseq}\r\nFrom: {to};tag=uas1\r\nTo: {from}\r\nCall-ID: {call_id}\r\nCSeq: {cseq} {method}\r\n{contact}{content_type}Content-Length: {}\r\n\r\n{body}",
                body.len(),
            )
        };
        let probe = |branch: &str, headers: &str| {
            format!(
                "OPTIONS sip:caller@{client} SIP/2.0\r\nVia: SIP/2.0/UDP {trunk_addr};branch=z9hG4bK{branch}\r\n{headers}Content-Length: 0\r\n\r\n",
            )
        };
        let mut rtp_buf = vec![0_u8; 2048];

        // Stray traffic before the final response must not disturb the INVITE transaction.
        for stray in [
            "\r\n\r\n".to_owned(),
            format!("SIP/2.0 100 Trying\r\nVia: {via}\r\nContent-Length: 0\r\n\r\n"),
            response("200 OK", "1 OPTIONS", ""),
            response("486 Busy Here", "9 INVITE", ""),
            request("INVITE", 1, "", ""),
            response("099 Unknown", "1 INVITE", ""),
            response(
                "200 OK",
                "1 INVITE",
                &trunk_sdp("127.0.0.1", rtp_port, "sendonly"),
            ),
        ] {
            send_udp_text(&trunk_sip, &stray, client).await;
        }
        let (ack, _) = recv_udp_text(&trunk_sip).await;
        assert!(
            ack.starts_with(&format!("ACK sip:uas@{trunk_addr} SIP/2.0\r\n")),
            "{ack}",
        );
        assert!(
            timeout(
                Duration::from_millis(120),
                trunk_rtp.recv_from(&mut rtp_buf)
            )
            .await
            .is_err(),
            "a sendonly answer holds outbound RTP",
        );
        send_udp_text(&trunk_sip, &response("180 Ringing", "1 INVITE", ""), client).await;

        let reinvite = request("INVITE", 2, "", "");
        for mismatched in [
            reinvite.replace(&call_id, "other-call-id"),
            reinvite.replace(&from_tag, "wrong-local-tag"),
            reinvite.replace("tag=uas1", "tag=wrong-remote-tag"),
        ] {
            send_udp_text(&trunk_sip, &mismatched, client).await;
            let (rejected, _) = recv_udp_text(&trunk_sip).await;
            assert!(
                rejected.starts_with("SIP/2.0 481 Call/Transaction Does Not Exist\r\n"),
                "{rejected}",
            );
        }

        let update = request("UPDATE", 2, "", "");
        send_udp_text(
            &trunk_sip,
            &update.replace("CSeq: 2 UPDATE\r\n", ""),
            client,
        )
        .await;
        send_udp_text(&trunk_sip, &update, client).await;
        let (refresh, _) = recv_udp_text(&trunk_sip).await;
        assert!(
            refresh.starts_with("SIP/2.0 200 OK\r\n") && refresh.contains("CSeq: 2 UPDATE\r\n"),
            "{refresh}",
        );
        assert!(!refresh.contains("Content-Type:"), "{refresh}");
        send_udp_text(&trunk_sip, &reinvite, client).await;
        let (out_of_order, _) = recv_udp_text(&trunk_sip).await;
        assert!(
            out_of_order.starts_with("SIP/2.0 500 CSeq Out of Order\r\n")
                && out_of_order.contains("CSeq: 2 INVITE\r\n"),
            "{out_of_order}",
        );

        send_udp_text(&trunk_sip, &request("INVITE", 3, "", ""), client).await;
        let (offer, _) = recv_udp_text(&trunk_sip).await;
        assert!(
            offer.starts_with("SIP/2.0 200 OK\r\n") && offer.contains("m=audio "),
            "{offer}",
        );
        let foreign_ack = request("ACK", 3, "", &trunk_sdp("127.0.0.1", rtp_port, "inactive"))
            .replace(&call_id, "other-call-id");
        send_udp_text(&trunk_sip, &foreign_ack, client).await;
        send_udp_text(
            &trunk_sip,
            &request("ACK", 3, "", &trunk_sdp("127.0.0.1", rtp_port, "sendrecv")),
            client,
        )
        .await;
        send_udp_text(
            &trunk_sip,
            &probe("probe1", "To: <sip:probe@trunk.test>\r\n"),
            client,
        )
        .await;
        let (tagged, _) = recv_udp_text(&trunk_sip).await;
        assert!(tagged.starts_with("SIP/2.0 200 OK\r\n"), "{tagged}");
        assert!(
            tagged.contains(&format!("To: <sip:probe@trunk.test>;tag={from_tag}\r\n")),
            "{tagged}",
        );
        assert!(
            !tagged.contains("From:") && !tagged.contains("Call-ID:") && !tagged.contains("CSeq:"),
            "{tagged}",
        );
        let (_, rtp_from) = timeout(TEST_TIMEOUT, trunk_rtp.recv_from(&mut rtp_buf))
            .await
            .expect("RTP resumes timeout")
            .expect("RTP resumes");
        assert_eq!(rtp_from, client_rtp);

        send_udp_text(
            &trunk_sip,
            &request("INVITE", 4, "", "not an sdp body"),
            client,
        )
        .await;
        let (unacceptable, _) = recv_udp_text(&trunk_sip).await;
        assert!(
            unacceptable.starts_with("SIP/2.0 488 Not Acceptable Here\r\n"),
            "{unacceptable}",
        );

        let inbound = |seq: u16, byte: u8| {
            build_rtp_packet(
                false,
                PCMU_PAYLOAD_TYPE,
                seq,
                u32::from(seq) * RTP_TIMESTAMP_STEP,
                0x0102_0304,
                &[byte; PCMU_FRAME_BYTES],
            )
        };
        let held_offers = [
            (
                5,
                trunk_sdp("127.0.0.1", rtp_port, "inactive"),
                "a=inactive\r\n",
            ),
            (
                6,
                trunk_sdp("0.0.0.0", rtp_port, "sendrecv"),
                "a=sendrecv\r\n",
            ),
        ];
        for (cseq, sdp, answer_direction) in held_offers {
            send_udp_text(&trunk_sip, &request("INVITE", cseq, "", &sdp), client).await;
            let (answer, _) = recv_udp_text(&trunk_sip).await;
            assert!(
                answer.starts_with("SIP/2.0 200 OK\r\n") && answer.contains(answer_direction),
                "{answer}",
            );
            send_udp_text(&trunk_sip, &request("INFO", 20 + cseq, "", ""), client).await;
            send_udp_text(&trunk_sip, &probe("probe2", ""), client).await;
            let (bare, _) = recv_udp_text(&trunk_sip).await;
            assert!(
                bare.starts_with("SIP/2.0 200 OK\r\n") && !bare.contains("To:"),
                "INFO is ignored and a bare OPTIONS is answered: {bare}",
            );
            let seq = u16::try_from(cseq).expect("small CSeq");
            trunk_rtp
                .send_to(&inbound(seq, 0x11), client_rtp)
                .await
                .expect("send held RTP");
            tokio::time::sleep(Duration::from_millis(30)).await;
        }

        let refreshed_contact = format!("Contact: <sip:refreshed@{trunk_addr}>\r\n");
        send_udp_text(
            &trunk_sip,
            &request(
                "INVITE",
                9,
                &refreshed_contact,
                &trunk_sdp("127.0.0.1", rtp_port, "sendrecv"),
            ),
            client,
        )
        .await;
        let (resumed, _) = recv_udp_text(&trunk_sip).await;
        assert!(resumed.starts_with("SIP/2.0 200 OK\r\n"), "{resumed}");
        send_udp_text(&trunk_sip, &probe("probe3", ""), client).await;
        let _ = recv_udp_text(&trunk_sip).await;
        trunk_rtp
            .send_to(b"junk", client_rtp)
            .await
            .expect("send non-RTP datagram");
        trunk_rtp
            .send_to(&inbound(7, 0x5A), client_rtp)
            .await
            .expect("send resumed RTP");

        let (bye, _) = recv_udp_text(&trunk_sip).await;
        assert!(
            bye.starts_with(&format!("BYE sip:refreshed@{trunk_addr} SIP/2.0\r\n")),
            "{bye}",
        );
        assert!(bye.contains("CSeq: 2 BYE\r\n"), "{bye}");
        let bye_via = extract_header(&bye, "Via:");
        // Unrelated traffic during the BYE drain is ignored and the missing 200 lets it time out.
        for stray in [
            request("OPTIONS", 30, "", ""),
            format!("SIP/2.0 100 Trying\r\nVia: {bye_via}\r\nCall-ID: {call_id}\r\nCSeq: 2 BYE\r\nContent-Length: 0\r\n\r\n"),
            response("200 OK", "9 INVITE", ""),
        ] {
            send_udp_text(&trunk_sip, &stray, client).await;
        }
        let mut sip_buf = vec![0_u8; 2048];
        assert!(
            timeout(
                Duration::from_millis(400),
                trunk_sip.recv_from(&mut sip_buf)
            )
            .await
            .is_err(),
            "requests during teardown are not answered",
        );
    });

    let mut config = SipDialConfig::new(
        "127.0.0.1",
        trunk_addr.port(),
        SipTransportKind::Udp,
        "+15551112222",
        "+15553334444",
    );
    config.keepalive_interval = Duration::ZERO;
    let mut session = SipCallSession::dial(config).await.expect("dial");
    let mut events = Vec::new();
    for _ in 0..6 {
        events.push(
            timeout(TEST_TIMEOUT, session.next_event())
                .await
                .expect("event timeout")
                .expect("event"),
        );
    }
    let hold = |on_hold| SipCallEvent::HoldChanged {
        on_hold,
        negotiated_dtmf_pt: Some(DEFAULT_TELEPHONE_EVENT_PT),
    };
    assert_eq!(
        events,
        vec![
            SipCallEvent::Connected {
                negotiated_dtmf_pt: Some(DEFAULT_TELEPHONE_EVENT_PT)
            },
            hold(true),
            hold(false),
            hold(true),
            hold(true),
            hold(false),
        ],
    );
    let frame = timeout(TEST_TIMEOUT, session.next_inbound_audio())
        .await
        .expect("inbound audio timeout")
        .expect("inbound audio");
    assert_eq!(
        (frame.rtp_sequence, frame.inbound_pcmu),
        (7, [0x5A; PCMU_FRAME_BYTES]),
        "RTP received while inactive or addressed to 0.0.0.0 is discarded",
    );

    session
        .hangup()
        .await
        .expect("hangup tolerates an unanswered BYE");
    let ended = timeout(TEST_TIMEOUT, session.next_event())
        .await
        .expect("ended timeout")
        .expect("ended event");
    assert_eq!(
        ended,
        SipCallEvent::Ended {
            reason: "local_hangup".to_owned()
        },
    );
    server_task
        .await
        .expect("mock trunk verified dialog handling");
}
