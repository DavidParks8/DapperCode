#![forbid(unsafe_code)]

use super::{RealtimeTool, ToolDispatch, ToolEffect, ToolExecutionContext, ToolOutcome};
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
        ctx: &ToolExecutionContext<'_>,
    ) -> ToolDispatch {
        if !ctx.callee_has_spoken {
            return ToolDispatch::Immediate(ToolOutcome {
                call_id: invocation.call_id,
                output:
                    "Cannot end the call before the recipient has spoken. Wait for their reply."
                        .to_string(),
                request_spoken_reply: false,
                effect: ToolEffect::None,
            });
        }
        let reason = trimmed_field(&invocation.arguments, "reason").unwrap_or("Call completed");
        let summary = trimmed_field(&invocation.arguments, "outcome_summary").unwrap_or(reason);
        ToolDispatch::Immediate(ToolOutcome {
            call_id: invocation.call_id,
            output: r#"{"ok":true}"#.to_string(),
            request_spoken_reply: !ctx.assistant_spoke_in_turn,
            effect: ToolEffect::ScheduleCallEnd {
                reason: reason.to_string(),
                summary: summary.to_string(),
            },
        })
    }
}

fn trimmed_field<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
}
