use super::end_call::EndCallTool;
use super::{
    DtmfTransmitter, RealtimeTool, RealtimeToolRegistry, ToolDispatch, ToolEffect,
    ToolExecutionContext, ToolOutcome,
};
use crate::phone_call::realtime::lfm3_strategy::Lfm3AudioStrategy;
use crate::phone_call::realtime::strategy::{RealtimeToolInvocation, RealtimeToolSpec};
use crate::phone_call::voice::{VoicePipelineClient, VoicePipelineConfig};
use serde_json::json;
use std::sync::{Arc, Mutex as StdMutex};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct RecordingDtmf {
    sent: StdMutex<Vec<String>>,
}

impl DtmfTransmitter for RecordingDtmf {
    fn transmit(&self, digits: &str) -> Result<(), String> {
        self.sent.lock().unwrap().push(digits.to_string());
        Ok(())
    }
}

struct CustomWeatherTool;

impl RealtimeTool for CustomWeatherTool {
    fn name(&self) -> &'static str {
        "get_weather"
    }

    fn spec(&self) -> RealtimeToolSpec {
        RealtimeToolSpec {
            name: self.name(),
            description: "Return local weather.",
            parameters: json!({ "type": "object", "properties": {} }),
        }
    }

    fn dispatch(
        self: Arc<Self>,
        invocation: RealtimeToolInvocation,
        _ctx: &ToolExecutionContext<'_>,
    ) -> ToolDispatch {
        ToolDispatch::Immediate(ToolOutcome {
            call_id: invocation.call_id,
            output: "Sunny and 72 degrees.".to_string(),
            request_spoken_reply: true,
            effect: ToolEffect::None,
        })
    }
}

#[tokio::test]
async fn tool_registry_exposes_default_phone_tools_and_supports_custom_tools() {
    let cancel = CancellationToken::new();
    let voice = VoicePipelineClient::new(VoicePipelineConfig::default()).unwrap();
    let mut registry = RealtimeToolRegistry::with_default_phone_tools(
        Arc::new(Lfm3AudioStrategy),
        voice,
        cancel.clone(),
    );
    let names: Vec<&str> = registry.specs().iter().map(|spec| spec.name).collect();
    assert_eq!(names, vec!["send_dtmf", "web_search", "end_call"]);

    // Register a new tool without changing the registry or harness implementation.
    registry.register(Arc::new(CustomWeatherTool));
    assert_eq!(registry.specs().len(), 4);

    let dtmf = RecordingDtmf::default();
    let http = crate::tls::http_client();
    let ctx = ToolExecutionContext {
        http: &http,
        dtmf: &dtmf,
        callee_has_spoken: false,
        assistant_spoke_in_turn: false,
        call_cancel: &cancel,
    };

    // SendDtmfTool normalizes digits, invokes DtmfTransmitter, and requests IVR mode.
    let dtmf_dispatch = registry.dispatch(
        RealtimeToolInvocation {
            call_id: "c_dtmf".to_string(),
            name: "send_dtmf".to_string(),
            arguments: json!({ "digits": " 1-2# " }),
        },
        &ctx,
    );
    assert!(matches!(
        dtmf_dispatch,
        ToolDispatch::Immediate(ToolOutcome {
            effect: ToolEffect::SetIvrMode(true),
            request_spoken_reply: false,
            ..
        })
    ));
    assert_eq!(dtmf.sent.lock().unwrap().as_slice(), &["12#"]);

    // Custom tool dispatches generically.
    let weather_dispatch = registry.dispatch(
        RealtimeToolInvocation {
            call_id: "c_weather".to_string(),
            name: "get_weather".to_string(),
            arguments: json!({}),
        },
        &ctx,
    );
    match weather_dispatch {
        ToolDispatch::Immediate(outcome) => {
            assert_eq!(outcome.output, "Sunny and 72 degrees.");
            assert!(outcome.request_spoken_reply);
            assert_eq!(outcome.effect, ToolEffect::None);
        }
        ToolDispatch::Async { .. } => panic!("expected immediate outcome"),
    }

    // EndCallTool rejects ending before the callee has spoken.
    let early_end = Arc::new(EndCallTool).dispatch(
        RealtimeToolInvocation {
            call_id: "c_end_early".to_string(),
            name: "end_call".to_string(),
            arguments: json!({ "reason": "Premature" }),
        },
        &ctx,
    );
    match early_end {
        ToolDispatch::Immediate(outcome) => {
            assert_eq!(outcome.effect, ToolEffect::None);
            assert!(!outcome.request_spoken_reply);
        }
        ToolDispatch::Async { .. } => panic!("expected immediate outcome"),
    }

    // EndCallTool schedules call end and requests spoken goodbye once callee has spoken.
    let spoken_ctx = ToolExecutionContext {
        callee_has_spoken: true,
        ..ctx
    };
    let valid_end = Arc::new(EndCallTool).dispatch(
        RealtimeToolInvocation {
            call_id: "c_end_ok".to_string(),
            name: "end_call".to_string(),
            arguments: json!({ "reason": "User said goodbye" }),
        },
        &spoken_ctx,
    );
    match valid_end {
        ToolDispatch::Immediate(outcome) => {
            assert!(outcome.request_spoken_reply);
            assert_eq!(
                outcome.effect,
                ToolEffect::ScheduleCallEnd {
                    reason: "User said goodbye".to_string(),
                    summary: "User said goodbye".to_string(),
                },
            );
        }
        ToolDispatch::Async { .. } => panic!("expected immediate outcome"),
    }

    // Unknown tool fails gracefully without panicking.
    let unknown = registry.dispatch(
        RealtimeToolInvocation {
            call_id: "c_unknown".to_string(),
            name: "nonexistent".to_string(),
            arguments: json!({}),
        },
        &spoken_ctx,
    );
    assert!(matches!(
        unknown,
        ToolDispatch::Immediate(ToolOutcome {
            request_spoken_reply: false,
            effect: ToolEffect::None,
            ..
        })
    ));
}
