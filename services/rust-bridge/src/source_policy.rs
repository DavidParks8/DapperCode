use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

fn non_platform_sources() -> Vec<PathBuf> {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut sources = production_rust_sources(&workspace.join("src"));
    for entry in fs::read_dir(workspace.join("crates")).expect("list bridge crates") {
        let entry = entry.expect("read bridge crate");
        if entry.file_name() == "platform" {
            continue;
        }
        let source_root = entry.path().join("src");
        if source_root.is_dir() {
            sources.extend(production_rust_sources(&source_root));
        }
    }
    sources
}

fn production_rust_sources(source_root: &Path) -> Vec<PathBuf> {
    let mut all_sources = Vec::new();
    collect_rust_sources(source_root, &mut all_sources);
    let entry_points = collect_cargo_entry_points(source_root);
    let test_only = collect_verified_test_only_sources(&all_sources, &entry_points);
    all_sources.retain(|path| !test_only.contains(path));
    all_sources
}

fn strip_toml_comment(line: &str) -> &str {
    let mut in_double = false;
    let mut in_single = false;
    let mut escaped = false;
    for (index, ch) in line.char_indices() {
        if in_double {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_double = false;
            }
            continue;
        }
        if in_single {
            if ch == '\'' {
                in_single = false;
            }
            continue;
        }
        match ch {
            '"' => in_double = true,
            '\'' => in_single = true,
            '#' => return &line[..index],
            _ => {}
        }
    }
    line
}

fn collect_cargo_entry_points(source_root: &Path) -> HashSet<PathBuf> {
    let mut roots = HashSet::new();
    for file in ["lib.rs", "main.rs"] {
        let candidate = source_root.join(file);
        if candidate.is_file() {
            roots.insert(candidate);
        }
    }
    let bin_dir = source_root.join("bin");
    if bin_dir.is_dir() {
        for entry in fs::read_dir(&bin_dir).expect("list src/bin") {
            let path = entry.expect("read src/bin entry").path();
            if path.is_file() && path.extension().is_some_and(|ext| ext == "rs") {
                roots.insert(path);
            } else if path.is_dir() {
                let main = path.join("main.rs");
                if main.is_file() {
                    roots.insert(main);
                }
            }
        }
    }
    if let Some(crate_root) = source_root.parent() {
        let manifest_path = crate_root.join("Cargo.toml");
        if manifest_path.is_file() {
            let manifest = fs::read_to_string(&manifest_path).expect("read crate Cargo.toml");
            let mut in_bin_or_lib = false;
            for raw_line in manifest.lines() {
                let trimmed = strip_toml_comment(raw_line).trim();
                if trimmed.is_empty() {
                    continue;
                }
                if trimmed.starts_with('[') {
                    in_bin_or_lib = matches!(trimmed, "[[bin]]" | "[lib]");
                    continue;
                }
                if in_bin_or_lib {
                    if let Some(rest) = trimmed.strip_prefix("path") {
                        let rest = rest.trim_start();
                        if let Some(rest) = rest.strip_prefix('=') {
                            let rest = rest.trim();
                            let unquoted = rest
                                .strip_prefix('"')
                                .and_then(|value| value.strip_suffix('"'))
                                .or_else(|| {
                                    rest.strip_prefix('\'')
                                        .and_then(|value| value.strip_suffix('\''))
                                });
                            if let Some(rel) = unquoted {
                                let candidate = crate_root.join(rel);
                                if candidate.is_file() {
                                    roots.insert(candidate);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    roots
}

fn collect_verified_test_only_sources(
    all_sources: &[PathBuf],
    entry_points: &HashSet<PathBuf>,
) -> HashSet<PathBuf> {
    let known: HashSet<PathBuf> = all_sources.iter().cloned().collect();
    let mut prod_mod_edges: HashMap<PathBuf, Vec<PathBuf>> = HashMap::new();
    let mut test_mod_edges: HashMap<PathBuf, Vec<PathBuf>> = HashMap::new();
    let mut include_edges: HashMap<PathBuf, Vec<PathBuf>> = HashMap::new();
    let mut referenced_by_any_edge: HashSet<PathBuf> = HashSet::new();

    for source_path in all_sources {
        let source = fs::read_to_string(source_path).expect("read rust source");
        for (target, is_cfg_test) in parse_external_mod_targets(source_path, &source) {
            if !known.contains(&target) {
                continue;
            }
            referenced_by_any_edge.insert(target.clone());
            if is_cfg_test {
                test_mod_edges
                    .entry(source_path.clone())
                    .or_default()
                    .push(target);
            } else {
                prod_mod_edges
                    .entry(source_path.clone())
                    .or_default()
                    .push(target);
            }
        }
        for target in parse_include_targets(source_path, &source) {
            if known.contains(&target) {
                referenced_by_any_edge.insert(target.clone());
                include_edges
                    .entry(source_path.clone())
                    .or_default()
                    .push(target);
            }
        }
    }

    // Production roots are explicit Cargo entry points plus any unreferenced files.
    let mut prod_reachable: HashSet<PathBuf> = all_sources
        .iter()
        .filter(|path| entry_points.contains(*path) || !referenced_by_any_edge.contains(*path))
        .cloned()
        .collect();

    // Propagate production reachability across all non-test `mod` and `include!` edges first.
    let mut queue: Vec<PathBuf> = prod_reachable.iter().cloned().collect();
    while let Some(current) = queue.pop() {
        for target in prod_mod_edges
            .get(&current)
            .into_iter()
            .flatten()
            .chain(include_edges.get(&current).into_iter().flatten())
        {
            if prod_reachable.insert(target.clone()) {
                queue.push(target.clone());
            }
        }
    }

    // Collect files reachable through test-only edges (`cfg(test)` mods and their descendants).
    let mut test_reachable: HashSet<PathBuf> = test_mod_edges
        .values()
        .flatten()
        .filter(|target| !prod_reachable.contains(*target))
        .cloned()
        .collect();
    let mut test_queue: Vec<PathBuf> = test_reachable.iter().cloned().collect();
    while let Some(current) = test_queue.pop() {
        for target in prod_mod_edges
            .get(&current)
            .into_iter()
            .flatten()
            .chain(test_mod_edges.get(&current).into_iter().flatten())
            .chain(include_edges.get(&current).into_iter().flatten())
        {
            if !prod_reachable.contains(target) && test_reachable.insert(target.clone()) {
                test_queue.push(target.clone());
            }
        }
    }

    test_reachable
}

fn raw_string_hashes(bytes: &[u8], index: usize) -> Option<(usize, usize)> {
    let prev_is_ident =
        index > 0 && (bytes[index - 1].is_ascii_alphanumeric() || bytes[index - 1] == b'_');
    if prev_is_ident {
        return None;
    }
    let r_pos = match bytes[index] {
        b'r' => index,
        b'b' | b'c' if bytes.get(index + 1) == Some(&b'r') => index + 1,
        _ => return None,
    };
    let mut hashes = 0_usize;
    while bytes.get(r_pos + 1 + hashes) == Some(&b'#') {
        hashes += 1;
    }
    if bytes.get(r_pos + 1 + hashes) == Some(&b'"') {
        Some((r_pos + 1 + hashes + 1, hashes))
    } else {
        None
    }
}

fn strip_rust_comments(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut index = 0_usize;
    let mut block_depth = 0_usize;
    let mut in_string = false;
    let mut raw_hashes: Option<usize> = None;

    while index < bytes.len() {
        if block_depth > 0 {
            if bytes[index] == b'/' && bytes.get(index + 1) == Some(&b'*') {
                block_depth += 1;
                index += 2;
            } else if bytes[index] == b'*' && bytes.get(index + 1) == Some(&b'/') {
                block_depth -= 1;
                out.push(' ');
                index += 2;
            } else {
                if bytes[index] == b'\n' {
                    out.push('\n');
                }
                index += 1;
            }
            continue;
        }
        if let Some(expected_hashes) = raw_hashes {
            let ch = input[index..].chars().next().expect("valid utf8");
            out.push(ch);
            index += ch.len_utf8();
            if ch == '"' {
                let mut matched = 0_usize;
                while matched < expected_hashes && bytes.get(index + matched) == Some(&b'#') {
                    matched += 1;
                }
                if matched == expected_hashes {
                    for _ in 0..matched {
                        out.push('#');
                    }
                    index += matched;
                    raw_hashes = None;
                }
            }
            continue;
        }
        if in_string {
            if bytes[index] == b'\\' && index + 1 < bytes.len() {
                let next_ch = input[index + 1..].chars().next().expect("valid utf8");
                out.push('\\');
                out.push(next_ch);
                index += 1 + next_ch.len_utf8();
                continue;
            }
            let ch = input[index..].chars().next().expect("valid utf8");
            out.push(ch);
            if ch == '"' {
                in_string = false;
            }
            index += ch.len_utf8();
            continue;
        }
        if bytes[index] == b'/' && bytes.get(index + 1) == Some(&b'/') {
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if bytes[index] == b'/' && bytes.get(index + 1) == Some(&b'*') {
            block_depth = 1;
            index += 2;
            continue;
        }
        if let Some((after_open_quote, hashes)) = raw_string_hashes(bytes, index) {
            out.push_str(&input[index..after_open_quote]);
            index = after_open_quote;
            raw_hashes = Some(hashes);
            continue;
        }
        if bytes[index] == b'\'' {
            if bytes.get(index + 1) == Some(&b'\\') {
                let mut cursor = index + 2;
                if cursor < bytes.len() && bytes[cursor] != b'\n' {
                    cursor += 1;
                }
                while cursor < bytes.len() && bytes[cursor] != b'\'' && bytes[cursor] != b'\n' {
                    cursor += 1;
                }
                if bytes.get(cursor) == Some(&b'\'') {
                    out.push_str(&input[index..=cursor]);
                    index = cursor + 1;
                    continue;
                }
            } else if let Some(ch) = input[index + 1..].chars().next() {
                let close = index + 1 + ch.len_utf8();
                if bytes.get(close) == Some(&b'\'') {
                    out.push_str(&input[index..=close]);
                    index = close + 1;
                    continue;
                }
            }
        }
        let ch = input[index..].chars().next().expect("valid utf8");
        out.push(ch);
        if ch == '"' {
            in_string = true;
        }
        index += ch.len_utf8();
    }
    out
}

fn split_top_level_args(input: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0_usize;
    let mut start = 0_usize;
    let mut in_string = false;
    let mut escaped = false;
    for (index, ch) in input.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => {
                parts.push(input[start..index].trim());
                start = index + 1;
            }
            _ => {}
        }
    }
    let tail = input[start..].trim();
    if !tail.is_empty() {
        parts.push(tail);
    }
    parts
}

fn cfg_expr_implies_test(expr: &str) -> bool {
    let trimmed = expr.trim();
    if trimmed == "test" {
        return true;
    }
    if let Some(inner) = trimmed
        .strip_prefix("all(")
        .and_then(|rest| rest.strip_suffix(')'))
    {
        return split_top_level_args(inner)
            .into_iter()
            .any(cfg_expr_implies_test);
    }
    if let Some(inner) = trimmed
        .strip_prefix("any(")
        .and_then(|rest| rest.strip_suffix(')'))
    {
        let args = split_top_level_args(inner);
        return !args.is_empty() && args.into_iter().all(cfg_expr_implies_test);
    }
    false
}

fn cfg_attr_implies_test(attr: &str) -> bool {
    let cleaned = strip_rust_comments(attr);
    let Some(inner) = cleaned
        .trim()
        .strip_prefix("#[cfg(")
        .and_then(|rest| rest.strip_suffix(")]"))
    else {
        return false;
    };
    cfg_expr_implies_test(inner)
}

fn parse_path_attr(attr: &str) -> Option<String> {
    let rest = attr.trim().strip_prefix("#[path")?.trim_start();
    let rest = rest.strip_prefix('=')?.trim_start();
    let rest = rest.strip_prefix('"')?;
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn resolve_mod_target(source_path: &Path, mod_name: &str, explicit_path: Option<&str>) -> PathBuf {
    let parent = source_path.parent().expect("source file has parent");
    let stem = source_path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let is_mod_root = matches!(stem, "lib" | "main" | "mod");
    if let Some(relative) = explicit_path {
        if is_mod_root {
            return parent.join(relative);
        }
        let sibling = parent.join(relative);
        if sibling.is_file() {
            return sibling;
        }
        return parent.join(stem).join(relative);
    }
    let search_dir = if is_mod_root {
        parent.to_path_buf()
    } else {
        parent.join(stem)
    };
    let direct = search_dir.join(format!("{mod_name}.rs"));
    if direct.is_file() {
        direct
    } else {
        search_dir.join(mod_name).join("mod.rs")
    }
}

fn parse_external_mod_targets(source_path: &Path, source: &str) -> Vec<(PathBuf, bool)> {
    let mut results = Vec::new();
    let mut pending_attrs: Vec<String> = Vec::new();
    let mut current_attr: Option<String> = None;
    let cleaned = strip_rust_comments(source);

    for raw_line in cleaned.lines() {
        let trimmed = raw_line.trim();
        if let Some(mut attr) = current_attr.take() {
            attr.push(' ');
            attr.push_str(trimmed);
            if trimmed.ends_with(']') {
                pending_attrs.push(attr);
            } else {
                current_attr = Some(attr);
            }
            continue;
        }
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with("#[") && !trimmed.starts_with("#![") {
            if trimmed.ends_with(']') {
                pending_attrs.push(trimmed.to_string());
            } else {
                current_attr = Some(trimmed.to_string());
            }
            continue;
        }
        if let Some(mod_name) = parse_external_mod_name(trimmed) {
            let is_cfg_test = pending_attrs.iter().any(|attr| cfg_attr_implies_test(attr));
            let explicit_path = pending_attrs.iter().find_map(|attr| parse_path_attr(attr));
            let target = resolve_mod_target(source_path, mod_name, explicit_path.as_deref());
            results.push((target, is_cfg_test));
        }
        pending_attrs.clear();
    }
    results
}

fn parse_external_mod_name(line: &str) -> Option<&str> {
    let without_vis = if let Some(rest) = line.strip_prefix("pub") {
        let rest = rest.trim_start();
        if let Some(after_paren) = rest.strip_prefix('(') {
            let (_, remainder) = after_paren.split_once(')')?;
            remainder.trim_start()
        } else {
            rest
        }
    } else {
        line
    };
    let rest = without_vis.strip_prefix("mod ")?.trim_start();
    let name = rest.strip_suffix(';')?.trim();
    if !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        Some(name)
    } else {
        None
    }
}

fn parse_include_targets(source_path: &Path, source: &str) -> Vec<PathBuf> {
    let parent = source_path.parent().expect("source file has parent");
    let cleaned = strip_rust_comments(source);
    let mut results = Vec::new();
    let mut search_from = 0_usize;
    while let Some(offset) = cleaned[search_from..].find("include") {
        let match_start = search_from + offset;
        let prev_is_ident = match_start > 0
            && cleaned[..match_start]
                .chars()
                .next_back()
                .is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_');
        let after_ident = match_start + "include".len();
        search_from = after_ident;
        if prev_is_ident {
            continue;
        }
        let after_ws = cleaned[after_ident..].trim_start();
        let Some(after_bang) = after_ws.strip_prefix('!') else {
            continue;
        };
        let after_bang = after_bang.trim_start();
        let Some(first) = after_bang.chars().next() else {
            break;
        };
        if !matches!(first, '(' | '[' | '{') {
            continue;
        }
        let body = after_bang[first.len_utf8()..].trim_start();
        if let Some(quoted) = body.strip_prefix('"') {
            if let Some(end) = quoted.find('"') {
                results.push(parent.join(&quoted[..end]));
            }
        }
    }
    results
}

#[test]
fn production_modules_do_not_import_native_platform_apis() {
    assert_no_production_markers(
        &[
            "std::os::unix",
            "std::os::windows",
            "windows_sys::",
            "libc::",
            "rustix::",
        ],
        "production native APIs must live in dappercode-bridge-platform",
    );
}

#[test]
fn production_modules_do_not_define_cfg_split_platform_functions() {
    assert_no_production_markers(
        &[
            "#[cfg(unix",
            "#[cfg(windows",
            "#[cfg(not(unix",
            "#[cfg(not(windows",
            "#[cfg(any(unix",
            "#[cfg(any(windows",
            "target_os",
            "target_family",
        ],
        "production platform branches must live in dappercode-bridge-platform",
    );
}

#[test]
fn windows_owner_watch_remains_cancellable_and_bounded() {
    let source = include_str!("../crates/platform/src/platform/windows/process.rs");
    assert!(!source.contains("spawn_blocking"));
    assert!(!source.contains("INFINITE"));
    assert!(source.contains("WaitForSingleObject"));
    assert!(source.contains(", 0)"));
}

#[test]
fn windows_git_timeout_terminates_descendants_before_joining_readers() {
    let windows = include_str!("../crates/platform/src/platform/windows/process.rs");
    assert!(windows.contains("kill_on_drop(true)"));
    assert!(windows.contains("taskkill.exe"));
    assert!(windows.contains(r#""/T""#));
    assert!(windows.contains(r#""/F""#));
    assert!(windows.contains(".status()"));

    let terminal = include_str!("services/terminal.rs");
    let terminate = terminal
        .find("kill_git_process_group(&child)")
        .expect("Git timeout must invoke platform tree termination");
    let join_readers = terminal
        .find("stdout_task.await")
        .expect("Git execution must join its stdout reader");
    assert!(
        terminate < join_readers,
        "the process tree must be terminated before pipe readers are joined",
    );
}

fn assert_no_production_markers(markers: &[&str], message: &str) {
    let mut violations: HashMap<PathBuf, Vec<&str>> = HashMap::new();
    for path in non_platform_sources() {
        let source = fs::read_to_string(&path).expect("read production source");
        let production = without_test_items(&source);
        for &marker in markers {
            if production.contains(marker) {
                violations.entry(path.clone()).or_default().push(marker);
            }
        }
    }
    assert!(violations.is_empty(), "{message}: {violations:#?}");
}

fn collect_rust_sources(directory: &Path, output: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(directory).expect("list source directory") {
        let path = entry.expect("source entry").path();
        if path.is_dir() {
            collect_rust_sources(&path, output);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            output.push(path);
        }
    }
}

fn without_test_items(source: &str) -> String {
    // This lightweight scanner is conservative: if brace counting is confused by source text, it
    // over-scans test code rather than allowing a production violation to pass unnoticed.
    let mut production = String::new();
    let mut skipping = false;
    let mut waiting_for_item = false;
    let mut block_depth = 0_i32;

    for line in source.lines() {
        let trimmed = line.trim();
        if !skipping && trimmed == "#[cfg(test)]" {
            skipping = true;
            waiting_for_item = true;
            continue;
        }
        if !skipping {
            production.push_str(line);
            production.push('\n');
            continue;
        }

        if waiting_for_item && trimmed.starts_with("#[") {
            continue;
        }
        waiting_for_item = false;
        for character in line.chars() {
            match character {
                '{' => block_depth += 1,
                '}' => block_depth -= 1,
                _ => {}
            }
        }
        if block_depth == 0 && (line.contains(';') || line.contains('}') || trimmed.ends_with(','))
        {
            skipping = false;
        }
    }
    production
}

#[test]
fn production_linked_tests_suffix_file_is_not_excluded_from_source_policy() {
    let dir = tempfile::tempdir().expect("create tempdir");
    let src = dir.path().join("src");
    fs::create_dir(&src).expect("create src dir");
    fs::write(
        src.join("lib.rs"),
        "mod prod_tests;\n#[cfg(test)]\n#[path = \"lib_tests.rs\"]\nmod tests;\n",
    )
    .expect("write lib.rs");
    fs::write(
        src.join("prod_tests.rs"),
        "pub fn bad() { let _ = libc::getpid; }\n",
    )
    .expect("write prod_tests.rs");
    fs::write(src.join("lib_tests.rs"), "#[test] fn ok() {}\n").expect("write lib_tests.rs");

    let sources = production_rust_sources(&src);
    assert!(sources.contains(&src.join("lib.rs")));
    assert!(
        sources.contains(&src.join("prod_tests.rs")),
        "production-linked *_tests.rs must remain in production policy scan",
    );
    assert!(
        !sources.contains(&src.join("lib_tests.rs")),
        "cfg(test)-only sibling *_tests.rs should be excluded",
    );
}

#[test]
fn nested_cfg_any_and_transitive_shared_includes_remain_in_production_scan() {
    let dir = tempfile::tempdir().expect("create tempdir");
    let src = dir.path().join("src");
    fs::create_dir(&src).expect("create src dir");
    fs::write(
        src.join("lib.rs"),
        concat!(
            "#[cfg(all(any(unix, test, windows)))]\n",
            "mod nested_prod;\n",
            "#[cfg(test)]\n",
            "mod shared;\n",
            "include!(\"shared.rs\");\n",
        ),
    )
    .expect("write lib.rs");
    fs::write(src.join("nested_prod.rs"), "pub fn prod() {}\n").expect("write nested_prod.rs");
    fs::write(src.join("shared.rs"), "include!(\"leaf.rs\");\n").expect("write shared.rs");
    fs::write(src.join("leaf.rs"), "pub fn leaf() {}\n").expect("write leaf.rs");

    let sources = production_rust_sources(&src);
    assert!(
        sources.contains(&src.join("nested_prod.rs")),
        "cfg(all(any(unix, test, windows))) does not imply test and must stay in production scan",
    );
    assert!(
        sources.contains(&src.join("shared.rs")),
        "file included in production must stay in production scan even with a cfg(test) mod edge",
    );
    assert!(
        sources.contains(&src.join("leaf.rs")),
        "transitive include from a shared production file must stay in production scan",
    );
}

#[test]
fn cfg_comments_cargo_bin_entries_and_brace_includes_remain_in_production_scan() {
    let dir = tempfile::tempdir().expect("create tempdir");
    let src = dir.path().join("src");
    let bin = src.join("bin");
    fs::create_dir_all(&bin).expect("create src/bin dir");
    fs::write(
        dir.path().join("Cargo.toml"),
        concat!(
            "[package]\n",
            r#"name = "fixture""#,
            "\n",
            r#"version = "0.1.0""#,
            "\n",
            "[[bin]]\n",
            r#"name = "custom""#,
            "\n",
            r#"path = "src/custom.rs" # comment"#,
            "\n",
        ),
    )
    .expect("write Cargo.toml");
    fs::write(
        src.join("lib.rs"),
        concat!(
            "mod live; // production\n",
            "#[cfg(test)]\n",
            r#"#[path = "live.rs"]"#,
            "\n",
            "mod live_alias;\n",
            "#[cfg(all(unix /* supported: linux, test, macOS */))]\n",
            "mod commented_prod;\n",
            "#[cfg(test)]\n",
            r#"#[path = "bin/tool.rs"]"#,
            "\n",
            "mod tool_under_test;\n",
            "#[cfg(test)]\n",
            r#"#[path = "custom.rs"]"#,
            "\n",
            "mod custom_under_test;\n",
            "#[cfg(test)]\n",
            r#"#[path = "brace_included.rs"]"#,
            "\n",
            "mod brace_included_test;\n",
            r##"const RAW: &str = r#"quote " then /* not a comment "#;"##,
            "\n",
            "const CHARS: [char; 2] = ['\\'','\"'];\n",
            r#"include /* note */ ! { "brace_included.rs" }"#,
            "\n",
        ),
    )
    .expect("write lib.rs");
    fs::write(src.join("live.rs"), "pub fn live() {}\n").expect("write live.rs");
    fs::write(src.join("commented_prod.rs"), "pub fn prod() {}\n")
        .expect("write commented_prod.rs");
    fs::write(bin.join("tool.rs"), "fn main() {}\n").expect("write bin/tool.rs");
    fs::write(src.join("custom.rs"), "fn main() {}\n").expect("write custom.rs");
    fs::write(src.join("brace_included.rs"), "pub fn inc() {}\n").expect("write brace_included.rs");

    let lib_source = fs::read_to_string(src.join("lib.rs")).expect("read lib.rs");
    assert!(
        parse_include_targets(&src.join("lib.rs"), &lib_source)
            .contains(&src.join("brace_included.rs")),
        "include! after raw string and escaped quote char literal must be detected",
    );

    let sources = production_rust_sources(&src);
    assert!(
        sources.contains(&src.join("live.rs")),
        "trailing line comment on production mod must not drop it when a cfg(test) alias exists",
    );
    assert!(
        sources.contains(&src.join("commented_prod.rs")),
        "comment containing `, test,` inside cfg(all(...)) must not hide production module",
    );
    assert!(
        sources.contains(&bin.join("tool.rs")),
        "Cargo src/bin/*.rs entry point must remain in production scan even if referenced by cfg(test)",
    );
    assert!(
        sources.contains(&src.join("custom.rs")),
        "explicit [[bin]] path with trailing TOML comment must remain in production scan",
    );
    assert!(
        sources.contains(&src.join("brace_included.rs")),
        "commented brace-form include! target must remain in production scan even with a cfg(test) alias",
    );
}
