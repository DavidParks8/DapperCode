use super::{keychain_entry, keychain_password_result};

#[test]
fn dependency_upgrade_native_entry_preserves_service_and_account_without_opening_the_store() {
    for account in [
        "bridge-auth-vault:v1",
        "bridge-auth-vault:v2",
        "bridge-auth-token:v2:0038851cbd37beeb49b6cbf6893d248ac90536f123ace1fa818a90c255b91dc1",
        "__phone-call-sip-password",
    ] {
        // Entry construction only builds a descriptor; no keychain lookup, write, or delete.
        let entry = keychain_entry(account).unwrap();
        assert_eq!(
            entry.inner.get_specifiers(),
            Some(("dev.dappercode.desktop".to_string(), account.to_string())),
        );
        #[cfg(target_os = "windows")]
        assert!(format!("{:?}", entry.inner).contains(&format!(
            r#"target_name: "{account}.dev.dappercode.desktop""#
        )));
        #[cfg(target_os = "windows")]
        assert!(format!("{:?}", entry.inner).contains("persistence: Enterprise"));
        #[cfg(target_os = "macos")]
        assert!(format!("{:?}", entry.inner).contains("domain: User"));
    }
}

#[test]
fn dependency_upgrade_password_results_preserve_absence_payload_and_read_errors() {
    assert_eq!(
        keychain_password_result(Err(keyring::Error::NoEntry)).unwrap(),
        None,
    );
    let token = crate::secrets::generate_token();
    let sip_secret = format!("{}é🔐", crate::secrets::generate_token());
    let payload = serde_json::json!({
        "version": 1,
        "bridgeAuthTokens": {"alpha": token},
        "sipPassword": sip_secret,
    })
    .to_string();
    assert_eq!(
        keychain_password_result(Ok(payload.clone())).unwrap(),
        Some(payload),
    );
    assert!(keychain_password_result(Ok("   ".to_string())).is_err());
    assert!(keychain_password_result(Err(keyring::Error::BadEncoding(vec![0xff]))).is_err());
}
