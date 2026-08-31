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
Node, package-manager executables, JavaScript, package manifests, `node_modules`, or Slint. macOS
styling comes from standard
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

- `apps/mobile/src/app/_layout.tsx`: Expo Router app shell and root providers
- `src/bridge`: bridge client, WebSocket transport, and typed contracts
- `src/shell/state`: jotai atoms for shell-wide cross-feature state (see `docs/mobile-state.md`)
- `src/features`: feature-owned product surfaces and state, such as chat
- `ios`: active Expo native iOS project

`MainScreen.tsx` is large; edit it surgically.

## Primary Commands

```bash
pnpm run mobile
pnpm run ios
pnpm run android
pnpm run bridge
pnpm run operator status --workspace <path>
pnpm run desktop:check
pnpm run desktop:test
pnpm run desktop:build:macos
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run e2e
pnpm run contract:check
pnpm run coverage:rust
pnpm run release:testflight --dry-run
```

Do not automatically restart a user bridge during debugging unless explicitly requested.

## Editing Rules

- Keep bridge contract changes mirrored in Rust, mobile types/client, fixtures, tests, and docs.
- Setup/lifecycle changes belong under `apps/desktop/src` and native shell directories, not package scripts.
- Never add a Node bridge package, JavaScript operator fallback, or bridge update RPC.
- Never write app-owned configuration or state into a user repository; it belongs in the central data
  directory (`DAPPERCODE_DATA_DIR` overrides it for tests).
- Preserve the central data directory, keychain entries, bridge logs, and user-installed agent state.
- Bridge ports are allocated per workspace, never hard-coded, so parallel worktrees keep working.
- Shell-wide cross-component mobile state lives in `apps/mobile/src/shell/state` as jotai atoms;
  feature-owned state belongs under the owning feature in `apps/mobile/src/features`. Keep state used
  by a single component as `useState`. Never store a thenable value in an atom — jotai suspends on it.
- `testID` values referenced by `e2e/fixtures/selectors.ts` are test contracts; renaming one means
  updating that file. Add new handles there instead of inlining raw selector strings in specs.
- Do not edit generated/vendor paths such as `node_modules`, `.expo`, `target`, Pods, or `dist`.
- The active iOS project is `apps/mobile/ios`, not the old root `ios` directory.
- Version changes must keep both Rust lockfiles and mobile metadata synchronized.

## Regression Protection

- Every bug fix must include an automated regression test that fails on the broken behavior and
  passes with the fix. Reproduce the reported sequence; do not settle for testing a helper's final
  value when the defect depends on timing, ordering, navigation, or state transitions.
- Assert all user-visible states coupled to the defect. For lifecycle bugs, cover the transition
  from running to settled and every control derived from it, such as status text, loading
  indicators, stop/cancel actions, and composer availability.
- Test the lowest layer that owns the bug, then add an integration test when the failure crosses
  layers or only appears after components are wired together. Contract regressions still require
  mirrored Rust, mobile, fixture, and contract coverage.
- Do not weaken, delete, or broadly snapshot existing assertions to make a fix pass. If automated
  coverage is genuinely infeasible, explain why in the PR and provide deterministic manual
  reproduction and verification steps.

## Validation

Desktop changes:

```bash
pnpm run cargo fmt --check --manifest-path apps/desktop/Cargo.toml
pnpm run cargo clippy --locked --all-targets --manifest-path apps/desktop/Cargo.toml -- -D warnings
pnpm run cargo test --locked --manifest-path apps/desktop/Cargo.toml -- --test-threads=1
pnpm run desktop:build:macos
```

Bridge changes:

```bash
pnpm run cargo fmt --check --manifest-path services/rust-bridge/Cargo.toml
pnpm run cargo check --locked --all-targets --all-features --manifest-path services/rust-bridge/Cargo.toml
pnpm run cargo test --locked --all-targets --all-features --manifest-path services/rust-bridge/Cargo.toml -- --test-threads=1
```

Mobile changes:

```bash
pnpm --filter @dappercode/mobile run lint
pnpm --filter @dappercode/mobile run typecheck
pnpm --filter @dappercode/mobile run test
```

Mobile layout or navigation changes also need the end-to-end layout suite, which measures real
on-screen geometry through the production Rust bridge and a deterministic ACP fixture:

```bash
pnpm run e2e
pnpm run typecheck:e2e
```

Use `docs/setup-and-operations.md` for smoke tests and `docs/troubleshooting.md` for recovery.
