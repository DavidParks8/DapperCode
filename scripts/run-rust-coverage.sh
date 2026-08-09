#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIDGE_DIR="$ROOT_DIR/services/rust-bridge"
DESKTOP_DIR="$ROOT_DIR/apps/desktop"
TOOLCHAIN="nightly-2026-07-15"
BRIDGE_REPORT_DIR="$BRIDGE_DIR/target/llvm-cov"
DESKTOP_REPORT_DIR="$DESKTOP_DIR/target/llvm-cov"

if ! rustup toolchain list | grep -q "^${TOOLCHAIN}"; then
  echo "Missing Rust coverage toolchain. Install it with:" >&2
  echo "  rustup toolchain install ${TOOLCHAIN} --profile minimal --component llvm-tools-preview" >&2
  exit 1
fi
if ! cargo llvm-cov --version >/dev/null 2>&1; then
  echo "Missing cargo-llvm-cov. Install it with:" >&2
  echo "  cargo install cargo-llvm-cov@0.8.7 --locked" >&2
  exit 1
fi

cargo_run() {
  node "$ROOT_DIR/scripts/run-cargo.mjs" "$@"
}

mkdir -p "$BRIDGE_REPORT_DIR"
(
  cd "$BRIDGE_DIR"
  cargo_run "+${TOOLCHAIN}" llvm-cov test \
    --locked \
    --bin dappercode-bridge \
    --branch \
    --json \
    --summary-only \
    --output-path "$BRIDGE_REPORT_DIR/coverage.json" \
    -- \
    --test-threads=1
  cargo_run "+${TOOLCHAIN}" llvm-cov report \
    --branch \
    --html \
    --output-dir "$BRIDGE_REPORT_DIR/html"
)

# The desktop operator owns the central configuration store and the bridge process lifecycle, so it
# is gated on branch coverage too. Secrets always use the private-file backend here so coverage runs
# never touch a real login keychain.
mkdir -p "$DESKTOP_REPORT_DIR"
(
  cd "$DESKTOP_DIR"
  DAPPERCODE_SECRETS_BACKEND=file cargo_run "+${TOOLCHAIN}" llvm-cov test \
    --locked \
    --bin dappercode \
    --branch \
    --json \
    --summary-only \
    --output-path "$DESKTOP_REPORT_DIR/coverage.json" \
    -- \
    --test-threads=1
  cargo_run "+${TOOLCHAIN}" llvm-cov report \
    --branch \
    --html \
    --output-dir "$DESKTOP_REPORT_DIR/html"
)

node "$ROOT_DIR/scripts/check-rust-coverage.mjs" \
  "bridge=$BRIDGE_REPORT_DIR/coverage.json" \
  "desktop=$DESKTOP_REPORT_DIR/coverage.json"
