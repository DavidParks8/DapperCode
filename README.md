# DapperCode

DapperCode controls ACP-compatible coding agents from a phone. The desktop app owns an authenticated
Rust bridge beside your repositories; the Expo mobile app connects over a trusted LAN, VPN, or
Tailscale network.

The bridge is private-network software. Keep authentication enabled and never expose it directly to
the public internet.

## Product Layout

- `apps/desktop`: Rust `dappercode` operator plus the native macOS SwiftUI/AppKit shell
- `services/rust-bridge`: Axum bridge and ACP process manager
- `apps/mobile`: Expo and React Native client
- `contracts`: versioned bridge RPC fixtures
- `scripts`: development, contract, version, coverage, and app-bundle automation

There is no npm bridge package and no JavaScript operator CLI. npm is used only for the mobile and
repository development toolchain. The macOS app bundles both Rust executables:

```text
DapperCode.app
├── Contents/MacOS/DapperCode                  # native SwiftUI/AppKit shell
└── Contents/Resources/bin/
    ├── dappercode                             # Rust operator CLI
    └── dappercode-bridge                      # Rust bridge
```

## macOS App

Build and open the self-contained app:

```bash
npm ci
npm run desktop:build:macos
open apps/desktop/dist/DapperCode.app
```

The app provides native menu-bar lifecycle, first-time setup, bridge start/stop/restart,
authenticated status, pairing QR, logs, workspace selection, and launch-at-login.

The shell uses standard SwiftUI and AppKit controls, menus, forms, materials, panels, and SF
Symbols. It does not draw or freeze a custom theme. Appearance is inherited from the installed
macOS version, so changes such as Liquid Glass are supplied by the OS without a DapperCode update.
The equivalent guarantee on Windows will require a native WinUI shell so Mica and future Windows
styling come from Windows itself.

First-time setup registers an ACP executable already installed on the Mac, such as OpenCode. The
Rust operator hashes that executable and stores the resulting configuration centrally, in
`~/Library/Application Support/dev.dappercode.desktop`, never inside your repositories. The bridge
bearer token is kept in the macOS keychain. It does not invoke npm, npx, Node.js, shell setup
scripts, or floating package resolution.

Each workspace gets its own profile, port pair, and token, so bridges for several worktrees run at
the same time. Quitting DapperCode stops all of them, and each bridge also exits on its own if the
app is force-quit or crashes.

## Rust Operator

For direct terminal operation from a source checkout:

```bash
npm run operator -- discover-agent --agent-id opencode
npm run operator -- setup --workspace "$PWD" --network local --host 192.168.1.20 \
  --agent-id opencode --agent-args acp
npm run operator -- start --workspace "$PWD"
npm run operator -- status --workspace "$PWD" --human
npm run operator -- restart --workspace "$PWD"
npm run operator -- stop --workspace "$PWD"
```

The installed app's operator is at:

```text
DapperCode.app/Contents/Resources/bin/dappercode
```

The operator is the only bridge process-control authority. It serializes transitions with a
workspace lock and verifies PID, process start time, executable, workspace, and config identity
before signaling a process.

## Mobile Development

Requirements: Node.js 22.13+, npm 10+, Rust 1.97.1, and Git.

```bash
npm ci
npm run mobile
```

Use a LAN or Tailscale bridge address on physical devices. `localhost` on a phone refers to the
phone, not the Mac running the bridge.

## Quality Gates

```bash
npm run lint
npm run duplicates:check
npm run typecheck
npm run test
npm run contract:check
npm run coverage:check
npm run coverage:rust
npm run desktop:build:macos
```

`npm run duplicates:check` scans authored mobile TypeScript and native Rust/Swift sources with
separate production-focused thresholds. Generated artifacts and dedicated test files/directories
are excluded; inline Rust unit tests remain subject to the native high-signal threshold.

GitHub Actions validates repository policy, RPC contracts, mobile quality/coverage, Rust bridge
quality/coverage, and a signed macOS app bundle. Mobile EAS distribution remains a separate
protected workflow. There is no npm publication workflow for the bridge.

## Documentation

- [Setup and operations](docs/setup-and-operations.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Mobile end-to-end layout tests](docs/mobile-e2e-tests.md)
- [Realtime streaming limitations](docs/realtime-streaming-limitations.md)
- [Push notifications](docs/push-notifications.md)
- [Browser preview limitations](docs/browser-preview-limitations.md)
- [Privacy policy](docs/privacy-policy.md)
- [Terms of service](docs/terms-of-service.md)
- [Security policy](SECURITY.md)

## License

DapperCode is distributed under the [MIT License](LICENSE).
