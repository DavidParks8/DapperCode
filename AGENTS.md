# AGENTS

## Purpose

DapperCode controls ACP-compatible coding agents from a phone.

- `apps/mobile`: Expo React Native client
- `apps/desktop`: Rust operator plus native desktop shells
- `services/rust-bridge`: authenticated ACP bridge and host services
- `scripts`: development, bundle, contract, version, and coverage automation

The bridge is private-network software. Never treat it as internet-safe by default.

## Architecture

### Desktop

- `apps/desktop/src/main.rs`: Rust `dappercode` operator CLI and JSON contract
- `apps/desktop/src/setup.rs`: local ACP executable registration and secure config
- `apps/desktop/src/supervisor.rs`: locked process lifecycle and authenticated status
- `apps/desktop/src/config.rs`: runtime/resource/config discovery
- `apps/desktop/macos/DapperCodeApp.swift`: native SwiftUI/AppKit menu-bar shell
- `scripts/build-desktop-macos.mjs`: deterministic macOS app assembly

The app bundle contains a native Swift executable and two Rust executables. It must not contain
Node, npm, JavaScript, npm manifests, `node_modules`, or Slint. macOS styling comes from standard
SwiftUI/AppKit controls. Windows will require a native WinUI shell for Mica/future OS styling.

### Bridge

- `services/rust-bridge/src/main.rs`: Axum composition root
- `src/acp/manager.rs`: installed ACP agent/session lifecycle
- `src/acp/runtime.rs`: typed ACP transport and events
- `src/services/git.rs`: Git helpers
- `src/services/terminal.rs`: constrained terminal execution

The bridge is configured purely by environment variables. The desktop operator builds that
environment in memory from its central store and never writes a secret to a repository. Rust setup
registers and hashes an already-installed ACP executable; it does not install package-manager
distributions.

- `apps/desktop/src/store.rs`: central data directory, per-workspace profiles, `config.json`
- `apps/desktop/src/secrets.rs`: keychain-backed bridge tokens with a private-file fallback
- `services/rust-bridge/src/owner_watchdog.rs`: bridge exits when the desktop app does

### Mobile

- `apps/mobile/App.tsx`: app shell and custom navigation
- `src/api`: bridge client, WebSocket transport, typed contracts
- `src/state`: jotai atoms for cross-component state (see `docs/mobile-state.md`)
- `src/screens`: main product surfaces
- `ios`: active Expo native iOS project

`MainScreen.tsx` is large; edit it surgically.

## Primary Commands

```bash
npm run mobile
npm run ios
npm run android
npm run bridge
npm run operator -- status --workspace <path>
npm run desktop:check
npm run desktop:test
npm run desktop:build:macos
npm run lint
npm run typecheck
npm run test
npm run contract:check
npm run coverage:rust
npm run release:testflight -- --dry-run
```

Do not automatically restart a user bridge during debugging unless explicitly requested.

## Editing Rules

- Keep bridge contract changes mirrored in Rust, mobile types/client, fixtures, tests, and docs.
- Setup/lifecycle changes belong under `apps/desktop/src` and native shell directories, not npm scripts.
- Never add an npm bridge package, JavaScript operator fallback, or bridge update RPC.
- Never write app-owned configuration or state into a user repository; it belongs in the central data
  directory (`DAPPERCODE_DATA_DIR` overrides it for tests).
- Preserve the central data directory, keychain entries, bridge logs, and user-installed agent state.
- Bridge ports are allocated per workspace, never hard-coded, so parallel worktrees keep working.
- Cross-component mobile state lives in `apps/mobile/src/state` as jotai atoms; keep state used by a
  single component as `useState`. Never store a thenable value in an atom — jotai suspends on it.
- Do not edit generated/vendor paths such as `node_modules`, `.expo`, `target`, Pods, or `dist`.
- The active iOS project is `apps/mobile/ios`, not the old root `ios` directory.
- Version changes must keep both Rust lockfiles and mobile metadata synchronized.

## Validation

Desktop changes:

```bash
cargo fmt --check --manifest-path apps/desktop/Cargo.toml
cargo clippy --locked --all-targets --manifest-path apps/desktop/Cargo.toml -- -D warnings
cargo test --locked --manifest-path apps/desktop/Cargo.toml -- --test-threads=1
npm run desktop:build:macos
```

Bridge changes:

```bash
cargo fmt --check --manifest-path services/rust-bridge/Cargo.toml
cargo check --locked --all-targets --all-features --manifest-path services/rust-bridge/Cargo.toml
cargo test --locked --all-targets --all-features --manifest-path services/rust-bridge/Cargo.toml -- --test-threads=1
```

Mobile changes:

```bash
npm run lint -w @dappercode/mobile
npm run typecheck -w @dappercode/mobile
npm run test -w @dappercode/mobile
```

Use `docs/setup-and-operations.md` for smoke tests and `docs/troubleshooting.md` for recovery.
