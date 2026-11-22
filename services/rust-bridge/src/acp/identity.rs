use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;

const VERSION: &str = "v1";
const MAX_COMPONENT_BYTES: usize = 1_024;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum IdentityError {
    #[error("invalid bridge ACP identity")]
    Invalid,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSessionId {
    pub agent_id: String,
    pub acp_session_id: String,
}

impl AgentSessionId {
    pub fn new(
        agent_id: impl Into<String>,
        acp_session_id: impl Into<String>,
    ) -> Result<Self, IdentityError> {
        let identity = Self {
            agent_id: agent_id.into(),
            acp_session_id: acp_session_id.into(),
        };
        identity.validate()?;
        Ok(identity)
    }

    pub fn encode(&self) -> String {
        format!(
            "{VERSION}.{}.{}",
            URL_SAFE_NO_PAD.encode(&self.agent_id),
            URL_SAFE_NO_PAD.encode(&self.acp_session_id),
        )
    }

    pub fn decode(value: &str) -> Result<Self, IdentityError> {
        let mut parts = value.split('.');
        if parts.next() != Some(VERSION) {
            return Err(IdentityError::Invalid);
        }
        let agent_id = decode_component(parts.next())?;
        let acp_session_id = decode_component(parts.next())?;
        if parts.next().is_some() {
            return Err(IdentityError::Invalid);
        }
        Self::new(agent_id, acp_session_id)
    }

    fn validate(&self) -> Result<(), IdentityError> {
        let invalid_agent = self.agent_id.is_empty()
            || self.agent_id.len() > MAX_COMPONENT_BYTES
            || !self
                .agent_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'));
        let invalid_session = self.acp_session_id.is_empty()
            || self.acp_session_id.len() > MAX_COMPONENT_BYTES
            || self.acp_session_id.contains('\0');
        if invalid_agent || invalid_session {
            return Err(IdentityError::Invalid);
        }
        Ok(())
    }
}

fn decode_component(value: Option<&str>) -> Result<String, IdentityError> {
    let value = value.ok_or(IdentityError::Invalid)?;
    if value.is_empty() || value.len() > MAX_COMPONENT_BYTES * 2 {
        return Err(IdentityError::Invalid);
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| IdentityError::Invalid)?;
    String::from_utf8(bytes).map_err(|_| IdentityError::Invalid)
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "identity_tests.rs"]
mod tests;
