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
  secrets/<profileId>.json     only when the keychain is unavailable
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

The bridge bearer token is **not** in `config.json`. It is stored in the operating system keychain
under service `dev.dappercode.desktop`, account `bridge-auth-token:<profileId>`. When no keychain is
available (headless Linux, CI) the token falls back to a `0600` file under `secrets/`, and the app
reports which backend is in use. Set `DAPPERCODE_SECRETS_BACKEND=file` to force the fallback.

Because the macOS app is ad-hoc code-signed, every rebuild produces a new code signature and macOS
asks for keychain access again. That is expected until the app is signed with a stable identity.

Setup registers an existing executable; it does not download or execute package-manager code. A
previous workspace token and the broker endpoint are preserved when setup is rerun.

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
the lexicographically first profile ID as the canonical broker endpoint, keeps every profile ID,
keychain token, manifest, state directory, and attachment directory, and rewrites future pairing
payloads to the canonical endpoint. The broker also listens on the previous bridge ports as
credential-gated compatibility aliases, so already-paired phones reach the same broker without
starting legacy per-workspace processes.

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
and all workers while preserving the remembered launch intent for the next macOS app launch.
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
owner behavior. The macOS shell restores the broker once, regardless of profile count.
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

Windows and Linux need separate native shells over the Rust operator. A WinUI shell is required on
Windows to inherit Mica and future WinUI styling from the OS.
