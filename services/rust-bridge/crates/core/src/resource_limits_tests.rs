use super::truncate_utf8_bytes;

#[test]
fn truncates_at_utf8_boundary() {
    assert_eq!(truncate_utf8_bytes("é", 0), (String::new(), true));
    assert_eq!(truncate_utf8_bytes("é", 1), (String::new(), true));
    assert_eq!(truncate_utf8_bytes("aéz", 2), ("a".to_string(), true));
    assert_eq!(truncate_utf8_bytes("aéz", 3), ("aé".to_string(), true));
    assert_eq!(truncate_utf8_bytes("aéz", 4), ("aéz".to_string(), false));
}
