use serde_json::{json, Value};

#[derive(Debug)]
pub struct BridgeError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl BridgeError {
    pub fn method_not_found(message: &str) -> Self {
        Self {
            code: -32601,
            message: message.to_string(),
            data: None,
        }
    }

    pub fn invalid_params(message: &str) -> Self {
        Self {
            code: -32602,
            message: message.to_string(),
            data: None,
        }
    }

    pub fn resource_limit(resource: &str, limit: usize, actual: usize) -> Self {
        Self {
            code: -32602,
            message: format!("{resource} exceeds limit of {limit}"),
            data: Some(json!({
                "error": "resource_limit_exceeded",
                "resource": resource,
                "limit": limit,
                "actual": actual,
            })),
        }
    }

    pub fn server(message: &str) -> Self {
        Self {
            code: -32000,
            message: message.to_string(),
            data: None,
        }
    }

    pub fn forbidden(error: &str, message: &str) -> Self {
        Self {
            code: -32003,
            message: message.to_string(),
            data: Some(json!({ "error": error })),
        }
    }
}
