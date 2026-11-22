use super::{AgentSessionId, MAX_COMPONENT_BYTES};

#[test]
fn opaque_session_identity_round_trips() {
    let id = AgentSessionId::new("registry-agent", "session/with spaces:opaque").unwrap();
    assert_eq!(AgentSessionId::decode(&id.encode()).unwrap(), id);
}

#[test]
fn identity_rejects_invalid_encodings() {
    for value in [
        "v0.YQ.Yg",
        "v1..Yg",
        "v1.YQ.Yg.extra",
        "v1.%%%%.Yg",
        "v1.YQ",
        "v1._w.Yg",
    ] {
        assert!(AgentSessionId::decode(value).is_err(), "{value}");
    }
    let oversized = "a".repeat(MAX_COMPONENT_BYTES * 2 + 1);
    assert!(AgentSessionId::decode(&format!("v1.{oversized}.Yg")).is_err());
}

#[test]
fn identity_rejects_invalid_components_at_every_boundary() {
    for (agent_id, session_id) in [
        ("", "session"),
        ("bad/agent", "session"),
        (&"a".repeat(MAX_COMPONENT_BYTES + 1), "session"),
        ("agent", ""),
        ("agent", "bad\0session"),
        ("agent", &"s".repeat(MAX_COMPONENT_BYTES + 1)),
    ] {
        assert!(AgentSessionId::new(agent_id, session_id).is_err());
    }
}
