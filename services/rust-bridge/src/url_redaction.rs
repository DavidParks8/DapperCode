const REDACTED: &str = "[REDACTED]";

pub(crate) fn redact_url_credentials(value: &str) -> String {
    let value = redact_url_userinfo(value);
    let mut output = String::with_capacity(value.len());
    let mut cursor = 0;

    while cursor < value.len() {
        let Some((delimiter_offset, delimiter)) = value[cursor..]
            .char_indices()
            .find(|(_, character)| matches!(character, '?' | '&' | '#'))
        else {
            output.push_str(&value[cursor..]);
            break;
        };
        let delimiter_index = cursor + delimiter_offset;
        output.push_str(&value[cursor..=delimiter_index]);
        let key_start = delimiter_index + delimiter.len_utf8();
        let Some((key_end_offset, _)) = value[key_start..].char_indices().find(|(_, character)| {
            matches!(character, '=' | '?' | '&' | '#' | ' ' | '\t' | '\r' | '\n')
        }) else {
            output.push_str(&value[key_start..]);
            break;
        };
        let key_end = key_start + key_end_offset;
        if value.as_bytes().get(key_end) != Some(&b'=') {
            output.push_str(&value[key_start..key_end]);
            cursor = key_end;
            continue;
        }

        output.push_str(&value[key_start..=key_end]);
        let value_start = key_end + 1;
        let value_end = value[value_start..]
            .char_indices()
            .find(|(_, character)| matches!(character, '&' | '#'))
            .map_or(value.len(), |(offset, _)| value_start + offset);

        if is_sensitive_query_key(&value[key_start..key_end]) {
            output.push_str(REDACTED);
        } else {
            output.push_str(&value[value_start..value_end]);
        }
        cursor = value_end;
    }

    output
}

fn redact_url_userinfo(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut cursor = 0;

    while let Some(authority_offset) = find_authority_marker(&value[cursor..]) {
        let authority_start = cursor + authority_offset + 2;
        output.push_str(&value[cursor..authority_start]);
        let authority_end = value[authority_start..]
            .char_indices()
            .find(|(_, character)| {
                matches!(character, '/' | '?' | '#') || character.is_whitespace()
            })
            .map_or(value.len(), |(offset, _)| authority_start + offset);
        let authority = &value[authority_start..authority_end];
        if let Some(at_index) = authority.rfind('@') {
            output.push_str(REDACTED);
            output.push_str(&authority[at_index..]);
        } else {
            output.push_str(authority);
        }
        cursor = authority_end;
    }

    output.push_str(&value[cursor..]);
    output
}

fn find_authority_marker(value: &str) -> Option<usize> {
    value.match_indices("//").find_map(|(index, _)| {
        if index == 0 {
            return Some(index);
        }
        value[..index]
            .chars()
            .next_back()
            .filter(|character| {
                character.is_whitespace() || matches!(character, ':' | '(' | '[' | '{' | '<' | '=')
            })
            .map(|_| index)
    })
}

fn is_sensitive_query_key(raw: &str) -> bool {
    let decoded = decode_query_key(raw);
    matches!(
        decoded.to_ascii_lowercase().as_str(),
        "token"
            | "access_token"
            | "auth"
            | "authorization"
            | "key"
            | "secret"
            | "password"
            | "code"
            | "st"
    )
}

fn decode_query_key(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
            {
                decoded.push((high << 4) | low);
                index += 3;
                continue;
            }
        }
        decoded.push(if bytes[index] == b'+' {
            b' '
        } else {
            bytes[index]
        });
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_all_credential_shaped_query_names_case_insensitively() {
        for key in [
            "token",
            "access_token",
            "AUTH",
            "Authorization",
            "key",
            "secret",
            "password",
            "code",
            "st",
        ] {
            let rendered = redact_url_credentials(&format!(
                "https://example.test/path?{key}=never-log-me&ok=1"
            ));
            assert!(!rendered.contains("never-log-me"), "{rendered}");
            assert!(rendered.contains(&format!("{key}={REDACTED}")));
            assert!(rendered.contains("ok=1"));
        }
    }

    #[test]
    fn redacts_encoded_keys_fragments_and_invalid_url_text_without_hiding_safe_context() {
        let rendered = redact_url_credentials(
            "request failed for not a url?to%6ben=query-secret&view=full#St=fragment-secret&tab=2",
        );
        assert!(!rendered.contains("query-secret"));
        assert!(!rendered.contains("fragment-secret"));
        assert!(rendered.starts_with("request failed for not a url?"));
        assert!(rendered.contains("view=full"));
        assert!(rendered.contains("tab=2"));
    }

    #[test]
    fn redacts_full_values_with_legal_punctuation_and_url_userinfo() {
        let rendered = redact_url_credentials(
            "failed https://user:pass@example.test/path?token=abc)def'ghi&ok=1",
        );
        for secret in ["user", "pass", "abc", "def", "ghi"] {
            assert!(!rendered.contains(secret), "{rendered}");
        }
        assert!(rendered.contains("https://[REDACTED]@example.test/path"));
        assert!(rendered.contains("token=[REDACTED]&ok=1"));
    }

    #[test]
    fn redacts_scheme_relative_url_userinfo() {
        let rendered =
            redact_url_credentials("preview //user:credential@example.test/path?view=full");
        assert!(!rendered.contains("user"));
        assert!(!rendered.contains("credential"));
        assert_eq!(rendered, "preview //[REDACTED]@example.test/path?view=full");
    }

    #[test]
    fn leaves_non_sensitive_urls_unchanged() {
        let value = "https://example.test/path?view=full&tab=2#section";
        assert_eq!(redact_url_credentials(value), value);
    }
}
