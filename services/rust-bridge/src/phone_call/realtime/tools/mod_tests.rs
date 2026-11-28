use super::end_call::EndCallTool;
use super::{
    RealtimeTool, RealtimeToolRegistry, ToolDispatch, ToolExecutionContext, ToolHost, ToolOutcome,
};
use crate::phone_call::realtime::lfm3_strategy::Lfm3AudioStrategy;
use crate::phone_call::realtime::strategy::{RealtimeToolInvocation, RealtimeToolSpec};
use crate::phone_call::voice::{VoicePipelineClient, VoicePipelineConfig};
use serde_json::json;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct RecordingHost {
    callee_has_spoken: bool,
    assistant_spoke_in_turn: bool,
    dtmf_sent: Vec<String>,
    ivr_mode: Option<bool>,
    scheduled_end: Option<(String, String)>,
    fatal_error: Option<String>,
}

impl ToolHost for RecordingHost {
    fn callee_has_spoken(&self) -> bool {
        self.callee_has_spoken
    }

    fn assistant_spoke_in_turn(&self) -> bool {
        self.assistant_spoke_in_turn
    }

    fn transmit_dtmf(&mut self, digits: &str) -> Result<(), String> {
        self.dtmf_sent.push(digits.to_string());
        Ok(())
    }

    fn set_ivr_mode(&mut self, enabled: bool) {
        self.ivr_mode = Some(enabled);
    }

    fn schedule_call_end(&mut self, reason: String, summary: String) {
        self.scheduled_end = Some((reason, summary));
    }

    fn fail_call(&mut self, error: String) {
        self.fatal_error = Some(error);
    }
}

struct CustomIvrEscapeTool;

impl RealtimeTool for CustomIvrEscapeTool {
    fn name(&self) -> &'static str {
        "escape_ivr"
    }

    fn spec(&self) -> RealtimeToolSpec {
        RealtimeToolSpec {
            name: self.name(),
            description: "Dial 0 and exit IVR mode.",
            prompt_guidance: Some("Call escape_ivr to reach a live operator."),
            parameters: json!({ "type": "object", "properties": {} }),
        }
    }

    fn dispatch(
        self: Arc<Self>,
        invocation: RealtimeToolInvocation,
        ctx: &mut ToolExecutionContext<'_>,
    ) -> ToolDispatch {
        let _ = ctx.host.transmit_dtmf("0");
        ctx.host.set_ivr_mode(false);
        ToolDispatch::Immediate(ToolOutcome {
            call_id: invocation.call_id,
            output: r#"{"escaped":true}"#.to_string(),
            request_spoken_reply: false,
        })
    }
}

#[tokio::test]
async fn tool_registry_exposes_default_phone_tools_and_supports_extensible_host_tools() {
    let cancel = CancellationToken::new();
    let voice = VoicePipelineClient::new(VoicePipelineConfig::default()).unwrap();
    let mut registry = RealtimeToolRegistry::with_default_phone_tools(
        Arc::new(Lfm3AudioStrategy),
        voice,
        cancel.clone(),
    );
    let names: Vec<&str> = registry.specs().iter().map(|spec| spec.name).collect();
    assert_eq!(names, vec!["send_dtmf", "web_search", "end_call"]);

    // Register a new tool using ToolHost capabilities without changing the registry or tool loop.
    registry.register(Arc::new(CustomIvrEscapeTool));
    assert_eq!(registry.specs().len(), 4);

    let http = crate::tls::http_client();
    let mut host = RecordingHost::default();
    let mut ctx = ToolExecutionContext {
        http: &http,
        host: &mut host,
        call_cancel: &cancel,
    };

    // SendDtmfTool normalizes digits, invokes ToolHost::transmit_dtmf, and enables IVR mode.
    let dtmf_dispatch = registry.dispatch(
        RealtimeToolInvocation {
            call_id: "c_dtmf".to_string(),
            name: "send_dtmf".to_string(),
            arguments: json!({ "digits": " 1-2# " }),
        },
        &mut ctx,
    );
    assert!(matches!(
        dtmf_dispatch,
        ToolDispatch::Immediate(ToolOutcome {
            request_spoken_reply: false,
            ..
        })
    ));

    // Invalid DTMF digits resume the model instead of going silent.
    let bad_dtmf = registry.dispatch(
        RealtimeToolInvocation {
            call_id: "c_bad_dtmf".to_string(),
            name: "send_dtmf".to_string(),
            arguments: json!({ "digits": "xyz" }),
        },
        &mut ctx,
    );
    assert!(matches!(
        bad_dtmf,
        ToolDispatch::Immediate(ToolOutcome {
            request_spoken_reply: true,
            ..
        })
    ));

    // Custom tool mutates host state directly via ToolHost without touching tool_loop.
    let escape_dispatch = registry.dispatch(
        RealtimeToolInvocation {
            call_id: "c_escape".to_string(),
            name: "escape_ivr".to_string(),
            arguments: json!({}),
        },
        &mut ctx,
    );
    assert!(matches!(
        escape_dispatch,
        ToolDispatch::Immediate(ToolOutcome {
            ref output,
            request_spoken_reply: false,
            ..
        }) if output == r#"{"escaped":true}"#
    ));

    // EndCallTool rejects ending before the callee has spoken.
    let early_end = Arc::new(EndCallTool).dispatch(
        RealtimeToolInvocation {
            call_id: "c_end_early".to_string(),
            name: "end_call".to_string(),
            arguments: json!({ "reason": "Premature" }),
        },
        &mut ctx,
    );
    assert!(matches!(
        early_end,
        ToolDispatch::Immediate(ToolOutcome {
            request_spoken_reply: false,
            ..
        })
    ));
    assert_eq!(host.dtmf_sent, vec!["12#", "0"]);
    assert_eq!(host.ivr_mode, Some(false));
    assert_eq!(host.scheduled_end, None);

    // EndCallTool schedules call end and requests spoken goodbye once callee has spoken.
    host.callee_has_spoken = true;
    let mut spoken_ctx = ToolExecutionContext {
        http: &http,
        host: &mut host,
        call_cancel: &cancel,
    };
    let valid_end = Arc::new(EndCallTool).dispatch(
        RealtimeToolInvocation {
            call_id: "c_end_ok".to_string(),
            name: "end_call".to_string(),
            arguments: json!({ "reason": "User said goodbye" }),
        },
        &mut spoken_ctx,
    );
    assert!(matches!(
        valid_end,
        ToolDispatch::Immediate(ToolOutcome {
            request_spoken_reply: true,
            ..
        })
    ));

    // Unknown tool returns a recoverable error and resumes the model with request_spoken_reply.
    let unknown = registry.dispatch(
        RealtimeToolInvocation {
            call_id: "c_unknown".to_string(),
            name: "nonexistent".to_string(),
            arguments: json!({}),
        },
        &mut spoken_ctx,
    );
    assert!(matches!(
        unknown,
        ToolDispatch::Immediate(ToolOutcome {
            request_spoken_reply: true,
            ref output,
            ..
        }) if output.contains("unknown_tool")
    ));
    assert_eq!(
        host.scheduled_end,
        Some((
            "User said goodbye".to_string(),
            "User said goodbye".to_string(),
        )),
    );
}
