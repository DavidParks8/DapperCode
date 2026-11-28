use super::{dispatch_tool_batch, poll_pending_tools, submit_tool_outputs_batch};
use crate::phone_call::realtime::state::{RealtimeTurnRequest, ToolOutputSubmission};
use crate::phone_call::realtime::strategy::{
    BoxFuture, OnPcmuFrame, RealtimeModelSession, RealtimeToolInvocation, RealtimeToolSpec,
    RealtimeTurnOutput,
};
use crate::phone_call::realtime::tools::{
    spawn_async_tool, RealtimeTool, RealtimeToolRegistry, ToolDispatch, ToolExecutionContext,
    ToolHost, ToolOutcome,
};
use crate::phone_call::voice::VoiceError;
use serde_json::json;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct DummyHost;

impl ToolHost for DummyHost {
    fn callee_has_spoken(&self) -> bool {
        true
    }
    fn assistant_spoke_in_turn(&self) -> bool {
        false
    }
    fn transmit_dtmf(&mut self, _digits: &str) -> Result<(), String> {
        Ok(())
    }
    fn set_ivr_mode(&mut self, _enabled: bool) {}
    fn schedule_call_end(&mut self, _reason: String, _summary: String) {}
    fn fail_call(&mut self, _error: String) {}
}

struct EchoImmediateTool;

impl RealtimeTool for EchoImmediateTool {
    fn name(&self) -> &'static str {
        "echo_now"
    }

    fn spec(&self) -> RealtimeToolSpec {
        RealtimeToolSpec {
            name: self.name(),
            description: "Echo immediately.",
            prompt_guidance: None,
            parameters: json!({ "type": "object", "properties": {} }),
        }
    }

    fn dispatch(
        self: Arc<Self>,
        invocation: RealtimeToolInvocation,
        _ctx: &mut ToolExecutionContext<'_>,
    ) -> ToolDispatch {
        let value = invocation
            .arguments
            .get("v")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string();
        let speak = invocation
            .arguments
            .get("speak")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        ToolDispatch::Immediate(ToolOutcome {
            call_id: invocation.call_id,
            output: format!("echo:{value}"),
            request_spoken_reply: speak,
        })
    }
}

struct DelayedAsyncTool {
    cancelled_tokens: Arc<StdMutex<Vec<CancellationToken>>>,
}

impl RealtimeTool for DelayedAsyncTool {
    fn name(&self) -> &'static str {
        "slow_lookup"
    }

    fn spec(&self) -> RealtimeToolSpec {
        RealtimeToolSpec {
            name: self.name(),
            description: "Delayed async lookup.",
            prompt_guidance: None,
            parameters: json!({ "type": "object", "properties": {} }),
        }
    }

    fn dispatch(
        self: Arc<Self>,
        invocation: RealtimeToolInvocation,
        ctx: &mut ToolExecutionContext<'_>,
    ) -> ToolDispatch {
        let delay_ms = invocation
            .arguments
            .get("delay_ms")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(10);
        let value = invocation
            .arguments
            .get("v")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string();
        let call_id = invocation.call_id.clone();
        let tokens = Arc::clone(&self.cancelled_tokens);
        let task = spawn_async_tool(invocation.call_id, ctx.call_cancel, move |cancel| {
            tokens.lock().unwrap().push(cancel.clone());
            Box::pin(async move {
                tokio::select! {
                    () = cancel.cancelled() => ToolOutcome {
                        call_id,
                        output: r#"{"cancelled":true}"#.to_string(),
                        request_spoken_reply: false,
                    },
                    () = tokio::time::sleep(Duration::from_millis(delay_ms)) => ToolOutcome {
                        call_id,
                        output: format!("async:{value}"),
                        request_spoken_reply: true,
                    },
                }
            })
        });
        ToolDispatch::Async { task, filler: None }
    }
}

#[derive(Default)]
struct RecordingSession {
    submitted: Vec<(String, String, bool)>,
}

impl RealtimeModelSession for RecordingSession {
    fn run_audio_turn<'a>(
        &'a mut self,
        _pcm_8k: &'a [i16],
        _cancel: &'a CancellationToken,
        _on_pcmu_frame: OnPcmuFrame<'a>,
    ) -> BoxFuture<'a, Result<RealtimeTurnOutput, VoiceError>> {
        Box::pin(async {
            Ok(RealtimeTurnOutput {
                spoken_text: String::new(),
                tool_calls: Vec::new(),
                audio_frames_emitted: 0,
                cancelled: false,
            })
        })
    }

    fn run_text_turn<'a>(
        &'a mut self,
        _user_text: &'a str,
        _force_audio: bool,
        _cancel: &'a CancellationToken,
        _on_pcmu_frame: OnPcmuFrame<'a>,
    ) -> BoxFuture<'a, Result<RealtimeTurnOutput, VoiceError>> {
        Box::pin(async {
            Ok(RealtimeTurnOutput {
                spoken_text: String::new(),
                tool_calls: Vec::new(),
                audio_frames_emitted: 0,
                cancelled: false,
            })
        })
    }

    fn submit_tool_output<'a>(
        &'a mut self,
        call_id: &'a str,
        output: &'a str,
        request_spoken_reply: bool,
        _cancel: &'a CancellationToken,
        _on_pcmu_frame: OnPcmuFrame<'a>,
    ) -> BoxFuture<'a, Result<RealtimeTurnOutput, VoiceError>> {
        self.submitted.push((
            call_id.to_string(),
            output.to_string(),
            request_spoken_reply,
        ));
        Box::pin(async move {
            Ok(RealtimeTurnOutput {
                spoken_text: if request_spoken_reply {
                    "Combined reply.".to_string()
                } else {
                    String::new()
                },
                tool_calls: Vec::new(),
                audio_frames_emitted: 0,
                cancelled: false,
            })
        })
    }
}

#[tokio::test]
async fn multi_tool_batch_preserves_immediate_async_and_unknown_outputs_before_replying() {
    let cancel = CancellationToken::new();
    let http = crate::tls::http_client();
    let tokens = Arc::new(StdMutex::new(Vec::new()));
    let mut registry = RealtimeToolRegistry::default();
    registry.register(Arc::new(EchoImmediateTool));
    registry.register(Arc::new(DelayedAsyncTool {
        cancelled_tokens: Arc::clone(&tokens),
    }));

    // 1. Multiple immediate calls + unknown tool in a single turn all produce outputs and resume.
    let mut host = DummyHost;
    let imm = dispatch_tool_batch(
        &registry,
        vec![
            RealtimeToolInvocation {
                call_id: "c1".to_string(),
                name: "echo_now".to_string(),
                arguments: json!({ "v": "one", "speak": false }),
            },
            RealtimeToolInvocation {
                call_id: "c2".to_string(),
                name: "missing_tool".to_string(),
                arguments: json!({}),
            },
        ],
        &http,
        &mut host,
        &cancel,
    );
    assert!(imm.batch.is_empty());
    let Some(RealtimeTurnRequest::ToolOutputs {
        outputs,
        request_spoken_reply,
    }) = imm.batch.into_turn_request()
    else {
        panic!("expected ToolOutputs request");
    };
    assert!(request_spoken_reply);
    assert_eq!(outputs.len(), 2);
    let mut session = RecordingSession::default();
    let mut ignore = |_| {};
    let out = submit_tool_outputs_batch(
        &mut session,
        &outputs,
        request_spoken_reply,
        &cancel,
        &mut ignore,
    )
    .await
    .unwrap();
    assert_eq!(out.spoken_text, "Combined reply.");
    assert_eq!(session.submitted.len(), 2);
    assert_eq!(
        session.submitted[0],
        ("c1".to_string(), "echo:one".to_string(), false),
    );
    assert_eq!(session.submitted[1].0, "c2");
    assert!(session.submitted[1].1.contains("unknown_tool"));
    assert!(session.submitted[1].2);

    // 2. Mixed immediate + two concurrent async tools all complete before triggering one reply.
    let mixed = dispatch_tool_batch(
        &registry,
        vec![
            RealtimeToolInvocation {
                call_id: "m_imm".to_string(),
                name: "echo_now".to_string(),
                arguments: json!({ "v": "fast", "speak": false }),
            },
            RealtimeToolInvocation {
                call_id: "m_slow_a".to_string(),
                name: "slow_lookup".to_string(),
                arguments: json!({ "v": "alpha", "delay_ms": 25 }),
            },
            RealtimeToolInvocation {
                call_id: "m_slow_b".to_string(),
                name: "slow_lookup".to_string(),
                arguments: json!({ "v": "beta", "delay_ms": 5 }),
            },
        ],
        &http,
        &mut host,
        &cancel,
    );
    let mut slot = Some(mixed.batch);
    while slot.as_ref().is_some_and(|batch| !batch.is_empty()) {
        let (idx, res) = poll_pending_tools(&mut slot).await;
        slot.as_mut().unwrap().record_completed(idx, res);
    }
    let Some(RealtimeTurnRequest::ToolOutputs {
        outputs: mixed_outputs,
        request_spoken_reply: mixed_reply,
    }) = slot.take().unwrap().into_turn_request()
    else {
        panic!("expected combined ToolOutputs request");
    };
    assert!(mixed_reply);
    assert_eq!(mixed_outputs.len(), 3);
    assert!(mixed_outputs.contains(&ToolOutputSubmission {
        call_id: "m_imm".to_string(),
        output: "echo:fast".to_string(),
    }));
    assert!(mixed_outputs.contains(&ToolOutputSubmission {
        call_id: "m_slow_a".to_string(),
        output: "async:alpha".to_string(),
    }));
    assert!(mixed_outputs.contains(&ToolOutputSubmission {
        call_id: "m_slow_b".to_string(),
        output: "async:beta".to_string(),
    }));

    // 3. Cancelling a batch with multiple in-flight async tasks cancels every task without orphans.
    tokens.lock().unwrap().clear();
    let to_cancel = dispatch_tool_batch(
        &registry,
        vec![
            RealtimeToolInvocation {
                call_id: "x_done".to_string(),
                name: "echo_now".to_string(),
                arguments: json!({ "v": "kept" }),
            },
            RealtimeToolInvocation {
                call_id: "x_async_1".to_string(),
                name: "slow_lookup".to_string(),
                arguments: json!({ "v": "never1", "delay_ms": 5_000 }),
            },
            RealtimeToolInvocation {
                call_id: "x_async_2".to_string(),
                name: "slow_lookup".to_string(),
                arguments: json!({ "v": "never2", "delay_ms": 5_000 }),
            },
        ],
        &http,
        &mut host,
        &cancel,
    );
    let cancelled_outputs = to_cancel.batch.cancel_all();
    assert_eq!(
        cancelled_outputs,
        vec![
            ToolOutputSubmission {
                call_id: "x_done".to_string(),
                output: "echo:kept".to_string(),
            },
            ToolOutputSubmission {
                call_id: "x_async_1".to_string(),
                output: r#"{"cancelled":true}"#.to_string(),
            },
            ToolOutputSubmission {
                call_id: "x_async_2".to_string(),
                output: r#"{"cancelled":true}"#.to_string(),
            },
        ],
    );
    let captured_tokens = tokens.lock().unwrap();
    assert_eq!(captured_tokens.len(), 2);
    assert!(captured_tokens.iter().all(CancellationToken::is_cancelled));
}
