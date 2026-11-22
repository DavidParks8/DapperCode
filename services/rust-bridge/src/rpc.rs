use serde_json::Value;

#[derive(Debug)]
pub(crate) enum RpcRequestParseError {
    InvalidJson(String),
    InvalidPayload,
    MissingMethod {
        id: Value,
    },
    Notification {
        method: String,
        params: Option<Value>,
    },
}

#[derive(Debug)]
pub(crate) struct RpcRequest {
    pub(crate) id: Value,
    pub(crate) method: String,
    pub(crate) params: Option<Value>,
}

pub(crate) fn parse_request(text: &str) -> Result<RpcRequest, RpcRequestParseError> {
    let parsed = serde_json::from_str::<Value>(text)
        .map_err(|error| error.to_string())
        .map_err(RpcRequestParseError::InvalidJson)?;
    let object = parsed
        .as_object()
        .ok_or(RpcRequestParseError::InvalidPayload)?;
    let id = object.get("id").cloned();
    let method = object
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| RpcRequestParseError::MissingMethod {
            id: id.clone().unwrap_or(Value::Null),
        })?;
    let Some(id) = id else {
        return Err(RpcRequestParseError::Notification {
            method: method.to_string(),
            params: object.get("params").cloned(),
        });
    };
    Ok(RpcRequest {
        id,
        method: method.to_string(),
        params: object.get("params").cloned(),
    })
}

pub(crate) fn parse_client_request_id(text: &str) -> Value {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| value.get("id").cloned())
        .unwrap_or(Value::Null)
}

pub(crate) fn is_forwarded_method(method: &str) -> bool {
    matches!(
        method,
        "account/login/cancel"
            | "account/login/start"
            | "account/logout"
            | "account/rateLimits/read"
            | "account/read"
            | "agent/list"
            | "config/read"
            | "model/list"
            | "review/start"
            | "thread/list"
            | "thread/delete"
            | "thread/approvalPolicy/set"
            | "thread/name/update"
            | "thread/snapshot/page"
            | "thread/loaded/list"
            | "thread/read"
            | "thread/resume"
            | "thread/config/set"
            | "thread/start"
            | "turn/interrupt"
            | "turn/start",
    )
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "rpc_tests.rs"]
mod tests;
