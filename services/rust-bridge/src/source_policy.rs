use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

fn non_platform_sources() -> Vec<PathBuf> {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut sources = Vec::new();
    collect_rust_sources(&workspace.join("src"), &mut sources);
    for entry in fs::read_dir(workspace.join("crates")).expect("list bridge crates") {
        let entry = entry.expect("read bridge crate");
        if entry.file_name() == "platform" {
            continue;
        }
        let source_root = entry.path().join("src");
        if source_root.is_dir() {
            collect_rust_sources(&source_root, &mut sources);
        }
    }
    sources.retain(|path| !path.ends_with("source_policy.rs"));
    sources
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
        "the process tree must be terminated before pipe readers are joined"
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
        block_depth += line.chars().filter(|character| *character == '{').count() as i32;
        block_depth -= line.chars().filter(|character| *character == '}').count() as i32;
        if block_depth == 0 && (line.contains(';') || line.contains('}') || trimmed.ends_with(','))
        {
            skipping = false;
        }
    }
    production
}
