# Setup and Operations

DapperCode's desktop app owns bridge setup and lifecycle. The bridge is not distributed through npm.
The macOS app uses a native SwiftUI/AppKit shell. The Windows app uses a native C# WinUI 3 shell.
Both packages contain the Rust `dappercode` operator and Rust bridge and expose the same setup,
pairing, workspace, status, logs, and lifecycle capabilities.

## macOS Setup

Build and open the app from a source checkout:

```bash
npm ci
npm run desktop:build:macos
open apps/desktop/dist/DapperCode.app
```

In the app:

1. Choose the workspace the bridge may access.
2. Choose an installed ACP executable. OpenCode is discovered automatically in standard paths.
3. Select Tailscale or local-network access.
4. Confirm the host and bridge port.
5. Select **Set Up and Start**.
6. Scan the pairing QR from the mobile app.

The app uses native file panels, forms, buttons, menus, pickers, alerts, and launch-at-login APIs.
Styling and materials come from AppKit/SwiftUI on the installed macOS release.

Tailscale mode requires the Tailscale app to be installed and connected. Local mode detects common
macOS interfaces; a concrete LAN IP can also be entered manually.

## Windows 11 Setup

The Windows desktop build is a packaged, tray-first WinUI 3 app. Its MSIX bundle contains separate
x64 and ARM64 packages; App Installer selects the package for the current computer.

The installed app runs entirely in the signed-in user's session. It does not install a Windows
service, request elevation, register a scheduled task, or write machine-wide configuration.
Production-signed installation and normal use require no administrator rights. A local test-signed
build requires one elevated certificate-trust step; the app remains non-elevated afterward. The
optional packaged startup task is per-user and disabled until the user enables **Launch at login**.

Build it on Windows with PowerShell 7 (`pwsh`), the pinned .NET 10 SDK (`10.0.302`, which supplies
MSBuild 18), the Windows SDK, the x64 and ARM64 Rust targets, Node.js, and npm:

```powershell
npm ci
npm run desktop:build:windows
```

Artifacts are written to `apps/desktop/dist/windows`, including
`DapperCode-<version>-x64_arm64.msixbundle`, `DapperCode-Signing.cer`, and
`INSTALL-WINDOWS.txt`. Architecture packages are written under `packages` as
`DapperCode-<version>-x64.msix` and `DapperCode-<version>-arm64.msix`. Test signing is the default:
local builds create and use a current-user test certificate but do not install it into a trust store.
Before installing on a local test computer, trust that emitted public certificate from an elevated
terminal:

```powershell
certutil -addstore TrustedPeople .\DapperCode-Signing.cer
Add-AppxPackage .\DapperCode-<version>-x64_arm64.msixbundle
```

This imports into Local Machine **Trusted People**, as required by App Installer. Trust only a
certificate produced by a checkout you control. Remove an obsolete test certificate from that store
after testing. Public packages must instead use the
two-phase production signing hook and a certificate trusted for distribution. First package with
only the non-secret production identity configured; certificate inputs are rejected during this
build phase:

```powershell
$env:DAPPERCODE_WINDOWS_SIGNING_MODE = "Production"
$env:DAPPERCODE_WINDOWS_PUBLISHER = "CN=<distribution identity>"
npm run desktop:build:windows
```

After the checkout, dependency installation, tests, and unsigned build have completed, provide the
PFX from outside the repository only to the dedicated signing operation:

```powershell
$env:DAPPERCODE_WINDOWS_CERTIFICATE_PATH = "C:\secure\DapperCode.pfx"
$env:DAPPERCODE_WINDOWS_CERTIFICATE_PASSWORD = "<secret>"
$env:DAPPERCODE_WINDOWS_TIMESTAMP_URL = "https://<provider>/rfc3161"
& .\scripts\build-desktop-windows.ps1 -SigningMode Production -Operation Sign

Remove-Item Env:DAPPERCODE_WINDOWS_CERTIFICATE_PATH
Remove-Item Env:DAPPERCODE_WINDOWS_CERTIFICATE_PASSWORD
npm run desktop:test:windows -- -SigningMode Production
```

`DAPPERCODE_WINDOWS_CERTIFICATE_BASE64` may replace the external path in protected CI. Never commit
the PFX or password and never expose either value to checkout, npm, build, or test steps. The
timestamp URL is mandatory and must identify the provider's RFC 3161 endpoint; production signing
uses SignTool `/tr` with `/td SHA256` (and `/fd SHA256`) and fails closed when any signing input is
absent.

GitHub Actions first builds, tests, and fully inspects the unsigned bundle and both standalone
packages without signing secrets. A separate `main`-only job downloads that artifact into the
approval-protected `windows-production-signing` environment. That job performs no checkout and runs
no repository script: its inline workflow PowerShell validates the exact artifact set, certificate
subject, and HTTPS timestamp endpoint before using the PFX and password to sign. It then verifies
every signature and emits the public certificate and installation guidance. Configure required
reviewers on that environment before enabling Production workflow dispatches.

Launch DapperCode from Start and complete the same in-app setup used on macOS:

1. Choose the workspace the bridge may access.
2. Choose an installed ACP executable.
3. Select Tailscale or local-network access and confirm the endpoint.
4. Select **Set Up and Start**, then pair the mobile app.

Closing the main window leaves DapperCode in the notification area. Use its tray menu to show the
window or quit; quitting stops the broker and its workspace workers. **Launch at login** controls the
packaged `DapperCodeStartup` task, which is disabled on install and never enables itself without the
user opting in. When enabled, sign-in starts the app quietly in the tray. Windows may disable the
task through **Settings > Apps > Startup**, and the app reflects that operating-system state.

WinUI owns the controls, keyboard behavior, accessibility semantics, Fluent resources, system theme,
and Mica backdrop where supported. DapperCode does not draw a substitute theme, so Windows 11
appearance and accessibility changes flow through without a custom-shell update.

## Where Configuration Lives

Nothing DapperCode owns is written into your repositories. Configuration, runtime state, and logs
live in a central per-user data directory:

- macOS: `~/Library/Application Support/dev.dappercode.desktop`
- Windows: `%APPDATA%\DapperCode`
- other Unix: `$XDG_DATA_HOME/dappercode`, else `~/.local/share/dappercode`
- override for development and tests: `DAPPERCODE_DATA_DIR`

```
<data-dir>/
  config.json                  non-secret settings for every workspace
  runtime/config.lock          guards concurrent config.json updates
  runtime/broker/              broker ownership record and transition lock
  broker.log                   stable broker log
  secrets/bridge-auth-vault.json  private fallback when the system credential store is unavailable
  secrets/<profileId>.json     unused legacy credential files
  profiles/<profileId>/
    agents.json                typed ACP manifest with digest
    bridge.log
    runtime/                   legacy ownership data retained for safe migration
    state/                     session index, push registry
    attachments/               mobile uploads
```

Each workspace gets a profile keyed by a hash of its canonical path, so separate worktrees of the
same repository are independent. Every file is written through restrictive-mode temporary files and
atomic rename.

Bridge bearer tokens are **not** in `config.json`. macOS stores distinct workspace tokens together
under Keychain service `dev.dappercode.desktop`, account `bridge-auth-vault:v1`. Windows uses the
same service with one bounded Generic Credential per workspace, named
`bridge-auth-token:v2:<sha256-profile-id>`, plus the fixed `bridge-auth-vault:v2` layout marker. The
operator migrates an older shared Windows vault before removing it. If initial credential-store
persistence is unavailable (for example, headless Linux or CI), storage falls back to a `0600` file
under `secrets/`; it never silently downgrades existing system credentials after a later update
failure. The app reports which backend is in use. Set `DAPPERCODE_SECRETS_BACKEND=file` to explicitly
select the fallback.

Because the macOS app is ad-hoc code-signed, every rebuild produces a new code signature and macOS
asks for keychain access again. The shared vault limits that to one item instead of one prompt per
workspace. This remains expected until the app is signed with a stable identity.

Setup registers an existing executable; it does not download or execute package-manager code. A
vault-backed workspace token and the broker endpoint are preserved when setup is rerun.

For OpenCode, the default ACP argument is `acp`. Other agents may require a different argument list.

## Broker and Lazy Workspace Runtimes

The first configured workspace allocates the stable public broker port. Every later workspace uses
that endpoint but receives a different credential. Browser previews retain a distinct per-workspace
port so cookies, storage, and service workers never cross workspace browser origins; that preview
listener exists only while the workspace worker is running. The broker validates the credential and
optional workspace claim before it allocates anything; a credential can route only to its own
canonical workspace profile.

Configured profiles are metadata, not processes. Five hundred profiles still start one broker and
zero workspace workers until requests arrive. On the first authenticated WebSocket or HTTP request,
the broker starts a loopback-only `dappercode-bridge` worker with that profile's manifest, workspace,
state, and attachment roots. It rewrites the external credential to a random worker-only credential
and holds the original connection until the worker accepts it, so a first mobile send wakes a
dormant workspace and continues the same submission.

The default pool admits at most 12 workers and retains at most two idle workers. A worker must be
idle for a full 60-second grace period before it is LRU-eligible. It is never idle while it has a
connected client, active or admitting run, queued message, pending steer, approval, user input,
preview session, in-flight request, or other queue transition. A failed activity probe also fails
closed as busy. Runs that were admitted continue after the phone disconnects.

The worker owns replay while it is warm. If it retires, durable session snapshots remain in the
profile state directory; the next worker has a new stream identity, so the existing mobile
snapshot-required recovery path reloads state instead of treating a new stream as a continuation.
Submission, thread-create, fork, and approval-resolution idempotency records are persisted beside
those snapshots, so a retry after retirement cannot duplicate already-admitted work.

`dappercode list` reports every configured profile without waking it. `dappercode stop --all` tears
down the one broker, which in turn stops all workers.

### Version 1 migration

On first launch, the operator atomically upgrades the old per-workspace-listener config. It chooses
the lexicographically first profile ID as the canonical broker endpoint and keeps every profile ID,
manifest, state directory, and attachment directory. The credential migration intentionally rotates
legacy per-workspace keychain tokens; re-pair each phone once after upgrading. Legacy
keychain items are left untouched but are no longer read. The broker also listens on previous bridge
ports as compatibility aliases while clients move to the canonical endpoint.

## Agent Integrity

Native setup records the lowercase SHA-256 digest of the selected executable. The Rust bridge
rechecks that digest immediately before constructing the SDK process transport, so a moved or
modified executable fails closed and must be registered again.

The bridge also retains compatibility with typed `dappercode-tree-v1` manifests. When such a
manifest is loaded, it independently recomputes the complete controlled installation tree. The
receipt is deterministic JSON Lines and excludes only `.dappercode-install.json` to avoid
self-reference. Validation rejects more than 100,000 entries, more than 2 GiB of regular-file
content, paths over 4,096 UTF-8 bytes, receipts over 32 MiB, escaping or broken symlinks,
hardlinked regular files, special files, and non-UTF-8 paths.

## Rust Operator

The app calls the bundled operator with JSON output. The same commands are available from a source
checkout:

```bash
npm run operator -- discover-agent --agent-id opencode
npm run operator -- setup --workspace /path/to/repository \
  --network tailscale --agent-id opencode --agent-args acp
npm run operator -- start --workspace /path/to/repository --owner-pid $$
npm run operator -- status --workspace /path/to/repository --human
npm run operator -- restart --workspace /path/to/repository
npm run operator -- stop --workspace /path/to/repository
npm run operator -- list --human
npm run operator -- stop --all
npm run operator -- forget --workspace /path/to/repository
```

`setup` accepts:

- `--network local|tailscale`
- `--host <ip-or-hostname>`; optional when the platform backend can discover it
- `--port <port>`; optional for the first workspace. Later workspaces share that broker port while
  setup allocates each workspace a distinct preview port.
- `--replace-broker-endpoint`; changes the shared host/network/port only while the broker is stopped,
  retaining the previous address as an authenticated compatibility alias.
- `--agent-id <id>`
- `--display-name <name>`
- `--agent-executable <path>`; optional when the agent is discoverable
- `--agent-args '<space-separated arguments>'`

`start` and `restart` accept `--owner-pid <pid>`; the broker exits when that process does. `list`
returns one snapshot per configured workspace without waking workers. `stop --all` stops the broker
and all workers while preserving the remembered launch intent for the next desktop app launch.
`forget` removes a workspace's profile, token, and profile directory once the broker is stopped.

## Process Ownership

The desktop operator serializes start/stop/restart with a private broker file lease. It stores
a versioned ownership record containing:

- PID
- OS process start time
- canonical broker executable
- canonical central data directory
- secure-config SHA-256

A live owned broker remains stoppable when health is temporarily unavailable or stored
configuration needs repair.

The recorded configuration digest covers everything the bridge was started with **except** the token,
so the ownership record never contains a secret.

## Bridge Lifetime

The desktop app passes its own process ID as `--owner-pid`. The broker watches that exact PID and
start time; every worker separately watches the broker PID. Quitting the app runs
`dappercode stop --all`; a force-quit or crash also causes the broker and then every worker to exit.
The standalone `npm run bridge` development flow remains workspace-bound and keeps its existing
owner behavior. The native shell restores the broker once, regardless of profile count.
While the broker is running, the desktop shell keeps one authenticated broker-level WebSocket
observer open. A broker crash or external kill closes it and triggers immediate operator
reconciliation. Reconnects use bounded backoff, while full operator reconciliation runs only on
launch, foreground presentation, explicit actions, or disconnect instead of continuously spawning
`status` and `list` processes.

## Runtime Configuration

The broker builds each worker environment in memory and passes it directly to the child process.
External workspace credentials never reach workers; worker-only credentials never reach disk.
Workers remain configured through the existing environment contract, which keeps `npm run bridge`
working:

- `BRIDGE_HOST`, `BRIDGE_PORT`
- `BRIDGE_PREVIEW_HOST`, `BRIDGE_PREVIEW_PORT`
- `BRIDGE_CONNECT_URL`, `BRIDGE_PREVIEW_CONNECT_URL`
- `BRIDGE_AUTH_TOKEN`
- `BRIDGE_ALLOW_QUERY_TOKEN_AUTH`
- `BRIDGE_WORKDIR`
- `BRIDGE_STATE_DIR`: bridge-owned state; defaults to `<workdir>/.dappercode`
- `BRIDGE_ATTACHMENTS_DIR`: mobile uploads; defaults to `<workdir>/.dappercode-attachments`
- `BRIDGE_OWNER_PID`: exit when this process does; unset means run until signalled
- `ACP_AGENT_MANIFEST`, `ACP_AGENT_ROOTS`
- `ACP_INITIALIZE_TIMEOUT_MS`

`BRIDGE_ATTACHMENTS_DIR` is a second allowed path root so agents and the mobile client can still read
uploads after they move out of the workspace. It must be an absolute path and must not be a symlink.
Broker workers set `BRIDGE_ALLOW_OUTSIDE_ROOT_CWD=false`, so every other path surface stays confined
to that credential's `BRIDGE_WORKDIR`.

Inbound WebSocket frames and reassembled messages default to a 32 MiB limit. Upload, Git,
filesystem, replay, queue, and preview surfaces have additional bounded byte or collection limits;
rejected requests and truncated responses include explicit resource metadata.

The bridge is for authenticated private networks only. Do not expose it directly to the public
internet. Query-token authentication exists for mobile compatibility; bearer authentication remains
preferred.

## Bridge API Summary

- `GET /health`: unauthenticated broker availability only; never allocates a worker
- `GET /broker/status`: authenticated workspace routing status; never allocates a worker
- `GET /broker/rpc`: authenticated desktop status WebSocket; never allocates a worker
- `GET /rpc`: authenticated WebSocket JSON-RPC
- `GET /status`: authenticated operational status
- `GET /local-image`: authenticated descriptor-relative image access beneath the allowed workspace
- `POST /attachments`: bearer-authenticated streamed upload with a 20 MiB file limit

Browser preview uses its separately configured listener rather than another route on the main bridge
listener. The versioned mobile RPC inventory is `contracts/bridge-rpc/v2/manifest.json`; the Rust
allowlist remains authoritative at runtime.

## Development

Start Expo independently after the desktop app has configured the bridge:

```bash
npm run mobile
```

The Expo bootstrap reads the bridge host from the central `config.json`, falling back to a repo-root
`.env.secure` for the `npm run bridge` development flow. Physical devices must use a LAN or Tailscale
bridge URL, not localhost.

The mobile app uses Expo Router with the `dappercode` scheme. Canonical links include
`dappercode://profiles/<profile-id>/chats/<thread-id>` and
`/profiles/<profile-id>/chats/<thread-id>` on web. Web output is a client-rendered single-page app;
any production host must rewrite unmatched paths to `index.html` so profile and chat URLs survive a
direct load or browser refresh.

## Distribution

`npm run desktop:build:macos` creates:

- `apps/desktop/dist/DapperCode.app`
- `apps/desktop/dist/DapperCode-<version>-<arch>.zip`

The build fails if the app contains Node, npm, npx, JavaScript, npm manifests, `node_modules`, or
Slint artifacts. Local builds are ad-hoc signed. Public distribution requires project-owned Apple
Developer signing and notarization.

The Windows build produces a test-signed x64/ARM64 MSIX bundle and its local test certificate. The
production path uploads an inspected unsigned artifact, then signs it in the protected, main-only
workflow job described above so release automation never treats the development certificate as
production identity. Each Windows package includes the C# WinUI 3 shell, both Rust executables, the
DapperCode license, and platform-aware third-party notices covering the Cargo and restored NuGet
dependency closures. The installed copies are `Licenses\DapperCode-LICENSE.txt` and
`Licenses\THIRD_PARTY_NOTICES.txt`.

Run `npm run desktop:test:windows` on Windows to inspect bundle signatures, identity, architectures,
native executable architecture, required payloads, and forbidden runtime content.

To uninstall, first choose **Quit** from the tray menu, then remove DapperCode from **Settings → Apps
→ Installed apps**. For a complete reset, remove credentials before deleting
`%APPDATA%\DapperCode`: in **Credential Manager → Windows Credentials**, remove every Generic
Credential for service `dev.dappercode.desktop` whose account matches `bridge-auth-token:v2:*`, the
`bridge-auth-vault:v2` layout marker, any legacy `bridge-auth-vault:v1` shared vault, and any legacy
`bridge-auth-token:<profile-id>` entry. Only then delete `%APPDATA%\DapperCode`. Removing that data
discards every configured workspace, bridge token, session snapshot, attachment, and log;
reinstalling or relaunching then requires setup and pairing again.
