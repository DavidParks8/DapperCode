use super::{
    approval_surface_id, build_approval_modal_surface, build_live_workflow_card,
    build_post_call_report_content, callee_expects_spoken_reply,
    format_rolling_transcript_markdown, format_transcript_line, is_likely_self_echo, json,
    live_surface_id, lock_unpoisoned, mpsc, non_empty_kv_value, oneshot,
    transcript_recipient_label, truncate_utf8_tail, update_vad_ivr_mode_for_wait_silently,
    validate_bridge_ui_surface, validate_call_id, validate_start_request,
    validate_steer_instruction, Arc, AtomicUsize, BridgeQueueService, BridgeUiBlock, BridgeUiTone,
    ClientHub, Duration, HangupPhoneCallResult, HangupPhoneCallStatus, Instant, LiveCardParams,
    Ordering, PhoneCallError, PhoneCallRuntimeConfig, PhoneCallService, PhoneCallSnapshot,
    PhoneCallStatus, PhoneCallTimeouts, ResolveBridgeUiSurfaceRequest, SpokenTurnProgress,
    StartPhoneCallRequest, SteerPhoneCallStatus, TranscriptEntry, TranscriptSpeaker,
    ValidatedStartRequest, VecDeque, Weak, COMPLETED_CALL_HISTORY_LIMIT, ECHO_RECOVERY_NUDGE,
    END_CALL_QUIET_GRACE, INTERRUPTED_MARKER, MAX_CALLEE_NAME_BYTES, MAX_CALL_ID_BYTES,
    MAX_CONTEXT_BYTES, MAX_FIRST_MESSAGE_BYTES, MAX_KV_VALUE_BYTES, MAX_OBJECTIVE_BYTES,
    MAX_REPORT_BODY_BYTES, MAX_STEER_INSTRUCTION_BYTES, QUEUE_MAX_CONTENT_BYTES, RTP_FRAME_SAMPLES,
    SILENT_TURN_RETRY_NUDGE,
};
use crate::client_hub::ClientConnectionMetadata;
use crate::client_outbox::{client_outbox, ClientOutboxReceiver};
use crate::phone_call::audio::{
    TelephonyVad, VAD_BARGE_IN_ONSET_FRAMES, VAD_DEFAULT_HANGOVER_FRAMES, VAD_IVR_HANGOVER_FRAMES,
};
use crate::phone_call::sip::{
    build_rtp_packet, parse_rtp_packet, SipTransportKind, DEFAULT_TELEPHONE_EVENT_PT,
    PCMU_FRAME_BYTES, PCMU_PAYLOAD_TYPE,
};
use crate::phone_call::voice::VoicePipelineConfig;
use crate::runtime_backend::{bridge_prompt, QueueRuntimeDispatcher, QueueRuntimeSnapshot};
use agent_client_protocol::v1::schema::ContentBlock;
use axum::body::Body;
use axum::extract::ws::Message;
use axum::extract::{Multipart, State};
use axum::http::header::CONTENT_TYPE;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use futures_util::future::BoxFuture;
use serde_json::Value;
use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use tokio::net::{TcpListener, UdpSocket};
use tokio::sync::Mutex;
use tokio::time::timeout;

const TEST_TIMEOUT: Duration = Duration::from_secs(6);

struct TurnStartCapture {
    thread_id: String,
    turn_start: Value,
}

struct MockQueueDispatcher {
    captured: mpsc::UnboundedSender<TurnStartCapture>,
}

impl QueueRuntimeDispatcher for MockQueueDispatcher {
    fn read_snapshot<'a>(
        &'a self,
        thread_id: &'a str,
    ) -> BoxFuture<'a, Result<QueueRuntimeSnapshot, String>> {
        let session =
            crate::acp::snapshot::SessionSnapshot::new("agent".to_string(), thread_id.into());
        Box::pin(async move {
            Ok(QueueRuntimeSnapshot {
                session,
                pending_approval_ids: HashSet::new(),
                pending_user_input_ids: HashSet::new(),
            })
        })
    }

    fn supports_steer(&self, _thread_id: &str) -> Result<bool, String> {
        Ok(false)
    }

    fn prepare_steer<'a>(&'a self, _thread_id: &'a str) -> BoxFuture<'a, Result<u64, String>> {
        Box::pin(async { Ok(1) })
    }

    fn verify_steer_epoch<'a>(
        &'a self,
        _thread_id: &'a str,
        _epoch: u64,
    ) -> BoxFuture<'a, Result<bool, String>> {
        Box::pin(async { Ok(true) })
    }

    fn steer<'a>(
        &'a self,
        _thread_id: &'a str,
        _expected_run_id: String,
        _expected_source_turn_id: String,
        _prompt_generation: u64,
        _interaction_epoch: u64,
        _prompt: Vec<ContentBlock>,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async { Err("steer unsupported".to_string()) })
    }

    fn turn_start<'a>(
        &'a self,
        thread_id: &'a str,
        turn_start: &'a Value,
        source_turn_id: &'a str,
    ) -> BoxFuture<'a, Result<String, String>> {
        let parsed_prompt = bridge_prompt(turn_start);
        let tid = thread_id.to_string();
        let payload = turn_start.clone();
        let src = source_turn_id.to_string();
        let tx = self.captured.clone();
        Box::pin(async move {
            let _ = parsed_prompt?;
            let _ = tx.send(TurnStartCapture {
                thread_id: tid,
                turn_start: payload,
            });
            Ok(src)
        })
    }
}

const STT_FAILURE_REPLY: &str = "<mock-stt-failure>";

struct MockVoiceState {
    preload_delay_ms: AtomicUsize,
    preload_requests: AtomicUsize,
    preload_status: Mutex<StatusCode>,
    chat_turns: Mutex<VecDeque<Vec<Vec<u8>>>>,
    stt_replies: Mutex<VecDeque<String>>,
    stt_delay_ms: AtomicUsize,
    stt_requests: AtomicUsize,
    stt_request_fields: Mutex<Vec<std::collections::BTreeMap<String, Vec<u8>>>>,
    tts_pcm_bytes: Mutex<Vec<u8>>,
    tts_chunk_delay_ms: AtomicUsize,
    chat_requests: Mutex<Vec<Value>>,
    chat_status: Mutex<StatusCode>,
    tts_requests: Mutex<Vec<Value>>,
    tts_fail_after: AtomicUsize,
}

impl MockVoiceState {
    fn new(
        chat_turns: Vec<Vec<Vec<u8>>>,
        stt_replies: Vec<&str>,
        tts_samples_24k: usize,
    ) -> Arc<Self> {
        let mut pcm = Vec::with_capacity(tts_samples_24k * 2);
        for _ in 0..tts_samples_24k {
            pcm.extend_from_slice(&8_000_i16.to_le_bytes());
        }
        Arc::new(Self {
            preload_delay_ms: AtomicUsize::new(0),
            preload_requests: AtomicUsize::new(0),
            preload_status: Mutex::new(StatusCode::OK),
            chat_turns: Mutex::new(chat_turns.into()),
            stt_replies: Mutex::new(stt_replies.into_iter().map(ToOwned::to_owned).collect()),
            stt_delay_ms: AtomicUsize::new(0),
            stt_requests: AtomicUsize::new(0),
            stt_request_fields: Mutex::new(Vec::new()),
            tts_pcm_bytes: Mutex::new(pcm),
            tts_chunk_delay_ms: AtomicUsize::new(0),
            chat_requests: Mutex::new(Vec::new()),
            chat_status: Mutex::new(StatusCode::OK),
            tts_requests: Mutex::new(Vec::new()),
            tts_fail_after: AtomicUsize::new(usize::MAX),
        })
    }
}

async fn spawn_mock_voice_http(state: Arc<MockVoiceState>) -> String {
    let app = Router::new()
        .route(
            "/api/chat",
            post(|State(st): State<Arc<MockVoiceState>>| async move {
                let delay = st.preload_delay_ms.load(Ordering::SeqCst);
                st.preload_requests.fetch_add(1, Ordering::SeqCst);
                let status = *st.preload_status.lock().await;
                let body = futures_util::stream::once(async move {
                    if delay > 0 {
                        tokio::time::sleep(Duration::from_millis(u64::try_from(delay).unwrap()))
                            .await;
                    }
                    Ok::<_, std::convert::Infallible>(br#"{"done":true}"#.to_vec())
                });
                Response::builder()
                    .status(status)
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from_stream(body))
                    .unwrap()
            }),
        )
        .route(
            "/v1/audio/transcriptions",
            post(
                |State(st): State<Arc<MockVoiceState>>, mut mp: Multipart| async move {
                    let mut fields = std::collections::BTreeMap::new();
                    while let Ok(Some(field)) = mp.next_field().await {
                        let name = field.name().expect("named transcription field").to_string();
                        fields.insert(
                            name,
                            field
                                .bytes()
                                .await
                                .expect("complete transcription field")
                                .to_vec(),
                        );
                    }
                    st.stt_request_fields.lock().await.push(fields);
                    // Replies and delays are bound before the arrival is counted, so tests can
                    // change the delay for the next request once they observe this one.
                    let delay_ms = st.stt_delay_ms.load(Ordering::SeqCst);
                    let text = st.stt_replies.lock().await.pop_front().unwrap_or_default();
                    st.stt_requests.fetch_add(1, Ordering::SeqCst);
                    if delay_ms > 0 {
                        tokio::time::sleep(Duration::from_millis(
                            u64::try_from(delay_ms).unwrap_or(0),
                        ))
                        .await;
                    }
                    if text == STT_FAILURE_REPLY {
                        return (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            Json(json!({ "error": "transcriber crashed" })),
                        );
                    }
                    (StatusCode::OK, Json(json!({ "text": text })))
                },
            ),
        )
        .route(
            "/v1/chat/completions",
            post(
                |State(st): State<Arc<MockVoiceState>>, Json(body): Json<Value>| async move {
                    st.chat_requests.lock().await.push(body);
                    let status = *st.chat_status.lock().await;
                    if !status.is_success() {
                        return (status, Json(json!({"error":"model not found"}))).into_response();
                    }
                    let chunks = st
                        .chat_turns
                        .lock()
                        .await
                        .pop_front()
                        .unwrap_or_else(|| vec![b"data: [DONE]\n\n".to_vec()]);
                    let stream = futures_util::stream::iter(
                        chunks
                            .into_iter()
                            .map(Ok::<Vec<u8>, std::convert::Infallible>),
                    );
                    Response::builder()
                        .status(StatusCode::OK)
                        .header(CONTENT_TYPE, "text/event-stream")
                        .body(Body::from_stream(stream))
                        .expect("SSE response")
                },
            ),
        )
        .route(
            "/v1/audio/speech",
            post(
                |State(st): State<Arc<MockVoiceState>>, Json(body): Json<Value>| async move {
                    st.tts_requests.lock().await.push(body);
                    if st.tts_requests.lock().await.len() > st.tts_fail_after.load(Ordering::SeqCst)
                    {
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        return (StatusCode::INTERNAL_SERVER_ERROR, "synthesis failed")
                            .into_response();
                    }
                    let pcm = st.tts_pcm_bytes.lock().await.clone();
                    let delay_ms = st.tts_chunk_delay_ms.load(Ordering::SeqCst);
                    let chunks: Vec<Vec<u8>> =
                        pcm.chunks(960).map(|slice| slice.to_vec()).collect();
                    let stream = futures_util::stream::unfold(
                        (chunks.into_iter(), delay_ms),
                        |(mut iter, wait_ms)| async move {
                            let next = iter.next()?;
                            if wait_ms > 0 {
                                tokio::time::sleep(Duration::from_millis(
                                    u64::try_from(wait_ms).unwrap_or(10),
                                ))
                                .await;
                            }
                            Some((
                                Ok::<Vec<u8>, std::convert::Infallible>(next),
                                (iter, wait_ms),
                            ))
                        },
                    );
                    Response::builder()
                        .status(StatusCode::OK)
                        .header(CONTENT_TYPE, "application/octet-stream")
                        .body(Body::from_stream(stream))
                        .expect("PCM response")
                },
            ),
        )
        .with_state(state);

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock voice");
    let addr = listener.local_addr().expect("voice addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{addr}/v1")
}

async fn recv_matching_notification<Predicate>(
    rx: &mut ClientOutboxReceiver,
    mut predicate: Predicate,
) -> Value
where
    Predicate: FnMut(&str, &Value) -> bool,
{
    timeout(TEST_TIMEOUT, async {
        loop {
            let msg = rx.recv().await.expect("outbox open");
            if let Message::Text(text) = msg {
                let parsed: Value = serde_json::from_str(text.as_str()).expect("json frame");
                if let Some(method) = parsed.get("method").and_then(Value::as_str) {
                    let params = parsed.get("params").cloned().unwrap_or(Value::Null);
                    if predicate(method, &params) {
                        return params;
                    }
                }
            }
        }
    })
    .await
    .expect("timed out waiting for hub notification")
}

fn extract_sip_header(msg: &str, prefix: &str) -> String {
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
        .expect("SIP header present")
}

fn extract_sdp_port(msg: &str) -> u16 {
    msg.lines()
        .find_map(|line| {
            let rest = line.trim().strip_prefix("m=audio ")?;
            rest.split_whitespace().next()?.parse::<u16>().ok()
        })
        .expect("SDP m=audio port")
}

fn sample_runtime_config(sip_port: u16, voice_url: &str) -> PhoneCallRuntimeConfig {
    PhoneCallRuntimeConfig {
        server_host: "127.0.0.1".to_string(),
        server_port: sip_port,
        transport: SipTransportKind::Udp,
        sip_username: String::new(),
        sip_password: String::new(),
        caller_id: "+15551112222".to_string(),
        user_display_name: "Alex Example".to_string(),
        voice: VoicePipelineConfig {
            stt_base_url: voice_url.to_string(),
            stt_model: "gemma4:e4b".to_string(),
            llm_base_url: voice_url.to_string(),
            llm_model: "gemma4:e4b".to_string(),
            tts_base_url: voice_url.to_string(),
            tts_model: "phonon".to_string(),
            tts_voice: "Harper".to_string(),
        },
    }
}

fn can_retire_for_service(service: &PhoneCallService) -> bool {
    let empty_queue = crate::health::QueueStatus {
        tracked_threads: 0,
        depth: 0,
        busy_threads: 0,
        active_runs: 0,
        pending_steers: 0,
        pending_approvals: 0,
        pending_user_inputs: 0,
        other_live_work: 0,
    };
    crate::health::runtime_activity(0, &empty_queue, 0, 0, 0, service.live_work_count(), 0)
        .can_retire
}

#[derive(Debug, Clone)]
struct MockSipDialog {
    client_sip_addr: SocketAddr,
    client_rtp_addr: SocketAddr,
    from: String,
    to: String,
    call_id: String,
}

impl MockSipDialog {
    async fn accept_invite(
        sip: &UdpSocket,
        rtp_port: u16,
        send_ringing: bool,
        include_dtmf: bool,
    ) -> Self {
        let local_sip_addr = sip.local_addr().expect("local SIP addr");
        let mut buf = vec![0_u8; 65535];
        let (n_inv, client_sip_addr) = sip.recv_from(&mut buf).await.expect("INVITE");
        let inv = std::str::from_utf8(&buf[..n_inv]).expect("utf8 INVITE");
        let via = extract_sip_header(inv, "Via:");
        let from = extract_sip_header(inv, "From:");
        let to = extract_sip_header(inv, "To:");
        let call_id = extract_sip_header(inv, "Call-ID:");
        let client_rtp_port = extract_sdp_port(inv);
        let client_rtp_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), client_rtp_port);

        if send_ringing {
            let ringing = format!(
                "SIP/2.0 180 Ringing\r\nVia: {via}\r\nFrom: {from}\r\nTo: {to};tag=uas1\r\nCall-ID: {call_id}\r\nCSeq: 1 INVITE\r\nContent-Length: 0\r\n\r\n",
            );
            sip.send_to(ringing.as_bytes(), client_sip_addr)
                .await
                .expect("180 Ringing");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        let sdp = if include_dtmf {
            format!(
                "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio {rtp_port} RTP/AVP 0 101\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:101 telephone-event/8000\r\n",
            )
        } else {
            format!(
                "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio {rtp_port} RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n",
            )
        };
        let ok_200 = format!(
            "SIP/2.0 200 OK\r\nVia: {via}\r\nFrom: {from}\r\nTo: {to};tag=uas1\r\nCall-ID: {call_id}\r\nCSeq: 1 INVITE\r\nContact: <sip:uas@{local_sip_addr}>\r\nContent-Type: application/sdp\r\nContent-Length: {}\r\n\r\n{sdp}",
            sdp.len(),
        );
        sip.send_to(ok_200.as_bytes(), client_sip_addr)
            .await
            .expect("200 OK");
        let _ = sip.recv_from(&mut buf).await.expect("ACK");

        Self {
            client_sip_addr,
            client_rtp_addr,
            from,
            to,
            call_id,
        }
    }

    async fn renegotiate(
        &self,
        sip: &UdpSocket,
        cseq: u32,
        method: &str,
        direction: &str,
        rtp_port: u16,
    ) -> String {
        let local = sip.local_addr().unwrap();
        let sdp = format!(
            "v=0\r\no=- 1 {cseq} IN IP4 127.0.0.1\r\ns=-\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio {rtp_port} RTP/AVP 0 101\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:101 telephone-event/8000\r\na={direction}\r\n",
        );
        let request = format!(
            "{method} sip:caller@{} SIP/2.0\r\nVia: SIP/2.0/UDP {local};branch=z9hG4bKhold{cseq}\r\nFrom: {};tag=uas1\r\nTo: {}\r\nCall-ID: {}\r\nCSeq: {cseq} {method}\r\nContact: <sip:uas@{local}>\r\nContent-Type: application/sdp\r\nContent-Length: {}\r\n\r\n{sdp}",
            self.client_sip_addr, self.to, self.from, self.call_id, sdp.len(),
        );
        sip.send_to(request.as_bytes(), self.client_sip_addr)
            .await
            .unwrap();
        let mut response = [0; 4096];
        let (len, _) = timeout(TEST_TIMEOUT, sip.recv_from(&mut response))
            .await
            .unwrap()
            .unwrap();
        let response = String::from_utf8(response[..len].to_vec()).unwrap();
        assert!(response.starts_with("SIP/2.0 200 OK"), "{response}");
        if method == "INVITE" {
            let ack = request.replacen("INVITE ", "ACK ", 1).replace(
                &format!("CSeq: {cseq} INVITE"),
                &format!("CSeq: {cseq} ACK"),
            );
            sip.send_to(ack.as_bytes(), self.client_sip_addr)
                .await
                .unwrap();
        }
        response
    }

    async fn expect_bye_and_reply_ok(&self, sip: &UdpSocket) {
        let mut buf = vec![0_u8; 65535];
        loop {
            let (n_msg, peer) = sip.recv_from(&mut buf).await.expect("BYE");
            let text = std::str::from_utf8(&buf[..n_msg]).unwrap_or("");
            if text.starts_with("BYE ") {
                let bye_via = extract_sip_header(text, "Via:");
                let bye_cseq = extract_sip_header(text, "CSeq:");
                let bye_ok = format!(
                    "SIP/2.0 200 OK\r\nVia: {bye_via}\r\nFrom: {}\r\nTo: {};tag=uas1\r\nCall-ID: {}\r\nCSeq: {bye_cseq}\r\nContent-Length: 0\r\n\r\n",
                    self.from, self.to, self.call_id,
                );
                let _ = sip.send_to(bye_ok.as_bytes(), peer).await;
                break;
            }
        }
    }

    async fn send_remote_bye(&self, sip: &UdpSocket, cseq: u32) {
        let local = sip.local_addr().unwrap();
        let request = format!(
            "BYE sip:caller@{} SIP/2.0\r\nVia: SIP/2.0/UDP {local};branch=z9hG4bKbye{cseq}\r\nFrom: {};tag=uas1\r\nTo: {}\r\nCall-ID: {}\r\nCSeq: {cseq} BYE\r\nContent-Length: 0\r\n\r\n",
            self.client_sip_addr, self.to, self.from, self.call_id,
        );
        sip.send_to(request.as_bytes(), self.client_sip_addr)
            .await
            .unwrap();
        let mut response = [0; 4096];
        let (len, _) = timeout(TEST_TIMEOUT, sip.recv_from(&mut response))
            .await
            .unwrap()
            .unwrap();
        let response = String::from_utf8_lossy(&response[..len]);
        assert!(response.starts_with("SIP/2.0 200 OK"), "{response}");
        assert!(
            response.contains(&format!("CSeq: {cseq} BYE")),
            "{response}",
        );
    }
}

#[derive(Clone)]
struct McpHttpTestClient {
    client: reqwest::Client,
    http_url: String,
    authorization: String,
    session_id: String,
}

impl McpHttpTestClient {
    async fn connect(
        config: &crate::agent_messaging::AgentMessagingMcpConfig,
        agent_id: &str,
        thread_id: &str,
    ) -> Self {
        let pending = config
            .stage_credential(agent_id)
            .expect("stage MCP credential");
        let authorization =
            match config.descriptor(crate::acp::runtime::McpTransportPreference::Http, &pending) {
                Some(agent_client_protocol::v1::schema::McpServer::Http(desc)) => {
                    desc.headers[0].value.clone()
                }
                _ => String::new(),
            };
        assert!(authorization.starts_with("Bearer dcm_"));
        config
            .activate_credential(pending, thread_id)
            .expect("activate MCP credential");

        let client = crate::tls::http_client_builder()
            .no_proxy()
            .build()
            .expect("reqwest MCP client");
        let init_resp = client
            .post(&config.http_url)
            .header(reqwest::header::AUTHORIZATION, &authorization)
            .header("accept", "application/json, text/event-stream")
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": { "name": "phone-call-e2e", "version": "1.0.0" }
                }
            }))
            .send()
            .await
            .expect("MCP initialize");
        assert_eq!(init_resp.status(), StatusCode::OK);
        let session_id = init_resp
            .headers()
            .get("mcp-session-id")
            .map(reqwest::header::HeaderValue::to_str)
            .and_then(Result::ok)
            .expect("mcp-session-id header")
            .to_string();
        let _ = init_resp.text().await.expect("init body");

        let initialized_resp = client
            .post(&config.http_url)
            .header(reqwest::header::AUTHORIZATION, &authorization)
            .header("mcp-session-id", &session_id)
            .header("mcp-protocol-version", "2025-03-26")
            .header("accept", "application/json, text/event-stream")
            .json(&json!({
                "jsonrpc": "2.0",
                "method": "notifications/initialized"
            }))
            .send()
            .await
            .expect("MCP initialized notification");
        assert!(initialized_resp.status().is_success());

        Self {
            client,
            http_url: config.http_url.clone(),
            authorization,
            session_id,
        }
    }

    async fn call_tool(&self, id: u64, name: &str, arguments: Value) -> Value {
        let resp = self
            .client
            .post(&self.http_url)
            .header(reqwest::header::AUTHORIZATION, &self.authorization)
            .header("mcp-session-id", &self.session_id)
            .header("mcp-protocol-version", "2025-03-26")
            .header("accept", "application/json, text/event-stream")
            .json(&json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": "tools/call",
                "params": {
                    "name": name,
                    "arguments": arguments,
                }
            }))
            .send()
            .await
            .expect("MCP tools/call HTTP response");
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.text().await.expect("MCP tools/call body");
        if body.trim_start().starts_with('{') {
            return serde_json::from_str(&body).expect("JSON-RPC object");
        }
        body.lines()
            .map(str::trim)
            .filter_map(|line| line.strip_prefix("data:"))
            .map(str::trim)
            .filter(|data| !data.is_empty())
            .find_map(|data| {
                let val: Value = serde_json::from_str(data).ok()?;
                (val.get("id") == Some(&json!(id))).then_some(val)
            })
            .expect("SSE JSON-RPC response matching request id")
    }

    async fn call_tool_json(&self, id: u64, name: &str, arguments: Value) -> Value {
        let rpc = self.call_tool(id, name, arguments).await;
        assert!(
            rpc.get("error").is_none(),
            "expected MCP tool success, got error: {rpc}",
        );
        assert_ne!(rpc["result"]["isError"], json!(true), "tool error: {rpc}");
        let text = rpc["result"]["content"][0]["text"]
            .as_str()
            .expect("MCP tool JSON text content");
        serde_json::from_str(text).expect("parse MCP tool JSON payload")
    }
}

async fn send_rtp_utterance(
    rtp_sock: &UdpSocket,
    dest: SocketAddr,
    seq: &mut u16,
    ts: &mut u32,
    loud_frames: usize,
    silence_frames: usize,
) {
    let loud_frame =
        crate::phone_call::audio::tests::encode_mulaw_frame(&[8_000_i16; RTP_FRAME_SAMPLES]);
    let silence_frame = [0xFF_u8; PCMU_FRAME_BYTES];
    for _ in 0..loud_frames {
        let pkt = build_rtp_packet(
            false,
            PCMU_PAYLOAD_TYPE,
            *seq,
            *ts,
            0x1122_3344,
            &loud_frame,
        );
        rtp_sock
            .send_to(&pkt, dest)
            .await
            .expect("send loud RTP frame");
        *seq = seq.wrapping_add(1);
        *ts = ts.wrapping_add(160);
    }

    for _ in 0..silence_frames {
        let pkt = build_rtp_packet(
            false,
            PCMU_PAYLOAD_TYPE,
            *seq,
            *ts,
            0x1122_3344,
            &silence_frame,
        );
        rtp_sock
            .send_to(&pkt, dest)
            .await
            .expect("send silence RTP frame");
        *seq = seq.wrapping_add(1);
        *ts = ts.wrapping_add(160);
    }
}

fn voice_reply(text: &str, tools: Value) -> Vec<Vec<u8>> {
    let tools = if tools.as_array().is_some_and(Vec::is_empty) && !text.trim().is_empty() {
        voice_tool(
            "wait_silently",
            json!({"reason": "Listening", "on_hold": false}),
        )
    } else {
        tools
    };
    vec![
        format!(
            "data: {}\n\n",
            json!({"choices": [{"delta": {"content": text, "tool_calls": tools}}]})
        )
        .into_bytes(),
        b"data: [DONE]\n\n".to_vec(),
    ]
}

fn voice_tool(name: &str, arguments: Value) -> Value {
    json!([{
        "index": 0,
        "id": format!("call_{name}"),
        "type": "function",
        "function": {"name": name, "arguments": arguments.to_string()}
    }])
}

#[tokio::test]
async fn mcp_e2e_partial_reply_hold_music_resume_and_interrupted_hangup() {
    let hub = Arc::new(ClientHub::new());
    let (outbox, mut notifications) = client_outbox(256);
    hub.add_client_with_metadata(outbox, ClientConnectionMetadata::default())
        .await;
    let (report_tx, mut reports) = mpsc::unbounded_channel();
    let queue = BridgeQueueService::with_submission_store(
        Arc::new(MockQueueDispatcher {
            captured: report_tx,
        }),
        Arc::clone(&hub),
        None,
        crate::queue_service::DurableQueueSubmissions::default(),
    );
    let end = || {
        voice_tool(
            "end_call",
            json!({
                "reason": "Information was not provided by the recipient.",
                "outcome_summary": "No answer"
            }),
        )
    };
    let voice = MockVoiceState::new(
        vec![
            voice_reply("", end()),
            voice_reply("Thank you, I have the address. Goodbye.", end()),
            voice_reply(
                "Of course, I can wait.",
                voice_tool(
                    "wait_silently",
                    json!({"reason": "Checking the address", "on_hold": true}),
                ),
            ),
            voice_reply("Goodbye, your call is important to us.", end()),
            voice_reply(
                "",
                voice_tool(
                    "wait_silently",
                    json!({"reason": "Still waiting for the person", "on_hold": true}),
                ),
            ),
            voice_reply("", voice_tool("resume_call", json!({}))),
            voice_reply("Thank you for the address. Goodbye.", end()),
            voice_reply("Go ahead, I'm listening.", json!([])),
            voice_reply("Thanks again. Goodbye.", end()),
        ],
        vec![
            "I",
            "I ...",
            "Could you please hold while I check?",
            "Your call is important to us.",
            "Thanks for holding. The address is twelve Main Street.",
            "Actually, one more thing.",
            "That is all. Goodbye.",
        ],
        2_400,
    );
    let voice_url = spawn_mock_voice_http(Arc::clone(&voice)).await;
    let sip = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
    let rtp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let (connected_tx, connected_rx) = oneshot::channel();
    let (bye_tx, mut bye_rx) = oneshot::channel();
    let (finish_tx, finish_rx) = oneshot::channel();
    let rtp_port = rtp.local_addr().unwrap().port();
    let sip_port = sip.local_addr().unwrap().port();
    let trunk_sip = Arc::clone(&sip);
    tokio::spawn(async move {
        let dialog = MockSipDialog::accept_invite(&trunk_sip, rtp_port, false, true).await;
        connected_tx.send(dialog.clone()).unwrap();
        let _ = finish_rx.await;
        dialog.expect_bye_and_reply_ok(&trunk_sip).await;
        let _ = bye_tx.send(());
    });
    let service = PhoneCallService::with_options(
        Some(sample_runtime_config(sip_port, &voice_url)),
        hub,
        Arc::downgrade(&queue),
        PhoneCallTimeouts {
            approval_timeout: Duration::from_secs(5),
            max_call_duration: Duration::from_secs(60),
            opening_greeting_wait: Duration::from_secs(20),
        },
        None,
    );
    let mcp_server = crate::agent_messaging::AgentMessagingService::start(
        Weak::new(),
        Arc::downgrade(&queue),
        crate::scheduled_prompts::ScheduledPromptService::inert_for_test(),
        Arc::clone(&service),
    )
    .await
    .unwrap();
    let owner = crate::acp::identity::AgentSessionId::new("agent", "hold-regression")
        .unwrap()
        .encode();
    let mcp = McpHttpTestClient::connect(mcp_server.config(), "agent", &owner).await;
    let start_mcp = mcp.clone();
    let start = tokio::spawn(async move {
        start_mcp
            .call_tool_json(
                10,
                "start_phone_call",
                json!({
                    "phoneNumber": "+15559876543", "objective": "Ask for the address"
                }),
            )
            .await
    });
    let modal = recv_matching_notification(&mut notifications, |method, params| {
        method == "bridge/ui.present" && params["presentation"] == "modal"
    })
    .await;
    service
        .resolve_ui_action(&ResolveBridgeUiSurfaceRequest {
            id: modal["id"].as_str().unwrap().to_string(),
            thread_id: owner.clone(),
            turn_id: None,
            action_id: "approve".to_string(),
        })
        .await;
    let started = timeout(TEST_TIMEOUT, start).await.unwrap().unwrap();
    let call_id = started["callId"].as_str().unwrap();
    let dialog = connected_rx.await.unwrap();
    let dest = dialog.client_rtp_addr;
    let mut seq = 1;
    let mut ts = 160;
    send_rtp_utterance(
        &rtp,
        dest,
        &mut seq,
        &mut ts,
        10,
        VAD_DEFAULT_HANGOVER_FRAMES + 2,
    )
    .await;
    timeout(TEST_TIMEOUT, async {
        while voice.chat_requests.lock().await.is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    let snapshot = mcp
        .call_tool_json(11, "get_phone_call", json!({"callId": call_id}))
        .await;
    assert_eq!(
        snapshot["status"], "in_progress",
        "a partial 'I' cannot end the call",
    );
    assert!(
        bye_rx.try_recv().is_err(),
        "no BYE for a tool-only end_call",
    );
    assert!(voice.tts_requests.lock().await.is_empty());
    assert!(reports.try_recv().is_err());

    send_rtp_utterance(
        &rtp,
        dest,
        &mut seq,
        &mut ts,
        10,
        VAD_DEFAULT_HANGOVER_FRAMES + 2,
    )
    .await;
    recv_matching_notification(&mut notifications, |method, params| {
        method == "bridge/ui.update" && params["blocks"].to_string().contains("I have the address")
    })
    .await;
    tokio::time::sleep(Duration::from_millis(2_200)).await;
    let snapshot = mcp
        .call_tool_json(17, "get_phone_call", json!({"callId": call_id}))
        .await;
    assert_eq!(snapshot["status"], "in_progress",
        "a model-invented goodbye cannot turn a provisional one-word reply into permission to hang up");
    assert!(bye_rx.try_recv().is_err());
    assert!(reports.try_recv().is_err());

    send_rtp_utterance(
        &rtp,
        dest,
        &mut seq,
        &mut ts,
        10,
        VAD_DEFAULT_HANGOVER_FRAMES + 2,
    )
    .await;
    let held = recv_matching_notification(&mut notifications, |method, params| {
        method == "bridge/ui.update" && params["subtitle"] == "On hold"
    })
    .await;
    assert_eq!(held["dismissible"], false);
    assert_eq!(held["actions"][0]["id"], "hangup");
    let snapshot = mcp
        .call_tool_json(12, "get_phone_call", json!({"callId": call_id}))
        .await;
    assert_eq!(snapshot["onHold"], true);
    assert_eq!(snapshot["status"], "in_progress");
    assert!(!can_retire_for_service(&service));
    let spoken_before_music = voice.tts_requests.lock().await.len();
    send_rtp_utterance(&rtp, dest, &mut seq, &mut ts, 10, 65).await;
    timeout(TEST_TIMEOUT, async {
        while voice.chat_requests.lock().await.len() < 3 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(2_200)).await;
    assert_eq!(
        voice.tts_requests.lock().await.len(),
        spoken_before_music,
        "hold announcements must not provoke speech",
    );
    assert!(
        bye_rx.try_recv().is_err(),
        "hold music cannot trigger autonomous hangup",
    );
    assert!(reports.try_recv().is_err());
    let steered = mcp.call_tool_json(16, "steer_phone_call", json!({
        "callId": call_id, "instruction": "Also ask for their opening hours when they return. Keep waiting."
    })).await;
    assert_eq!(steered["status"], "steered");
    timeout(TEST_TIMEOUT, async {
        while voice.chat_requests.lock().await.len() < 4 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(voice.tts_requests.lock().await.len(), spoken_before_music);
    let mut packet = [0; 2048];
    let (len, _) = timeout(TEST_TIMEOUT, rtp.recv_from(&mut packet))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        parse_rtp_packet(&packet[..len]).unwrap().payload_type,
        PCMU_PAYLOAD_TYPE,
    );

    send_rtp_utterance(&rtp, dest, &mut seq, &mut ts, 10, 65).await;
    recv_matching_notification(&mut notifications, |method, params| {
        method == "bridge/ui.update"
            && params["subtitle"] == "In call"
            && params["blocks"]
                .to_string()
                .contains("Thank you for the address")
    })
    .await;
    let snapshot = mcp
        .call_tool_json(13, "get_phone_call", json!({"callId": call_id}))
        .await;
    assert_eq!(snapshot["onHold"], false);
    send_rtp_utterance(
        &rtp,
        dest,
        &mut seq,
        &mut ts,
        10,
        VAD_DEFAULT_HANGOVER_FRAMES + 2,
    )
    .await;
    recv_matching_notification(&mut notifications, |method, params| {
        method == "bridge/ui.update"
            && params["blocks"]
                .to_string()
                .contains("Go ahead, I'm listening")
    })
    .await;
    tokio::time::sleep(Duration::from_millis(2_200)).await;
    assert!(
        bye_rx.try_recv().is_err(),
        "resumed speech cancels the hangup grace period",
    );

    let response = dialog
        .renegotiate(&sip, 2, "INVITE", "sendonly", rtp_port)
        .await;
    assert!(response.contains("a=recvonly"));
    recv_matching_notification(&mut notifications, |method, params| {
        method == "bridge/ui.update" && params["subtitle"] == "On hold"
    })
    .await;
    let snapshot = mcp
        .call_tool_json(14, "get_phone_call", json!({"callId": call_id}))
        .await;
    assert_eq!(snapshot["onHold"], true);
    assert_eq!(snapshot["status"], "in_progress");
    assert!(!can_retire_for_service(&service));
    let response = dialog
        .renegotiate(&sip, 3, "UPDATE", "inactive", rtp_port)
        .await;
    assert!(response.contains("a=inactive"));
    let resumed_rtp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let new_port = resumed_rtp.local_addr().unwrap().port();
    let response = dialog
        .renegotiate(&sip, 4, "INVITE", "sendrecv", new_port)
        .await;
    assert!(response.contains("a=sendrecv"));
    recv_matching_notification(&mut notifications, |method, params| {
        method == "bridge/ui.update" && params["subtitle"] == "In call"
    })
    .await;
    let snapshot = mcp
        .call_tool_json(15, "get_phone_call", json!({"callId": call_id}))
        .await;
    assert_eq!(snapshot["onHold"], false);
    finish_tx.send(()).unwrap();
    send_rtp_utterance(
        &resumed_rtp,
        dest,
        &mut seq,
        &mut ts,
        10,
        VAD_DEFAULT_HANGOVER_FRAMES + 2,
    )
    .await;
    timeout(TEST_TIMEOUT, async {
        let mut packet = [0; 2048];
        loop {
            let (len, _) = resumed_rtp.recv_from(&mut packet).await.unwrap();
            if parse_rtp_packet(&packet[..len])
                .unwrap()
                .payload
                .iter()
                .any(|byte| *byte != 0xff)
            {
                break;
            }
        }
    })
    .await
    .expect("resumed voice must use renegotiated RTP port");
    timeout(TEST_TIMEOUT, &mut bye_rx).await.unwrap().unwrap();
    let settled = recv_matching_notification(&mut notifications, |method, params| {
        method == "bridge/ui.update" && params["title"] == "Phone call ended"
    })
    .await;
    assert_eq!(settled["actions"], json!([]));
    assert_eq!(settled["dismissible"], true);
    timeout(TEST_TIMEOUT, reports.recv())
        .await
        .unwrap()
        .unwrap();
    timeout(TEST_TIMEOUT, async {
        while service.live_work_count() != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(can_retire_for_service(&service));
    mcp_server.shutdown().await;
}

const CLOSING_OWNER: &str = "closing-owner";

struct ClosingTestCall {
    service: Arc<PhoneCallService>,
    notifications: ClientOutboxReceiver,
    reports: mpsc::UnboundedReceiver<TurnStartCapture>,
    rtp: UdpSocket,
    dest: SocketAddr,
    seq: u16,
    ts: u32,
    call_id: String,
    bye_rx: oneshot::Receiver<()>,
    _queue: Arc<BridgeQueueService>,
}

impl ClosingTestCall {
    async fn connect(voice: &Arc<MockVoiceState>) -> Self {
        let hub = Arc::new(ClientHub::new());
        let (outbox, mut notifications) = client_outbox(256);
        hub.add_client_with_metadata(outbox, ClientConnectionMetadata::default())
            .await;
        let (report_tx, reports) = mpsc::unbounded_channel();
        let queue = BridgeQueueService::with_submission_store(
            Arc::new(MockQueueDispatcher {
                captured: report_tx,
            }),
            Arc::clone(&hub),
            None,
            crate::queue_service::DurableQueueSubmissions::default(),
        );
        let voice_url = spawn_mock_voice_http(Arc::clone(voice)).await;
        let sip = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let rtp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let sip_port = sip.local_addr().unwrap().port();
        let rtp_port = rtp.local_addr().unwrap().port();
        let (connected_tx, connected_rx) = oneshot::channel();
        let (bye_tx, bye_rx) = oneshot::channel();
        tokio::spawn(async move {
            let dialog = MockSipDialog::accept_invite(&sip, rtp_port, false, true).await;
            connected_tx.send(dialog.client_rtp_addr).unwrap();
            dialog.expect_bye_and_reply_ok(&sip).await;
            let _ = bye_tx.send(());
        });
        let service = PhoneCallService::with_options(
            Some(sample_runtime_config(sip_port, &voice_url)),
            hub,
            Arc::downgrade(&queue),
            PhoneCallTimeouts {
                approval_timeout: Duration::from_secs(5),
                max_call_duration: Duration::from_secs(60),
                opening_greeting_wait: Duration::from_secs(20),
            },
            None,
        );
        let start_service = Arc::clone(&service);
        let start = tokio::spawn(async move {
            start_service
                .start_phone_call(
                    CLOSING_OWNER,
                    StartPhoneCallRequest {
                        phone_number: "+15559876543".to_string(),
                        objective: "Ask for the opening hours".to_string(),
                        callee_name: None,
                        first_message: None,
                        context: None,
                    },
                )
                .await
        });
        let modal = recv_matching_notification(&mut notifications, |method, params| {
            method == "bridge/ui.present" && params["presentation"] == "modal"
        })
        .await;
        service
            .resolve_ui_action(&ResolveBridgeUiSurfaceRequest {
                id: modal["id"].as_str().unwrap().to_string(),
                thread_id: CLOSING_OWNER.to_string(),
                turn_id: None,
                action_id: "approve".to_string(),
            })
            .await;
        let started = timeout(TEST_TIMEOUT, start)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let dest = connected_rx.await.unwrap();
        Self {
            service,
            notifications,
            reports,
            rtp,
            dest,
            seq: 1,
            ts: 160,
            call_id: started.call_id,
            bye_rx,
            _queue: queue,
        }
    }

    async fn callee_speaks(&mut self) {
        send_rtp_utterance(
            &self.rtp,
            self.dest,
            &mut self.seq,
            &mut self.ts,
            10,
            VAD_DEFAULT_HANGOVER_FRAMES + 2,
        )
        .await;
    }

    async fn card_shows(&mut self, text: &str) {
        recv_matching_notification(&mut self.notifications, |method, params| {
            method == "bridge/ui.update" && params["blocks"].to_string().contains(text)
        })
        .await;
    }

    async fn expect_settled_report(&mut self, expected: &[&str]) {
        timeout(TEST_TIMEOUT, &mut self.bye_rx)
            .await
            .expect("the accepted closing sends BYE")
            .unwrap();
        let report = timeout(TEST_TIMEOUT, self.reports.recv())
            .await
            .unwrap()
            .unwrap()
            .turn_start
            .to_string();
        for text in expected {
            assert!(report.contains(text), "{text:?} missing from {report}");
        }
        timeout(TEST_TIMEOUT, async {
            while self.service.live_work_count() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
}

fn closing_end_call(reason: &str) -> Value {
    voice_tool(
        "end_call",
        json!({"reason": reason, "outcome_summary": "Open until nine"}),
    )
}

#[tokio::test]
async fn steer_during_closing_turn_cancels_its_hangup_and_plays_the_steered_turn() {
    let voice = MockVoiceState::new(
        vec![
            voice_reply(
                "Great, thank you. Goodbye.",
                closing_end_call("Got the opening hours"),
            ),
            voice_reply("One more question: do you take reservations?", json!([])),
            voice_reply(
                "Perfect, thanks. Goodbye.",
                closing_end_call("Got hours and reservations"),
            ),
        ],
        vec![
            "We are open until nine tonight.",
            "Yes, we take reservations.",
        ],
        4_800,
    );
    let mut call = ClosingTestCall::connect(&voice).await;
    call.callee_speaks().await;
    timeout(TEST_TIMEOUT, async {
        while voice.tts_requests.lock().await.is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    call.service
        .steer_phone_call(
            CLOSING_OWNER,
            &call.call_id,
            "Also ask whether they take reservations.",
        )
        .unwrap();
    call.card_shows("do you take reservations").await;
    tokio::time::sleep(END_CALL_QUIET_GRACE + Duration::from_millis(500)).await;
    assert!(
        call.bye_rx.try_recv().is_err(),
        "a steer during the closing turn cancels its hang-up",
    );
    let snapshot = call
        .service
        .get_phone_call(CLOSING_OWNER, &call.call_id)
        .unwrap();
    assert_eq!(snapshot.status, PhoneCallStatus::InProgress);
    let steered_request = voice.chat_requests.lock().await[1]["messages"].to_string();
    assert!(
        !steered_request.contains(r#""name":"end_call""#)
            && steered_request.contains("Also ask whether they take reservations."),
        "{steered_request}",
    );

    call.callee_speaks().await;
    call.expect_settled_report(&["End reason: Got hours and reservations"])
        .await;
}

#[tokio::test]
async fn short_goodbye_or_noise_after_spoken_closing_still_hangs_up() {
    for confirmation in ["Bye.", ""] {
        let voice = MockVoiceState::new(
            vec![
                voice_reply(
                    "Great, thank you. Goodbye.",
                    closing_end_call("Got the opening hours"),
                ),
                voice_reply("Are you still there?", json!([])),
            ],
            vec!["We are open until nine tonight.", confirmation],
            4_800,
        );
        let mut call = ClosingTestCall::connect(&voice).await;
        call.callee_speaks().await;
        call.card_shows("Great, thank you. Goodbye.").await;
        call.callee_speaks().await;
        let transcript = format!("Recipient: {confirmation}");
        let mut expected = vec!["End reason: Got the opening hours"];
        if !confirmation.is_empty() {
            expected.push(&transcript);
        }
        call.expect_settled_report(&expected).await;
        assert_eq!(
            voice.chat_requests.lock().await.len(),
            1,
            "{confirmation:?} confirms the closing instead of reopening the conversation",
        );
    }
}

#[tokio::test]
async fn held_call_preserves_mobile_hangup_and_maximum_duration() {
    for manual_hangup in [true, false] {
        let hub = Arc::new(ClientHub::new());
        let (outbox, mut notifications) = client_outbox(64);
        hub.add_client_with_metadata(outbox, ClientConnectionMetadata::default())
            .await;
        let (report_tx, mut reports) = mpsc::unbounded_channel();
        let queue = BridgeQueueService::with_submission_store(
            Arc::new(MockQueueDispatcher {
                captured: report_tx,
            }),
            Arc::clone(&hub),
            None,
            crate::queue_service::DurableQueueSubmissions::default(),
        );
        let voice = MockVoiceState::new(
            vec![voice_reply(
                "",
                voice_tool(
                    "wait_silently",
                    json!({"reason": "Waiting on hold", "on_hold": true}),
                ),
            )],
            vec![],
            480,
        );
        let voice_url = spawn_mock_voice_http(voice).await;
        let sip = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let rtp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let sip_port = sip.local_addr().unwrap().port();
        let rtp_port = rtp.local_addr().unwrap().port();
        let trunk = tokio::spawn(async move {
            let dialog = MockSipDialog::accept_invite(&sip, rtp_port, false, false).await;
            dialog.expect_bye_and_reply_ok(&sip).await;
        });
        let service = PhoneCallService::with_options(
            Some(sample_runtime_config(sip_port, &voice_url)),
            hub,
            Arc::downgrade(&queue),
            PhoneCallTimeouts {
                approval_timeout: Duration::from_secs(5),
                max_call_duration: Duration::from_secs(1),
                opening_greeting_wait: Duration::from_millis(20),
            },
            None,
        );
        let start_service = Arc::clone(&service);
        let start = tokio::spawn(async move {
            start_service
                .start_phone_call(
                    "held-owner",
                    StartPhoneCallRequest {
                        phone_number: "+15559876543".to_string(),
                        objective: "Check opening hours".to_string(),
                        callee_name: None,
                        first_message: None,
                        context: None,
                    },
                )
                .await
        });
        let modal = recv_matching_notification(&mut notifications, |method, params| {
            method == "bridge/ui.present" && params["presentation"] == "modal"
        })
        .await;
        service
            .resolve_ui_action(&ResolveBridgeUiSurfaceRequest {
                id: modal["id"].as_str().unwrap().to_string(),
                thread_id: "held-owner".to_string(),
                turn_id: None,
                action_id: "approve".to_string(),
            })
            .await;
        let started = timeout(TEST_TIMEOUT, start)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let held = recv_matching_notification(&mut notifications, |method, params| {
            method == "bridge/ui.update" && params["subtitle"] == "On hold"
        })
        .await;
        assert_eq!(held["dismissible"], false);
        assert_eq!(held["actions"][0]["id"], "hangup");
        let snapshot = service
            .get_phone_call("held-owner", &started.call_id)
            .unwrap();
        assert!(snapshot.on_hold);
        assert_eq!(snapshot.status, PhoneCallStatus::InProgress);
        assert!(!can_retire_for_service(&service));
        assert!(reports.try_recv().is_err());
        if manual_hangup {
            service
                .resolve_ui_action(&ResolveBridgeUiSurfaceRequest {
                    id: held["id"].as_str().unwrap().to_string(),
                    thread_id: "held-owner".to_string(),
                    turn_id: None,
                    action_id: "hangup".to_string(),
                })
                .await;
        }
        timeout(TEST_TIMEOUT, trunk).await.unwrap().unwrap();
        let settled = recv_matching_notification(&mut notifications, |method, params| {
            method == "bridge/ui.update" && params["title"] == "Phone call ended"
        })
        .await;
        assert_eq!(settled["actions"], json!([]));
        assert_eq!(settled["dismissible"], true);
        let report = timeout(TEST_TIMEOUT, reports.recv())
            .await
            .unwrap()
            .unwrap();
        let reason = if manual_hangup {
            "mobile_hangup"
        } else {
            "max_duration_reached"
        };
        assert!(report.turn_start.to_string().contains(reason));
        timeout(TEST_TIMEOUT, async {
            while service.live_work_count() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let snapshot = service
            .get_phone_call("held-owner", &started.call_id)
            .unwrap();
        assert!(!snapshot.on_hold);
        assert_eq!(snapshot.status, PhoneCallStatus::Completed);
        assert!(can_retire_for_service(&service));
    }
}
#[tokio::test]
async fn validation_decline_timeout_and_concurrent_call_slot_guard_behave_deterministically() {
    let hub = Arc::new(ClientHub::new());
    let (outbox, mut rx) = client_outbox(64);
    let _client_id = hub
        .add_client_with_metadata(outbox, ClientConnectionMetadata::default())
        .await;

    let unconfigured = PhoneCallService::new(None, Arc::clone(&hub), Weak::new());
    assert!(unconfigured
        .start_phone_call(
            "thread-a",
            StartPhoneCallRequest {
                phone_number: "+15559876543".to_string(),
                objective: "Check hours".to_string(),
                callee_name: None,
                first_message: None,
                context: None,
            },
        )
        .await
        .is_err());

    let cfg = sample_runtime_config(5060, "http://127.0.0.1:11434/v1");
    let service = PhoneCallService::with_options(
        Some(cfg),
        Arc::clone(&hub),
        Weak::new(),
        PhoneCallTimeouts {
            approval_timeout: Duration::from_millis(80),
            max_call_duration: Duration::from_secs(30),
            opening_greeting_wait: Duration::from_millis(50),
        },
        None,
    );

    // Input validation checks.
    for bad_req in [
        StartPhoneCallRequest {
            phone_number: "5559876543".to_string(),
            objective: "Valid".to_string(),
            callee_name: None,
            first_message: None,
            context: None,
        },
        StartPhoneCallRequest {
            phone_number: "+15559876543".to_string(),
            objective: "   ".to_string(),
            callee_name: None,
            first_message: None,
            context: None,
        },
        StartPhoneCallRequest {
            phone_number: "+15559876543".to_string(),
            objective: "x".repeat(MAX_OBJECTIVE_BYTES + 1),
            callee_name: None,
            first_message: None,
            context: None,
        },
        StartPhoneCallRequest {
            phone_number: "+15559876543".to_string(),
            objective: "Valid".to_string(),
            callee_name: Some("n".repeat(MAX_CALLEE_NAME_BYTES + 1)),
            first_message: None,
            context: None,
        },
        StartPhoneCallRequest {
            phone_number: "+15559876543".to_string(),
            objective: "Valid".to_string(),
            callee_name: None,
            first_message: Some("f".repeat(MAX_FIRST_MESSAGE_BYTES + 1)),
            context: None,
        },
        StartPhoneCallRequest {
            phone_number: "+15559876543".to_string(),
            objective: "Valid".to_string(),
            callee_name: None,
            first_message: None,
            context: Some("c".repeat(MAX_CONTEXT_BYTES + 1)),
        },
    ] {
        assert!(matches!(
            service.start_phone_call("thread-a", bad_req).await,
            Err(PhoneCallError::Invalid(_))
        ));
    }

    // Start call 1 and verify approval modal + live_work_count + concurrent slot rejection + user decline!
    let svc_decline = PhoneCallService::with_options(
        service.config.clone(),
        Arc::clone(&hub),
        Weak::new(),
        PhoneCallTimeouts {
            approval_timeout: Duration::from_secs(5),
            max_call_duration: Duration::from_secs(30),
            opening_greeting_wait: Duration::from_millis(50),
        },
        None,
    );
    let svc_spawn = Arc::clone(&svc_decline);
    let call_task = tokio::spawn(async move {
        svc_spawn
            .start_phone_call(
                "thread-a",
                StartPhoneCallRequest {
                    phone_number: "+15559876543".to_string(),
                    objective: "Ask if dinner reservations are open".to_string(),
                    callee_name: Some("Osteria Bella".to_string()),
                    first_message: Some("Say hello".to_string()),
                    context: None,
                },
            )
            .await
    });

    let modal = recv_matching_notification(&mut rx, |method, params| {
        method == "bridge/ui.present"
            && params["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("phone-call-approval:"))
    })
    .await;
    let approval_id = modal["id"].as_str().expect("modal id").to_string();
    assert_eq!(modal["presentation"], "modal");
    assert_eq!(modal["kind"], "phone-call");
    assert_eq!(modal["tone"], "warning");
    assert_eq!(modal["dismissible"], false);
    assert_eq!(svc_decline.live_work_count(), 1);

    // Concurrent call attempt while first is awaiting approval must be rejected.
    let concurrent_err = svc_decline
        .start_phone_call(
            "thread-b",
            StartPhoneCallRequest {
                phone_number: "+15550001111".to_string(),
                objective: "Second call".to_string(),
                callee_name: None,
                first_message: None,
                context: None,
            },
        )
        .await
        .expect_err("second concurrent call rejected");
    assert!(concurrent_err.to_string().contains("already active"));

    svc_decline
        .resolve_ui_action(&ResolveBridgeUiSurfaceRequest {
            id: approval_id.clone(),
            thread_id: "thread-a".to_string(),
            turn_id: None,
            action_id: "cancel".to_string(),
        })
        .await;

    let dismiss = recv_matching_notification(&mut rx, |method, params| {
        method == "bridge/ui.dismiss" && params["id"] == approval_id
    })
    .await;
    assert_eq!(dismiss["threadId"], "thread-a");

    let decline_err = call_task
        .await
        .expect("join call task")
        .expect_err("declined call returns error");
    assert_eq!(
        decline_err.to_string(),
        "Phone call was declined by the user",
    );
    assert_eq!(svc_decline.live_work_count(), 0);

    // Approval timeout dismisses modal and releases slot.
    let timeout_err = service
        .start_phone_call(
            "thread-a",
            StartPhoneCallRequest {
                phone_number: "+15559876543".to_string(),
                objective: "Check table".to_string(),
                callee_name: None,
                first_message: None,
                context: None,
            },
        )
        .await
        .expect_err("approval timeout");
    assert_eq!(
        timeout_err.to_string(),
        "Timed out waiting for phone call approval",
    );
    let _ = recv_matching_notification(&mut rx, |method, _| method == "bridge/ui.dismiss").await;
    assert_eq!(service.live_work_count(), 0);
}

#[tokio::test]
async fn full_duplex_call_lifecycle_covers_barge_in_steer_dtmf_end_call_isolation_and_queue_report()
{
    let hub = Arc::new(ClientHub::new());
    let (outbox, mut rx) = client_outbox(256);
    let _client_id = hub
        .add_client_with_metadata(outbox, ClientConnectionMetadata::default())
        .await;

    let (report_tx, mut report_rx) = mpsc::unbounded_channel();
    let dispatcher = Arc::new(MockQueueDispatcher {
        captured: report_tx,
    });
    let queue = BridgeQueueService::with_submission_store(
        dispatcher,
        Arc::clone(&hub),
        None,
        crate::queue_service::DurableQueueSubmissions::default(),
    );

    // Turn 1 (opening silent-pickup turn): long speech that gets interrupted by callee barge-in.
    // Turn 2 (after callee utterance + live steer): sends DTMF "1" + wait_silently.
    // Turn 3 (after second callee utterance): speaks closing + calls end_call.
    let turn1_sse = vec![
        b"data: {\"choices\":[{\"delta\":{\"content\":\"Hi, I am an AI assistant calling for Alex Example.\"}}]}\n\n".to_vec(),
        b"data: {\"choices\":[{\"delta\":{\"content\":\" I would like to reserve a table for four tonight.\"}}]}\n\n".to_vec(),
        format!("data: {}\n\n", json!({"choices":[{"delta":{"tool_calls":voice_tool("wait_silently",json!({"on_hold":false}))}}]})).into_bytes(),
        b"data: [DONE]\n\n".to_vec(),
    ];
    let turn2_sse = vec![
        b"data: {\"choices\":[{\"delta\":{\"content\":\"Pressing one now.\"}}]}\n\n".to_vec(),
        b"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"tc_dtmf\",\"type\":\"function\",\"function\":{\"name\":\"send_dtmf\",\"arguments\":\"{\\\"digits\\\":\\\"1\\\"}\"}},{\"index\":1,\"id\":\"tc_wait\",\"type\":\"function\",\"function\":{\"name\":\"wait_silently\",\"arguments\":\"{\\\"reason\\\":\\\"IVR menu\\\"}\"}}]}}]}\n\n".to_vec(),
        b"data: [DONE]\n\n".to_vec(),
    ];
    let turn3_sse = vec![
        b"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"tc_end\",\"type\":\"function\",\"function\":{\"name\":\"phone_turn\",\"arguments\":\"{\\\"decision\\\":\\\"end_call\\\",\\\"reason\\\":\\\"reservation_confirmed\\\",\\\"outcome_summary\\\":\\\"Booked patio table for four at 7:45 PM\\\",\\\"speech\\\":\\\"Confirmed for seven forty-five p m on the patio, thank you!\\\",\\\"digits\\\":\\\"\\\",\\\"on_hold\\\":false}\"}}]}}]}\n\n".to_vec(),
        b"data: [DONE]\n\n".to_vec(),
    ];

    let voice_state = MockVoiceState::new(
        vec![turn1_sse, turn2_sse, turn3_sse],
        vec![
            "Welcome to Osteria Bella. Press 1 for reservations.",
            "Patio table for four is booked for seven forty-five!",
        ],
        24_000, // 1,000 ms @ 24 kHz -> 50 RTP frames per clause (100 across 2 clauses) so barge-in truncates active playback
    );
    voice_state.tts_chunk_delay_ms.store(10, Ordering::SeqCst);
    let voice_url = spawn_mock_voice_http(Arc::clone(&voice_state)).await;

    let trunk_sip = UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("bind SIP UDP");
    let trunk_sip_addr = trunk_sip.local_addr().expect("sip addr");
    let trunk_rtp = Arc::new(
        UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .await
            .expect("bind RTP UDP"),
    );
    let trunk_rtp_addr = trunk_rtp.local_addr().expect("rtp addr");

    let trunk_rtp_task = Arc::clone(&trunk_rtp);
    let (barge_ready_tx, barge_ready_rx) = oneshot::channel::<SocketAddr>();
    let (turn1_truncated_tx, turn1_truncated_rx) = oneshot::channel::<usize>();
    let (dtmf_seen_tx, dtmf_seen_rx) = oneshot::channel::<()>();
    let (bye_seen_tx, bye_seen_rx) = oneshot::channel::<()>();

    tokio::spawn(async move {
        let dialog =
            MockSipDialog::accept_invite(&trunk_sip, trunk_rtp_addr.port(), true, true).await;

        // Wait until assistant voice RTP frames (non-0xFF) start arriving, then signal barge_ready!
        let mut rtp_buf = vec![0_u8; 2048];
        loop {
            let (n_pkt, _) = trunk_rtp_task.recv_from(&mut rtp_buf).await.expect("RTP");
            if let Some(pkt) = parse_rtp_packet(&rtp_buf[..n_pkt]) {
                if pkt.payload_type == PCMU_PAYLOAD_TYPE && pkt.payload.iter().any(|&b| b != 0xFF) {
                    let _ = barge_ready_tx.send(dialog.client_rtp_addr);
                    break;
                }
            }
        }

        // Observe Turn 1 truncation (returns to 0xFF silence well before 100 frames) and RFC 4733 DTMF '1'!
        let mut turn1_voice_frames = 1_usize;
        let mut silence_run = 0_usize;
        let mut truncated_tx = Some(turn1_truncated_tx);
        loop {
            let (n_pkt, _) = trunk_rtp_task.recv_from(&mut rtp_buf).await.expect("RTP");
            if let Some(pkt) = parse_rtp_packet(&rtp_buf[..n_pkt]) {
                if truncated_tx.is_some() && pkt.payload_type == PCMU_PAYLOAD_TYPE {
                    if pkt.payload.iter().any(|&b| b != 0xFF) {
                        turn1_voice_frames = turn1_voice_frames.saturating_add(1);
                        silence_run = 0;
                    } else {
                        silence_run = silence_run.saturating_add(1);
                        if silence_run >= 2 {
                            if let Some(tx) = truncated_tx.take() {
                                let _ = tx.send(turn1_voice_frames);
                            }
                        }
                    }
                }
                if pkt.payload_type == DEFAULT_TELEPHONE_EVENT_PT && pkt.payload.first() == Some(&1)
                {
                    if let Some(tx) = truncated_tx.take() {
                        let _ = tx.send(turn1_voice_frames);
                    }
                    let _ = dtmf_seen_tx.send(());
                    break;
                }
            }
        }

        dialog.expect_bye_and_reply_ok(&trunk_sip).await;
        let _ = bye_seen_tx.send(());
    });

    let service = PhoneCallService::with_options(
        Some(sample_runtime_config(trunk_sip_addr.port(), &voice_url)),
        Arc::clone(&hub),
        Arc::downgrade(&queue),
        PhoneCallTimeouts {
            approval_timeout: Duration::from_secs(5),
            max_call_duration: Duration::from_secs(60),
            opening_greeting_wait: Duration::from_millis(40),
        },
        None,
    );

    let svc_for_start = Arc::clone(&service);
    let start_handle = tokio::spawn(async move {
        svc_for_start
            .start_phone_call(
                "owner-thread",
                StartPhoneCallRequest {
                    phone_number: "+15559876543".to_string(),
                    objective: "Book dinner for four at 7:45 PM".to_string(),
                    callee_name: Some("Osteria Bella".to_string()),
                    first_message: None,
                    context: Some("Quiet table preferred".to_string()),
                },
            )
            .await
    });

    let modal = recv_matching_notification(&mut rx, |method, params| {
        method == "bridge/ui.present"
            && params["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("phone-call-approval:"))
    })
    .await;
    service
        .resolve_ui_action(&ResolveBridgeUiSurfaceRequest {
            id: modal["id"].as_str().expect("id").to_string(),
            thread_id: "owner-thread".to_string(),
            turn_id: None,
            action_id: "approve".to_string(),
        })
        .await;

    let started = timeout(TEST_TIMEOUT, start_handle)
        .await
        .expect("start_phone_call timeout")
        .expect("join start")
        .expect("start_phone_call succeeded on 200 OK");
    assert_eq!(started.status, PhoneCallStatus::InProgress);
    assert_eq!(started.phone_number, "+15559876543");
    assert_eq!(started.callee_name.as_deref(), Some("Osteria Bella"));
    assert_eq!(service.live_work_count(), 1);

    // Cross-thread isolation: another thread cannot read, steer, or hang up this call!
    assert_eq!(
        service
            .steer_phone_call("intruder-thread", &started.call_id, "Cancel everything")
            .expect("steer isolation")
            .status,
        SteerPhoneCallStatus::NotFound,
    );
    assert_eq!(
        service
            .get_phone_call("intruder-thread", &started.call_id)
            .expect("get isolation")
            .status,
        PhoneCallStatus::NotFound,
    );
    assert_eq!(
        service
            .hangup_phone_call("intruder-thread", &started.call_id)
            .await
            .expect("hangup isolation")
            .status,
        HangupPhoneCallStatus::NotFound,
    );

    // Wait until Turn 1 audio is actively playing on RTP, then inject live steer + callee barge-in!
    let client_rtp_addr = timeout(TEST_TIMEOUT, barge_ready_rx)
        .await
        .expect("barge ready timeout")
        .expect("client rtp addr");

    let steer_res = service
        .steer_phone_call(
            "owner-thread",
            &started.call_id,
            "Ask for the heated patio.",
        )
        .expect("owner steer");
    assert_eq!(steer_res.status, SteerPhoneCallStatus::Steered);

    // Send loud inbound RTP frames to trigger barge-in followed by hangover silence to complete Utterance 1!
    let mut seq: u16 = 1;
    let mut ts: u32 = 160;
    send_rtp_utterance(
        &trunk_rtp,
        client_rtp_addr,
        &mut seq,
        &mut ts,
        VAD_BARGE_IN_ONSET_FRAMES + 4,
        VAD_DEFAULT_HANGOVER_FRAMES + 2,
    )
    .await;

    let turn1_voice_frames = timeout(TEST_TIMEOUT, turn1_truncated_rx)
        .await
        .expect("barge-in truncation timeout")
        .expect("turn1 voice frame count");
    assert!(
        turn1_voice_frames < 80,
        "barge-in must truncate queued 100-frame outbound TTS early (saw {turn1_voice_frames})",
    );

    let interrupted_card = recv_matching_notification(&mut rx, |method, params| {
        method == "bridge/ui.update"
            && params["blocks"].as_array().is_some_and(|blocks| {
                blocks.iter().any(|block| {
                    block["markdown"]
                        .as_str()
                        .is_some_and(|md| md.contains("[interrupted]"))
                })
            })
    })
    .await;
    assert_eq!(interrupted_card["kind"], "phone-call");

    // Turn 2 sends RFC 4733 DTMF '1' and sets IVR hangover mode (55 frames)!
    timeout(TEST_TIMEOUT, dtmf_seen_rx)
        .await
        .expect("RFC 4733 DTMF '1' timeout")
        .expect("DTMF seen");

    // Send Utterance 2 from callee (with 60 silence frames for IVR hangover) so Turn 3 calls end_call!
    send_rtp_utterance(&trunk_rtp, client_rtp_addr, &mut seq, &mut ts, 10, 60).await;

    timeout(TEST_TIMEOUT, bye_seen_rx)
        .await
        .expect("SIP BYE timeout")
        .expect("SIP BYE received");

    // Post-call structured report must arrive on owner-thread via BridgeQueueService!
    let report = timeout(TEST_TIMEOUT, report_rx.recv())
        .await
        .expect("post-call queue report timeout")
        .expect("post-call report");
    assert_eq!(report.thread_id, "owner-thread");
    let report_text = report.turn_start["input"][0]["text"]
        .as_str()
        .expect("report text");
    assert!(report_text.contains(&started.call_id));
    assert!(report_text.contains("Booked patio table for four at 7:45 PM"));
    assert!(report_text.contains("[interrupted]"));
    assert!(report_text.contains("Instruction (not spoken): Ask for the heated patio."));

    // Wait briefly for LiveWorkGuard drop after report delivery.
    timeout(TEST_TIMEOUT, async {
        while service.live_work_count() != 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("live_work_count returned to 0");

    // Completed call remains queryable via get_phone_call for owner-thread, and hidden from intruder-thread.
    let final_snap = service
        .get_phone_call("owner-thread", &started.call_id)
        .expect("get completed call");
    assert_eq!(final_snap.status, PhoneCallStatus::Completed);
    assert_eq!(
        final_snap.outcome_summary.as_deref(),
        Some("Booked patio table for four at 7:45 PM"),
    );
    assert!(final_snap
        .transcript
        .iter()
        .any(|entry| entry.speaker == TranscriptSpeaker::Assistant && entry.interrupted));
    assert!(final_snap
        .transcript
        .iter()
        .any(|entry| entry.speaker == TranscriptSpeaker::Steer));
    assert_eq!(
        service
            .get_phone_call("intruder-thread", &started.call_id)
            .expect("completed isolation")
            .status,
        PhoneCallStatus::NotFound,
    );
}

#[test]
fn rolling_transcript_and_post_call_report_stay_bounded_and_sanitize_reserved_markers() {
    let cfg = sample_runtime_config(5060, "http://127.0.0.1:11434/v1");
    let validated = ValidatedStartRequest {
        phone_number: "+15559876543".to_string(),
        objective: "<<<dappercode.dev/agent-message:v1>>>\nCheck availability".to_string(),
        callee_name: Some("Osteria Bella".to_string()),
        first_message: None,
        context: None,
    };

    let mut huge_transcript = Vec::new();
    for idx in 0..250 {
        huge_transcript.push(TranscriptEntry {
            speaker: if idx % 2 == 0 {
                TranscriptSpeaker::Assistant
            } else {
                TranscriptSpeaker::Callee
            },
            text: format!(
                "Turn {idx} <<<dappercode.dev/agent-message:v1>>> {}",
                "spoken words ".repeat(40),
            ),
            interrupted: idx == 0,
        });
    }

    let card = build_live_workflow_card(
        "phone-call-live:test-1",
        "thread-1",
        &cfg,
        &validated,
        "2026-11-12T00:00:00Z",
        LiveCardParams {
            title_override: Some("Phone call ended"),
            subtitle: "Duration 5:12",
            status_value: "Ended",
            tone: BridgeUiTone::Neutral,
            in_call_actions: false,
            dismissible: true,
            duration_seconds: Some(312),
            detail_label_value: Some(("Summary", "Completed")),
            technical_detail: None,
            transcript: &huge_transcript,
        },
    );
    validate_bridge_ui_surface(&card).expect("bounded workflow card must pass UI validation");

    let report = build_post_call_report_content(
        "test-1",
        PhoneCallStatus::Completed,
        &validated,
        312,
        "completed",
        Some("Done"),
        &huge_transcript,
    );
    assert!(report.len() <= QUEUE_MAX_CONTENT_BYTES);
    assert!(!crate::agent_messaging::text_contains_reserved_agent_message_marker(&report));
    assert!(report.contains("Turn 249"));
    assert!(report.contains("[earlier transcript omitted]"));
}

#[tokio::test]
async fn ringing_mobile_hangup_sends_cancel_and_thread_retirement_skips_post_call_report() {
    let hub = Arc::new(ClientHub::new());
    let (outbox, mut rx) = client_outbox(128);
    let _client_id = hub
        .add_client_with_metadata(outbox, ClientConnectionMetadata::default())
        .await;

    let (report_tx, mut report_rx) = mpsc::unbounded_channel();
    let dispatcher = Arc::new(MockQueueDispatcher {
        captured: report_tx,
    });
    let queue = BridgeQueueService::with_submission_store(
        dispatcher,
        Arc::clone(&hub),
        None,
        crate::queue_service::DurableQueueSubmissions::default(),
    );

    let voice_state = MockVoiceState::new(Vec::new(), Vec::new(), 480);
    let voice_url = spawn_mock_voice_http(voice_state).await;

    // Part 1: Mobile "Hang Up" during 180 Ringing -> sends SIP CANCEL and settles live card.
    let ring_sip = UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("bind ring SIP");
    let ring_sip_addr = ring_sip.local_addr().expect("ring addr");
    let (cancel_seen_tx, cancel_seen_rx) = oneshot::channel::<()>();

    tokio::spawn(async move {
        let mut buf = vec![0_u8; 65535];
        let (n_inv, peer) = ring_sip.recv_from(&mut buf).await.expect("INVITE");
        let inv = std::str::from_utf8(&buf[..n_inv]).expect("utf8");
        let via = extract_sip_header(inv, "Via:");
        let from = extract_sip_header(inv, "From:");
        let to = extract_sip_header(inv, "To:");
        let call_id = extract_sip_header(inv, "Call-ID:");
        let r180 = format!(
            "SIP/2.0 180 Ringing\r\nVia: {via}\r\nFrom: {from}\r\nTo: {to};tag=r1\r\nCall-ID: {call_id}\r\nCSeq: 1 INVITE\r\nContent-Length: 0\r\n\r\n",
        );
        ring_sip.send_to(r180.as_bytes(), peer).await.expect("180");

        let (n_can, _) = ring_sip.recv_from(&mut buf).await.expect("CANCEL");
        let can = std::str::from_utf8(&buf[..n_can]).expect("utf8");
        assert!(can.starts_with("CANCEL "));
        let ok_can = format!(
            "SIP/2.0 200 OK\r\nVia: {via}\r\nFrom: {from}\r\nTo: {to};tag=r1\r\nCall-ID: {call_id}\r\nCSeq: 1 CANCEL\r\nContent-Length: 0\r\n\r\n",
        );
        let t487 = format!(
            "SIP/2.0 487 Request Terminated\r\nVia: {via}\r\nFrom: {from}\r\nTo: {to};tag=r1\r\nCall-ID: {call_id}\r\nCSeq: 1 INVITE\r\nContent-Length: 0\r\n\r\n",
        );
        let _ = ring_sip.send_to(ok_can.as_bytes(), peer).await;
        let _ = ring_sip.send_to(t487.as_bytes(), peer).await;
        let _ = cancel_seen_tx.send(());
    });

    let ring_service = PhoneCallService::with_options(
        Some(sample_runtime_config(ring_sip_addr.port(), &voice_url)),
        Arc::clone(&hub),
        Arc::downgrade(&queue),
        PhoneCallTimeouts {
            approval_timeout: Duration::from_secs(5),
            max_call_duration: Duration::from_secs(60),
            opening_greeting_wait: Duration::from_secs(5),
        },
        None,
    );

    let svc_ring = Arc::clone(&ring_service);
    let ring_task = tokio::spawn(async move {
        svc_ring
            .start_phone_call(
                "thread-ring",
                StartPhoneCallRequest {
                    phone_number: "+15559876543".to_string(),
                    objective: "Test ringing hangup".to_string(),
                    callee_name: None,
                    first_message: None,
                    context: None,
                },
            )
            .await
    });

    let modal = recv_matching_notification(&mut rx, |method, params| {
        method == "bridge/ui.present"
            && params["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("phone-call-approval:"))
    })
    .await;
    ring_service
        .resolve_ui_action(&ResolveBridgeUiSurfaceRequest {
            id: modal["id"].as_str().expect("id").to_string(),
            thread_id: "thread-ring".to_string(),
            turn_id: None,
            action_id: "approve".to_string(),
        })
        .await;

    let ringing_card = recv_matching_notification(&mut rx, |method, params| {
        method == "bridge/ui.update" && params["subtitle"] == "Ringing…"
    })
    .await;
    let live_id = ringing_card["id"].as_str().expect("live id").to_string();

    ring_service
        .resolve_ui_action(&ResolveBridgeUiSurfaceRequest {
            id: live_id.clone(),
            thread_id: "thread-ring".to_string(),
            turn_id: None,
            action_id: "hangup".to_string(),
        })
        .await;

    timeout(TEST_TIMEOUT, cancel_seen_rx)
        .await
        .expect("SIP CANCEL timeout")
        .expect("CANCEL seen");

    let ring_err = ring_task
        .await
        .expect("join")
        .expect_err("ring hangup rejects");
    assert!(ring_err.to_string().contains("hung up before connecting"));

    let settled_ring_card = recv_matching_notification(&mut rx, |method, params| {
        method == "bridge/ui.update"
            && params["id"] == live_id
            && params["title"] == "Phone call ended"
    })
    .await;
    assert_eq!(settled_ring_card["dismissible"], true);
    assert_eq!(
        settled_ring_card["actions"].as_array().map(Vec::len),
        Some(0),
    );
    assert!(report_rx.try_recv().is_err());

    // Part 2: Active connected call cancelled by thread retirement skips post-call queue report!
    let ret_sip = UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("bind ret SIP");
    let ret_sip_addr = ret_sip.local_addr().expect("ret addr");
    let ret_rtp = UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("bind ret RTP");
    let ret_rtp_port = ret_rtp.local_addr().expect("rtp port").port();

    tokio::spawn(async move {
        let dialog = MockSipDialog::accept_invite(&ret_sip, ret_rtp_port, false, false).await;
        dialog.expect_bye_and_reply_ok(&ret_sip).await;
    });

    let ret_service = PhoneCallService::with_options(
        Some(sample_runtime_config(ret_sip_addr.port(), &voice_url)),
        Arc::clone(&hub),
        Arc::downgrade(&queue),
        PhoneCallTimeouts {
            approval_timeout: Duration::from_secs(5),
            max_call_duration: Duration::from_secs(60),
            opening_greeting_wait: Duration::from_secs(10),
        },
        None,
    );

    let svc_ret = Arc::clone(&ret_service);
    let ret_start = tokio::spawn(async move {
        svc_ret
            .start_phone_call(
                "retiring-thread",
                StartPhoneCallRequest {
                    phone_number: "+15559876543".to_string(),
                    objective: "Test retirement".to_string(),
                    callee_name: None,
                    first_message: None,
                    context: None,
                },
            )
            .await
    });

    let modal2 = recv_matching_notification(&mut rx, |method, params| {
        method == "bridge/ui.present"
            && params["threadId"] == "retiring-thread"
            && params["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("phone-call-approval:"))
    })
    .await;
    ret_service
        .resolve_ui_action(&ResolveBridgeUiSurfaceRequest {
            id: modal2["id"].as_str().expect("id").to_string(),
            thread_id: "retiring-thread".to_string(),
            turn_id: None,
            action_id: "approve".to_string(),
        })
        .await;

    let started_ret = ret_start.await.expect("join").expect("connected");
    assert_eq!(started_ret.status, PhoneCallStatus::InProgress);

    ret_service
        .cancel_for_retiring_threads(&["retiring-thread".to_string()])
        .await;
    assert_eq!(ret_service.live_work_count(), 0);
    assert!(
        report_rx.try_recv().is_err(),
        "thread retirement must skip post-call report delivery",
    );
}

#[tokio::test]
async fn mcp_e2e_happy_path_covers_approval_ringing_callee_speech_tts_rtp_steer_dtmf_and_autonomous_hangup(
) {
    let hub = Arc::new(ClientHub::new());
    let (outbox, mut rx) = client_outbox(256);
    let _client_id = hub
        .add_client_with_metadata(outbox, ClientConnectionMetadata::default())
        .await;

    let (report_tx, mut report_rx) = mpsc::unbounded_channel();
    let queue = BridgeQueueService::with_submission_store(
        Arc::new(MockQueueDispatcher {
            captured: report_tx,
        }),
        Arc::clone(&hub),
        None,
        crate::queue_service::DurableQueueSubmissions::default(),
    );

    let turn1_sse = vec![
        b"data: {\"choices\":[{\"delta\":{\"content\":\"Hi, I am an AI assistant calling for Alex Example to book dinner for four.\"}}]}\n\n".to_vec(),
        format!("data: {}\n\n", json!({"choices":[{"delta":{"tool_calls":voice_tool("wait_silently",json!({"on_hold":false}))}}]})).into_bytes(),
        b"data: [DONE]\n\n".to_vec(),
    ];
    let turn2_sse = vec![
        b"data: {\"choices\":[{\"delta\":{\"content\":\"Dialing extension two and confirming seven forty-five p m.\"}}]}\n\n".to_vec(),
        b"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"tc_dtmf_2\",\"type\":\"function\",\"function\":{\"name\":\"send_dtmf\",\"arguments\":\"{\\\"digits\\\":\\\"2\\\"}\"}},{\"index\":1,\"id\":\"tc_end_2\",\"type\":\"function\",\"function\":{\"name\":\"end_call\",\"arguments\":\"{\\\"reason\\\":\\\"reservation_confirmed\\\",\\\"outcome_summary\\\":\\\"Booked patio table for four at 7:45 PM\\\"}\"}}]}}]}\n\n".to_vec(),
        b"data: [DONE]\n\n".to_vec(),
    ];
    let voice_state = MockVoiceState::new(
        vec![turn1_sse, turn2_sse],
        vec!["Hello, Osteria Bella, press 2 for the patio host."],
        2_400, // 100 ms @ 24 kHz -> 5 PCMU RTP frames
    );
    let voice_url = spawn_mock_voice_http(Arc::clone(&voice_state)).await;

    let trunk_sip = UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("bind SIP UDP");
    let trunk_sip_port = trunk_sip.local_addr().expect("sip addr").port();
    let trunk_rtp = Arc::new(
        UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .await
            .expect("bind RTP UDP"),
    );
    let trunk_rtp_port = trunk_rtp.local_addr().expect("rtp addr").port();

    let (connected_rtp_tx, connected_rtp_rx) = oneshot::channel::<SocketAddr>();
    let (pcmu_voice_tx, pcmu_voice_rx) = oneshot::channel::<usize>();
    let (dtmf_end_tx, dtmf_end_rx) = oneshot::channel::<()>();
    let (bye_tx, bye_rx) = oneshot::channel::<()>();
    let trunk_rtp_task = Arc::clone(&trunk_rtp);

    tokio::spawn(async move {
        let dialog = MockSipDialog::accept_invite(&trunk_sip, trunk_rtp_port, true, true).await;
        let _ = connected_rtp_tx.send(dialog.client_rtp_addr);

        let mut rtp_buf = vec![0_u8; 2048];
        let mut voice_frames = 0_usize;
        loop {
            let (n_pkt, _) = trunk_rtp_task.recv_from(&mut rtp_buf).await.expect("RTP");
            if let Some(pkt) = parse_rtp_packet(&rtp_buf[..n_pkt]) {
                if pkt.payload_type == PCMU_PAYLOAD_TYPE
                    && pkt.payload.len() == PCMU_FRAME_BYTES
                    && pkt.payload.iter().any(|&b| b != 0xFF)
                {
                    voice_frames = voice_frames.saturating_add(1);
                    if voice_frames >= 3 {
                        let _ = pcmu_voice_tx.send(voice_frames);
                        break;
                    }
                }
            }
        }

        // Observe RFC 4733 DTMF digit '2' including end-of-event marker bit (0x80).
        loop {
            let (n_pkt, _) = trunk_rtp_task.recv_from(&mut rtp_buf).await.expect("RTP");
            if let Some(pkt) = parse_rtp_packet(&rtp_buf[..n_pkt]) {
                if pkt.payload_type == DEFAULT_TELEPHONE_EVENT_PT
                    && pkt.payload.first() == Some(&2)
                    && pkt.payload.get(1).is_some_and(|flags| flags & 0x80 != 0)
                {
                    let _ = dtmf_end_tx.send(());
                    break;
                }
            }
        }

        dialog.expect_bye_and_reply_ok(&trunk_sip).await;
        let _ = bye_tx.send(());
    });

    let service = PhoneCallService::with_options(
        Some(sample_runtime_config(trunk_sip_port, &voice_url)),
        Arc::clone(&hub),
        Arc::downgrade(&queue),
        PhoneCallTimeouts {
            approval_timeout: Duration::from_secs(5),
            max_call_duration: Duration::from_secs(60),
            opening_greeting_wait: Duration::from_secs(5),
        },
        None,
    );
    assert!(can_retire_for_service(&service));

    let mcp_service = crate::agent_messaging::AgentMessagingService::start(
        Weak::<crate::runtime_backend::RuntimeBackend>::new(),
        Arc::downgrade(&queue),
        crate::scheduled_prompts::ScheduledPromptService::inert_for_test(),
        Arc::clone(&service),
    )
    .await
    .expect("start HTTP MCP server");
    let owner_thread = crate::acp::identity::AgentSessionId::new("agent", "mcp-owner")
        .expect("owner session id")
        .encode();
    let owner_mcp = McpHttpTestClient::connect(mcp_service.config(), "agent", &owner_thread).await;

    let owner_mcp_start = owner_mcp.clone();
    let start_task = tokio::spawn(async move {
        owner_mcp_start
            .call_tool_json(
                10,
                "start_phone_call",
                json!({
                    "phoneNumber": "+15559876543",
                    "calleeName": "Osteria Bella",
                    "objective": "Book dinner for four at 7:45 PM",
                    "firstMessage": "Introduce yourself politely",
                    "context": "Patio preferred"
                }),
            )
            .await
    });

    let modal = recv_matching_notification(&mut rx, |method, params| {
        method == "bridge/ui.present"
            && params["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("phone-call-approval:"))
    })
    .await;
    let approval_id = modal["id"].as_str().expect("modal id").to_string();
    assert_eq!(modal["presentation"], "modal");
    assert_eq!(modal["kind"], "phone-call");
    assert_eq!(modal["dismissible"], false);
    assert_eq!(service.live_work_count(), 1);
    assert!(!can_retire_for_service(&service));

    service
        .resolve_ui_action(&ResolveBridgeUiSurfaceRequest {
            id: approval_id.clone(),
            thread_id: owner_thread.clone(),
            turn_id: None,
            action_id: "approve".to_string(),
        })
        .await;

    let _ = recv_matching_notification(&mut rx, |method, params| {
        method == "bridge/ui.dismiss" && params["id"] == approval_id
    })
    .await;
    let presented_card = recv_matching_notification(&mut rx, |method, params| {
        method == "bridge/ui.present"
            && params["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("phone-call-live:"))
    })
    .await;
    let live_id = presented_card["id"].as_str().expect("live id").to_string();
    assert_eq!(presented_card["presentation"], "workflowCard");
    assert_eq!(presented_card["kind"], "phone-call");
    assert_eq!(presented_card["dismissible"], false);
    assert_eq!(presented_card["actions"][0]["id"], "hangup");
    assert_eq!(presented_card["actions"][0]["dismissesSurface"], false);

    let _ = recv_matching_notification(&mut rx, |method, params| {
        method == "bridge/ui.update" && params["id"] == live_id && params["subtitle"] == "Ringing…"
    })
    .await;

    let started_json = timeout(TEST_TIMEOUT, start_task)
        .await
        .expect("MCP start_phone_call timeout")
        .expect("join MCP start_phone_call");
    let call_id = started_json["callId"].as_str().expect("callId").to_string();
    assert_eq!(started_json["status"], "in_progress");
    assert_eq!(started_json["phoneNumber"], "+15559876543");
    assert_eq!(started_json["calleeName"], "Osteria Bella");
    assert_eq!(service.live_work_count(), 1);
    assert!(!can_retire_for_service(&service));

    let client_rtp_addr = timeout(TEST_TIMEOUT, connected_rtp_rx)
        .await
        .expect("connected RTP addr timeout")
        .expect("client RTP addr");

    // Callee speaks -> VAD segments -> STT transcribes -> live card shows callee transcript -> LLM + TTS -> 8kHz PCMU RTP!
    let mut seq: u16 = 1;
    let mut ts: u32 = 160;
    send_rtp_utterance(
        &trunk_rtp,
        client_rtp_addr,
        &mut seq,
        &mut ts,
        10,
        VAD_DEFAULT_HANGOVER_FRAMES + 2,
    )
    .await;

    let callee_card = recv_matching_notification(&mut rx, |method, params| {
        method == "bridge/ui.update"
            && params["id"] == live_id
            && params["blocks"].as_array().is_some_and(|blocks| {
                blocks.iter().any(|block| {
                    block["markdown"].as_str().is_some_and(|md| {
                        md.contains(
                            "**Osteria Bella:** Hello, Osteria Bella, press 2 for the patio host.",
                        )
                    })
                })
            })
    })
    .await;
    assert_eq!(callee_card["subtitle"], "In call");

    let downsampled_frames = timeout(TEST_TIMEOUT, pcmu_voice_rx)
        .await
        .expect("outbound 8kHz PCMU RTP timeout")
        .expect("voice frames");
    assert!(downsampled_frames >= 3);

    // Wait for Turn 1 assistant transcript update so Turn 1 has finished playing out before steering.
    let _ = recv_matching_notification(&mut rx, |method, params| {
        method == "bridge/ui.update"
            && params["id"] == live_id
            && params["blocks"].as_array().is_some_and(|blocks| {
                blocks.iter().any(|block| {
                    block["markdown"]
                        .as_str()
                        .is_some_and(|md| md.contains("**Agent:** Hi, I am an AI assistant"))
                })
            })
    })
    .await;

    // Live steer_phone_call mid-call via HTTP MCP!
    let steer_json = owner_mcp
        .call_tool_json(
            11,
            "steer_phone_call",
            json!({
                "callId": call_id,
                "instruction": "Press 2 now and confirm 7:45 PM for four."
            }),
        )
        .await;
    assert_eq!(steer_json["status"], "steered");

    let steer_card = recv_matching_notification(&mut rx, |method, params| {
        method == "bridge/ui.update"
            && params["id"] == live_id
            && params["blocks"].as_array().is_some_and(|blocks| {
                blocks.iter().any(|block| {
                    block["markdown"].as_str().is_some_and(|md| {
                        md.contains("**Instruction (not spoken):** Press 2 now and confirm 7:45 PM for four.")
                    })
                })
            })
    })
    .await;
    assert_eq!(steer_card["kind"], "phone-call");

    timeout(TEST_TIMEOUT, dtmf_end_rx)
        .await
        .expect("RFC 4733 DTMF '2' timeout")
        .expect("DTMF '2' observed");
    timeout(TEST_TIMEOUT, bye_rx)
        .await
        .expect("SIP BYE timeout")
        .expect("SIP BYE observed");

    let settled_card = recv_matching_notification(&mut rx, |method, params| {
        method == "bridge/ui.update"
            && params["id"] == live_id
            && params["title"] == "Phone call ended"
    })
    .await;
    assert_eq!(settled_card["dismissible"], true);
    assert_eq!(settled_card["actions"].as_array().map(Vec::len), Some(0));

    // Verify KV-cache-safe steer preserved message[0] system prompt while appending steer message.
    {
        let requests = voice_state.chat_requests.lock().await;
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0]["messages"][0]["role"], "system");
        assert_eq!(requests[0]["messages"][0], requests[1]["messages"][0]);
        let turn2_msgs = requests[1]["messages"].as_array().expect("turn2 messages");
        assert!(turn2_msgs.iter().any(|message| {
            message["role"] == "system"
                && message["content"]
                    .as_str()
                    .is_some_and(|c| c.contains("Press 2 now and confirm 7:45 PM for four."))
        }));
    }

    let report = timeout(TEST_TIMEOUT, report_rx.recv())
        .await
        .expect("post-call queue report timeout")
        .expect("post-call report");
    assert_eq!(report.thread_id, owner_thread);
    let report_text = report.turn_start["input"][0]["text"]
        .as_str()
        .expect("report text");
    assert!(report_text.contains(&call_id));
    assert!(report_text.contains("Status: completed"));
    assert!(report_text.contains("Booked patio table for four at 7:45 PM"));
    assert!(
        report_text.contains("Instruction (not spoken): Press 2 now and confirm 7:45 PM for four."),
    );

    timeout(TEST_TIMEOUT, async {
        while service.live_work_count() != 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("live_work_count returned to 0");
    assert!(can_retire_for_service(&service));

    mcp_service.shutdown().await;
}

#[tokio::test]
async fn mcp_e2e_decline_zero_sip_packets_mobile_mid_call_hangup_and_cross_session_isolation() {
    let hub = Arc::new(ClientHub::new());
    let (outbox, mut rx) = client_outbox(256);
    let _client_id = hub
        .add_client_with_metadata(outbox, ClientConnectionMetadata::default())
        .await;

    let (report_tx, mut report_rx) = mpsc::unbounded_channel();
    let queue = BridgeQueueService::with_submission_store(
        Arc::new(MockQueueDispatcher {
            captured: report_tx,
        }),
        Arc::clone(&hub),
        None,
        crate::queue_service::DurableQueueSubmissions::default(),
    );
    let voice_url = spawn_mock_voice_http(MockVoiceState::new(Vec::new(), Vec::new(), 480)).await;

    // 1. Pre-call decline: zero SIP packets ever reach the mock SIP UDP socket!
    let decline_sip = UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("bind decline SIP UDP");
    let decline_sip_port = decline_sip.local_addr().expect("decline addr").port();

    let decline_service = PhoneCallService::with_options(
        Some(sample_runtime_config(decline_sip_port, &voice_url)),
        Arc::clone(&hub),
        Arc::downgrade(&queue),
        PhoneCallTimeouts {
            approval_timeout: Duration::from_secs(5),
            max_call_duration: Duration::from_secs(60),
            opening_greeting_wait: Duration::from_secs(10),
        },
        None,
    );
    let decline_mcp_server = crate::agent_messaging::AgentMessagingService::start(
        Weak::<crate::runtime_backend::RuntimeBackend>::new(),
        Arc::downgrade(&queue),
        crate::scheduled_prompts::ScheduledPromptService::inert_for_test(),
        Arc::clone(&decline_service),
    )
    .await
    .expect("start decline MCP");
    let owner_thread = crate::acp::identity::AgentSessionId::new("agent", "owner-sess")
        .expect("owner id")
        .encode();
    let intruder_thread = crate::acp::identity::AgentSessionId::new("agent", "intruder-sess")
        .expect("intruder id")
        .encode();
    let decline_owner =
        McpHttpTestClient::connect(decline_mcp_server.config(), "agent", &owner_thread).await;

    let decline_call_task = tokio::spawn(async move {
        decline_owner
            .call_tool(
                20,
                "start_phone_call",
                json!({
                    "phoneNumber": "+15559876543",
                    "objective": "Verify decline never dials"
                }),
            )
            .await
    });

    let decline_modal = recv_matching_notification(&mut rx, |method, params| {
        method == "bridge/ui.present"
            && params["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("phone-call-approval:"))
    })
    .await;
    assert_eq!(decline_service.live_work_count(), 1);
    assert!(!can_retire_for_service(&decline_service));

    decline_service
        .resolve_ui_action(&ResolveBridgeUiSurfaceRequest {
            id: decline_modal["id"].as_str().expect("modal id").to_string(),
            thread_id: owner_thread.clone(),
            turn_id: None,
            action_id: "cancel".to_string(),
        })
        .await;

    let decline_rpc = timeout(TEST_TIMEOUT, decline_call_task)
        .await
        .expect("decline MCP timeout")
        .expect("join decline MCP");
    let decline_err_msg = decline_rpc["error"]["message"].as_str().unwrap_or_else(|| {
        decline_rpc["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or("")
    });
    assert!(
        decline_err_msg.contains("declined by the user"),
        "unexpected decline MCP response: {decline_rpc}",
    );
    assert_eq!(decline_service.live_work_count(), 0);
    assert!(can_retire_for_service(&decline_service));

    let mut probe_buf = [0_u8; 64];
    assert!(
        matches!(
            decline_sip.try_recv_from(&mut probe_buf),
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock
        ),
        "declined phone call must transmit zero SIP packets",
    );
    decline_mcp_server.shutdown().await;

    // 2. Connected mid-call mobile Hang Up + cross-thread MCP credential isolation!
    let live_sip = UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("bind live SIP");
    let live_sip_port = live_sip.local_addr().expect("live sip addr").port();
    let live_rtp = UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("bind live RTP");
    let live_rtp_port = live_rtp.local_addr().expect("live rtp addr").port();
    let (bye_seen_tx, bye_seen_rx) = oneshot::channel::<()>();

    tokio::spawn(async move {
        let dialog = MockSipDialog::accept_invite(&live_sip, live_rtp_port, true, true).await;
        dialog.expect_bye_and_reply_ok(&live_sip).await;
        let _ = bye_seen_tx.send(());
    });

    let live_service = PhoneCallService::with_options(
        Some(sample_runtime_config(live_sip_port, &voice_url)),
        Arc::clone(&hub),
        Arc::downgrade(&queue),
        PhoneCallTimeouts {
            approval_timeout: Duration::from_secs(5),
            max_call_duration: Duration::from_secs(60),
            opening_greeting_wait: Duration::from_secs(10),
        },
        None,
    );
    let live_mcp_server = crate::agent_messaging::AgentMessagingService::start(
        Weak::<crate::runtime_backend::RuntimeBackend>::new(),
        Arc::downgrade(&queue),
        crate::scheduled_prompts::ScheduledPromptService::inert_for_test(),
        Arc::clone(&live_service),
    )
    .await
    .expect("start live MCP");

    let owner_mcp =
        McpHttpTestClient::connect(live_mcp_server.config(), "agent", &owner_thread).await;
    let intruder_mcp =
        McpHttpTestClient::connect(live_mcp_server.config(), "agent", &intruder_thread).await;

    let owner_mcp_start = owner_mcp.clone();
    let start_task = tokio::spawn(async move {
        owner_mcp_start
            .call_tool_json(
                30,
                "start_phone_call",
                json!({
                    "phoneNumber": "+15559876543",
                    "calleeName": "City Clinic",
                    "objective": "Check walk-in hours"
                }),
            )
            .await
    });

    let approve_modal = recv_matching_notification(&mut rx, |method, params| {
        method == "bridge/ui.present"
            && params["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("phone-call-approval:"))
    })
    .await;
    live_service
        .resolve_ui_action(&ResolveBridgeUiSurfaceRequest {
            id: approve_modal["id"].as_str().expect("id").to_string(),
            thread_id: owner_thread.clone(),
            turn_id: None,
            action_id: "approve".to_string(),
        })
        .await;

    let live_card = recv_matching_notification(&mut rx, |method, params| {
        method == "bridge/ui.present"
            && params["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("phone-call-live:"))
    })
    .await;
    let live_card_id = live_card["id"].as_str().expect("live card id").to_string();

    let started = timeout(TEST_TIMEOUT, start_task)
        .await
        .expect("MCP start timeout")
        .expect("join start");
    let call_id = started["callId"].as_str().expect("callId").to_string();
    assert_eq!(started["status"], "in_progress");

    // Another ACP session's MCP credential gets not_found on get / steer / hangup!
    assert_eq!(
        intruder_mcp
            .call_tool_json(31, "get_phone_call", json!({ "callId": call_id }))
            .await["status"],
        "not_found",
    );
    assert_eq!(
        intruder_mcp
            .call_tool_json(
                32,
                "steer_phone_call",
                json!({ "callId": call_id, "instruction": "Hijack call" }),
            )
            .await["status"],
        "not_found",
    );
    assert_eq!(
        intruder_mcp
            .call_tool_json(33, "hangup_phone_call", json!({ "callId": call_id }))
            .await["status"],
        "not_found",
    );

    // User taps Hang Up on the live workflowCard mid-call -> sends SIP BYE, settles card, enqueues report!
    live_service
        .resolve_ui_action(&ResolveBridgeUiSurfaceRequest {
            id: live_card_id.clone(),
            thread_id: owner_thread.clone(),
            turn_id: None,
            action_id: "hangup".to_string(),
        })
        .await;

    timeout(TEST_TIMEOUT, bye_seen_rx)
        .await
        .expect("mid-call mobile hangup SIP BYE timeout")
        .expect("SIP BYE received");

    let settled = recv_matching_notification(&mut rx, |method, params| {
        method == "bridge/ui.update"
            && params["id"] == live_card_id
            && params["title"] == "Phone call ended"
    })
    .await;
    assert_eq!(settled["dismissible"], true);
    assert_eq!(settled["actions"].as_array().map(Vec::len), Some(0));

    let report = timeout(TEST_TIMEOUT, report_rx.recv())
        .await
        .expect("mobile hangup post-call report timeout")
        .expect("post-call report");
    assert_eq!(report.thread_id, owner_thread);
    let report_text = report.turn_start["input"][0]["text"]
        .as_str()
        .expect("report text");
    assert!(report_text.contains(&call_id));
    assert!(report_text.contains("End reason: mobile_hangup"));

    timeout(TEST_TIMEOUT, async {
        while live_service.live_work_count() != 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("live_work_count returned to 0");
    assert!(can_retire_for_service(&live_service));

    let owner_snap = owner_mcp
        .call_tool_json(34, "get_phone_call", json!({ "callId": call_id }))
        .await;
    assert_eq!(owner_snap["status"], "completed");
    assert_eq!(owner_snap["endReason"], "mobile_hangup");
    assert_eq!(
        intruder_mcp
            .call_tool_json(35, "get_phone_call", json!({ "callId": call_id }))
            .await["status"],
        "not_found",
    );

    let _ = live_rtp;
    live_mcp_server.shutdown().await;
}

fn parking_request() -> StartPhoneCallRequest {
    StartPhoneCallRequest {
        phone_number: "+15559876543".to_string(),
        objective: "Ask about parking".to_string(),
        callee_name: None,
        first_message: None,
        context: None,
    }
}

fn ui_action(id: &str, thread_id: &str, action_id: &str) -> ResolveBridgeUiSurfaceRequest {
    ResolveBridgeUiSurfaceRequest {
        id: id.to_string(),
        thread_id: thread_id.to_string(),
        turn_id: None,
        action_id: action_id.to_string(),
    }
}

fn approval_timeouts(approval_timeout: Duration) -> PhoneCallTimeouts {
    PhoneCallTimeouts {
        approval_timeout,
        max_call_duration: Duration::from_secs(30),
        opening_greeting_wait: Duration::from_secs(5),
    }
}

async fn await_approval_call_id(rx: &mut ClientOutboxReceiver) -> String {
    let modal = recv_matching_notification(rx, |method, params| {
        method == "bridge/ui.present" && params["presentation"] == "modal"
    })
    .await;
    modal["id"]
        .as_str()
        .and_then(|id| id.strip_prefix("phone-call-approval:"))
        .expect("approval surface id")
        .to_string()
}

async fn stt_requests_reach(voice: &MockVoiceState, count: usize) {
    timeout(TEST_TIMEOUT, async {
        while voice.stt_requests.load(Ordering::SeqCst) < count {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("transcription request reaches the mock");
}

async fn chat_requests_reach(voice: &MockVoiceState, count: usize) {
    timeout(TEST_TIMEOUT, async {
        while voice.chat_requests.lock().await.len() < count {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("assistant turn request reaches the mock");
}

fn voice_tools(calls: &[(&str, Value)]) -> Value {
    Value::Array(
        calls
            .iter()
            .enumerate()
            .map(|(index, (name, arguments))| {
                json!({
                    "index": index,
                    "id": format!("call_{name}_{index}"),
                    "type": "function",
                    "function": {"name": name, "arguments": arguments.to_string()}
                })
            })
            .collect(),
    )
}

const TRUNK_OWNER: &str = "trunk-owner";
const SLOW_GREETING: &str = "Hello, I am calling about your opening hours today.";

struct TrunkCallOptions {
    timeouts: PhoneCallTimeouts,
    include_dtmf: bool,
    report_queue: bool,
    pre_connect_steer: Option<&'static str>,
    sip_username: Option<&'static str>,
    custom_tls: Option<Arc<rustls::ClientConfig>>,
    voice_config: Option<VoicePipelineConfig>,
    objective: Option<&'static str>,
    connect_timeout: Duration,
}

impl TrunkCallOptions {
    fn new(opening_greeting_wait: Duration, max_call_duration: Duration) -> Self {
        Self {
            timeouts: PhoneCallTimeouts {
                approval_timeout: Duration::from_secs(5),
                max_call_duration,
                opening_greeting_wait,
            },
            include_dtmf: true,
            report_queue: true,
            pre_connect_steer: None,
            sip_username: None,
            custom_tls: None,
            voice_config: None,
            objective: None,
            connect_timeout: TEST_TIMEOUT,
        }
    }
}

// A connected call whose trunk side is driven step by step by the test.
struct TrunkCall {
    service: Arc<PhoneCallService>,
    notifications: ClientOutboxReceiver,
    reports: mpsc::UnboundedReceiver<TurnStartCapture>,
    sip: Arc<UdpSocket>,
    rtp: UdpSocket,
    rtp_port: u16,
    dialog: MockSipDialog,
    seq: u16,
    ts: u32,
    call_id: String,
    _queue: Arc<BridgeQueueService>,
}

impl TrunkCall {
    async fn connect(voice: &Arc<MockVoiceState>, options: TrunkCallOptions) -> Self {
        let connect_timeout = options.connect_timeout;
        let hub = Arc::new(ClientHub::new());
        let (outbox, mut notifications) = client_outbox(256);
        hub.add_client_with_metadata(outbox, ClientConnectionMetadata::default())
            .await;
        let (report_tx, reports) = mpsc::unbounded_channel();
        let queue = BridgeQueueService::with_submission_store(
            Arc::new(MockQueueDispatcher {
                captured: report_tx,
            }),
            Arc::clone(&hub),
            None,
            crate::queue_service::DurableQueueSubmissions::default(),
        );
        let voice_url = spawn_mock_voice_http(Arc::clone(voice)).await;
        let sip = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
        let rtp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let sip_port = sip.local_addr().unwrap().port();
        let rtp_port = rtp.local_addr().unwrap().port();
        let mut config = sample_runtime_config(sip_port, &voice_url);
        if let Some(voice_config) = options.voice_config {
            config.voice = voice_config;
        }
        if let Some(username) = options.sip_username {
            config.sip_username = username.to_string();
        }
        let report_queue = if options.report_queue {
            Arc::downgrade(&queue)
        } else {
            Weak::new()
        };
        let service = PhoneCallService::with_options(
            Some(config),
            hub,
            report_queue,
            options.timeouts,
            options.custom_tls,
        );
        let trunk_sip = Arc::clone(&sip);
        let include_dtmf = options.include_dtmf;
        let accept = tokio::spawn(async move {
            MockSipDialog::accept_invite(&trunk_sip, rtp_port, false, include_dtmf).await
        });
        let start_service = Arc::clone(&service);
        let objective = options
            .objective
            .unwrap_or("Ask for the opening hours")
            .to_string();
        let start = tokio::spawn(async move {
            start_service
                .start_phone_call(
                    TRUNK_OWNER,
                    StartPhoneCallRequest {
                        phone_number: "+15559876543".to_string(),
                        objective,
                        callee_name: Some("Corner Bistro".to_string()),
                        first_message: None,
                        context: None,
                    },
                )
                .await
        });
        let call_id = await_approval_call_id(&mut notifications).await;
        if let Some(instruction) = options.pre_connect_steer {
            assert_eq!(
                service
                    .steer_phone_call(TRUNK_OWNER, &call_id, instruction)
                    .unwrap()
                    .status,
                SteerPhoneCallStatus::Steered,
            );
        }
        service
            .resolve_ui_action(&ui_action(
                &approval_surface_id(&call_id),
                TRUNK_OWNER,
                "approve",
            ))
            .await;
        let started = timeout(connect_timeout, start)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(started.call_id, call_id);
        let dialog = timeout(connect_timeout, accept).await.unwrap().unwrap();
        Self {
            service,
            notifications,
            reports,
            sip,
            rtp,
            rtp_port,
            dialog,
            seq: 1,
            ts: 160,
            call_id,
            _queue: queue,
        }
    }

    async fn callee_speaks(&mut self, silence_frames: usize) {
        send_rtp_utterance(
            &self.rtp,
            self.dialog.client_rtp_addr,
            &mut self.seq,
            &mut self.ts,
            10,
            silence_frames,
        )
        .await;
    }

    async fn update_matching<Predicate>(&mut self, mut predicate: Predicate) -> Value
    where
        Predicate: FnMut(&Value) -> bool,
    {
        recv_matching_notification(&mut self.notifications, |method, params| {
            method == "bridge/ui.update" && predicate(params)
        })
        .await
    }

    async fn card_shows(&mut self, text: &str) {
        self.update_matching(|params| params["blocks"].to_string().contains(text))
            .await;
    }

    async fn assistant_audio_reaches_trunk(&self) {
        timeout(TEST_TIMEOUT, async {
            let mut packet = [0_u8; 2048];
            loop {
                let (len, _) = self.rtp.recv_from(&mut packet).await.unwrap();
                if parse_rtp_packet(&packet[..len]).is_some_and(|pkt| {
                    pkt.payload_type == PCMU_PAYLOAD_TYPE
                        && pkt.payload.iter().any(|byte| *byte != 0xFF)
                }) {
                    return;
                }
            }
        })
        .await
        .expect("assistant speech reaches the trunk");
    }

    // Returns the payload type of every non-silent packet until outbound audio stays quiet.
    async fn outbound_audio_goes_quiet(&self) -> Vec<u8> {
        timeout(TEST_TIMEOUT, async {
            let mut packet = [0_u8; 2048];
            let mut voiced_payload_types = Vec::new();
            let mut quiet_run = 0_usize;
            loop {
                let (len, _) = self.rtp.recv_from(&mut packet).await.unwrap();
                let Some(pkt) = parse_rtp_packet(&packet[..len]) else {
                    continue;
                };
                if pkt.payload_type != PCMU_PAYLOAD_TYPE
                    || pkt.payload.iter().any(|byte| *byte != 0xFF)
                {
                    voiced_payload_types.push(pkt.payload_type);
                    quiet_run = 0;
                } else if !voiced_payload_types.is_empty() {
                    quiet_run = quiet_run.saturating_add(1);
                    if quiet_run >= 15 {
                        return voiced_payload_types;
                    }
                }
            }
        })
        .await
        .expect("outbound audio drains")
    }

    async fn agent_hangup(&self) -> HangupPhoneCallResult {
        let (result, ()) = timeout(TEST_TIMEOUT, async {
            let hangup_future = self.service.hangup_phone_call(TRUNK_OWNER, &self.call_id);
            let bye_future = self.dialog.expect_bye_and_reply_ok(&self.sip);
            tokio::join!(hangup_future, bye_future)
        })
        .await
        .expect("agent hang-up completes");
        result.unwrap()
    }

    fn snapshot(&self) -> PhoneCallSnapshot {
        self.service
            .get_phone_call(TRUNK_OWNER, &self.call_id)
            .unwrap()
    }

    async fn settled(&self) -> PhoneCallSnapshot {
        timeout(TEST_TIMEOUT, async {
            while self.service.live_work_count() != 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("call settles");
        self.snapshot()
    }

    async fn report(&mut self) -> String {
        let report = timeout(TEST_TIMEOUT, self.reports.recv())
            .await
            .expect("post-call report")
            .expect("report channel open");
        report.turn_start["input"][0]["text"]
            .as_str()
            .expect("report text")
            .to_string()
    }
}

#[cfg(feature = "e2e-agent")]
include!("full_audio_tests.rs");

#[test]
fn spoken_text_reports_only_clauses_that_reached_the_wire() {
    let progress = |clauses: &[(usize, &str)], total_frames_enqueued: usize| SpokenTurnProgress {
        clauses_started: clauses
            .iter()
            .map(|(start, clause)| (*start, (*clause).to_string()))
            .collect(),
        clauses_finished: clauses
            .iter()
            .enumerate()
            .map(|(idx, _)| {
                clauses
                    .get(idx + 1)
                    .map_or(total_frames_enqueued, |(start, _)| *start)
            })
            .collect(),
        total_frames_enqueued,
        ..SpokenTurnProgress::default()
    };
    let two_clauses = [(0, "Hello there."), (10, "How are you?")];
    for (turn, cleared_frames, expected) in [
        (progress(&[], 25), 0, ""),
        (progress(&two_clauses, 20), 0, "Hello there. How are you?"),
        (progress(&two_clauses, 20), 10, "Hello there."),
        (
            progress(&two_clauses, 20),
            15,
            "[partially spoken sentence]",
        ),
        (progress(&two_clauses, 20), 20, ""),
        (progress(&two_clauses[..1], 0), 0, ""),
    ] {
        assert_eq!(
            turn.spoken_text(cleared_frames),
            expected,
            "{turn:?} with {cleared_frames} cleared frames",
        );
    }
}

#[test]
fn request_validators_reject_malformed_fields_and_drop_blank_optionals() {
    let request = |objective: &str,
                   callee_name: Option<&str>,
                   first_message: Option<&str>,
                   context: Option<&str>| StartPhoneCallRequest {
        phone_number: "+15559876543".to_string(),
        objective: objective.to_string(),
        callee_name: callee_name.map(ToOwned::to_owned),
        first_message: first_message.map(ToOwned::to_owned),
        context: context.map(ToOwned::to_owned),
    };
    for (invalid, field) in [
        (request("Ask\0hours", None, None, None), "objective"),
        (
            request("Ask", Some("Front\ndesk"), None, None),
            "calleeName",
        ),
        (request("Ask", None, Some("Hi\0"), None), "firstMessage"),
        (request("Ask", None, None, Some("Notes\0")), "context"),
    ] {
        match validate_start_request(invalid) {
            Err(PhoneCallError::Invalid(message)) => {
                assert!(message.starts_with(field), "{message}");
            }
            other => panic!("{field} must be rejected, got {other:?}"),
        }
    }
    let normalized = validate_start_request(request(
        "  Ask about parking  ",
        Some("   "),
        Some(" \n "),
        Some("\t"),
    ))
    .unwrap();
    assert_eq!(normalized.objective, "Ask about parking");
    assert_eq!(normalized.callee_name, None);
    assert_eq!(normalized.first_message, None);
    assert_eq!(normalized.context, None);

    let long_call_id = "c".repeat(MAX_CALL_ID_BYTES + 1);
    for invalid in ["", "   ", long_call_id.as_str(), "call\u{7}id"] {
        assert!(
            matches!(validate_call_id(invalid), Err(PhoneCallError::Invalid(_))),
            "{invalid:?}",
        );
    }
    assert_eq!(validate_call_id("  call-123  ").unwrap(), "call-123");

    let long_instruction = "s".repeat(MAX_STEER_INSTRUCTION_BYTES + 1);
    for invalid in [long_instruction.as_str(), "Say\0this", " \n\t "] {
        assert!(
            matches!(
                validate_steer_instruction(invalid),
                Err(PhoneCallError::Invalid(_))
            ),
            "{invalid:?}",
        );
    }
    assert_eq!(
        validate_steer_instruction("  Ask about parking. ").unwrap(),
        "Ask about parking.",
    );
}

#[test]
fn cards_transcripts_and_reports_bound_blank_oversized_and_interrupted_content() {
    let entry = |speaker, text: &str, interrupted| TranscriptEntry {
        speaker,
        text: text.to_string(),
        interrupted,
    };

    let bounded = non_empty_kv_value(&"é".repeat(MAX_KV_VALUE_BYTES), "-");
    assert!(bounded.ends_with('…'), "{bounded}");
    assert!(bounded.len() <= MAX_KV_VALUE_BYTES + '…'.len_utf8());
    assert_eq!(non_empty_kv_value(" \t ", "fallback"), "fallback");

    let mut cfg = sample_runtime_config(5060, "http://127.0.0.1:9/v1");
    cfg.user_display_name = "  ".to_string();
    let validated = ValidatedStartRequest {
        phone_number: "+15559876543".to_string(),
        objective: "Ask about parking".to_string(),
        callee_name: Some("  ".to_string()),
        first_message: Some("Hi, this is a quick question.".to_string()),
        context: None,
    };
    let modal = build_approval_modal_surface("phone-call-approval:x", "thread-1", &cfg, &validated);
    validate_bridge_ui_surface(&modal).unwrap();
    assert_eq!(modal.subtitle.as_deref(), Some("+15559876543"));
    let BridgeUiBlock::KeyValue { items } = &modal.blocks[0] else {
        panic!("approval modal starts with key-value details");
    };
    assert!(items
        .iter()
        .any(|item| item.label == "On behalf of" && item.value == "User"));
    assert!(matches!(
        &modal.blocks[1],
        BridgeUiBlock::Markdown { markdown }
            if markdown == "**Opening message**\n\nHi, this is a quick question."
    ));

    let full_scope = ValidatedStartRequest {
        objective: "o".repeat(MAX_OBJECTIVE_BYTES),
        context: Some("  Account reference EXAMPLE-001; contact Example Support.  ".to_string()),
        ..validated.clone()
    };
    let modal =
        build_approval_modal_surface("phone-call-approval:y", "thread-1", &cfg, &full_scope);
    validate_bridge_ui_surface(&modal).unwrap();
    let BridgeUiBlock::KeyValue { items } = &modal.blocks[0] else {
        panic!("approval modal starts with key-value details");
    };
    assert!(
        items
            .iter()
            .any(|item| item.label == "Objective" && item.value == full_scope.objective),
        "the user approves the whole objective the calling agent receives",
    );
    assert!(matches!(
        modal.blocks.last(),
        Some(BridgeUiBlock::Markdown { markdown })
            if markdown == "**Background for the calling agent**\n\nAccount reference EXAMPLE-001; contact Example Support."
    ));

    let card = build_live_workflow_card(
        "phone-call-live:x",
        "thread-1",
        &cfg,
        &validated,
        "2026-11-12T00:00:00Z",
        LiveCardParams {
            title_override: None,
            subtitle: "Dialing…",
            status_value: "  ",
            tone: BridgeUiTone::Info,
            in_call_actions: true,
            dismissible: false,
            duration_seconds: None,
            detail_label_value: Some(("Reason", "   ")),
            technical_detail: None,
            transcript: &[],
        },
    );
    validate_bridge_ui_surface(&card).unwrap();
    assert_eq!(card.title, "Phone call · +15559876543");
    assert_eq!(card.blocks.len(), 1, "an empty transcript adds no block");
    let BridgeUiBlock::KeyValue { items } = &card.blocks[0] else {
        panic!("live card starts with key-value details");
    };
    let labels: Vec<&str> = items.iter().map(|item| item.label.as_str()).collect();
    assert_eq!(labels, ["Status", "To", "From", "Objective"]);
    assert_eq!(items[0].value, "Active");
    assert_eq!(card.actions[0].id, "hangup");

    let interrupted = entry(TranscriptSpeaker::Assistant, "Hello there", true);
    assert_eq!(
        format_transcript_line(&interrupted, true, "Recipient"),
        "**Agent:** Hello there [interrupted]",
    );
    assert_eq!(
        format_transcript_line(&interrupted, false, "Recipient"),
        "Agent: Hello there [interrupted]",
    );
    let already_marked = entry(
        TranscriptSpeaker::Assistant,
        "Hello there [interrupted]",
        true,
    );
    assert_eq!(
        format_transcript_line(&already_marked, false, "Recipient"),
        "Agent: Hello there [interrupted]",
    );
    let steer = entry(TranscriptSpeaker::Steer, "Ask about parking.", false);
    assert_eq!(
        format_transcript_line(&steer, true, "Recipient"),
        "**Instruction (not spoken):** Ask about parking.",
    );
    for (callee_name, label) in [
        (Some("  Osteria Bella "), "Osteria Bella"),
        (Some("Dr. O'Neil & Co."), "Dr. O'Neil & Co."),
        (Some("**Bold**"), "Recipient"),
        (Some("Status: urgent"), "Recipient"),
        (
            Some("A very long business name that keeps going on"),
            "Recipient",
        ),
        (None, "Recipient"),
    ] {
        assert_eq!(transcript_recipient_label(callee_name), label);
    }

    let short = entry(TranscriptSpeaker::Callee, "We open at nine.", false);
    let huge = entry(
        TranscriptSpeaker::Assistant,
        &format!("start {}end", "€".repeat(200)),
        false,
    );
    assert_eq!(
        format_rolling_transcript_markdown(&[], 4_096, "Recipient"),
        None,
    );
    assert_eq!(
        format_rolling_transcript_markdown(std::slice::from_ref(&short), 63, "Recipient"),
        None,
    );
    let only_huge =
        format_rolling_transcript_markdown(std::slice::from_ref(&huge), 200, "Recipient").unwrap();
    assert!(
        only_huge.starts_with("**Live transcript**\n\n…") && only_huge.ends_with("€end"),
        "{only_huge}",
    );
    assert!(!only_huge.contains("omitted") && only_huge.len() <= 200);
    let newest_huge =
        format_rolling_transcript_markdown(&[short.clone(), huge.clone()], 200, "Recipient")
            .unwrap();
    assert!(newest_huge.contains("_Earlier turns omitted…_\n\n…"));
    assert!(!newest_huge.contains("We open at nine."));
    assert_eq!(
        format_rolling_transcript_markdown(&[huge.clone(), short.clone()], 200, "Recipient")
            .unwrap(),
        "**Live transcript**\n\n_Earlier turns omitted…_\n\n**Recipient:** We open at nine.",
    );

    assert_eq!(truncate_utf8_tail("abc", 3), "abc");
    assert_eq!(truncate_utf8_tail("aé€", 4), "€");
    assert_eq!(truncate_utf8_tail("aé€", 2), "");

    let report = |end_reason: &str, transcript: &[TranscriptEntry]| {
        build_post_call_report_content(
            "call-1",
            PhoneCallStatus::Completed,
            &validated,
            65,
            end_reason,
            Some("  "),
            transcript,
        )
    };
    let empty = report("remote_bye", &[]);
    assert!(empty.contains("Duration: 1:05 (65s)"));
    assert!(!empty.contains("Outcome summary"));
    assert!(empty.ends_with("Transcript:\n(no spoken transcript recorded)"));
    let oversized_reason = "r".repeat(MAX_REPORT_BODY_BYTES);
    let no_budget = report(&oversized_reason, std::slice::from_ref(&short));
    assert!(no_budget.ends_with("Transcript:\n(no spoken transcript recorded)"));

    let giant = entry(
        TranscriptSpeaker::Callee,
        &"word ".repeat(MAX_REPORT_BODY_BYTES / 4),
        false,
    );
    let giant_only = report("remote_bye", std::slice::from_ref(&giant));
    assert!(giant_only.contains("Transcript:\n…") && giant_only.ends_with("word word"));
    assert!(!giant_only.contains("[earlier transcript omitted]"));
    assert!(giant_only.len() <= MAX_REPORT_BODY_BYTES);
    let newest_giant = report("remote_bye", &[short.clone(), giant.clone()]);
    assert!(newest_giant.contains("Transcript:\n[earlier transcript omitted]\n…"));
    assert!(!newest_giant.contains("We open at nine."));
    assert!(report("remote_bye", &[giant, short])
        .ends_with("Transcript:\n[earlier transcript omitted]\nRecipient: We open at nine."));
}

#[tokio::test]
async fn snapshot_surfaces_restores_pending_approval_without_republishing_it() {
    let hub = Arc::new(ClientHub::new());
    let (outbox, mut notifications) = client_outbox(128);
    hub.add_client_with_metadata(outbox, ClientConnectionMetadata::default())
        .await;
    let sip = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let service = PhoneCallService::with_options(
        Some(sample_runtime_config(
            sip.local_addr().unwrap().port(),
            "http://127.0.0.1:9/v1",
        )),
        hub,
        Weak::new(),
        approval_timeouts(Duration::from_secs(5)),
        None,
    );
    let starting = Arc::clone(&service);
    let start = tokio::spawn(async move {
        starting
            .start_phone_call(
                "snapshot-owner",
                StartPhoneCallRequest {
                    context: Some("Ask about weekend hours too.".to_string()),
                    first_message: Some("Hello, I am calling about your hours.".to_string()),
                    ..parking_request()
                },
            )
            .await
    });
    let call_id = await_approval_call_id(&mut notifications).await;
    let surfaces = service.snapshot_surfaces();
    assert_eq!(surfaces.len(), 1);
    validate_bridge_ui_surface(&surfaces[0]).unwrap();
    assert_eq!(surfaces[0].id, approval_surface_id(&call_id));
    assert_eq!(surfaces[0].thread_id, "snapshot-owner");
    assert!(surfaces[0]
        .actions
        .iter()
        .any(|action| action.id == "approve"));
    assert!(surfaces[0].blocks.iter().any(|block| matches!(
        block, BridgeUiBlock::Markdown { markdown } if markdown.contains("Ask about weekend hours too.")
    )));
    assert!(
        notifications.try_recv().is_err(),
        "snapshot reads must not publish new events",
    );
    service
        .resolve_ui_action(&ui_action(&surfaces[0].id, "snapshot-owner", "cancel"))
        .await;
    timeout(TEST_TIMEOUT, start)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert!(service.snapshot_surfaces().is_empty());
    assert_eq!(service.live_work_count(), 0);
    let mut packet = [0; 1024];
    assert!(
        timeout(Duration::from_millis(50), sip.recv_from(&mut packet))
            .await
            .is_err(),
    );
}

#[tokio::test]
async fn snapshot_surfaces_restores_quiet_held_call_controls_with_fresh_duration() {
    let voice = MockVoiceState::new(Vec::new(), Vec::new(), 0);
    let mut call = TrunkCall::connect(
        &voice,
        TrunkCallOptions::new(Duration::from_secs(30), Duration::from_secs(120)),
    )
    .await;
    call.dialog
        .renegotiate(&call.sip, 1, "UPDATE", "inactive", call.rtp_port)
        .await;
    call.card_shows("On hold").await;
    let slot = lock_unpoisoned(&call.service.registry)
        .active
        .clone()
        .unwrap();
    lock_unpoisoned(&slot.shared).connected_instant =
        Instant::now().checked_sub(Duration::from_secs(65));
    let recovered = call.service.snapshot_surfaces();
    assert_eq!(recovered.len(), 1);
    validate_bridge_ui_surface(&recovered[0]).unwrap();
    assert_eq!(recovered[0].id, live_surface_id(&call.call_id));
    assert!(recovered[0]
        .actions
        .iter()
        .any(|action| action.id == "hangup"));
    assert_eq!(recovered[0].dismissible, Some(false));
    let BridgeUiBlock::KeyValue { items } = &recovered[0].blocks[0] else {
        panic!("live call details");
    };
    assert!(items
        .iter()
        .any(|item| item.label == "Status" && item.value == "On hold"));
    let duration = items.iter().find(|item| item.label == "Duration").unwrap();
    let (minutes, seconds) = duration.value.split_once(':').unwrap();
    let elapsed = minutes.parse::<u64>().unwrap() * 60 + seconds.parse::<u64>().unwrap();
    assert!(
        (65..70).contains(&elapsed),
        "recovery must read current duration, not the last card",
    );
    call.agent_hangup().await;
    call.settled().await;
    assert!(call.service.snapshot_surfaces().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_thread_retirement_waits_for_call_slot_registration_then_cancels_start() {
    let hub = Arc::new(ClientHub::new());
    let (outbox, mut notifications) = client_outbox(128);
    hub.add_client_with_metadata(outbox, ClientConnectionMetadata::default())
        .await;
    let (report_tx, mut reports) = mpsc::unbounded_channel();
    let queue = BridgeQueueService::with_submission_store(
        Arc::new(MockQueueDispatcher {
            captured: report_tx,
        }),
        Arc::clone(&hub),
        None,
        crate::queue_service::DurableQueueSubmissions::default(),
    );
    let sip = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let service = PhoneCallService::with_options(
        Some(sample_runtime_config(
            sip.local_addr().unwrap().port(),
            "http://127.0.0.1:9/v1",
        )),
        hub,
        Arc::downgrade(&queue),
        approval_timeouts(Duration::from_secs(1)),
        None,
    );

    let (locked_tx, locked_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let registry = Arc::clone(&service.registry);
    let holder = std::thread::spawn(move || {
        let lock = lock_unpoisoned(&registry);
        locked_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        drop(lock);
    });
    locked_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let admitted = Arc::new(tokio::sync::Notify::new());
    *lock_unpoisoned(&queue.retirement_fence.admission_acquired) = Some(Arc::clone(&admitted));
    let starting = Arc::clone(&service);
    let start = tokio::spawn(async move {
        starting
            .start_phone_call("retiring-owner", parking_request())
            .await
    });
    tokio::time::timeout(Duration::from_secs(2), admitted.notified())
        .await
        .unwrap();

    let (retiring_tx, mut retiring_rx) = oneshot::channel();
    let retiring_queue = Arc::clone(&queue);
    let retiring_service = Arc::clone(&service);
    let deletion = tokio::spawn(async move {
        let ids = vec!["retiring-owner".to_string()];
        let barrier = retiring_queue.block_retirement_admissions().await;
        let lease = retiring_queue
            .retirement_fence
            .begin_blocked(&ids, &barrier);
        retiring_tx.send(()).unwrap();
        drop(barrier);
        retiring_service.cancel_for_retiring_threads(&ids).await;
        lease.finish_deleted().await;
    });
    let blocked = tokio::time::timeout(Duration::from_millis(100), &mut retiring_rx)
        .await
        .is_err();
    release_tx.send(()).unwrap();
    holder.join().unwrap();
    tokio::time::timeout(Duration::from_secs(2), deletion)
        .await
        .unwrap()
        .unwrap();
    let result = tokio::time::timeout(Duration::from_secs(2), start)
        .await
        .unwrap()
        .unwrap();
    assert!(
        blocked,
        "deletion must not scan calls before an admitted start is registered",
    );
    assert!(matches!(result, Err(PhoneCallError::Rejected(_))));
    assert_eq!(service.live_work_count(), 0);
    assert!(lock_unpoisoned(&service.registry).active.is_none());
    assert!(reports.try_recv().is_err());
    let mut packet = [0_u8; 1024];
    assert!(
        tokio::time::timeout(Duration::from_millis(50), sip.recv_from(&mut packet))
            .await
            .is_err(),
    );
    assert!(matches!(
        service
            .start_phone_call("retiring-owner", parking_request())
            .await,
        Err(PhoneCallError::Invalid(_))
    ));
    let mut dismissed = false;
    while let Ok(message) = notifications.try_recv() {
        if let axum::extract::ws::Message::Text(text) = message {
            dismissed |= text.contains("bridge/ui.dismiss");
        }
    }
    assert!(dismissed, "the cancelled approval must be dismissed");
}

#[tokio::test]
async fn ownership_ui_actions_and_retirement_only_affect_the_owning_active_call() {
    let hub = Arc::new(ClientHub::new());
    let (outbox, mut rx) = client_outbox(128);
    hub.add_client_with_metadata(outbox, ClientConnectionMetadata::default())
        .await;
    let service = PhoneCallService::with_options(
        Some(sample_runtime_config(9, "http://127.0.0.1:9/v1")),
        Arc::clone(&hub),
        Weak::new(),
        approval_timeouts(Duration::from_secs(5)),
        None,
    );
    let oversized_owner = "t".repeat(MAX_OBJECTIVE_BYTES + 1);
    for owner in ["   ", oversized_owner.as_str()] {
        assert!(matches!(
            service.start_phone_call(owner, parking_request()).await,
            Err(PhoneCallError::Invalid(_))
        ));
    }

    // Without an active call, UI actions and retirements are no-ops.
    service
        .resolve_ui_action(&ui_action("phone-call-live:ghost", "owner-a", "hangup"))
        .await;
    service
        .cancel_for_retiring_threads(&["owner-a".to_string()])
        .await;
    assert_eq!(service.live_work_count(), 0);

    let spawn_start = || {
        let svc = Arc::clone(&service);
        tokio::spawn(async move { svc.start_phone_call("owner-a", parking_request()).await })
    };
    let declined = spawn_start();
    let call_id = await_approval_call_id(&mut rx).await;
    let approval_id = approval_surface_id(&call_id);
    let live_id = live_surface_id(&call_id);

    assert_eq!(
        service
            .steer_phone_call("owner-a", "other-call", "Hi")
            .unwrap()
            .status,
        SteerPhoneCallStatus::NotFound,
    );
    assert_eq!(
        service
            .get_phone_call("owner-a", "other-call")
            .unwrap()
            .status,
        PhoneCallStatus::NotFound,
    );
    assert_eq!(
        service
            .hangup_phone_call("owner-a", "other-call")
            .await
            .unwrap()
            .status,
        HangupPhoneCallStatus::NotFound,
    );
    assert_eq!(
        service
            .steer_phone_call("owner-a", &call_id, " Mention the patio. ")
            .unwrap()
            .status,
        SteerPhoneCallStatus::Steered,
    );
    let queued_steer = vec![TranscriptEntry {
        speaker: TranscriptSpeaker::Steer,
        text: "Mention the patio.".to_string(),
        interrupted: false,
    }];
    let awaiting = service.get_phone_call("owner-a", &call_id).unwrap();
    assert_eq!(awaiting.status, PhoneCallStatus::AwaitingApproval);
    assert_eq!(awaiting.transcript, queued_steer);

    for (surface_id, thread_id, action_id) in [
        ("unrelated-surface", "owner-a", "approve"),
        (approval_id.as_str(), "owner-b", "approve"),
        ("phone-call-approval:other-call", "owner-a", "approve"),
        ("phone-call-live:other-call", "owner-a", "hangup"),
        (live_id.as_str(), "owner-a", "mute"),
        (approval_id.as_str(), "owner-a", "maybe"),
    ] {
        service
            .resolve_ui_action(&ui_action(surface_id, thread_id, action_id))
            .await;
    }
    service
        .cancel_for_retiring_threads(&["owner-b".to_string()])
        .await;
    let slot = lock_unpoisoned(&service.registry)
        .active
        .clone()
        .expect("call still awaits approval");
    assert!(
        lock_unpoisoned(&slot.approval_tx).is_some(),
        "ignored actions must not resolve the approval",
    );
    assert!(
        !slot.cancel.is_cancelled(),
        "ignored actions must not hang up",
    );
    assert_eq!(service.live_work_count(), 1);

    service
        .resolve_ui_action(&ui_action(&approval_id, "owner-a", "cancel"))
        .await;
    service
        .resolve_ui_action(&ui_action(&approval_id, "owner-a", "approve"))
        .await;
    assert_eq!(
        declined.await.unwrap().unwrap_err().to_string(),
        "Phone call was declined by the user",
    );

    assert_eq!(
        service
            .steer_phone_call("owner-a", &call_id, "Hi")
            .unwrap()
            .status,
        SteerPhoneCallStatus::AlreadyEnded,
    );
    for (owner, id) in [("owner-b", call_id.as_str()), ("owner-a", "other-call")] {
        assert_eq!(
            service.steer_phone_call(owner, id, "Hi").unwrap().status,
            SteerPhoneCallStatus::NotFound,
        );
        assert_eq!(
            service.get_phone_call(owner, id).unwrap().status,
            PhoneCallStatus::NotFound,
        );
        assert_eq!(
            service.hangup_phone_call(owner, id).await.unwrap().status,
            HangupPhoneCallStatus::NotFound,
        );
    }
    let ended = service.get_phone_call("owner-a", &call_id).unwrap();
    assert_eq!(ended.status, PhoneCallStatus::Cancelled);
    assert_eq!(ended.end_reason.as_deref(), Some("declined_by_user"));
    assert_eq!(ended.transcript, queued_steer);
    assert_eq!(
        service
            .hangup_phone_call("owner-a", &call_id)
            .await
            .unwrap()
            .status,
        HangupPhoneCallStatus::AlreadyEnded,
    );

    // The owner can hang up a call that is still awaiting approval.
    let hung_up = spawn_start();
    let hung_up_id = await_approval_call_id(&mut rx).await;
    assert_eq!(
        service
            .hangup_phone_call(" owner-a ", &hung_up_id)
            .await
            .unwrap()
            .status,
        HangupPhoneCallStatus::HungUp,
    );
    let cancelled = service.get_phone_call("owner-a", &hung_up_id).unwrap();
    assert_eq!(cancelled.status, PhoneCallStatus::Cancelled);
    assert_eq!(
        cancelled.end_reason.as_deref(),
        Some("cancelled_before_dial"),
    );
    assert_eq!(
        hung_up.await.unwrap().unwrap_err().to_string(),
        "Phone call was cancelled before dialing",
    );

    // Shutdown cancels the pending call and refuses new ones.
    let shut_down = spawn_start();
    let shut_down_id = await_approval_call_id(&mut rx).await;
    service.shutdown().await;
    assert_eq!(
        service
            .get_phone_call("owner-a", &shut_down_id)
            .unwrap()
            .end_reason
            .as_deref(),
        Some("cancelled_before_dial"),
    );
    assert_eq!(
        shut_down.await.unwrap().unwrap_err().to_string(),
        "Phone call was cancelled before dialing",
    );
    match service.start_phone_call("owner-a", parking_request()).await {
        Err(PhoneCallError::Internal(message)) => {
            assert_eq!(message, "bridge is shutting down");
        }
        other => panic!("calls after shutdown must be refused, got {other:?}"),
    }
    assert_eq!(service.live_work_count(), 0);
}

#[tokio::test]
async fn completed_call_history_keeps_only_the_most_recent_records() {
    let service = PhoneCallService::with_options(
        Some(sample_runtime_config(9, "http://127.0.0.1:9/v1")),
        Arc::new(ClientHub::new()),
        Weak::new(),
        approval_timeouts(Duration::from_millis(1)),
        None,
    );
    let mut call_ids = Vec::new();
    for _ in 0..=COMPLETED_CALL_HISTORY_LIMIT {
        let err = service
            .start_phone_call("history-owner", parking_request())
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "Timed out waiting for phone call approval");
        let newest = lock_unpoisoned(&service.registry)
            .completed
            .back()
            .map(|record| record.call_id.clone())
            .expect("timed-out call is recorded");
        call_ids.push(newest);
    }
    assert_eq!(
        lock_unpoisoned(&service.registry).completed.len(),
        COMPLETED_CALL_HISTORY_LIMIT,
    );
    assert_eq!(
        service
            .get_phone_call("history-owner", &call_ids[0])
            .unwrap()
            .status,
        PhoneCallStatus::NotFound,
    );
    assert_eq!(
        service
            .steer_phone_call("history-owner", &call_ids[0], "Hi")
            .unwrap()
            .status,
        SteerPhoneCallStatus::NotFound,
    );
    for call_id in &call_ids[1..] {
        let snapshot = service.get_phone_call("history-owner", call_id).unwrap();
        assert_eq!(snapshot.status, PhoneCallStatus::Cancelled);
        assert_eq!(snapshot.end_reason.as_deref(), Some("approval_timeout"));
    }
}

#[tokio::test]
async fn dropping_a_pending_start_cancels_the_call_and_dismisses_its_surfaces() {
    let hub = Arc::new(ClientHub::new());
    let (outbox, mut rx) = client_outbox(128);
    hub.add_client_with_metadata(outbox, ClientConnectionMetadata::default())
        .await;
    let voice_url = spawn_mock_voice_http(MockVoiceState::new(Vec::new(), Vec::new(), 480)).await;
    let ringing_sip = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let sip_port = ringing_sip.local_addr().unwrap().port();
    tokio::spawn(async move {
        let mut buf = vec![0_u8; 65535];
        let (n_inv, peer) = ringing_sip.recv_from(&mut buf).await.unwrap();
        let invite = String::from_utf8_lossy(&buf[..n_inv]).into_owned();
        let ringing = format!(
            "SIP/2.0 180 Ringing\r\nVia: {}\r\nFrom: {}\r\nTo: {};tag=drop1\r\nCall-ID: {}\r\nCSeq: 1 INVITE\r\nContent-Length: 0\r\n\r\n",
            extract_sip_header(&invite, "Via:"),
            extract_sip_header(&invite, "From:"),
            extract_sip_header(&invite, "To:"),
            extract_sip_header(&invite, "Call-ID:"),
        );
        ringing_sip.send_to(ringing.as_bytes(), peer).await.unwrap();
        while ringing_sip.recv_from(&mut buf).await.is_ok() {}
    });
    let service = PhoneCallService::with_options(
        Some(sample_runtime_config(sip_port, &voice_url)),
        hub,
        Weak::new(),
        approval_timeouts(Duration::from_secs(5)),
        None,
    );

    for ringing in [false, true] {
        let svc = Arc::clone(&service);
        let pending =
            tokio::spawn(
                async move { svc.start_phone_call("drop-owner", parking_request()).await },
            );
        let call_id = await_approval_call_id(&mut rx).await;
        let presented_surface = if ringing {
            service
                .resolve_ui_action(&ui_action(
                    &approval_surface_id(&call_id),
                    "drop-owner",
                    "approve",
                ))
                .await;
            let live_id = live_surface_id(&call_id);
            recv_matching_notification(&mut rx, |method, params| {
                method == "bridge/ui.update"
                    && params["id"] == live_id
                    && params["subtitle"] == "Ringing…"
            })
            .await;
            live_id
        } else {
            approval_surface_id(&call_id)
        };
        assert_eq!(service.live_work_count(), 1);
        pending.abort();
        assert!(pending.await.unwrap_err().is_cancelled());

        let dismissed =
            recv_matching_notification(&mut rx, |method, _| method == "bridge/ui.dismiss").await;
        assert_eq!(dismissed["id"], presented_surface.as_str());
        assert_eq!(dismissed["threadId"], "drop-owner");
        let snapshot = service.get_phone_call("drop-owner", &call_id).unwrap();
        assert_eq!(snapshot.status, PhoneCallStatus::Cancelled);
        assert_eq!(snapshot.end_reason.as_deref(), Some("caller_dropped"));
        timeout(TEST_TIMEOUT, async {
            while service.live_work_count() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
}

#[test]
fn dropping_a_pending_start_outside_a_runtime_settles_synchronously() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let service = PhoneCallService::with_options(
        Some(sample_runtime_config(9, "http://127.0.0.1:9/v1")),
        Arc::new(ClientHub::new()),
        Weak::new(),
        approval_timeouts(Duration::from_secs(5)),
        None,
    );
    let mut pending = service.start_phone_call("detached-owner", parking_request());
    runtime.block_on(async {
        assert!(
            timeout(Duration::from_millis(300), &mut pending)
                .await
                .is_err(),
            "the call waits for approval",
        );
    });
    assert_eq!(service.live_work_count(), 1);
    drop(pending);
    assert_eq!(service.live_work_count(), 0);
    let registry = lock_unpoisoned(&service.registry);
    assert!(registry.active.is_none());
    let record = registry.completed.back().expect("dropped call is recorded");
    assert_eq!(record.snapshot.status, PhoneCallStatus::Cancelled);
    assert_eq!(
        record.snapshot.end_reason.as_deref(),
        Some("caller_dropped"),
    );
}

#[tokio::test]
async fn agent_hangup_mid_greeting_reports_pre_connect_steer_and_interrupted_speech() {
    let voice = MockVoiceState::new(vec![voice_reply(SLOW_GREETING, json!([]))], vec![], 48_000);
    voice.tts_chunk_delay_ms.store(100, Ordering::SeqCst);
    let mut options = TrunkCallOptions::new(Duration::from_secs(20), Duration::from_secs(60));
    options.pre_connect_steer = Some("Mention that the party is four people.");
    options.sip_username = Some("trunk-user");
    options.custom_tls = Some(crate::phone_call::sip::default_rustls_client_config().unwrap());
    let mut call = TrunkCall::connect(&voice, options).await;

    // The queued steer starts speaking at connect instead of after the 20 s greeting window.
    call.assistant_audio_reaches_trunk().await;
    assert!(voice.chat_requests.lock().await[0]["messages"]
        .to_string()
        .contains("Mention that the party is four people."));
    assert_eq!(
        call.agent_hangup().await.status,
        HangupPhoneCallStatus::HungUp,
    );

    let snapshot = call.settled().await;
    assert_eq!(snapshot.status, PhoneCallStatus::Completed);
    assert_eq!(snapshot.end_reason.as_deref(), Some("agent_hangup"));
    assert_eq!(snapshot.transcript[0].speaker, TranscriptSpeaker::Steer);
    let greeting = snapshot.transcript.last().unwrap();
    assert_eq!(greeting.speaker, TranscriptSpeaker::Assistant);
    assert!(greeting.interrupted, "{greeting:?}");
    assert!(
        greeting.text == "[partially spoken sentence] [interrupted]",
        "{greeting:?}",
    );
    let report = call.report().await;
    assert!(report.contains("End reason: agent_hangup"), "{report}");
    assert!(report.contains("Instruction (not spoken): Mention that the party is four people."));
    assert!(report.contains(INTERRUPTED_MARKER), "{report}");
    assert_eq!(
        call.service
            .hangup_phone_call(TRUNK_OWNER, &call.call_id)
            .await
            .unwrap()
            .status,
        HangupPhoneCallStatus::AlreadyEnded,
    );
}

#[tokio::test]
async fn remote_bye_and_maximum_duration_settle_calls_with_or_without_active_speech() {
    for (speaking, max_duration) in [
        (true, None),
        (false, None),
        (true, Some(Duration::from_secs(1))),
    ] {
        let voice =
            MockVoiceState::new(vec![voice_reply(SLOW_GREETING, json!([]))], vec![], 48_000);
        voice.tts_chunk_delay_ms.store(100, Ordering::SeqCst);
        let opening = if speaking {
            Duration::from_millis(20)
        } else {
            Duration::from_secs(20)
        };
        let mut options =
            TrunkCallOptions::new(opening, max_duration.unwrap_or(Duration::from_secs(60)));
        let report_queue = !speaking || max_duration.is_some();
        options.report_queue = report_queue;
        let mut call = TrunkCall::connect(&voice, options).await;
        if speaking {
            call.assistant_audio_reaches_trunk().await;
        }
        let (end_reason, card_detail) = if max_duration.is_some() {
            timeout(TEST_TIMEOUT, call.dialog.expect_bye_and_reply_ok(&call.sip))
                .await
                .expect("BYE at the maximum duration");
            ("max_duration_reached", "Maximum call duration reached.")
        } else {
            call.dialog.send_remote_bye(&call.sip, 2).await;
            ("remote_bye", "They hung up")
        };
        let settled_card = call
            .update_matching(|params| params["title"] == "Phone call ended")
            .await;
        assert!(
            settled_card["blocks"].to_string().contains(card_detail),
            "{settled_card}",
        );
        let snapshot = call.settled().await;
        assert_eq!(snapshot.status, PhoneCallStatus::Completed);
        assert_eq!(snapshot.end_reason.as_deref(), Some(end_reason));
        let spoken = snapshot
            .transcript
            .iter()
            .find(|entry| entry.speaker == TranscriptSpeaker::Assistant);
        if speaking {
            let spoken = spoken.expect("interrupted greeting");
            assert!(
                spoken.interrupted && spoken.text == "[partially spoken sentence] [interrupted]",
                "{spoken:?}",
            );
        } else {
            assert!(spoken.is_none(), "{spoken:?}");
            assert!(voice.chat_requests.lock().await.is_empty());
        }
        if report_queue {
            let report = call.report().await;
            assert!(
                report.contains(&format!("End reason: {end_reason}")),
                "{report}",
            );
            assert_eq!(
                report.contains("(no spoken transcript recorded)"),
                !speaking,
                "{report}",
            );
        } else {
            assert!(call.reports.try_recv().is_err());
        }
    }
}

#[tokio::test]
async fn remote_hold_aborts_speech_preserves_transcription_and_blocks_model_resume() {
    let voice = MockVoiceState::new(
        vec![
            voice_reply(SLOW_GREETING, json!([])),
            voice_reply("", voice_tool("resume_call", json!({}))),
        ],
        vec![
            "Thanks for holding, I am back now.",
            "Sorry, one more moment.",
        ],
        48_000,
    );
    voice.tts_chunk_delay_ms.store(100, Ordering::SeqCst);
    let mut call = TrunkCall::connect(
        &voice,
        TrunkCallOptions::new(Duration::from_millis(20), Duration::from_secs(60)),
    )
    .await;
    call.assistant_audio_reaches_trunk().await;

    let response = call
        .dialog
        .renegotiate(&call.sip, 2, "INVITE", "sendonly", call.rtp_port)
        .await;
    assert!(response.contains("a=recvonly"), "{response}");
    call.update_matching(|params| params["subtitle"] == "On hold")
        .await;
    let held = call.snapshot();
    assert!(held.on_hold);
    let greeting = held.transcript.last().unwrap();
    assert!(
        greeting.interrupted && greeting.text == "[partially spoken sentence] [interrupted]",
        "{greeting:?}",
    );

    // The model cannot resume while the remote endpoint still holds the call.
    let ivr_silence = crate::phone_call::audio::VAD_IVR_HANGOVER_FRAMES + 10;
    call.callee_speaks(ivr_silence).await;
    call.card_shows("Thanks for holding, I am back now.").await;
    assert!(call.snapshot().on_hold);
    assert_eq!(voice.chat_requests.lock().await.len(), 1);

    // A remote resume preserves a transcription that is still pending.
    voice.stt_delay_ms.store(1_000, Ordering::SeqCst);
    call.callee_speaks(ivr_silence).await;
    stt_requests_reach(&voice, 2).await;
    let response = call
        .dialog
        .renegotiate(&call.sip, 3, "INVITE", "sendrecv", call.rtp_port)
        .await;
    assert!(response.contains("a=sendrecv"), "{response}");
    call.update_matching(|params| params["subtitle"] == "In call")
        .await;
    call.card_shows("Sorry, one more moment.").await;
    chat_requests_reach(&voice, 2).await;
    let resumed = call.snapshot();
    assert!(!resumed.on_hold);
    assert!(
        resumed
            .transcript
            .iter()
            .any(|entry| entry.text.contains("one more moment")),
        "{:?}",
        resumed.transcript,
    );
    assert_eq!(voice.chat_requests.lock().await.len(), 2);

    call.dialog.send_remote_bye(&call.sip, 4).await;
    let snapshot = call.settled().await;
    assert_eq!(snapshot.end_reason.as_deref(), Some("remote_bye"));
    let report = call.report().await;
    assert!(report.contains("End reason: remote_bye"), "{report}");
    assert!(report.contains(INTERRUPTED_MARKER), "{report}");
    assert!(report.contains("Sorry, one more moment."), "{report}");
}

#[tokio::test]
async fn remote_hold_preserves_inflight_details_and_queued_correction_until_resume() {
    let voice = MockVoiceState::new(
        vec![voice_reply("Thursday, got it.", json!([]))],
        vec!["Book for two on Tuesday.", "Actually use Thursday instead."],
        2_400,
    );
    voice.stt_delay_ms.store(1_500, Ordering::SeqCst);
    let mut call = TrunkCall::connect(
        &voice,
        TrunkCallOptions::new(Duration::from_secs(20), Duration::from_secs(60)),
    )
    .await;
    call.callee_speaks(VAD_DEFAULT_HANGOVER_FRAMES + 2).await;
    stt_requests_reach(&voice, 1).await;
    voice.stt_delay_ms.store(0, Ordering::SeqCst);
    call.callee_speaks(VAD_DEFAULT_HANGOVER_FRAMES + 2).await;
    call.dialog
        .renegotiate(&call.sip, 2, "INVITE", "sendonly", call.rtp_port)
        .await;
    call.update_matching(|params| params["subtitle"] == "On hold")
        .await;
    let held_card = call
        .update_matching(|params| {
            params["subtitle"] == "On hold"
                && params["blocks"]
                    .to_string()
                    .contains("Actually use Thursday instead.")
        })
        .await;
    assert!(held_card.to_string().contains("hangup"), "{held_card}");
    assert!(call.snapshot().on_hold);
    assert_eq!(call.snapshot().status, PhoneCallStatus::InProgress);
    assert!(voice.chat_requests.lock().await.is_empty());
    assert!(voice.tts_requests.lock().await.is_empty());

    call.dialog
        .renegotiate(&call.sip, 3, "INVITE", "sendrecv", call.rtp_port)
        .await;
    call.card_shows("Thursday, got it.").await;
    assert!(!call.snapshot().on_hold);
    assert_eq!(call.snapshot().status, PhoneCallStatus::InProgress);
    let requests = voice.chat_requests.lock().await;
    assert_eq!(requests.len(), 1);
    let recipient: Vec<_> = requests[0]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "user")
        .map(|message| message["content"].as_str().unwrap())
        .collect();
    assert_eq!(
        recipient,
        [
            "Recipient: Book for two on Tuesday.",
            "Recipient: Actually use Thursday instead."
        ],
    );
    drop(requests);
    call.agent_hangup().await;
    assert_eq!(call.settled().await.status, PhoneCallStatus::Completed);
    let report = call.report().await;
    assert!(report.contains("Book for two on Tuesday."), "{report}");
    assert!(
        report.contains("Actually use Thursday instead."),
        "{report}",
    );
}

#[tokio::test]
async fn remote_hold_retries_the_captured_reply_when_its_assistant_turn_was_aborted() {
    let reply = "Four for Thursday, got it.";
    let voice = MockVoiceState::new(
        vec![voice_reply(reply, json!([])), voice_reply(reply, json!([]))],
        vec!["Please book four for Thursday."],
        2_400,
    );
    voice.tts_chunk_delay_ms.store(2_000, Ordering::SeqCst);
    let mut call = TrunkCall::connect(
        &voice,
        TrunkCallOptions::new(Duration::from_secs(20), Duration::from_secs(60)),
    )
    .await;
    call.callee_speaks(VAD_DEFAULT_HANGOVER_FRAMES + 2).await;
    chat_requests_reach(&voice, 1).await;
    call.dialog
        .renegotiate(&call.sip, 2, "INVITE", "sendonly", call.rtp_port)
        .await;
    call.update_matching(|params| params["subtitle"] == "On hold")
        .await;
    assert!(call.snapshot().on_hold);
    assert_eq!(voice.chat_requests.lock().await.len(), 1);
    assert!(call
        .snapshot()
        .transcript
        .iter()
        .any(|entry| entry.text == "Please book four for Thursday."));
    voice.tts_chunk_delay_ms.store(0, Ordering::SeqCst);
    call.dialog
        .renegotiate(&call.sip, 3, "INVITE", "sendrecv", call.rtp_port)
        .await;
    call.card_shows(reply).await;
    assert!(!call.snapshot().on_hold);
    assert_eq!(call.snapshot().status, PhoneCallStatus::InProgress);
    assert_eq!(voice.chat_requests.lock().await.len(), 2);
    call.agent_hangup().await;
    assert_eq!(call.settled().await.status, PhoneCallStatus::Completed);
    let report = call.report().await;
    assert!(
        report.contains("Please book four for Thursday."),
        "{report}",
    );
    assert!(report.contains(reply), "{report}");
}

#[tokio::test]
async fn barge_in_clears_queued_inband_dtmf_without_an_assistant_task() {
    let voice = MockVoiceState::new(
        vec![voice_reply(
            "",
            voice_tool("send_dtmf", json!({"digits":"01234567890123456789"})),
        )],
        vec![],
        2_400,
    );
    let mut options = TrunkCallOptions::new(Duration::from_millis(20), Duration::from_secs(60));
    options.include_dtmf = false;
    let mut call = TrunkCall::connect(&voice, options).await;
    call.assistant_audio_reaches_trunk().await;
    assert_eq!(voice.chat_requests.lock().await.len(), 1);
    assert!(voice.tts_requests.lock().await.is_empty());
    send_rtp_utterance(
        &call.rtp,
        call.dialog.client_rtp_addr,
        &mut call.seq,
        &mut call.ts,
        14,
        0,
    )
    .await;
    timeout(Duration::from_secs(1), async {
        let mut quiet = 0;
        let mut packet = [0; 2048];
        while quiet < 15 {
            let (len, _) = call.rtp.recv_from(&mut packet).await.unwrap();
            let rtp = parse_rtp_packet(&packet[..len]).unwrap();
            assert_eq!(rtp.payload_type, PCMU_PAYLOAD_TYPE);
            if rtp.payload.iter().all(|byte| matches!(*byte, 0xFF | 0x7F)) {
                quiet += 1;
            } else {
                quiet = 0;
            }
        }
    })
    .await
    .expect("barge-in discards remaining in-band tones immediately");
    assert_eq!(call.snapshot().status, PhoneCallStatus::InProgress);
    assert!(!call.snapshot().on_hold);
    call.agent_hangup().await;
    assert_eq!(
        call.settled().await.end_reason.as_deref(),
        Some("agent_hangup"),
    );
}

#[tokio::test]
async fn queued_substantive_correction_then_fragment_cancels_the_old_hangup_without_more_rtp() {
    let voice = MockVoiceState::new(
        vec![
            voice_reply(
                "Thanks, goodbye.",
                voice_tool(
                    "end_call",
                    json!({
                        "reason":"Got the hours", "outcome_summary":"Closes at nine"
                    }),
                ),
            ),
            voice_reply("Ten, got it. Thanks.", json!([])),
        ],
        vec!["We close at nine.", "Actually we close at ten.", "Bye"],
        2_400,
    );
    let mut call = TrunkCall::connect(
        &voice,
        TrunkCallOptions::new(Duration::from_secs(20), Duration::from_secs(60)),
    )
    .await;
    call.callee_speaks(VAD_DEFAULT_HANGOVER_FRAMES + 2).await;
    call.card_shows("Thanks, goodbye.").await;
    voice.stt_delay_ms.store(1_000, Ordering::SeqCst);
    call.callee_speaks(VAD_DEFAULT_HANGOVER_FRAMES + 2).await;
    stt_requests_reach(&voice, 2).await;
    voice.stt_delay_ms.store(0, Ordering::SeqCst);
    call.callee_speaks(VAD_DEFAULT_HANGOVER_FRAMES + 2).await;
    call.card_shows("Ten, got it. Thanks.").await;
    let snapshot = call.snapshot();
    assert_eq!(snapshot.status, PhoneCallStatus::InProgress);
    assert!(snapshot.end_reason.is_none());
    assert!(snapshot.outcome_summary.is_none());
    assert!(snapshot
        .transcript
        .iter()
        .any(|entry| entry.text == "Actually we close at ten."));
    assert!(snapshot.transcript.iter().any(|entry| entry.text == "Bye"));
    let requests = voice.chat_requests.lock().await;
    assert_eq!(requests.len(), 2);
    assert!(requests[1]["messages"]
        .to_string()
        .contains("Actually we close at ten."));
    assert!(requests[1]["messages"].to_string().contains("Bye"));
    drop(requests);
    call.agent_hangup().await;
    assert_eq!(
        call.settled().await.end_reason.as_deref(),
        Some("agent_hangup"),
    );
}

#[tokio::test]
async fn ordinary_steering_preserves_hold_then_late_transcription_keeps_explicit_resume() {
    let voice = MockVoiceState::new(
        vec![
            voice_reply(
                "Of course, I'll hold. I'll wait for you here.",
                voice_tool(
                    "wait_silently",
                    json!({"reason":"Recipient requested hold", "on_hold":true}),
                ),
            ),
            voice_reply(
                "",
                voice_tool(
                    "wait_silently",
                    json!({"reason":"Still holding", "on_hold":true}),
                ),
            ),
            voice_reply("", voice_tool("resume_call", json!({}))),
            voice_reply("Is there parking?", json!([])),
        ],
        vec![
            "Please hold while I check.",
            "Your call is important to us. Please continue to hold.",
        ],
        24_000,
    );
    let mut call = TrunkCall::connect(
        &voice,
        TrunkCallOptions::new(Duration::from_secs(20), Duration::from_secs(60)),
    )
    .await;
    call.callee_speaks(VAD_DEFAULT_HANGOVER_FRAMES + 2).await;
    call.assistant_audio_reaches_trunk().await;
    call.service
        .steer_phone_call(
            TRUNK_OWNER,
            &call.call_id,
            "Use a concise reply when they return.",
        )
        .unwrap();
    call.update_matching(|params| params["subtitle"] == "On hold")
        .await;
    chat_requests_reach(&voice, 2).await;
    call.update_matching(|params| params["subtitle"] == "On hold")
        .await;
    {
        let requests = voice.chat_requests.lock().await;
        assert_eq!(
            requests[1]["response_format"]["json_schema"]["name"],
            "hold_decision",
        );
        assert!(requests[1]["messages"][1]["content"]
            .as_str()
            .unwrap()
            .contains("Use a concise reply when they return."));
    }
    assert!(call.snapshot().on_hold);
    assert!(call
        .snapshot()
        .transcript
        .iter()
        .any(|entry| entry.text == "Of course, I'll hold."));
    assert!(!call
        .snapshot()
        .transcript
        .iter()
        .any(|entry| entry.text.contains("I'll wait for you here.")));
    voice.stt_delay_ms.store(500, Ordering::SeqCst);
    call.callee_speaks(crate::phone_call::audio::VAD_IVR_HANGOVER_FRAMES + 2)
        .await;
    stt_requests_reach(&voice, 2).await;
    call.service
        .steer_phone_call(
            TRUNK_OWNER,
            &call.call_id,
            "Resume speaking and ask about parking now.",
        )
        .unwrap();
    call.card_shows("Is there parking?").await;
    let requests = voice.chat_requests.lock().await;
    assert_eq!(requests.len(), 4);
    let held_input = requests[2]["messages"][1]["content"].as_str().unwrap();
    assert!(
        held_input.contains("Resume speaking and ask about parking now."),
        "{held_input}",
    );
    assert!(
        held_input.contains("Your call is important to us."),
        "{held_input}",
    );
    assert!(
        !held_input.contains("Use a concise reply when they return."),
        "{held_input}",
    );
    drop(requests);
    assert!(!call.snapshot().on_hold);
    assert_eq!(call.snapshot().status, PhoneCallStatus::InProgress);
    call.agent_hangup().await;
    assert_eq!(call.settled().await.status, PhoneCallStatus::Completed);
}

#[tokio::test]
async fn voice_tool_guards_keep_premature_and_held_actions_from_taking_effect() {
    let end_call = || {
        (
            "end_call",
            json!({"reason": "Got the hours", "outcome_summary": "Open until nine"}),
        )
    };
    let hold = || {
        (
            "wait_silently",
            json!({"reason": "Checking the patio", "on_hold": true}),
        )
    };
    let voice = MockVoiceState::new(
        vec![
            voice_reply(
                "Hello, I am calling about your opening hours.",
                voice_tools(&[
                    ("send_dtmf", json!({"digits": "1"})),
                    ("resume_call", json!({})),
                ]),
            ),
            voice_reply("", voice_tools(&[end_call()])),
            voice_reply("", voice_tools(&[hold(), end_call()])),
            voice_reply(
                "",
                voice_tools(&[
                    ("send_dtmf", json!({"digits": "2"})),
                    hold(),
                    ("resume_call", json!({})),
                ]),
            ),
            voice_reply("", voice_tools(&[hold()])),
            voice_reply("", voice_tools(&[("resume_call", json!({}))])),
            voice_reply(
                "Is the patio heated?",
                voice_tools(&[(
                    "wait_silently",
                    json!({"reason": "Awaiting the answer", "on_hold": false}),
                )]),
            ),
        ],
        vec![
            "We are open until nine tonight.",
            "Please hold while I check the patio.",
            "Still checking, one moment please.",
            "I'm back. How can I help?",
        ],
        2_450,
    );
    let mut options = TrunkCallOptions::new(Duration::from_millis(20), Duration::from_secs(60));
    options.include_dtmf = false;
    let mut call = TrunkCall::connect(&voice, options).await;

    // Without a negotiated telephone-event payload type, DTMF plays in-band.
    let voiced = call.outbound_audio_goes_quiet().await;
    assert!(
        voiced.iter().all(|pt| *pt == PCMU_PAYLOAD_TYPE),
        "{voiced:?}",
    );
    call.card_shows("Hello, I am calling about your opening hours.")
        .await;

    let ivr_silence = crate::phone_call::audio::VAD_IVR_HANGOVER_FRAMES + 10;
    call.callee_speaks(ivr_silence).await;
    call.card_shows("We are open until nine tonight.").await;
    call.update_matching(|_| true).await;
    call.callee_speaks(ivr_silence).await;
    call.card_shows("Please hold while I check the patio.")
        .await;
    call.update_matching(|params| params["subtitle"] == "On hold")
        .await;
    let held = call.snapshot();
    assert_eq!(held.status, PhoneCallStatus::InProgress);
    assert!(held.on_hold);

    call.callee_speaks(ivr_silence).await;
    call.card_shows("Still checking, one moment please.").await;
    call.update_matching(|_| true).await;
    assert!(
        call.snapshot().on_hold,
        "resume_call beside a hold request keeps holding",
    );

    call.service
        .steer_phone_call(
            TRUNK_OWNER,
            &call.call_id,
            "Ask whether the patio is heated.",
        )
        .unwrap();
    chat_requests_reach(&voice, 5).await;
    call.callee_speaks(ivr_silence).await;
    call.card_shows("Is the patio heated?").await;
    chat_requests_reach(&voice, 7).await;
    assert_eq!(call.snapshot().status, PhoneCallStatus::InProgress);
    assert!(!call.snapshot().on_hold);
    let requests: Vec<String> = voice
        .chat_requests
        .lock()
        .await
        .iter()
        .map(|request| request["messages"].to_string())
        .collect();
    let rejected_end = "Not ended: a single-word transcription is provisional";
    assert!(
        requests[1].contains("Sent DTMF digits: 1"),
        "{}",
        requests[1],
    );
    assert!(requests[1].contains("Conversation resumed; respond to the recipient now."));
    assert!(requests[2].contains(rejected_end), "{}", requests[2]);
    assert_eq!(
        requests[6].matches(rejected_end).count(),
        2,
        "{}",
        requests[6],
    );
    assert!(
        requests[6].contains("Not sent: the call is on hold."),
        "{}",
        requests[6],
    );
    assert!(!requests[6].contains("Sent DTMF digits: 2"));
    assert!(requests[3].contains("Still checking, one moment please."));
    assert!(requests[4].contains("Ask whether the patio is heated."));
    assert!(!requests[4].contains(rejected_end));

    assert_eq!(
        call.agent_hangup().await.status,
        HangupPhoneCallStatus::HungUp,
    );
    assert_eq!(
        call.settled().await.end_reason.as_deref(),
        Some("agent_hangup"),
    );
    assert!(call.report().await.contains("End reason: agent_hangup"));
}

#[tokio::test]
async fn opening_greeting_and_steers_wait_for_pending_transcriptions() {
    let voice = MockVoiceState::new(
        vec![
            voice_reply("Hello, I am calling about your opening hours.", json!([])),
            voice_reply("Do you also have parking nearby?", json!([])),
        ],
        vec![
            "",
            "",
            "",
            "We have a lot behind the building.",
            "Sorry, could you repeat that?",
        ],
        2_400,
    );
    let mut call = TrunkCall::connect(
        &voice,
        TrunkCallOptions::new(Duration::from_millis(800), Duration::from_secs(60)),
    )
    .await;
    let connected = Instant::now();
    let silence = VAD_DEFAULT_HANGOVER_FRAMES + 2;

    // An empty transcription inside the opening window keeps waiting for the deadline.
    call.callee_speaks(silence).await;
    stt_requests_reach(&voice, 1).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    // A transcription still pending at the deadline defers the greeting until it resolves.
    voice.stt_delay_ms.store(1_500, Ordering::SeqCst);
    call.callee_speaks(silence).await;
    stt_requests_reach(&voice, 2).await;
    call.card_shows("Hello, I am calling about your opening hours.")
        .await;
    assert!(
        connected.elapsed() >= Duration::from_millis(1_400),
        "the greeting started {:?} after connect",
        connected.elapsed(),
    );

    // A steer that arrives during a pending transcription waits for that result.
    voice.stt_delay_ms.store(800, Ordering::SeqCst);
    call.callee_speaks(silence).await;
    stt_requests_reach(&voice, 3).await;
    let transcribing = Instant::now();
    call.service
        .steer_phone_call(TRUNK_OWNER, &call.call_id, "Ask about parking.")
        .unwrap();
    call.card_shows("Do you also have parking nearby?").await;
    assert!(
        transcribing.elapsed() >= Duration::from_millis(700),
        "the steered turn started {:?} into the transcription",
        transcribing.elapsed(),
    );
    assert_eq!(voice.chat_requests.lock().await.len(), 2);

    // A newer utterance stays queued, and hang-up cancels the transcription and its backlog.
    voice.stt_delay_ms.store(3_000, Ordering::SeqCst);
    call.callee_speaks(silence).await;
    stt_requests_reach(&voice, 4).await;
    call.callee_speaks(silence).await;
    assert_eq!(voice.stt_requests.load(Ordering::SeqCst), 4);
    assert_eq!(
        call.agent_hangup().await.status,
        HangupPhoneCallStatus::HungUp,
    );
    let snapshot = call.settled().await;
    assert_eq!(snapshot.end_reason.as_deref(), Some("agent_hangup"));
    assert!(
        !snapshot
            .transcript
            .iter()
            .any(|entry| entry.speaker == TranscriptSpeaker::Callee),
        "{:?}",
        snapshot.transcript,
    );
    assert_eq!(voice.chat_requests.lock().await.len(), 2);
}

#[tokio::test]
async fn accepted_end_call_waits_for_queued_dtmf_before_hanging_up() {
    // 22 in-band digits take 22 * 8 frames * 20 ms = 3.52 s, longer than the quiet grace.
    let digits = "0123456789*#0123456789";
    let voice = MockVoiceState::new(
        vec![voice_reply(
            "Thanks, goodbye.",
            voice_tools(&[
                ("send_dtmf", json!({"digits": digits})),
                (
                    "end_call",
                    json!({"reason": "Got the hours", "outcome_summary": "Open until nine"}),
                ),
            ]),
        )],
        vec!["We are open until nine tonight."],
        2_400,
    );
    let mut options = TrunkCallOptions::new(Duration::from_secs(20), Duration::from_secs(60));
    options.include_dtmf = false;
    let mut call = TrunkCall::connect(&voice, options).await;
    call.callee_speaks(VAD_DEFAULT_HANGOVER_FRAMES + 2).await;
    call.card_shows("Thanks, goodbye.").await;
    let closing = Instant::now();
    timeout(TEST_TIMEOUT, call.dialog.expect_bye_and_reply_ok(&call.sip))
        .await
        .expect("the accepted closing hangs up");
    assert!(
        closing.elapsed() >= END_CALL_QUIET_GRACE + Duration::from_secs(1),
        "BYE was sent {:?} after the closing, before the queued DTMF finished",
        closing.elapsed(),
    );
    let snapshot = call.settled().await;
    assert_eq!(snapshot.end_reason.as_deref(), Some("Got the hours"));
    assert_eq!(snapshot.outcome_summary.as_deref(), Some("Open until nine"));
    assert!(call
        .report()
        .await
        .contains("Outcome summary: Open until nine"));
}

#[tokio::test]
async fn busy_line_settles_the_card_in_plain_words_with_the_sip_detail_secondary() {
    let hub = Arc::new(ClientHub::new());
    let (outbox, mut notifications) = client_outbox(64);
    hub.add_client_with_metadata(outbox, ClientConnectionMetadata::default())
        .await;
    let (report_tx, _reports) = mpsc::unbounded_channel();
    let queue = BridgeQueueService::with_submission_store(
        Arc::new(MockQueueDispatcher {
            captured: report_tx,
        }),
        Arc::clone(&hub),
        None,
        crate::queue_service::DurableQueueSubmissions::default(),
    );
    let sip = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let sip_port = sip.local_addr().unwrap().port();
    tokio::spawn(async move {
        let mut buf = vec![0_u8; 65535];
        let (n, client) = sip.recv_from(&mut buf).await.expect("INVITE");
        let invite = std::str::from_utf8(&buf[..n]).expect("utf8 INVITE");
        let busy = format!(
            "SIP/2.0 486 Busy Here\r\nVia: {}\r\nFrom: {}\r\nTo: {};tag=busy\r\nCall-ID: {}\r\nCSeq: 1 INVITE\r\nContent-Length: 0\r\n\r\n",
            extract_sip_header(invite, "Via:"),
            extract_sip_header(invite, "From:"),
            extract_sip_header(invite, "To:"),
            extract_sip_header(invite, "Call-ID:"),
        );
        sip.send_to(busy.as_bytes(), client).await.expect("486");
        let _ = sip.recv_from(&mut buf).await;
    });
    let voice = MockVoiceState::new(vec![], vec![], 0);
    let voice_url = spawn_mock_voice_http(voice).await;
    let service = PhoneCallService::with_options(
        Some(sample_runtime_config(sip_port, &voice_url)),
        hub,
        Arc::downgrade(&queue),
        PhoneCallTimeouts {
            approval_timeout: Duration::from_secs(5),
            max_call_duration: Duration::from_secs(60),
            opening_greeting_wait: Duration::from_secs(20),
        },
        None,
    );
    let start_service = Arc::clone(&service);
    let start = tokio::spawn(async move {
        start_service
            .start_phone_call(
                "busy-owner",
                StartPhoneCallRequest {
                    phone_number: "+15559876543".to_string(),
                    objective: "Ask about parking".to_string(),
                    callee_name: None,
                    first_message: None,
                    context: None,
                },
            )
            .await
    });
    let modal = recv_matching_notification(&mut notifications, |method, params| {
        method == "bridge/ui.present" && params["presentation"] == "modal"
    })
    .await;
    service
        .resolve_ui_action(&ResolveBridgeUiSurfaceRequest {
            id: modal["id"].as_str().unwrap().to_string(),
            thread_id: "busy-owner".to_string(),
            turn_id: None,
            action_id: "approve".to_string(),
        })
        .await;
    let failed = recv_matching_notification(&mut notifications, |method, params| {
        method == "bridge/ui.update" && params["title"] == "Phone call failed"
    })
    .await;
    let rows = failed["blocks"][0]["items"].to_string();
    assert!(
        rows.contains(r#"{"label":"Reason","value":"Line busy"}"#),
        "{rows}",
    );
    assert!(
        rows.contains(r#"{"label":"Details","value":"SIP call rejected (486 Busy Here)"}"#),
        "{rows}",
    );
    let error = timeout(TEST_TIMEOUT, start)
        .await
        .unwrap()
        .unwrap()
        .expect_err("a busy line fails the call");
    assert!(error.to_string().contains("486 Busy Here"), "{error}");
}

#[tokio::test]
async fn steering_during_synthesis_underrun_preserves_the_started_sentence() {
    let voice = MockVoiceState::new(
        vec![
            voice_reply(
                "Hello, I am checking the hours.",
                voice_tools(&[("wait_silently", json!({"on_hold": false}))]),
            ),
            voice_reply(
                "Is there parking?",
                voice_tools(&[("wait_silently", json!({"on_hold": false}))]),
            ),
        ],
        vec![],
        2_400,
    );
    voice.tts_chunk_delay_ms.store(100, Ordering::SeqCst);
    let mut call = TrunkCall::connect(
        &voice,
        TrunkCallOptions::new(Duration::from_millis(20), Duration::from_secs(60)),
    )
    .await;
    call.assistant_audio_reaches_trunk().await;
    timeout(TEST_TIMEOUT, async {
        let mut buffer = [0; 2048];
        loop {
            let (len, _) = call.rtp.recv_from(&mut buffer).await.unwrap();
            if parse_rtp_packet(&buffer[..len])
                .is_some_and(|packet| packet.payload.iter().all(|byte| *byte == 0xFF))
            {
                break;
            }
        }
    })
    .await
    .unwrap();
    voice.tts_chunk_delay_ms.store(0, Ordering::SeqCst);
    let steered_at = Instant::now();
    call.service
        .steer_phone_call(TRUNK_OWNER, &call.call_id, "Ask about parking.")
        .unwrap();
    call.card_shows("Is there parking?").await;
    assert!(steered_at.elapsed() >= Duration::from_millis(300));
    let messages = voice.chat_requests.lock().await[1]["messages"].to_string();
    assert!(messages.contains("Hello, I am checking the hours."));
    assert!(!messages.contains("[partially spoken sentence]"));
    call.agent_hangup().await;
}

#[tokio::test]
async fn remote_hold_preserves_discarded_audio_accounting() {
    let voice = MockVoiceState::new(
        vec![voice_reply(
            "The first sentence. The unplayed second sentence.",
            json!([]),
        )],
        vec![],
        48_000,
    );
    let mut call = TrunkCall::connect(
        &voice,
        TrunkCallOptions::new(Duration::from_millis(20), Duration::from_secs(60)),
    )
    .await;
    call.assistant_audio_reaches_trunk().await;
    call.dialog
        .renegotiate(&call.sip, 2, "INVITE", "sendonly", call.rtp_port)
        .await;
    call.update_matching(|params| params["subtitle"] == "On hold")
        .await;
    let snapshot = call.snapshot();
    assert!(snapshot.on_hold);
    let assistant: Vec<_> = snapshot
        .transcript
        .iter()
        .filter(|entry| entry.speaker == TranscriptSpeaker::Assistant)
        .collect();
    assert_eq!(assistant.len(), 1);
    assert_eq!(
        assistant[0].text,
        "[partially spoken sentence] [interrupted]",
    );
    call.agent_hangup().await;
}

#[tokio::test]
async fn interrupting_a_steered_turn_preserves_the_previous_completed_answer() {
    let voice = MockVoiceState::new(
        vec![
            voice_reply("The first answer.", json!([])),
            voice_reply("The second answer is still being spoken.", json!([])),
        ],
        vec![],
        2_400,
    );
    let mut call = TrunkCall::connect(
        &voice,
        TrunkCallOptions::new(Duration::from_millis(20), Duration::from_secs(60)),
    )
    .await;
    call.card_shows("The first answer.").await;
    call.outbound_audio_goes_quiet().await;
    *voice.tts_pcm_bytes.lock().await = vec![1; 96_000];
    call.service
        .steer_phone_call(TRUNK_OWNER, &call.call_id, "Ask about the patio.")
        .unwrap();
    call.assistant_audio_reaches_trunk().await;
    call.agent_hangup().await;
    let snapshot = call.settled().await;
    let assistant: Vec<_> = snapshot
        .transcript
        .iter()
        .filter(|entry| entry.speaker == TranscriptSpeaker::Assistant)
        .collect();
    assert_eq!(assistant.len(), 2);
    assert_eq!(assistant[0].text, "The first answer.");
    assert!(!assistant[0].interrupted);
    assert_eq!(
        assistant[1].text,
        "[partially spoken sentence] [interrupted]",
    );
    let report = call.report().await;
    assert!(report.contains("The first answer."));
}

#[tokio::test]
async fn synthesis_failure_preserves_an_already_played_sentence() {
    let voice = MockVoiceState::new(
        vec![voice_reply(
            "The first answer. The second answer.",
            json!([]),
        )],
        vec![],
        2_400,
    );
    voice.tts_fail_after.store(1, Ordering::SeqCst);
    let mut call = TrunkCall::connect(
        &voice,
        TrunkCallOptions::new(Duration::from_millis(20), Duration::from_secs(60)),
    )
    .await;
    call.assistant_audio_reaches_trunk().await;
    call.dialog.expect_bye_and_reply_ok(&call.sip).await;
    let snapshot = call.settled().await;
    assert_eq!(snapshot.status, PhoneCallStatus::Failed);
    assert!(snapshot
        .transcript
        .iter()
        .any(|entry| entry.text.starts_with("The first answer.")));
    assert!(!snapshot
        .transcript
        .iter()
        .any(|entry| entry.text.contains("The second answer.")));
    let report = call.report().await;
    assert!(report.starts_with("[Outbound phone call failed]"));
    assert!(report.contains("The first answer."));
}

#[tokio::test]
async fn steering_waits_for_pending_recipient_speech_onset() {
    let voice = MockVoiceState::new(
        vec![voice_reply("Is the patio open?", json!([]))],
        vec!["What would you like to know?"],
        2_400,
    );
    let mut call = TrunkCall::connect(
        &voice,
        TrunkCallOptions::new(Duration::from_secs(20), Duration::from_secs(60)),
    )
    .await;
    send_rtp_utterance(
        &call.rtp,
        call.dialog.client_rtp_addr,
        &mut call.seq,
        &mut call.ts,
        6,
        0,
    )
    .await;
    tokio::time::sleep(Duration::from_millis(30)).await;
    call.service
        .steer_phone_call(TRUNK_OWNER, &call.call_id, "Ask about the patio.")
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(voice.chat_requests.lock().await.is_empty());
    call.callee_speaks(VAD_DEFAULT_HANGOVER_FRAMES + 2).await;
    call.card_shows("Is the patio open?").await;
    assert_eq!(voice.chat_requests.lock().await.len(), 1);
    call.agent_hangup().await;
}

#[tokio::test]
async fn overlapping_transcriptions_preserve_both_inputs_before_replying() {
    let voice = MockVoiceState::new(
        vec![voice_reply("Thursday, got it.", json!([]))],
        vec![
            "Book for two on Tuesday.",
            "Actually, use Thursday instead.",
        ],
        2_400,
    );
    voice.stt_delay_ms.store(3_000, Ordering::SeqCst);
    let mut call = TrunkCall::connect(
        &voice,
        TrunkCallOptions::new(Duration::from_secs(20), Duration::from_secs(60)),
    )
    .await;
    call.callee_speaks(VAD_DEFAULT_HANGOVER_FRAMES + 2).await;
    stt_requests_reach(&voice, 1).await;
    call.callee_speaks(VAD_DEFAULT_HANGOVER_FRAMES + 2).await;
    call.card_shows("Book for two on Tuesday.").await;
    assert!(voice.chat_requests.lock().await.is_empty());
    call.card_shows("Thursday, got it.").await;
    let snapshot = call.snapshot();
    let recipient: Vec<_> = snapshot
        .transcript
        .iter()
        .filter(|entry| entry.speaker == TranscriptSpeaker::Callee)
        .map(|entry| entry.text.as_str())
        .collect();
    assert_eq!(
        recipient,
        [
            "Book for two on Tuesday.",
            "Actually, use Thursday instead."
        ],
    );
    let requests = voice.chat_requests.lock().await;
    assert_eq!(requests.len(), 1);
    let users: Vec<_> = requests[0]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "user")
        .map(|message| {
            message["content"]
                .as_str()
                .unwrap()
                .strip_prefix("Recipient: ")
                .unwrap()
        })
        .collect();
    assert_eq!(users, recipient);
    drop(requests);
    call.agent_hangup().await;
    assert_eq!(
        call.settled().await.end_reason.as_deref(),
        Some("agent_hangup"),
    );
}

#[tokio::test]
async fn speech_with_missing_packets_or_sparse_comfort_noise_completes_once() {
    for comfort_noise in [false, true] {
        let voice = MockVoiceState::new(
            vec![voice_reply("Thank you for the hours.", json!([]))],
            vec!["We open at nine tomorrow."],
            2_400,
        );
        let mut call = TrunkCall::connect(
            &voice,
            TrunkCallOptions::new(Duration::from_secs(20), Duration::from_secs(60)),
        )
        .await;
        call.callee_speaks(0).await;
        let quiet_started = Instant::now();
        timeout(Duration::from_millis(1_200), async {
            let emit_noise = async {
                if comfort_noise {
                    for _ in 0..5 {
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        let packet = build_rtp_packet(false, 13, call.seq, call.ts, 1, &[30]);
                        call.rtp
                            .send_to(&packet, call.dialog.client_rtp_addr)
                            .await
                            .unwrap();
                        call.seq = call.seq.wrapping_add(1);
                        call.ts = call.ts.wrapping_add(1_600);
                    }
                }
            };
            let stt_future = stt_requests_reach(&voice, 1);
            tokio::join!(emit_noise, stt_future);
        })
        .await
        .expect("quiet media completes the utterance within twelve hundred milliseconds");
        assert!(quiet_started.elapsed() <= Duration::from_millis(1_200));
        call.card_shows("Thank you for the hours.").await;
        assert_eq!(voice.stt_requests.load(Ordering::SeqCst), 1);
        assert_eq!(voice.chat_requests.lock().await.len(), 1);
        assert_eq!(call.snapshot().status, PhoneCallStatus::InProgress);
        call.agent_hangup().await;
        assert_eq!(call.settled().await.status, PhoneCallStatus::Completed);
    }
}

#[tokio::test]
async fn steering_during_speech_finishes_only_the_current_sentence_and_fences_actions() {
    for (instruction, should_finish) in [
        ("Do not press one. Ask about parking instead.", true),
        ("Please stop speaking. Ask about parking instead.", false),
        ("Stop! Ask about parking instead.", false),
        (
            "Please stop reading that. Ask about parking instead.",
            false,
        ),
    ] {
        let voice = MockVoiceState::new(
            vec![
                voice_reply(
                    "Hello, I am calling about hours. I will press one now.",
                    voice_tools(&[("send_dtmf", json!({"digits": "1"}))]),
                ),
                voice_reply(
                    "Is there parking?",
                    voice_tools(&[(
                        "wait_silently",
                        json!({"reason": "Awaiting parking", "on_hold": false}),
                    )]),
                ),
            ],
            vec![],
            24_000,
        );
        let mut call = TrunkCall::connect(
            &voice,
            TrunkCallOptions::new(Duration::from_millis(20), Duration::from_secs(60)),
        )
        .await;
        call.assistant_audio_reaches_trunk().await;
        let steered_at = Instant::now();
        call.service
            .steer_phone_call(TRUNK_OWNER, &call.call_id, instruction)
            .unwrap();
        call.card_shows("Is there parking?").await;
        let snapshot = call.snapshot();
        assert_eq!(snapshot.status, PhoneCallStatus::InProgress);
        assert!(!snapshot.on_hold);
        assert!(!snapshot
            .transcript
            .iter()
            .any(|entry| entry.text.contains("I will press one")));
        let first_turn = &voice.chat_requests.lock().await[1]["messages"].to_string();
        assert!(!first_turn.contains("Sent DTMF digits: 1"));
        assert!(!first_turn.contains("I will press one"));
        if should_finish {
            assert!(first_turn.contains("Hello, I am calling about hours."));
            assert!(steered_at.elapsed() >= Duration::from_millis(700));
        } else {
            assert!(!first_turn.contains("Hello, I am calling about hours."));
            assert!(steered_at.elapsed() < Duration::from_millis(1_500));
        }
        call.agent_hangup().await;
        assert_eq!(call.settled().await.status, PhoneCallStatus::Completed);
    }
}

#[tokio::test]
async fn voice_preparation_finishes_before_sip_and_preserves_cancel_and_failure_controls() {
    for outcome in [
        "ready",
        "cancel",
        "fail",
        "unsupported-stt-ready",
        "unsupported-stt-cancel",
        "unsupported-tts-ready",
        "unsupported-tts-cancel",
        "unsupported-tts-fail",
        "missing-dialogue",
    ] {
        let voice = MockVoiceState::new(
            vec![voice_reply(
                "",
                voice_tool(
                    "wait_silently",
                    json!({
                        "reason":"prepared", "on_hold":false
                    }),
                ),
            )],
            vec![],
            2_400,
        );
        voice.preload_delay_ms.store(1_000, Ordering::SeqCst);
        if outcome == "fail" {
            *voice.preload_status.lock().await = StatusCode::SERVICE_UNAVAILABLE;
        } else if outcome.starts_with("unsupported") || outcome == "missing-dialogue" {
            *voice.preload_status.lock().await = StatusCode::NOT_FOUND;
            if outcome == "missing-dialogue" {
                voice.stt_delay_ms.store(1_000, Ordering::SeqCst);
                *voice.chat_status.lock().await = StatusCode::NOT_FOUND;
            } else if outcome.starts_with("unsupported-stt") {
                voice.stt_delay_ms.store(1_000, Ordering::SeqCst);
            } else if outcome.ends_with("fail") {
                voice.tts_fail_after.store(0, Ordering::SeqCst);
            } else {
                voice.tts_chunk_delay_ms.store(1_000, Ordering::SeqCst);
                *voice.tts_pcm_bytes.lock().await = [0x40_u8, 0x1F].repeat(480);
            }
        }
        let voice_url = spawn_mock_voice_http(Arc::clone(&voice)).await;
        let sip = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let rtp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let hub = Arc::new(ClientHub::new());
        let (outbox, mut notifications) = client_outbox(256);
        hub.add_client_with_metadata(outbox, ClientConnectionMetadata::default())
            .await;
        let service = PhoneCallService::with_options(
            Some(sample_runtime_config(
                sip.local_addr().unwrap().port(),
                &voice_url,
            )),
            hub,
            Weak::new(),
            PhoneCallTimeouts {
                approval_timeout: Duration::from_secs(5),
                max_call_duration: Duration::from_secs(60),
                opening_greeting_wait: Duration::from_secs(20),
            },
            None,
        );
        let start_service = Arc::clone(&service);
        let start = tokio::spawn(async move {
            start_service
                .start_phone_call(TRUNK_OWNER, parking_request())
                .await
        });
        let call_id = await_approval_call_id(&mut notifications).await;
        service
            .resolve_ui_action(&ui_action(
                &approval_surface_id(&call_id),
                TRUNK_OWNER,
                "approve",
            ))
            .await;
        timeout(TEST_TIMEOUT, async {
            while voice.preload_requests.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        if outcome.starts_with("unsupported-stt") {
            stt_requests_reach(&voice, 1).await;
        }
        voice.preload_delay_ms.store(0, Ordering::SeqCst);
        let preparing = service.get_phone_call(TRUNK_OWNER, &call_id).unwrap();
        assert_eq!(preparing.status, PhoneCallStatus::Dialing);
        assert!(preparing.connected_at.is_none());
        assert_eq!(service.snapshot_surfaces().len(), 1);
        let mut packet = [0; 2048];
        assert!(
            timeout(Duration::from_millis(200), sip.recv_from(&mut packet))
                .await
                .is_err(),
            "SIP started while voice was still loading: {outcome}",
        );
        match outcome {
            "ready" | "unsupported-stt-ready" | "unsupported-tts-ready" => {
                let dialog = timeout(
                    TEST_TIMEOUT,
                    MockSipDialog::accept_invite(
                        &sip,
                        rtp.local_addr().unwrap().port(),
                        false,
                        true,
                    ),
                )
                .await
                .unwrap();
                assert!(timeout(TEST_TIMEOUT, start).await.unwrap().unwrap().is_ok());
                assert_eq!(
                    service
                        .get_phone_call(TRUNK_OWNER, &call_id)
                        .unwrap()
                        .status,
                    PhoneCallStatus::InProgress,
                );
                let hangup_future = service.hangup_phone_call(TRUNK_OWNER, &call_id);
                let bye_future = dialog.expect_bye_and_reply_ok(&sip);
                let (hangup, ()) = tokio::join!(hangup_future, bye_future);
                assert_eq!(hangup.unwrap().status, HangupPhoneCallStatus::HungUp);
            }
            "cancel" | "unsupported-stt-cancel" | "unsupported-tts-cancel" => {
                assert_eq!(
                    service
                        .hangup_phone_call(TRUNK_OWNER, &call_id)
                        .await
                        .unwrap()
                        .status,
                    HangupPhoneCallStatus::HungUp,
                );
                assert!(timeout(TEST_TIMEOUT, start)
                    .await
                    .unwrap()
                    .unwrap()
                    .is_err());
                assert_eq!(
                    service
                        .get_phone_call(TRUNK_OWNER, &call_id)
                        .unwrap()
                        .status,
                    PhoneCallStatus::Cancelled,
                );
                assert!(
                    timeout(Duration::from_millis(50), sip.recv_from(&mut packet))
                        .await
                        .is_err(),
                );
            }
            "fail" | "unsupported-tts-fail" | "missing-dialogue" => {
                assert!(timeout(TEST_TIMEOUT, start)
                    .await
                    .unwrap()
                    .unwrap()
                    .is_err());
                let failed = service.get_phone_call(TRUNK_OWNER, &call_id).unwrap();
                assert_eq!(failed.status, PhoneCallStatus::Failed);
                assert!(failed.end_reason.unwrap().contains(if outcome == "fail" {
                    "503"
                } else if outcome == "missing-dialogue" {
                    "404"
                } else {
                    "500"
                }));
                assert!(
                    timeout(Duration::from_millis(50), sip.recv_from(&mut packet))
                        .await
                        .is_err(),
                );
            }
            _ => unreachable!(),
        }
        timeout(TEST_TIMEOUT, async {
            while service.live_work_count() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(service.snapshot_surfaces().is_empty());
    }
}

#[tokio::test]
async fn punctuation_only_closing_is_not_a_successful_spoken_goodbye() {
    for native in [true, false] {
        let reply = if native {
            let delta = json!({"choices":[{"delta":{"content":json!({
                "decision":"end_call","speech":"...","digits":"","on_hold":false,"outcome_summary":"The restaurant closes at nine."
            }).to_string()}}]});
            vec![format!("data: {delta}\n\ndata: [DONE]\n\n").into_bytes()]
        } else {
            voice_reply(
                "...",
                voice_tools(&[(
                    "end_call",
                    json!({
                        "reason":"hours_confirmed","outcome_summary":"Closes at nine."
                    }),
                )]),
            )
        };
        let voice = MockVoiceState::new(vec![reply], vec!["We close at nine tonight."], 2_400);
        let mut call = TrunkCall::connect(
            &voice,
            TrunkCallOptions::new(Duration::from_secs(20), Duration::from_secs(60)),
        )
        .await;
        call.callee_speaks(VAD_DEFAULT_HANGOVER_FRAMES + 2).await;
        timeout(TEST_TIMEOUT, call.dialog.expect_bye_and_reply_ok(&call.sip))
            .await
            .unwrap();
        let card = call
            .update_matching(|params| params["title"] == "Phone call failed")
            .await;
        assert_eq!(card["tone"], "error");
        let snapshot = call.settled().await;
        assert_eq!(snapshot.status, PhoneCallStatus::Failed);
        assert!(voice.tts_requests.lock().await.is_empty());
    }
}

#[tokio::test]
async fn failed_closing_synthesis_settles_as_failed_not_completed() {
    for pcm in [vec![], vec![0x01], [1_u8, 0].repeat(2_400)] {
        let voice = MockVoiceState::new(
            vec![
                voice_reply("Hello, what time do you close?", json!([])),
                voice_reply(
                    "Thank you. Goodbye.",
                    voice_tools(&[(
                        "end_call",
                        json!({"reason": "hours_confirmed", "outcome_summary": "Open until nine"}),
                    )]),
                ),
            ],
            vec!["We close at nine tonight."],
            2_400,
        );
        let mut call = TrunkCall::connect(
            &voice,
            TrunkCallOptions::new(Duration::from_millis(20), Duration::from_secs(60)),
        )
        .await;
        call.card_shows("Hello, what time do you close?").await;
        *voice.tts_pcm_bytes.lock().await = pcm;
        call.callee_speaks(VAD_DEFAULT_HANGOVER_FRAMES + 2).await;
        timeout(TEST_TIMEOUT, call.dialog.expect_bye_and_reply_ok(&call.sip))
            .await
            .unwrap();
        let card = call
            .update_matching(|params| params["title"] == "Phone call failed")
            .await;
        assert_eq!(card["tone"], "error");
        let snapshot = call.settled().await;
        assert_eq!(snapshot.status, PhoneCallStatus::Failed);
        let failure = snapshot.outcome_summary.as_deref().unwrap();
        assert!(
            failure.contains("PCM") || failure.contains("silent after telephone encoding"),
            "{failure}",
        );
        assert!(!snapshot
            .transcript
            .iter()
            .any(|entry| entry.text == "Thank you. Goodbye."));
        let report = call.report().await;
        assert!(report.starts_with("[Outbound phone call failed]"));
        assert!(!report.contains("End reason: hours_confirmed"));
    }
}

#[tokio::test]
async fn transcription_and_assistant_turn_failures_fail_the_call() {
    for transcription_fails in [true, false] {
        let voice = if transcription_fails {
            MockVoiceState::new(Vec::new(), vec![STT_FAILURE_REPLY], 2_400)
        } else {
            MockVoiceState::new(
                vec![voice_reply(
                    "",
                    voice_tool("send_dtmf", json!({"digits": "9Z"})),
                )],
                Vec::new(),
                2_400,
            )
        };
        let opening = if transcription_fails {
            Duration::from_secs(20)
        } else {
            Duration::from_millis(20)
        };
        let mut call = TrunkCall::connect(
            &voice,
            TrunkCallOptions::new(opening, Duration::from_secs(60)),
        )
        .await;
        if transcription_fails {
            call.callee_speaks(VAD_DEFAULT_HANGOVER_FRAMES + 2).await;
        }
        timeout(TEST_TIMEOUT, call.dialog.expect_bye_and_reply_ok(&call.sip))
            .await
            .expect("a failed call hangs up");
        let failed_card = call
            .update_matching(|params| params["title"] == "Phone call failed")
            .await;
        assert_eq!(failed_card["tone"], "error");
        let snapshot = call.settled().await;
        assert_eq!(snapshot.status, PhoneCallStatus::Failed);
        let expected_error = if transcription_fails {
            "HTTP 500"
        } else {
            "invalid voice tool call 'send_dtmf'"
        };
        let end_reason = snapshot.end_reason.unwrap_or_default();
        assert!(end_reason.contains(expected_error), "{end_reason}");
        let card_rows = failed_card["blocks"][0]["items"].to_string();
        assert!(
            card_rows.contains(r#"{"label":"Reason","value":"The voice assistant hit an error"}"#),
            "{card_rows}",
        );
        assert!(card_rows.contains(r#""label":"Details""#) && card_rows.contains(expected_error));
        let report = call.report().await;
        assert!(
            report.starts_with("[Outbound phone call failed]"),
            "{report}",
        );
        assert!(report.contains("Status: failed"), "{report}");
    }
}

#[test]
fn self_echo_matcher_rejects_echo_fragments_and_preserves_genuine_replies() {
    for (callee, assistant) in [
        (
            "I wish I could find a",
            "I wish I could find a better option for you.",
        ),
        (
            "anything else on your mug",
            "Hi again! Is there anything else on your mind?",
        ),
        (
            "apologize if i what",
            "I apologize if I interrupted you earlier.",
        ),
        (
            "Sorry if I've made you",
            "Sorry if I've made you wait on the line.",
        ),
        ("I apologize", "I apologize if I interrupted."),
        ("anything else", "Is there anything else on your mind?"),
        ("Great.", "Great! What would you like to talk about today?"),
    ] {
        assert!(
            is_likely_self_echo(callee, assistant),
            "expected echo match for callee={callee:?} vs assistant={assistant:?}",
        );
    }

    for (callee, assistant) in [
        ("Hello", "Hello, I'm calling for David."),
        ("Yes", "Yes, I can check that."),
        ("No", "No problem at all."),
        ("Wait", "Wait a second, let me check."),
        ("Stop", "Please don't stop talking."),
        ("Hi there", "Hi there, I'm calling for Alex."),
        ("Thank you", "Thank you for checking."),
        ("Yes, I can hear you", "Hi, can you hear me okay?"),
        (
            "Yes, we take reservations.",
            "One more question: do you take reservations?",
        ),
        (
            "Book a table for two",
            "Hi, I'm calling for Alex to check your hours.",
        ),
        ("For David, sure", "Hi, I'm calling for David."),
        ("Okay.", "Okay! Sounds good."),
        ("Goodbye.", "Goodbye! Have a great day."),
    ] {
        assert!(
            !is_likely_self_echo(callee, assistant),
            "must not drop genuine reply callee={callee:?} vs assistant={assistant:?}",
        );
    }

    let progress = SpokenTurnProgress {
        clauses_started: vec![
            (0, "I wish I could find a better option.".to_string()),
            (20, "Let me check that for you.".to_string()),
        ],
        clauses_finished: vec![20],
        total_frames_enqueued: 25,
        ..SpokenTurnProgress::default()
    };
    assert_eq!(progress.spoken_text(20), "[partially spoken sentence]");
    assert_eq!(
        progress.started_clauses_text(),
        "I wish I could find a better option. Let me check that for you.",
    );
}

#[tokio::test]
async fn self_echo_after_barge_in_and_playback_is_dropped_while_real_callee_speech_passes() {
    let voice = MockVoiceState::new(
        vec![
            voice_reply(
                "I wish I could find a better option for you today.",
                json!([]),
            ),
            voice_reply("Hi again! Is there anything else on your mind?", json!([])),
            voice_reply("Seven works great, thank you.", json!([])),
        ],
        vec![
            "I wish I could find a",
            "anything else on your mug",
            "Yes, we have a table at seven.",
        ],
        24_000,
    );
    voice.tts_chunk_delay_ms.store(10, Ordering::SeqCst);
    let mut call = TrunkCall::connect(
        &voice,
        TrunkCallOptions::new(Duration::from_millis(20), Duration::from_secs(60)),
    )
    .await;

    // Trigger barge-in during Turn 1; STT returns an echo of the interrupted clause.
    call.assistant_audio_reaches_trunk().await;
    send_rtp_utterance(
        &call.rtp,
        call.dialog.client_rtp_addr,
        &mut call.seq,
        &mut call.ts,
        VAD_BARGE_IN_ONSET_FRAMES + 4,
        VAD_DEFAULT_HANGOVER_FRAMES + 2,
    )
    .await;
    stt_requests_reach(&voice, 1).await;

    // Echoed barge-in must be dropped and recover the interrupted turn without stalling.
    call.card_shows("Hi again! Is there anything else on your mind?")
        .await;
    {
        let requests = voice.chat_requests.lock().await;
        assert_eq!(requests.len(), 2);
        let recovery_messages = requests[1]["messages"].to_string();
        assert!(
            recovery_messages.contains(ECHO_RECOVERY_NUDGE),
            "{recovery_messages}",
        );
        assert!(
            !recovery_messages.contains("I wish I could find a"),
            "{recovery_messages}",
        );
    }

    // Speakerphone echo right after Turn 2 finishes must be dropped without prompting again.
    send_rtp_utterance(
        &call.rtp,
        call.dialog.client_rtp_addr,
        &mut call.seq,
        &mut call.ts,
        VAD_BARGE_IN_ONSET_FRAMES + 4,
        VAD_DEFAULT_HANGOVER_FRAMES + 2,
    )
    .await;
    stt_requests_reach(&voice, 2).await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(voice.chat_requests.lock().await.len(), 2);
    assert!(!call
        .snapshot()
        .transcript
        .iter()
        .any(|entry| entry.text.contains("anything else on your mug")));

    // Genuine callee speech is accepted and answered normally.
    send_rtp_utterance(
        &call.rtp,
        call.dialog.client_rtp_addr,
        &mut call.seq,
        &mut call.ts,
        VAD_BARGE_IN_ONSET_FRAMES + 4,
        VAD_DEFAULT_HANGOVER_FRAMES + 2,
    )
    .await;
    call.card_shows("Seven works great, thank you.").await;
    assert_eq!(voice.chat_requests.lock().await.len(), 3);
    let snapshot = call.snapshot();
    assert!(snapshot
        .transcript
        .iter()
        .any(|entry| entry.text == "Yes, we have a table at seven."));
    assert!(!snapshot.transcript.iter().any(|entry| {
        entry.speaker == TranscriptSpeaker::Callee
            && (entry.text.contains("I wish I could find a")
                || entry.text.contains("anything else on your mug"))
    }));

    call.agent_hangup().await;
    assert_eq!(call.settled().await.status, PhoneCallStatus::Completed);
}

#[tokio::test]
async fn silent_non_hold_turn_retries_once_on_substantive_speech_without_looping() {
    for prompt in [
        "Why did you stop talking?",
        "Hello",
        "Hello?",
        "Are you there",
        "Hi!",
        "Story.",
        "Yes.",
    ] {
        assert!(callee_expects_spoken_reply(prompt), "{prompt:?}");
    }
    for fragment in ["", "...", "?", "I", "I ...", "Uh", "And", "Um"] {
        assert!(!callee_expects_spoken_reply(fragment), "{fragment:?}");
    }
    for incomplete in [
        "This",
        "Isn't",
        "And",
        "Tempo, the pacing, that's how you know that I'm",
        "I need to",
        "Um",
        "Wait...",
    ] {
        assert!(super::is_incomplete_utterance(incomplete), "{incomplete:?}");
    }
    for complete in [
        "Tell me about Grand Theft Auto.",
        "Story.",
        "Stop the call.",
        "Why did you stop talking?",
        "Hello!",
    ] {
        assert!(!super::is_incomplete_utterance(complete), "{complete:?}");
    }

    let silent_wait = |reason: &str| {
        voice_reply(
            "",
            voice_tool("wait_silently", json!({"reason": reason, "on_hold": false})),
        )
    };
    let voice = MockVoiceState::new(
        vec![
            silent_wait("Listening"),
            voice_reply(
                "Sorry about that, I am still here and listening.",
                json!([]),
            ),
            silent_wait("Listening"),
            silent_wait("Still listening"),
            silent_wait("Waiting for complete thought"),
        ],
        vec!["Why did you stop talking?", "Hello", "I"],
        2_400,
    );
    let mut call = TrunkCall::connect(
        &voice,
        TrunkCallOptions::new(Duration::from_secs(20), Duration::from_secs(60)),
    )
    .await;

    // Substantive question met with empty speech + wait_silently(on_hold=false) retries once.
    call.callee_speaks(VAD_DEFAULT_HANGOVER_FRAMES + 2).await;
    call.card_shows("Sorry about that, I am still here and listening.")
        .await;
    {
        let requests = voice.chat_requests.lock().await;
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[0]["response_format"]["json_schema"]["schema"]["properties"]["speech"]
                ["minLength"],
            2,
            "first turn on a substantive reply must require spoken speech immediately",
        );
        assert_eq!(
            requests[1]["response_format"]["json_schema"]["schema"]["properties"]["speech"]
                ["minLength"],
            2,
        );
        assert!(
            requests[1]["messages"]
                .to_string()
                .contains(SILENT_TURN_RETRY_NUDGE),
            "{}",
            requests[1]["messages"],
        );
    }
    call.outbound_audio_goes_quiet().await;

    // If the single retry also stays silent, the loop stops without infinite retrying.
    send_rtp_utterance(
        &call.rtp,
        call.dialog.client_rtp_addr,
        &mut call.seq,
        &mut call.ts,
        VAD_BARGE_IN_ONSET_FRAMES + 4,
        VAD_DEFAULT_HANGOVER_FRAMES + 2,
    )
    .await;
    chat_requests_reach(&voice, 4).await;
    {
        let requests = voice.chat_requests.lock().await;
        assert_eq!(
            requests[2]["response_format"]["json_schema"]["schema"]["properties"]["speech"]
                ["minLength"],
            2,
            "direct greeting must require spoken speech on the first attempt",
        );
        assert_eq!(
            requests[3]["response_format"]["json_schema"]["schema"]["properties"]["speech"]
                ["minLength"],
            2,
        );
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(voice.chat_requests.lock().await.len(), 4);
    assert_eq!(call.snapshot().status, PhoneCallStatus::InProgress);
    assert!(!call.snapshot().on_hold);

    // Non-substantive 1-word fragment does not trigger a silent-turn retry or minLength.
    send_rtp_utterance(
        &call.rtp,
        call.dialog.client_rtp_addr,
        &mut call.seq,
        &mut call.ts,
        VAD_BARGE_IN_ONSET_FRAMES + 4,
        VAD_IVR_HANGOVER_FRAMES + 4,
    )
    .await;
    chat_requests_reach(&voice, 5).await;
    {
        let requests = voice.chat_requests.lock().await;
        assert!(
            requests[4]["response_format"]["json_schema"]["schema"]["properties"]["speech"]
                .get("minLength")
                .is_none(),
            "single-word fragment must not force minLength on speech",
        );
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(voice.chat_requests.lock().await.len(), 5);

    call.agent_hangup().await;
    assert_eq!(call.settled().await.status, PhoneCallStatus::Completed);
}

#[tokio::test]
async fn normal_spoken_wait_silently_does_not_stick_vad_in_ivr_mode() {
    let mut vad = TelephonyVad::new();
    update_vad_ivr_mode_for_wait_silently(&mut vad, false, false, false, false);
    assert!(!vad.is_ivr_mode());
    update_vad_ivr_mode_for_wait_silently(&mut vad, true, false, false, false);
    assert!(vad.is_ivr_mode());
    update_vad_ivr_mode_for_wait_silently(&mut vad, false, false, false, false);
    assert!(!vad.is_ivr_mode());
    update_vad_ivr_mode_for_wait_silently(&mut vad, false, true, false, false);
    assert!(vad.is_ivr_mode());
    update_vad_ivr_mode_for_wait_silently(&mut vad, false, false, false, true);
    assert!(vad.is_ivr_mode());
    vad.set_ivr_mode(false);
    update_vad_ivr_mode_for_wait_silently(&mut vad, false, true, true, false);
    assert!(!vad.is_ivr_mode());

    let structured_wait = |speech: &str| {
        let turn_json = json!({
            "speech": speech,
            "decision": "wait_silently",
            "digits": "",
            "reason": "Listening",
            "on_hold": false,
            "outcome_summary": "",
        })
        .to_string();
        vec![
            format!(
                "data: {}\n\n",
                json!({"choices": [{"delta": {"content": turn_json}}]}),
            )
            .into_bytes(),
            b"data: [DONE]\n\n".to_vec(),
        ]
    };

    let voice = MockVoiceState::new(
        vec![
            structured_wait("Hello, what time do you close tonight?"),
            structured_wait("Nine p m, got it."),
        ],
        vec!["We close at nine tonight."],
        2_400,
    );
    let mut call = TrunkCall::connect(
        &voice,
        TrunkCallOptions::new(Duration::from_millis(20), Duration::from_secs(60)),
    )
    .await;
    call.card_shows("Hello, what time do you close tonight?")
        .await;
    call.outbound_audio_goes_quiet().await;
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Exact default hangover followed by a loud frame completes immediately only when IVR mode is off.
    send_rtp_utterance(
        &call.rtp,
        call.dialog.client_rtp_addr,
        &mut call.seq,
        &mut call.ts,
        VAD_BARGE_IN_ONSET_FRAMES + 2,
        VAD_DEFAULT_HANGOVER_FRAMES,
    )
    .await;
    send_rtp_utterance(
        &call.rtp,
        call.dialog.client_rtp_addr,
        &mut call.seq,
        &mut call.ts,
        1,
        0,
    )
    .await;

    timeout(Duration::from_millis(450), async {
        while voice.stt_requests.load(Ordering::SeqCst) < 1 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("normal spoken wait_silently must keep default VAD hangover, not IVR hangover");

    call.card_shows("Nine p m, got it.").await;
    {
        let requests = voice.chat_requests.lock().await;
        assert_eq!(requests.len(), 2);
        assert!(
            !requests[1]["messages"]
                .to_string()
                .contains("Waiting silently:"),
            "normal spoken structured turns must not spam Waiting silently system messages: {}",
            requests[1]["messages"],
        );
    }
    call.agent_hangup().await;
    assert_eq!(call.settled().await.status, PhoneCallStatus::Completed);
}
