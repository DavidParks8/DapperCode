use super::bind_then_start_backend;

#[tokio::test]
async fn port_zero_reports_the_os_assigned_bridge_address() {
    let (address, listener, backend) =
        bind_then_start_backend("127.0.0.1", 0, || async { Ok::<_, String>("ready") })
            .await
            .expect("bind bridge listener");

    assert_eq!(address, listener.local_addr().unwrap().to_string());
    assert_ne!(listener.local_addr().unwrap().port(), 0);
    assert_eq!(backend, "ready");
}
