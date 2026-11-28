#![forbid(unsafe_code)]

use super::{RealtimeTool, ToolDispatch, ToolExecutionContext, ToolOutcome};
use crate::phone_call::realtime::strategy::{RealtimeToolInvocation, RealtimeToolSpec};
use serde_json::{json, Value};
use std::sync::Arc;

pub struct EndCallTool;

impl RealtimeTool for EndCallTool {
    fn name(&self) -> &'static str {
        "end_call"
    }

    fn spec(&self) -> RealtimeToolSpec {
        RealtimeToolSpec {
            name: self.name(),
            description: "End the phone call ONLY when the recipient explicitly asks to stop or hang up, refuses to continue, reports a wrong number/emergency, or says goodbye after the call is resolved.",
            prompt_guidance: Some("Call end_call immediately when the other person says goodbye, bye, asks to hang up or stop, refuses to talk, says it is a wrong number, or reports an emergency."),
            parameters: json!({
                "type": "object",
                "properties": {
                    "reason": {
                        "type": "string",
                        "description": "Short reason for ending the call."
                    },
                    "outcome_summary": {
                        "type": "string",
                        "description": "Brief summary of what happened on the call."
                    }
                },
                "required": ["reason"]
            }),
        }
    }

    fn dispatch(
        self: Arc<Self>,
        invocation: RealtimeToolInvocation,
        ctx: &mut ToolExecutionContext<'_>,
    ) -> ToolDispatch {
        if !ctx.host.callee_has_spoken() {
            return ToolDispatch::Immediate(ToolOutcome {
                call_id: invocation.call_id,
                output:
                    "Cannot end the call before the recipient has spoken. Wait for their reply."
                        .to_string(),
                request_spoken_reply: false,
            });
        }
        let reason = trimmed_field(&invocation.arguments, "reason").unwrap_or("Call completed");
        let summary = trimmed_field(&invocation.arguments, "outcome_summary").unwrap_or(reason);
        ctx.host
            .schedule_call_end(reason.to_string(), summary.to_string());
        ToolDispatch::Immediate(ToolOutcome {
            call_id: invocation.call_id,
            output: r#"{"ok":true}"#.to_string(),
            request_spoken_reply: !ctx.host.assistant_spoke_in_turn(),
        })
    }
}

fn trimmed_field<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
}
