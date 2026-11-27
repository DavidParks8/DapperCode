use super::{
    json, normalize_path, parse_internal_id, read_bool, read_string, required_push_id,
    validate_bridge_ui_action_payload, validate_bridge_ui_block, validate_bridge_ui_surface,
    BridgeUiAction, BridgeUiBlock, BridgeUiChecklistItem, BridgeUiKeyValueItem,
    BridgeUiPresentation, BridgeUiSurface, Path, PathBuf, Value, PUSH_ID_MAX_BYTES,
    UI_SURFACE_ACTION_PAYLOAD_MAX_BYTES, UI_SURFACE_MAX_ACTIONS, UI_SURFACE_MAX_BLOCKS,
    UI_SURFACE_MAX_BYTES, UI_SURFACE_MAX_ITEMS_PER_BLOCK, UI_SURFACE_MAX_TEXT_BYTES,
};

fn surface() -> BridgeUiSurface {
    BridgeUiSurface {
        id: "surface-1".into(),
        thread_id: "thread-1".into(),
        turn_id: None,
        kind: None,
        presentation: BridgeUiPresentation::WorkflowCard,
        tone: None,
        title: "Status".into(),
        subtitle: None,
        body_markdown: None,
        blocks: vec![],
        actions: vec![],
        dismissible: None,
        created_at: None,
        updated_at: None,
    }
}

#[test]
fn scalar_readers_accept_supported_shapes_and_reject_others() {
    assert_eq!(parse_internal_id(Some(&json!(42))), Some(42));
    assert_eq!(parse_internal_id(Some(&json!("43"))), Some(43));
    for value in [json!(-1), json!("invalid"), json!(true), Value::Null] {
        assert_eq!(parse_internal_id(Some(&value)), None);
    }
    assert_eq!(parse_internal_id(None), None);
    assert_eq!(read_string(Some(&json!("value"))), Some("value".into()));
    assert_eq!(read_string(Some(&json!(1))), None);
    assert_eq!(read_bool(Some(&json!(true))), Some(true));
    assert_eq!(read_bool(Some(&json!("true"))), None);

    assert_eq!(
        required_push_id(&json!({"profileId": "  profile-1  "}), "profileId").unwrap(),
        "profile-1",
    );
    for params in [
        json!({}),
        json!({"profileId": "   "}),
        json!({"profileId": 1}),
    ] {
        assert_eq!(
            required_push_id(&params, "profileId").unwrap_err().code,
            -32602,
        );
    }
    let oversized = "x".repeat(PUSH_ID_MAX_BYTES + 1);
    let error = required_push_id(&json!({"profileId": oversized}), "profileId").unwrap_err();
    assert_eq!(error.data.unwrap()["resource"], "push_identity_bytes");
}

#[test]
fn ui_surface_action_payload_validation_requires_bounded_object() {
    validate_bridge_ui_action_payload(None).unwrap();
    validate_bridge_ui_action_payload(Some(&json!({ "instruction": "Ask for callback" }))).unwrap();
    assert_eq!(
        validate_bridge_ui_action_payload(Some(&json!("not-an-object")))
            .unwrap_err()
            .code,
        -32602,
    );
    let oversized = json!({ "instruction": "x".repeat(UI_SURFACE_ACTION_PAYLOAD_MAX_BYTES + 1) });
    assert_eq!(
        validate_bridge_ui_action_payload(Some(&oversized))
            .unwrap_err()
            .data
            .unwrap()["resource"],
        "ui_surface_action_payload_bytes",
    );
}

#[test]
fn ui_surface_validation_checks_identity_actions_and_resource_limits() {
    let valid = surface();
    validate_bridge_ui_surface(&valid).unwrap();

    for field in ["id", "thread", "title"] {
        let mut candidate = surface();
        match field {
            "id" => candidate.id = " ".into(),
            "thread" => candidate.thread_id = " ".into(),
            "title" => candidate.title = " ".into(),
            _ => unreachable!(),
        }
        assert_eq!(
            validate_bridge_ui_surface(&candidate).unwrap_err().code,
            -32602,
        );
    }

    let mut candidate = surface();
    candidate.body_markdown = Some("x".repeat(UI_SURFACE_MAX_BYTES + 1));
    assert_eq!(
        validate_bridge_ui_surface(&candidate)
            .unwrap_err()
            .data
            .unwrap()["resource"],
        "ui_surface_bytes",
    );

    let mut candidate = surface();
    candidate.blocks = (0..=UI_SURFACE_MAX_BLOCKS)
        .map(|_| BridgeUiBlock::Text { text: "ok".into() })
        .collect();
    assert_eq!(
        validate_bridge_ui_surface(&candidate)
            .unwrap_err()
            .data
            .unwrap()["resource"],
        "ui_surface_blocks",
    );

    let action = |id: &str, label: &str| BridgeUiAction {
        id: id.into(),
        label: label.into(),
        style: None,
        dismisses_surface: None,
    };
    let mut candidate = surface();
    candidate.actions = (0..=UI_SURFACE_MAX_ACTIONS)
        .map(|_| action("run", "Run"))
        .collect();
    assert_eq!(
        validate_bridge_ui_surface(&candidate)
            .unwrap_err()
            .data
            .unwrap()["resource"],
        "ui_surface_actions",
    );
    for invalid in [action(" ", "Run"), action("run", " ")] {
        let mut candidate = surface();
        candidate.actions.push(invalid);
        assert_eq!(
            validate_bridge_ui_surface(&candidate).unwrap_err().code,
            -32602,
        );
    }
}

#[test]
fn ui_block_validation_exercises_every_block_shape() {
    let checklist_item = || BridgeUiChecklistItem {
        label: "Build".into(),
        status: None,
        detail: None,
    };
    let key_value_item = || BridgeUiKeyValueItem {
        label: "Branch".into(),
        value: "main".into(),
    };
    for valid in [
        BridgeUiBlock::Text {
            text: "text".into(),
        },
        BridgeUiBlock::Markdown {
            markdown: "**text**".into(),
        },
        BridgeUiBlock::Code {
            text: "code".into(),
            language: None,
        },
        BridgeUiBlock::Checklist {
            items: vec![checklist_item()],
        },
        BridgeUiBlock::KeyValue {
            items: vec![key_value_item()],
        },
        BridgeUiBlock::Progress {
            label: "Build".into(),
            value: 1.0,
            max: 2.0,
            detail: None,
        },
    ] {
        validate_bridge_ui_block(&valid).unwrap();
    }

    for empty in [
        BridgeUiBlock::Text { text: " ".into() },
        BridgeUiBlock::Markdown {
            markdown: " ".into(),
        },
        BridgeUiBlock::Code {
            text: " ".into(),
            language: None,
        },
        BridgeUiBlock::Checklist { items: vec![] },
        BridgeUiBlock::KeyValue { items: vec![] },
    ] {
        assert_eq!(validate_bridge_ui_block(&empty).unwrap_err().code, -32602);
    }
    assert_eq!(
        validate_bridge_ui_block(&BridgeUiBlock::Text {
            text: "x".repeat(UI_SURFACE_MAX_TEXT_BYTES + 1)
        })
        .unwrap_err()
        .data
        .unwrap()["resource"],
        "ui_surface_text_bytes",
    );

    let mut checklist = vec![checklist_item(); UI_SURFACE_MAX_ITEMS_PER_BLOCK + 1];
    assert_eq!(
        validate_bridge_ui_block(&BridgeUiBlock::Checklist {
            items: checklist.clone()
        })
        .unwrap_err()
        .data
        .unwrap()["resource"],
        "ui_surface_block_items",
    );
    checklist.truncate(1);
    checklist[0].label = " ".into();
    assert_eq!(
        validate_bridge_ui_block(&BridgeUiBlock::Checklist { items: checklist })
            .unwrap_err()
            .code,
        -32602,
    );

    let mut pairs = vec![key_value_item(); UI_SURFACE_MAX_ITEMS_PER_BLOCK + 1];
    assert_eq!(
        validate_bridge_ui_block(&BridgeUiBlock::KeyValue {
            items: pairs.clone()
        })
        .unwrap_err()
        .data
        .unwrap()["resource"],
        "ui_surface_block_items",
    );
    pairs.truncate(1);
    for (label, value) in [(" ", "main"), ("Branch", " ")] {
        pairs[0].label = label.into();
        pairs[0].value = value.into();
        assert_eq!(
            validate_bridge_ui_block(&BridgeUiBlock::KeyValue {
                items: pairs.clone()
            })
            .unwrap_err()
            .code,
            -32602,
        );
    }

    for (label, value, max) in [
        (" ", 1.0, 2.0),
        ("Build", f64::NAN, 2.0),
        ("Build", 1.0, f64::INFINITY),
        ("Build", 1.0, 0.0),
        ("Build", -1.0, 2.0),
    ] {
        assert_eq!(
            validate_bridge_ui_block(&BridgeUiBlock::Progress {
                label: label.into(),
                value,
                max,
                detail: None,
            })
            .unwrap_err()
            .code,
            -32602,
        );
    }
}

#[test]
fn path_normalization_resolves_dot_components_without_touching_the_filesystem() {
    assert_eq!(
        normalize_path(Path::new("/workspace/./src/../README.md")),
        PathBuf::from("/workspace/README.md"),
    );
    assert_eq!(
        normalize_path(Path::new("workspace/src/../../outside")),
        PathBuf::from("outside"),
    );
}
