use super::{Lfm3AudioStrategy, Lfm3RealtimeSession};
use crate::phone_call::audio::{decode_mulaw, RTP_FRAME_SAMPLES};
use crate::phone_call::realtime::lfm3_audio::{
    build_lfm3_instructions, derive_realtime_ws_url, encode_lfm3_mulaw_frame, encode_wav_16k_mono,
    transcribe_lfm3_chat_wav, upsample_8k_to_16k,
};
use crate::phone_call::realtime::strategy::{
    RealtimeModelSession, RealtimeModelStrategy, RealtimeToolInvocation, RealtimeToolSpec,
};
use crate::phone_call::realtime::tools::end_call::EndCallTool;
use crate::phone_call::realtime::tools::send_dtmf::SendDtmfTool;
use crate::phone_call::realtime::tools::RealtimeTool;
use crate::phone_call::voice::VoiceCallPromptParams;
use axum::extract::ws::{Message as AxumWsMsg, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use reqwest::Url;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct MockRealtimeState {
    received_events: Mutex<Vec<Value>>,
    scripted_turns: Mutex<Vec<MockTurnScript>>,
    asr_requests: Mutex<Vec<Value>>,
}

struct MockTurnScript {
    text_deltas: Vec<String>,
    audio_samples_24k: Vec<i16>,
    tool_calls: Vec<Value>,
    pause_for_cancel: bool,
}

async fn spawn_mock_realtime_server(state: Arc<MockRealtimeState>) -> Url {
    let app = Router::new()
        .route("/v1/realtime", get(handle_ws_upgrade))
        .route("/v1/chat/completions", post(handle_chat_asr))
        .with_state(state);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    Url::parse(&format!("http://{addr}/v1")).unwrap()
}

async fn handle_chat_asr(
    State(state): State<Arc<MockRealtimeState>>,
    Json(body): Json<Value>,
) -> Json<Value> {
    state.asr_requests.lock().await.push(body);
    Json(json!({
        "choices": [{ "message": { "content": "Hello from LFM3 ASR." } }]
    }))
}

async fn handle_ws_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<Arc<MockRealtimeState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws_session(socket, state))
}

async fn handle_ws_session(mut socket: WebSocket, state: Arc<MockRealtimeState>) {
    let _ = socket
        .send(AxumWsMsg::Text(
            json!({ "type": "session.created", "session": { "id": "sess_test" } })
                .to_string()
                .into(),
        ))
        .await;

    while let Some(Ok(msg)) = socket.recv().await {
        let AxumWsMsg::Text(text) = msg else { continue };
        let Ok(ev) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        state.received_events.lock().await.push(ev.clone());
        match ev.get("type").and_then(Value::as_str) {
            Some("session.update") => {
                let _ = socket
                    .send(AxumWsMsg::Text(
                        json!({ "type": "session.updated", "session": ev["session"] })
                            .to_string()
                            .into(),
                    ))
                    .await;
            }
            Some("response.create") => {
                let script = {
                    let mut guard = state.scripted_turns.lock().await;
                    if guard.is_empty() {
                        MockTurnScript {
                            text_deltas: vec!["Default reply.".to_string()],
                            audio_samples_24k: vec![1_000; 480],
                            tool_calls: Vec::new(),
                            pause_for_cancel: false,
                        }
                    } else {
                        guard.remove(0)
                    }
                };
                for delta in script.text_deltas {
                    let _ = socket
                        .send(AxumWsMsg::Text(
                            json!({ "type": "response.output_text.delta", "delta": delta })
                                .to_string()
                                .into(),
                        ))
                        .await;
                }
                if !script.audio_samples_24k.is_empty() {
                    let mut bytes = Vec::with_capacity(script.audio_samples_24k.len() * 2);
                    for sample in script.audio_samples_24k {
                        bytes.extend_from_slice(&sample.to_le_bytes());
                    }
                    let _ = socket
                        .send(AxumWsMsg::Text(
                            json!({
                                "type": "response.output_audio.delta",
                                "delta": BASE64_STANDARD.encode(&bytes),
                            })
                            .to_string()
                            .into(),
                        ))
                        .await;
                }
                if script.pause_for_cancel {
                    if let Some(Ok(AxumWsMsg::Text(cancel_raw))) = socket.recv().await {
                        if let Ok(cancel_ev) = serde_json::from_str::<Value>(&cancel_raw) {
                            state.received_events.lock().await.push(cancel_ev);
                        }
                    }
                    let _ = socket
                        .send(AxumWsMsg::Text(
                            json!({
                                "type": "response.done",
                                "response": { "status": "cancelled", "output": [] },
                            })
                            .to_string()
                            .into(),
                        ))
                        .await;
                    continue;
                }
                let _ = socket
                    .send(AxumWsMsg::Text(
                        json!({
                            "type": "response.done",
                            "response": { "status": "completed", "output": script.tool_calls },
                        })
                        .to_string()
                        .into(),
                    ))
                    .await;
            }
            _ => {}
        }
    }
}

#[test]
fn lfm3_helpers_match_models_derive_ws_url_upsample_encode_and_build_instructions() {
    let strategy = Lfm3AudioStrategy;
    assert_eq!(strategy.id(), "lfm3-audio-realtime");
    assert!(strategy.matches_model("LiquidAI/LFM3-Audio-2B-GGUF:Q8_0"));
    assert!(strategy.matches_model("LiquidAI/LFM3-Audio-2B-MLX-8bit"));
    assert!(!strategy.matches_model("gemma4:e4b"));
    assert!(!strategy.matches_model("gpt-oss:20b"));

    let http_url = Url::parse("http://127.0.0.1:8000/v1").unwrap();
    assert_eq!(
        derive_realtime_ws_url(&http_url).as_str(),
        "ws://127.0.0.1:8000/v1/realtime",
    );
    let https_url = Url::parse("https://localhost:8443/v1/").unwrap();
    assert_eq!(
        derive_realtime_ws_url(&https_url).as_str(),
        "wss://localhost:8443/v1/realtime",
    );

    assert_eq!(upsample_8k_to_16k(&[]), Vec::<i16>::new());
    assert_eq!(upsample_8k_to_16k(&[100, 300]), vec![100, 200, 300, 300]);

    let wav_16k = encode_wav_16k_mono(&[100, -100, 200, -200]);
    assert_eq!(&wav_16k[0..4], b"RIFF");
    assert_eq!(
        u32::from_le_bytes(wav_16k[24..28].try_into().unwrap()),
        16_000,
    );
    assert_eq!(wav_16k.len(), 44 + 8);

    let loud = [10_000_i16; RTP_FRAME_SAMPLES];
    let encoded = encode_lfm3_mulaw_frame(&loud);
    let decoded = decode_mulaw(encoded[0]);
    assert!((4_500..=5_500).contains(&decoded), "decoded={decoded}");

    let prompt_params = VoiceCallPromptParams {
        user_display_name: "David Parks".to_string(),
        callee_name: Some("User".to_string()),
        objective: "Open conversation".to_string(),
        first_message: Some("Hi! What's on your mind?".to_string()),
        context: None,
    };
    let default_specs = vec![SendDtmfTool.spec(), EndCallTool.spec()];
    let instructions = build_lfm3_instructions(
        &prompt_params,
        &["Keep it upbeat".to_string()],
        &default_specs,
    );
    assert!(
        instructions.starts_with("Respond with function calls, and interleaved text and audio."),
    );
    assert!(instructions.contains("Your own name is Lily"));
    assert!(instructions.contains("instead of over-simplifying"));
    assert!(instructions.contains("Call send_dtmf only for automated phone menus."));
    assert!(instructions.contains("Call end_call immediately when the other person says goodbye"));
    assert!(!instructions.contains("Use web_search ONLY"));
    assert!(instructions.contains("Private live instruction: Keep it upbeat"));

    // Custom/non-default tool registry only injects guidance for registered tools.
    let custom_specs = vec![RealtimeToolSpec {
        name: "lookup_calendar",
        description: "Check today's calendar events.",
        prompt_guidance: Some("Call lookup_calendar when asked about today's schedule."),
        parameters: json!({ "type": "object", "properties": {} }),
    }];
    let custom_instructions = build_lfm3_instructions(&prompt_params, &[], &custom_specs);
    assert!(custom_instructions.contains("Call lookup_calendar when asked about today's schedule."));
    assert!(!custom_instructions.contains("send_dtmf"));
    assert!(!custom_instructions.contains("web_search"));
    assert!(!custom_instructions.contains("end_call"));

    // Empty tool list omits the Tools section altogether.
    let no_tools_instructions = build_lfm3_instructions(&prompt_params, &[], &[]);
    assert!(!no_tools_instructions.contains("\nTools:"));
}

#[tokio::test]
async fn lfm3_realtime_session_streams_pcmu_handles_tools_cancel_and_chat_asr() {
    let state = Arc::new(MockRealtimeState::default());
    *state.scripted_turns.lock().await = vec![
        MockTurnScript {
            text_deltas: vec!["Hi! ".to_string(), "What's on your mind?".to_string()],
            audio_samples_24k: vec![2_000; 480],
            tool_calls: Vec::new(),
            pause_for_cancel: false,
        },
        MockTurnScript {
            text_deltas: Vec::new(),
            audio_samples_24k: Vec::new(),
            tool_calls: vec![json!({
                "type": "function_call",
                "name": "end_call",
                "call_id": "call_end_1",
                "arguments": r#"{"reason":"Recipient said goodbye"}"#,
            })],
            pause_for_cancel: false,
        },
        MockTurnScript {
            text_deltas: vec!["Bye, have a great day!".to_string()],
            audio_samples_24k: vec![2_000; 480],
            tool_calls: Vec::new(),
            pause_for_cancel: false,
        },
        MockTurnScript {
            text_deltas: vec!["Partial".to_string()],
            audio_samples_24k: vec![2_000; 480],
            tool_calls: Vec::new(),
            pause_for_cancel: true,
        },
    ];

    let base = spawn_mock_realtime_server(Arc::clone(&state)).await;
    let cancel = CancellationToken::new();
    let mut session = Lfm3RealtimeSession::connect(
        &base,
        "Respond with function calls, and interleaved text and audio.",
        json!([]),
        &cancel,
    )
    .await
    .unwrap();

    // Turn 1: audio turn streams 8 kHz PCMU frames and text.
    let mut received_frames = Vec::new();
    let out1 = session
        .run_audio_turn(&[100_i16; 160], &cancel, &mut |frame| {
            received_frames.push(frame);
        })
        .await
        .unwrap();
    assert_eq!(out1.spoken_text, "Hi! What's on your mind?");
    assert_eq!(out1.audio_frames_emitted, 1);
    assert_eq!(received_frames.len(), 1);
    assert!(out1.tool_calls.is_empty());

    // Turn 2: spoken hangup yields generic RawToolCall, then submit_tool_output yields goodbye.
    let out2 = session
        .run_audio_turn(&[200_i16; 160], &cancel, &mut |_| {})
        .await
        .unwrap();
    assert_eq!(
        out2.tool_calls,
        vec![RealtimeToolInvocation {
            call_id: "call_end_1".to_string(),
            name: "end_call".to_string(),
            arguments: json!({ "reason": "Recipient said goodbye" }),
        }],
    );
    let mut bye_frames = 0usize;
    let out3 = session
        .submit_tool_output("call_end_1", r#"{"ok":true}"#, true, &cancel, &mut |_| {
            bye_frames += 1;
        })
        .await
        .unwrap();
    assert_eq!(out3.spoken_text, "Bye, have a great day!");
    assert_eq!(bye_frames, 1);

    // Turn 4: cancellation sends response.cancel and drains cleanly.
    let barge_cancel = CancellationToken::new();
    let trigger = barge_cancel.clone();
    let out4 = session
        .run_audio_turn(&[300_i16; 160], &barge_cancel, &mut move |_| {
            trigger.cancel();
        })
        .await
        .unwrap();
    assert!(out4.cancelled);
    assert_eq!(out4.spoken_text, "Partial");

    // Same loopback server handles HTTP chat ASR.
    let http = crate::tls::http_client();
    let asr = transcribe_lfm3_chat_wav(
        &http,
        &base,
        "LiquidAI/LFM3-Audio-2B-GGUF:Q8_0",
        b"RIFF_FAKE_WAV",
        &cancel,
    )
    .await
    .unwrap();
    assert_eq!(asr.as_deref(), Some("Hello from LFM3 ASR."));

    let asr_reqs = state.asr_requests.lock().await;
    assert_eq!(asr_reqs.len(), 1);
    assert_eq!(asr_reqs[0]["max_tokens"], 64);
    assert_eq!(asr_reqs[0]["repeat_penalty"], 1.15);

    let events = state.received_events.lock().await;
    let update_count = events
        .iter()
        .filter(|ev| ev["type"] == "session.update")
        .count();
    assert_eq!(
        update_count, 1,
        "session.update must only be sent once before the first turn",
    );
    let first_clear = events
        .iter()
        .position(|ev| ev["type"] == "input_audio_buffer.clear")
        .expect("input_audio_buffer.clear sent");
    let first_append = events
        .iter()
        .position(|ev| ev["type"] == "input_audio_buffer.append")
        .expect("input_audio_buffer.append sent");
    assert!(first_clear < first_append);
    assert!(events.iter().any(|ev| ev["type"] == "response.cancel"));
    let tool_output = events
        .iter()
        .find(|ev| {
            ev["type"] == "conversation.item.create" && ev["item"]["type"] == "function_call_output"
        })
        .expect("function_call_output event sent");
    assert_eq!(tool_output["item"]["call_id"], "call_end_1");
    assert_eq!(tool_output["item"]["output"], r#"{"ok":true}"#);
}
