#![forbid(unsafe_code)]

use super::{RealtimeTool, ToolDispatch, ToolExecutionContext, ToolOutcome};
use crate::phone_call::realtime::strategy::{RealtimeToolInvocation, RealtimeToolSpec};
use serde_json::{json, Value};
use std::sync::Arc;

pub struct SendDtmfTool;

impl RealtimeTool for SendDtmfTool {
    fn name(&self) -> &'static str {
        "send_dtmf"
    }

    fn spec(&self) -> RealtimeToolSpec {
        RealtimeToolSpec {
            name: self.name(),
            description: "Press keypad digits ONLY when an automated IVR phone menu asks you to press a number.",
            prompt_guidance: Some("Call send_dtmf only for automated phone menus."),
            parameters: json!({
                "type": "object",
                "properties": {
                    "digits": {
                        "type": "string",
                        "description": "Literal keypad symbols such as 1, 2, *, or #."
                    }
                },
                "required": ["digits"]
            }),
        }
    }

    fn dispatch(
        self: Arc<Self>,
        invocation: RealtimeToolInvocation,
        ctx: &mut ToolExecutionContext<'_>,
    ) -> ToolDispatch {
        let normalized = normalize_dtmf_digits(&invocation.arguments);
        if normalized.is_empty() {
            return ToolDispatch::Immediate(ToolOutcome {
                call_id: invocation.call_id,
                output: r#"{"ok":false,"reason":"no valid DTMF digits"}"#.to_string(),
                request_spoken_reply: true,
            });
        }
        match ctx.host.transmit_dtmf(&normalized) {
            Ok(()) => {
                ctx.host.set_ivr_mode(true);
                ToolDispatch::Immediate(ToolOutcome {
                    call_id: invocation.call_id,
                    output: format!("Sent DTMF digits: {normalized}"),
                    request_spoken_reply: false,
                })
            }
            Err(err) => {
                ctx.host.fail_call(err.clone());
                ToolDispatch::Immediate(ToolOutcome {
                    call_id: invocation.call_id,
                    output: format!("Failed to send DTMF: {err}"),
                    request_spoken_reply: false,
                })
            }
        }
    }
}

fn normalize_dtmf_digits(args: &Value) -> String {
    args.get("digits")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .filter(|ch| *ch != '-')
        .map(|ch| ch.to_ascii_uppercase())
        .filter(|ch| matches!(ch, '0'..='9' | '*' | '#' | 'A'..='D'))
        .collect()
}
