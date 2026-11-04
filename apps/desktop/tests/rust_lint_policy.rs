use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

fn lint_section<'a>(manifest: &'a str, name: &str) -> &'a str {
    let heading = format!("[workspace.lints.{name}]\n");
    let section = manifest
        .split_once(&heading)
        .expect("workspace lint table must exist")
        .1;
    section
        .split_once("\n[")
        .map_or(section, |(section, _)| section)
}

fn check_fixture(directory: &Path, command: &str, source: &str) -> std::process::Output {
    fs::write(directory.join("src/main.rs"), source).expect("write lint fixture");
    Command::new(env!("CARGO"))
        .args([command, "--offline", "--quiet", "--all-targets"])
        .current_dir(directory)
        .env("CARGO_TARGET_DIR", directory.join("target"))
        .env_remove("RUSTUP_TOOLCHAIN")
        .output()
        .expect("run Cargo lint fixture")
}

#[test]
fn workspace_lint_policies_reject_representative_unsafe_and_lossy_code() {
    let desktop = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repository = desktop.parent().unwrap().parent().unwrap().to_path_buf();
    for workspace in [desktop, repository.join("services/rust-bridge")] {
        let manifest = fs::read_to_string(workspace.join("Cargo.toml")).expect("read manifest");
        let temporary = tempfile::tempdir().expect("create isolated lint fixture");
        fs::create_dir(temporary.path().join("src")).expect("create fixture source directory");
        fs::copy(
            repository.join("rust-toolchain.toml"),
            temporary.path().join("rust-toolchain.toml"),
        )
        .expect("copy pinned Rust toolchain");
        fs::copy(
            repository.join("clippy.toml"),
            temporary.path().join("clippy.toml"),
        )
        .expect("copy repository Clippy configuration");
        fs::write(
            temporary.path().join("Cargo.toml"),
            format!(
                "[package]\nname = \"lint-policy-fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\
                 [workspace]\n[workspace.lints.rust]\n{}\n[workspace.lints.clippy]\n{}\n\
                 [lints]\nworkspace = true\n",
                lint_section(&manifest, "rust"),
                lint_section(&manifest, "clippy"),
            ),
        )
        .expect("write fixture manifest");

        let clean = check_fixture(
            temporary.path(),
            "clippy",
            "fn main() {}\n#[cfg(test)] mod tests { #[test] fn assertion_failure_is_allowed() { let value = std::env::args().next().unwrap(); assert!(!value.is_empty()); if value.is_empty() { panic!(\"test failure\"); } } }\n",
        );
        assert!(
            clean.status.success(),
            "{} clean fixture failed: {}",
            workspace.display(),
            String::from_utf8_lossy(&clean.stderr)
        );
        let boundary = check_fixture(
            temporary.path(),
            "clippy",
            "fn main() { let buffer = [0u8; 16384]; std::hint::black_box(buffer); }\n",
        );
        assert!(
            boundary.status.success(),
            "16 KiB stack array must remain permitted: {}",
            String::from_utf8_lossy(&boundary.stderr)
        );

        let probes = [
            (
                "check",
                "pub unsafe fn read(p: *const u8) -> u8 { *p }\nfn main() {}\n",
                "unsafe-op-in-unsafe-fn",
            ),
            (
                "check",
                "fn main() { std::env::set_var(\"TEST_LINT_VALUE\", \"value\"); }\n",
                "deprecated-safe-2024",
            ),
            ("clippy", "fn main() { dbg!(1); }\n", "clippy::dbg-macro"),
            ("clippy", "fn main() { todo!(); }\n", "clippy::todo"),
            (
                "clippy",
                "fn main() { let value = std::env::args().nth(1); let _value = value.unwrap(); }\n",
                "clippy::unwrap-used",
            ),
            ("clippy", "fn main() { panic!(\"runtime failure\"); }\n", "clippy::panic"),
            (
                "clippy",
                "fn main() { let state = std::sync::Mutex::new(Some(1)); if let Some(value) = *state.lock().expect(\"lock\") { std::hint::black_box(value); }; }\n",
                "clippy::significant-drop-in-scrutinee",
            ),
            (
                "clippy",
                "fn main() { let buffer = [0u8; 16385]; std::hint::black_box(buffer); }\n",
                "clippy::large-stack-arrays",
            ),
            (
                "clippy",
                "async fn large() { let buffer = [0u8; 32768]; std::future::pending::<()>().await; std::hint::black_box(buffer); }\nfn main() { let _future = async { large().await }; }\n",
                "clippy::large-futures",
            ),
            (
                "check",
                "fn main() { std::hint::black_box(1); let unused = 1; }\n",
                "unused-variables",
            ),
            (
                "check",
                "fn main() { std::fs::read(\"missing\"); }\n",
                "unused-must-use",
            ),
            (
                "clippy",
                "#[expect(clippy::uninit_vec, reason = \"must not bypass soundness\")]\nfn main() {}\n",
                "incompatible with previous forbid",
            ),
            (
                "clippy",
                "fn main() { let value = std::env::args().count(); let _small = value as u8; }\n",
                "clippy::cast-possible-truncation",
            ),
            (
                "clippy",
                "fn main() { let value = 1u32; let pointer = &raw const value; let _value = unsafe { *pointer }; }\n",
                "clippy::undocumented-unsafe-blocks",
            ),
            (
                "clippy",
                "fn main() {\n let value = 1u32; let pointer = &raw const value;\n // SAFETY: pointer refers to value.\n let _values = unsafe { (*pointer, *pointer) };\n}\n",
                "clippy::multiple-unsafe-ops-per-block",
            ),
            (
                "clippy",
                "#[allow(dead_code, reason = \"fixture\")]\nfn unused() {}\nfn main() {}\n",
                "clippy::allow-attributes",
            ),
            (
                "clippy",
                "#[expect(dead_code)]\nfn unused() {}\nfn main() {}\n",
                "clippy::allow-attributes-without-reason",
            ),
        ];
        for (command, source, expected) in probes {
            let output = check_fixture(temporary.path(), command, source);
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert!(
                !output.status.success() && stderr.contains(expected),
                "{} did not reject {expected}: {stderr}",
                workspace.display()
            );
        }
    }
}
