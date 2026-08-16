# DapperCode

DapperCode controls ACP-compatible coding agents from a phone. The desktop app owns an authenticated
Rust bridge beside your repositories; the Expo mobile app connects over a trusted LAN, VPN, or
Tailscale network.

The bridge is private-network software. Keep authentication enabled and never expose it directly to
the public internet.

## Product Layout

- `apps/desktop`: Rust `dappercode` operator plus native macOS and Windows shells
- `services/rust-bridge`: Axum bridge and ACP process manager
- `apps/mobile`: Expo and React Native client
- `contracts`: versioned bridge RPC fixtures
- `scripts`: development, contract, version, coverage, and app-bundle automation

There is no published Node bridge package and no JavaScript operator CLI. pnpm is used only for the
mobile and repository development toolchain. Each desktop package includes the Rust operator and bridge. On
macOS the layout is:

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
pnpm install --frozen-lockfile
pnpm run desktop:build:macos
open apps/desktop/dist/DapperCode.app
```

The app provides native menu-bar lifecycle, first-time setup, authenticated status, pairing QR,
logs, workspace selection, and launch-at-login. The broker starts with the tray app and stops when
the app quits; users do not manually start, stop, or restart it from the desktop shell.

The shell uses standard SwiftUI and AppKit controls, menus, forms, materials, panels, and SF
Symbols. It does not draw or freeze a custom theme. Appearance is inherited from the installed
macOS version, so changes such as Liquid Glass are supplied by the OS without a DapperCode update.

## Windows App

The Windows 11 app is a packaged C# WinUI 3 tray-first app with full setup, pairing, workspace,
status, logs, and automatic bridge lifecycle parity. The broker starts with the tray app and stops
when it quits, without manual state controls. The release artifact is one MSIX bundle containing
x64 and ARM64 packages. Its shell uses native WinUI controls, Fluent system resources, and Mica
where Windows supports it, so accessibility, theme, and future platform styling remain owned by
Windows rather than a frozen custom theme.

It runs as the signed-in user and does not install a Windows service, request elevation, create a
scheduled task, or require administrator rights at runtime. Production-signed installation is also
non-elevated; trusting a local self-signed development certificate is the only one-time
administrator step. Bridge processes remain children owned by the per-user tray app.

Closing the window keeps DapperCode in the notification area; **Quit** stops the broker and exits.
The `DapperCodeStartup` package startup task is disabled on install and changes only when the user
opts in through **Launch at login**. Startup launches quietly into the tray, while an explicit app
launch presents the window. Development packages use a local test certificate that must be trusted
before installation. Release packaging has a separate production certificate signing hook; a test
certificate is not a production trust mechanism.

On Windows with PowerShell 7 (`pwsh`), the pinned .NET 10 SDK (`10.0.302`, including MSBuild 18),
the Windows SDK, the x64 and ARM64 Rust targets, Node.js, and pnpm:

```powershell
pnpm install --frozen-lockfile
pnpm run desktop:build:windows
```

This creates the bundle, public test certificate, and installation instructions under
`apps/desktop/dist/windows`. The build does not install its generated test certificate for App
Installer or leave it trusted. Before installing a local test bundle, import the emitted public
certificate once into Local Machine **Trusted People** from an elevated terminal.

First-time setup registers an ACP executable already installed on the computer, such as OpenCode. The
Rust operator hashes that executable and stores the resulting configuration centrally, in
the platform application-data directory, never inside your repositories. Distinct workspace bearer
tokens are protected by the operating-system credential store: one shared macOS Keychain vault and
bounded per-workspace Windows Credential Manager entries. It does not invoke pnpm, npm, npx, Node.js,
shell setup scripts, or floating package resolution.

Every workspace keeps an isolated profile, vault entry, manifest, state directory, and attachment root.
One authenticated desktop broker owns the stable mobile RPC endpoint. A workspace bridge and ACP
child start only after that workspace's credential has authenticated and a request needs the
runtime. Active browser previews keep per-workspace origins rather than sharing broker cookies.
Admitted runs survive mobile disconnects; idle workers are retired conservatively after a grace
period, while queued work, active runs, approvals, user input, steers, previews, and reconnect replay
keep their worker alive.

## Rust Operator

For direct terminal operation from a source checkout:

```bash
pnpm run operator discover-agent --agent-id opencode
pnpm run operator setup --workspace "$PWD" --network local --host 192.168.1.20 \
  --agent-id opencode --agent-args acp
pnpm run operator start --workspace "$PWD"
pnpm run operator status --workspace "$PWD" --human
pnpm run operator restart --workspace "$PWD"
pnpm run operator stop --workspace "$PWD"
```

The installed macOS app's operator is at:

```text
DapperCode.app/Contents/Resources/bin/dappercode
```

The operator is the only broker process-control authority. It serializes transitions with a global
broker lock and verifies PID, process start time, executable, data directory, and config identity
before signaling the process. The broker owns and reaps isolated workspace workers.

## Mobile Development

Requirements: Node.js 22.13+, pnpm 11.1.2, Rust 1.97.1, and Git.

```bash
pnpm install --frozen-lockfile
pnpm run mobile
```

Use a LAN or Tailscale bridge address on physical devices. `localhost` on a phone refers to the
phone, not the computer running the bridge.

## Quality Gates

```bash
pnpm run lint
pnpm run duplicates:check
pnpm run typecheck
pnpm run test
pnpm run contract:check
pnpm run coverage:check
pnpm run coverage:rust
pnpm run desktop:build:macos
# On Windows:
pnpm run desktop:build:windows
```

`pnpm run duplicates:check` scans authored mobile TypeScript and native Rust/Swift sources with
separate production-focused thresholds. Generated artifacts and dedicated test files/directories
are excluded; inline Rust unit tests remain subject to the native high-signal threshold.

GitHub Actions validates repository policy, RPC contracts, mobile quality/coverage, Rust bridge
quality/coverage, and desktop packages. Mobile EAS distribution remains a separate protected
workflow. There is no package-registry publication workflow for the bridge.

## Documentation

- [Setup and operations](docs/setup-and-operations.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Realtime streaming limitations](docs/realtime-streaming-limitations.md)
- [Push notifications](docs/push-notifications.md)
- [Browser preview limitations](docs/browser-preview-limitations.md)
- [Privacy policy](docs/privacy-policy.md)
- [Terms of service](docs/terms-of-service.md)
- [Security policy](SECURITY.md)

## License

DapperCode is distributed under the [MIT License](LICENSE).
