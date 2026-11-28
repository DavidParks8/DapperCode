use super::{
    build_realtime_instructions, build_realtime_tools, derive_realtime_ws_url, encode_wav_16k_mono,
    is_realtime_s2s_model, transcribe_lfm3_chat_wav, upsample_8k_to_16k, RealtimeSession,
};
use crate::phone_call::audio::{decode_mulaw, RTP_FRAME_SAMPLES};
use crate::phone_call::realtime_loop::{
    encode_realtime_mulaw_frame, is_mutual_farewell, should_precheck_utterance,
};
use crate::phone_call::voice::{VoiceCallPromptParams, VoiceToolCall};
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
    audio_samples: Vec<i16>,
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
                            audio_samples: vec![1_000, -1_000, 1_000, -1_000],
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
                if !script.audio_samples.is_empty() {
                    let mut bytes = Vec::with_capacity(script.audio_samples.len() * 2);
                    for sample in script.audio_samples {
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
fn realtime_helpers_detect_lfm3_derive_ws_url_upsample_and_forbid_robotic_phrases() {
    assert!(is_realtime_s2s_model("LiquidAI/LFM3-Audio-2B-GGUF:Q8_0"));
    assert!(is_realtime_s2s_model("LiquidAI/LFM3-Audio-2B-MLX-8bit"));
    assert!(!is_realtime_s2s_model("gemma4:e4b"));
    assert!(!is_realtime_s2s_model("gpt-oss:20b"));

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

    let instructions = build_realtime_instructions(
        &VoiceCallPromptParams {
            user_display_name: "David Parks".to_string(),
            callee_name: Some("User".to_string()),
            objective: "Open conversation".to_string(),
            first_message: Some("Hi! What's on your mind?".to_string()),
            context: None,
        },
        &["Keep it upbeat".to_string()],
    );
    assert!(
        instructions.starts_with("Respond with function calls, and interleaved text and audio."),
    );
    assert!(instructions.contains("Your own name is Lily"));
    assert!(instructions.contains("instead of over-simplifying"));
    assert!(instructions.contains("Use web_search ONLY for specific external facts"));
    assert!(instructions.contains("rather than ending every turn with a question"));
    assert!(instructions.contains("Always share your own fun personal take, opinion"));
    assert!(instructions.contains("Call end_call immediately when the other person says goodbye"));
    assert!(instructions.contains("Private live instruction: Keep it upbeat"));

    assert!(is_mutual_farewell(
        Some("Goodbye."),
        "Goodbye! Have a great day!",
    ));
    assert!(is_mutual_farewell(
        Some("Okay, bye!"),
        "Take care, talk to you later!",
    ));
    assert!(!is_mutual_farewell(
        Some("Bye, daddy!"),
        "Goodbye! Have a great day!",
    ));
    assert!(!is_mutual_farewell(
        Some("Can you play Goodbye Yellow Brick Road for me please?"),
        "Sure, I can talk about that song!",
    ));
    assert!(!is_mutual_farewell(
        Some("How is white chocolate made?"),
        "Have a great day!",
    ));

    let wav_16k = encode_wav_16k_mono(&[100, -100, 200, -200]);
    assert_eq!(&wav_16k[0..4], b"RIFF");
    assert_eq!(
        u32::from_le_bytes(wav_16k[24..28].try_into().unwrap()),
        16_000,
    );
    assert_eq!(wav_16k.len(), 44 + 8);

    let no_end = build_realtime_tools(false);
    let no_end_arr = no_end.as_array().unwrap();
    assert_eq!(no_end_arr.len(), 2);
    assert_eq!(no_end_arr[0]["name"], "send_dtmf");
    assert_eq!(no_end_arr[1]["name"], "web_search");

    let with_end = build_realtime_tools(true);
    let with_end_arr = with_end.as_array().unwrap();
    assert_eq!(with_end_arr.len(), 3);
    assert!(with_end_arr.iter().any(|tool| tool["name"] == "web_search"));
    assert!(with_end_arr.iter().all(|tool| tool["name"] != "hold_call"));

    // Mid-length utterances captured near assistant audio are pre-checked for self-echo,
    // short clips are pre-checked for incomplete-thought deferral, and long (>= 5s) utterances
    // or non-echo >= 1.5s clips go straight to LFM3 for low latency.
    assert!(should_precheck_utterance(24_000, true));
    assert!(!should_precheck_utterance(48_000, true));
    assert!(should_precheck_utterance(4_000, false));
    assert!(!should_precheck_utterance(24_000, false));

    // LFM3 realtime mu-law encoding applies -6 dB headroom (~0.5x).
    let loud = [10_000_i16; RTP_FRAME_SAMPLES];
    let encoded = encode_realtime_mulaw_frame(&loud);
    let decoded = decode_mulaw(encoded[0]);
    assert!((4_500..=5_500).contains(&decoded), "decoded={decoded}");
}

#[tokio::test]
async fn realtime_session_streams_audio_handles_tools_barge_in_cancel_and_chat_asr() {
    let state = Arc::new(MockRealtimeState::default());
    *state.scripted_turns.lock().await = vec![
        MockTurnScript {
            text_deltas: vec!["Hi! ".to_string(), "What's on your mind?".to_string()],
            audio_samples: vec![500, -500, 800, -800],
            tool_calls: Vec::new(),
            pause_for_cancel: false,
        },
        MockTurnScript {
            text_deltas: Vec::new(),
            audio_samples: Vec::new(),
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
            audio_samples: vec![600, -600],
            tool_calls: Vec::new(),
            pause_for_cancel: false,
        },
        MockTurnScript {
            text_deltas: vec!["Partial ".to_string()],
            audio_samples: vec![400, -400],
            tool_calls: Vec::new(),
            pause_for_cancel: true,
        },
    ];
    let base = spawn_mock_realtime_server(Arc::clone(&state)).await;
    let cancel = CancellationToken::new();

    let mut session = RealtimeSession::connect(
        &base,
        "Respond with interleaved text and audio.",
        build_realtime_tools(true),
        &cancel,
    )
    .await
    .unwrap();

    // Turn 1: audio turn streams PCM24k and text.
    let mut received_pcm = Vec::new();
    let out1 = session
        .run_audio_turn(&[100_i16; 320], &cancel, |chunk| {
            received_pcm.extend_from_slice(chunk);
        })
        .await
        .unwrap();
    assert_eq!(out1.spoken_text, "Hi! What's on your mind?");
    assert_eq!(received_pcm, vec![500, -500, 800, -800]);
    assert!(out1.tool_calls.is_empty());

    // Turn 2: spoken hangup triggers end_call tool, then submit_tool_output yields spoken goodbye.
    let out2 = session
        .run_audio_turn(&[200_i16; 320], &cancel, |_| {})
        .await
        .unwrap();
    assert_eq!(
        out2.tool_calls,
        vec![VoiceToolCall::EndCall {
            call_id: "call_end_1".to_string(),
            reason: "Recipient said goodbye".to_string(),
            outcome_summary: "Recipient said goodbye".to_string(),
        }],
    );
    let mut bye_pcm = Vec::new();
    let out3 = session
        .submit_tool_output(
            "call_end_1",
            "Say a brief goodbye.",
            true,
            &cancel,
            |chunk| bye_pcm.extend_from_slice(chunk),
        )
        .await
        .unwrap();
    assert_eq!(out3.spoken_text, "Bye, have a great day!");
    assert_eq!(bye_pcm, vec![600, -600]);

    // Turn 4: cancellation sends response.cancel and drains cleanly.
    let barge_cancel = CancellationToken::new();
    let trigger = barge_cancel.clone();
    let out4 = session
        .run_audio_turn(&[300_i16; 320], &barge_cancel, move |_| {
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
    assert!(events
        .iter()
        .any(|ev| ev["type"] == "conversation.item.create"
            && ev["item"]["type"] == "function_call_output"));
}
