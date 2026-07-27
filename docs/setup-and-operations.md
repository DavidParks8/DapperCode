# Setup and Operations

DapperCode's desktop app owns bridge setup and lifecycle. The bridge is not distributed through npm.
The macOS app contains a native SwiftUI/AppKit shell, the Rust `dappercode` operator, and the Rust
bridge.

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

## Transport Modes

Profiles use one canonical transport mode:

- `privateBearer` is the current production mode. It preserves bearer headers, native/mobile
  query-token compatibility when explicitly enabled, and the loopback-only no-auth development
  exception. It is private-network software for a trusted LAN, VPN, or Tailscale network and must
  never be exposed directly to the public internet.
- `tailnetPinnedTls` represents the future Tailscale-reachable transport using mutual TLS 1.3 and
  exact SHA-256 SPKI pins. Stage 0 defines and validates this contract, and the isolated
  [native platform proof](pinned-tls-platform-proof.md) exercises iOS-to-rustls feasibility without
  wiring production traffic. Pairing, the production pinned listener, device registry/enrollment,
  mobile migration, and key rotation are not implemented. Selecting this mode fails explicitly and
  never falls back to the current HTTP/bearer router.

Stored desktop and mobile profiles without `transportMode`, and bridge environments without
`BRIDGE_TRANSPORT_MODE`, migrate to `privateBearer`. Desktop setup, status, and list JSON report the
canonical non-secret mode. Mobile can preserve a future pinned profile without a bearer token, but
cannot create or connect it until secure device pairing exists; web does not support pinned mode.

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
  secrets/<profileId>.json     only when the keychain is unavailable
  profiles/<profileId>/
    agents.json                typed ACP manifest with digest
    bridge.log
    runtime/                   ownership record, transition lock, pid mirror
    state/                     session index, push registry
    attachments/               mobile uploads
```

Each workspace gets a profile keyed by a hash of its canonical path, so separate worktrees of the
same repository are independent. Every file is written through restrictive-mode temporary files and
atomic rename.

The bridge bearer token is **not** in `config.json`. It is stored in the operating system keychain
under service `dev.dappercode.desktop`, account `bridge-auth-token:<profileId>`. When no keychain is
available (headless Linux, CI) the token falls back to a `0600` file under `secrets/`, and the app
reports which backend is in use. Set `DAPPERCODE_SECRETS_BACKEND=file` to force the fallback.
Desktop-managed bridge processes suppress terminal pairing QR output so the token is not appended
to `bridge.log`; the native app renders pairing data directly. Existing logs from releases before
this protection are preserved and may contain an encoded pairing credential. Treat those logs as
sensitive. Credential rotation and historical-log rewriting are outside Stage 0.

Because the macOS app is ad-hoc code-signed, every rebuild produces a new code signature and macOS
asks for keychain access again. That is expected until the app is signed with a stable identity.

Setup registers an existing executable; it does not download or execute package-manager code. A
previous bridge token and port assignment are preserved when setup is rerun.

For OpenCode, the default ACP argument is `acp`. Other agents may require a different argument list.

## Running Several Worktrees at Once

Bridge ports are allocated per workspace rather than defaulted, so several bridges run in parallel:

- Setup scans upward from port 8787 in steps of two for a free consecutive `(bridge, preview)` pair.
- Pairs already assigned to another profile are skipped, and each candidate is bind-probed so ports
  held by unrelated processes are skipped too.
- The assignment is persisted, so a paired phone keeps working across restarts.
- Passing an explicit `--port` that another workspace owns fails and names that workspace.

`dappercode list` reports every configured profile with its state and port. `dappercode stop --all`
tears down every bridge this app owns, which is what the desktop app runs when you quit it.

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
- `--port <port>`; optional. Omit it to allocate the next free pair at or above `8787`
- `--agent-id <id>`
- `--display-name <name>`
- `--agent-executable <path>`; optional when the agent is discoverable
- `--agent-args '<space-separated arguments>'`

`start` and `restart` accept `--owner-pid <pid>`; the bridge exits when that process does. `list`
returns one snapshot per configured workspace. `stop --all` stops every bridge this app owns.
`forget` removes a workspace's profile, token, and profile directory once its bridge is stopped.

## Process Ownership

The desktop operator serializes start/stop/restart with a private per-workspace file lease. It stores
a versioned ownership record containing:

- PID
- OS process start time
- canonical bridge executable
- canonical workspace
- secure-config SHA-256

The legacy pid file under `profiles/<profileId>/runtime/` is only a compatibility mirror and never
authorizes a signal by itself. A live owned process remains stoppable when health is temporarily
unavailable or its stored configuration needs repair.

The recorded configuration digest covers everything the bridge was started with **except** the token,
so the ownership record never contains a secret.

## Bridge Lifetime

The desktop app passes its own process ID as `--owner-pid`, which the operator forwards to the bridge
as `BRIDGE_OWNER_PID`. Quitting the app runs `dappercode stop --all`; if the app is force-quit,
crashes, or is killed, each bridge notices its owner has exited and shuts itself down. On macOS this
uses a `kqueue` `NOTE_EXIT` watch, which cannot be fooled by a recycled process ID; other platforms
poll every two seconds. A bridge started without an owner (the `npm run bridge` development flow)
keeps running as before.

## Runtime Configuration

The operator builds the bridge environment in memory and passes it directly to the child process, so
the token never reaches disk outside the keychain. The bridge itself is still configured purely by
environment variables, which is what keeps `npm run bridge` working:

- `BRIDGE_TRANSPORT_MODE`: `privateBearer` (default) or `tailnetPinnedTls` (currently unavailable)
- `BRIDGE_NETWORK_MODE`
- `BRIDGE_HOST`, `BRIDGE_PORT`
- `BRIDGE_PREVIEW_HOST`, `BRIDGE_PREVIEW_PORT`
- `BRIDGE_CONNECT_URL`, `BRIDGE_PREVIEW_CONNECT_URL`
- `BRIDGE_AUTH_TOKEN`
- `BRIDGE_ALLOW_QUERY_TOKEN_AUTH`
- `BRIDGE_ENFORCE_AUTHENTICATED_ORIGINS`: opt-in Origin enforcement for authenticated
  `privateBearer` browser requests
- `BRIDGE_AUTHENTICATED_ALLOWED_ORIGINS`: comma-separated exact `http://` or `https://` origins
- `BRIDGE_NO_AUTH_ALLOWED_ORIGINS`: exact compatibility origins for loopback-only no-auth development
- `BRIDGE_PINNED_TLS_IDENTITY`, `BRIDGE_PINNED_TLS_DEVICE_REGISTRY`: reserved absolute paths required
  by `tailnetPinnedTls`; providing them does not make the unimplemented mode available
- `BRIDGE_WORKDIR`
- `BRIDGE_STATE_DIR`: bridge-owned state; defaults to `<workdir>/.dappercode`
- `BRIDGE_ATTACHMENTS_DIR`: mobile uploads; defaults to `<workdir>/.dappercode-attachments`
- `BRIDGE_OWNER_PID`: exit when this process does; unset means run until signalled
- `ACP_AGENT_MANIFEST`, `ACP_AGENT_ROOTS`
- `ACP_INITIALIZE_TIMEOUT_MS`

`BRIDGE_ATTACHMENTS_DIR` is a second allowed path root so agents and the mobile client can still read
uploads after they move out of the workspace. It must be an absolute path and must not be a symlink;
every other path surface stays confined to `BRIDGE_WORKDIR`.

Inbound WebSocket frames and reassembled messages default to a 32 MiB limit. Upload, Git,
filesystem, replay, queue, and preview surfaces have additional bounded byte or collection limits;
rejected requests and truncated responses include explicit resource metadata.

The bridge is for authenticated private networks only. Do not expose it directly to the public
internet. Query-token authentication exists for mobile compatibility; bearer authentication remains
preferred.

Authenticated `privateBearer` keeps its current Origin behavior unless
`BRIDGE_ENFORCE_AUTHENTICATED_ORIGINS=true`. With enforcement enabled, browser requests must use an
exact entry in `BRIDGE_AUTHENTICATED_ALLOWED_ORIGINS`; wildcard, `null`, malformed, and duplicate
Origin headers are rejected. Native and operator requests that omit Origin remain allowed after
bearer authentication. The future `tailnetPinnedTls` policy makes exact Origin enforcement
mandatory rather than opt-in.

Credential-shaped URL query values are redacted from bridge diagnostics, including `token`,
`access_token`, `auth`, `authorization`, `key`, `secret`, `password`, `code`, and preview `st`
parameters. Redaction affects rendered diagnostic text only, not request routing values.

## Bridge API Summary

- `GET /health`: unauthenticated minimal availability only
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
`.env.secure` for the `npm run bridge` development flow. Real phones must use a LAN or Tailscale
bridge URL, not localhost.

## Distribution

`npm run desktop:build:macos` creates:

- `apps/desktop/dist/DapperCode.app`
- `apps/desktop/dist/DapperCode-<version>-<arch>.zip`

The build fails if the app contains Node, npm, npx, JavaScript, npm manifests, `node_modules`, or
Slint artifacts. Local builds are ad-hoc signed. Public distribution requires project-owned Apple
Developer signing and notarization.

Windows and Linux need separate native shells over the Rust operator. A WinUI shell is required on
Windows to inherit Mica and future WinUI styling from the OS.
