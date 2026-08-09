# Contributing to DapperCode

Read [README.md](README.md), [setup and operations](docs/setup-and-operations.md), and
[troubleshooting](docs/troubleshooting.md) before starting.

## Project Shape

- `apps/mobile`: Expo React Native client
- `apps/desktop`: Rust operator and native platform shells
- `services/rust-bridge`: authenticated Rust bridge
- `scripts`: development and artifact automation

## Development

```bash
npm ci
npm run desktop:build:macos
npm run mobile
```

Useful focused commands:

```bash
npm run operator -- status --workspace "$PWD"
npm run desktop:test
npm run contract:check
npm run lint
npm run duplicates:check
npm run typecheck
npm run test
```

`npm run duplicates:check` validates authored mobile and native source separately. Generated
artifacts and dedicated test files/directories are excluded; inline Rust unit tests remain subject
to the native high-signal threshold.

The repository pins Rust in `rust-toolchain.toml`.

Repository commands run Cargo through `npm run cargo -- <args>`. Local builds use an isolated target
directory per Git worktree under the operating system cache directory. Each invocation removes
inactive managed targets whose worktrees are no longer registered, preventing deleted Copilot
worktrees from leaving Rust build artifacts behind. CI retains its checkout-local targets for
GitHub Actions caching. Set `DAPPERCODE_MANAGED_CARGO_TARGETS=0` to opt out locally, or
`DAPPERCODE_CARGO_TARGET_ROOT` to override the cache root.

## Guidelines

- Keep changes scoped.
- Never expose the bridge publicly.
- Mirror bridge contract changes across Rust, mobile, fixtures, tests, and docs.
- Keep bridge setup and lifecycle in Rust; do not add npm/Node/JavaScript operator fallbacks.
- Native shells should use OS controls and styling rather than hard-coded cross-platform themes.
- Do not edit generated paths such as `node_modules`, `.expo`, `target`, `dist`, or Pods.
- Update documentation when setup, runtime, platform, or distribution behavior changes.

Before a pull request, run the relevant quality gates and include screenshots for native UI changes.
Use private vulnerability reporting for security issues; see [SECURITY.md](SECURITY.md).
