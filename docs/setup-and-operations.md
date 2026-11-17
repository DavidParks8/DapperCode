# Setup and Operations

DapperCode's desktop app owns bridge setup and lifecycle. The bridge is not distributed through a package registry.
The macOS app uses a native SwiftUI/AppKit shell. The Windows app uses a native C# WinUI 3 shell.
Both packages contain the Rust `dappercode` operator and Rust bridge and expose the same setup,
pairing, workspace, status, logs, and automatic app-owned lifecycle.

## macOS Setup

Build and open the app from a source checkout:

```bash
pnpm install --frozen-lockfile
pnpm run desktop:build:macos
open apps/desktop/dist/DapperCode.app
```

In the app:

1. Choose the workspace the bridge may access.
2. Choose an installed ACP executable. OpenCode is discovered automatically in standard paths.
3. Select Tailscale or local-network access.
4. Confirm the host and bridge port.
5. Select **Set Up DapperCode**.
6. Scan the pairing QR from the mobile app.

The app uses native file panels, forms, buttons, menus, pickers, alerts, and launch-at-login APIs.
Styling and materials come from AppKit/SwiftUI on the installed macOS release. The broker starts
with the menu-bar app and stops when it quits; the shell does not expose manual state controls.

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
Managed .NET assemblies are trimmed in the self-contained package. The MSIX remains multi-file
because Windows App SDK single-file publishing is supported only for unpackaged applications.

Build it on Windows with PowerShell 7 (`pwsh`), the pinned .NET 10 SDK (`10.0.302`, which supplies
MSBuild 18), the Windows SDK, the x64 and ARM64 Rust targets, Node.js, and pnpm:

```powershell
pnpm install --frozen-lockfile
pnpm run desktop:build:windows
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
pnpm run desktop:build:windows
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
pnpm run desktop:test:windows -SigningMode Production
```

`DAPPERCODE_WINDOWS_CERTIFICATE_BASE64` may replace the external path in protected CI. Never commit
the PFX or password and never expose either value to checkout, dependency installation, build, or test steps. The
timestamp URL is mandatory and must identify the provider's RFC 3161 endpoint; production signing
uses SignTool `/tr` with `/td SHA256` (and `/fd SHA256`) and fails closed when any signing input is
absent.

GitHub Actions first builds, tests, and fully inspects the unsigned bundle and both standalone
packages without signing secrets. Windows validation and the x64/ARM64 package builds run in
parallel; a lightweight dependent job bundles and inspects the two architecture artifacts. A
separate `main`-only job downloads that artifact into the
approval-protected `windows-production-signing` environment. That job performs no checkout and runs
only the reviewed PowerShell signing script uploaded by the build job: that script validates the
exact artifact set, certificate subject, and HTTPS timestamp endpoint before using the PFX and
password to sign. It then verifies every signature and emits the public certificate and installation
guidance. Configure required reviewers on that environment before enabling Production workflow
dispatches.

Launch DapperCode from Start and complete the same in-app setup used on macOS:

1. Choose the workspace the bridge may access.
2. Choose an installed ACP executable.
3. Select Tailscale or local-network access and confirm the endpoint.
4. Select **Set up DapperCode**, then pair the mobile app.

Closing the main window leaves DapperCode in the notification area. The broker starts automatically
for configured workspaces while the tray app is running; the Windows shell does not expose manual
start, stop, or restart controls. Use the tray menu to show the window or quit; quitting stops the
broker and its workspace workers. **Launch at login** controls the packaged `DapperCodeStartup` task,
which is disabled on install and never enables itself without the user opting in. When enabled,
sign-in starts the app quietly in the tray. Windows may disable the task through
**Settings > Apps > Startup**, and the app reflects that operating-system state.

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
    state/                     session index, scheduler, retirement, idempotency and push state
    attachments/               mobile uploads
```

Each workspace gets a profile keyed by a hash of its canonical path, so separate worktrees of the
same repository are independent. Every file is written through restrictive-mode temporary files and
atomic rename.

The agent-message journal contains bounded message activity metadata and bodies needed to reconstruct
**Sent**/**Received** transcript rows. It contains no MCP credentials; those capabilities exist only
in bridge memory and are revoked when their ACP session is replaced, deleted, or shut down. Queued
and pending-steer activities are marked `cancelled` after a bridge restart because their in-memory
payloads do not survive the process; an envelope recovered from ACP history reconciles the
corresponding activity to `sent`.

`scheduled-prompts.json` is a separate private, bounded scheduler state file. It contains prompt text,
the owning ACP thread ID, UTC delivery time, retry metadata, and cancellation intent; it never
contains MCP credentials. The bridge fails startup rather than accepting malformed or oversized
scheduler state. At startup its single worker immediately catches up overdue prompts. Temporary
dispatch failures retry indefinitely with capped exponential backoff, and a busy session receives the
prompt through the ordinary queue rather than steering its active turn.

Scheduling is available only to an authenticated active ACP session through the bridge-owned
`schedule_prompt`, `list_scheduled_prompts`, and `cancel_scheduled_prompt` MCP tools. Timestamps must
be absolute RFC 3339 values strictly in the future when admitted and are normalized to UTC. A session
can have at most 100 pending schedules, each prompt uses the existing 64 KiB queue content limit, and
agents can list or cancel only their own schedules. DapperCode intentionally exposes no mobile UI or
WebSocket method that creates, edits, or cancels schedules. The mobile chat composer shows the
selected thread's pending schedules read-only. It hydrates them through
`bridge/thread/schedules/read` and converges on complete-list
`bridge/thread/schedules/updated` notifications.

The scheduler keeps due-but-queued records until the queue has a durable sent receipt. If the bridge
stops first, the in-memory queue item is recreated with the same deterministic submission ID; if the
receipt was already durable, restart suppresses a duplicate. Cancellation is persisted before a
queued item is removed, so a restart completes an interrupted cancellation instead of redispatching
it.

`thread-retirements.json` is the private, versioned, bounded deletion journal. Each versioned entry
records the manager's authoritative thread family in a `prepared` phase before ACP deletion begins.
The bridge first takes the global queue-admission write barrier and drains every previously admitted
dispatch or scheduling operation. While still holding that barrier, the manager locks and rechecks
the complete indexed family; the bridge then durably records that exact family and installs its
scheduler and queue guards before releasing the barrier. It never fences an initial family and later
expands it. Existing schedules and queue state remain durable in this phase. Only a failure
definitively known to occur before ACP deletion is invoked clears the prepared entry. Once ACP
deletion has been invoked, an error or task abort conservatively preserves the `prepared` entry for
startup reconciliation because the delete may have taken effect; in-memory retiring guards are
released when the owned deletion task ends.

Immediately after ACP confirms deletion, the entry atomically advances to `deleted` with the same
authoritative frozen family. Queue idempotency and scheduler state are then cleaned idempotently with
bounded exponential-backoff retries. The entry is cleared only after both stores converge, then
empty queue and schedule snapshots are published. The shared admission fence atomically transitions
the retiring family to permanent in-memory deleted-thread tombstones, so delayed canonical events
and retained queue or steer tasks cannot recreate runtime after cleanup.

On startup the bridge rejects malformed phases, unknown versions, and oversized journals. A
`deleted` entry resumes cleanup before the scheduled-prompt worker can dispatch. A `prepared` entry
is reconciled against the ACP runtime and durable session index: confirmed-live families preserve
their work and roll back the entry, confirmed-absent families advance to `deleted`, and mixed or
indeterminate results fail startup with the journal intact. Recovery installs deleted-thread
tombstones before it finishes a confirmed deletion and clears the journal. This also handles a crash
after only one store was cleaned. If shutdown interrupts a permanently failing transition or cleanup
write, shutdown remains bounded and leaves the journal intact for the next startup.

Bridge bearer tokens are **not** in `config.json`. macOS stores distinct workspace tokens together
under Keychain service `dev.dappercode.desktop`, account `bridge-auth-vault:v1`. Windows uses the
same service with one bounded Generic Credential per workspace, named
`bridge-auth-token:v2:<sha256-profile-id>`, plus the fixed `bridge-auth-vault:v2` layout marker. The
operator migrates an older shared Windows vault before removing it. If initial credential-store
persistence is unavailable (for example, headless Linux or CI), storage falls back to a `0600` file
under `secrets/`; it never silently downgrades existing system credentials after a later update
failure. The app reports which backend is in use. Set `DAPPERCODE_SECRETS_BACKEND=file` to explicitly
select the fallback.

The desktop's keyring 4 native stores preserve the login-Keychain service/account and UTF-8 vault
payload on macOS, and `account.service` Generic Credential targets with UTF-16LE passwords and
Enterprise persistence on Windows. Headless Unix always uses the private-file backend; it does not
initialize Secret Service or an ephemeral keyring mock. Process-inspection initialization failures
abort lifecycle actions without removing ownership records or declaring live processes dead.
Terminated, unreaped Unix children count as stopped; a process exiting during metadata inspection
is rechecked before an inspection error is reported.
The broker's HTTP clients contact loopback workers with proxies and redirects disabled; their
preconfigured Rustls backend explicitly retains ring and WebPKI roots, not OS/platform trust.

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
connected client, active or admitting run, queued or scheduled prompt, pending steer, approval, user
input, preview session, in-flight request, or other queue transition. A failed activity probe also
fails closed as busy. Runs that were admitted continue after the phone disconnects.

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

Setup also records the selected stable launcher as `agent.launcherPath`, separately from its
canonical executable. Before waking a workspace, the operator resolves that launcher again and
refreshes the path and digest when a package manager retargets it or a self-updater replaces its
binary in place. This works even if the old release still exists. Select the stable installer entry
(for example, `/opt/homebrew/bin/opencode` or `~/.opencode/bin/opencode`), not a version-specific
release file. Discovery preserves that entry rather than resolving away its symlink.

Older profiles without a launcher can recover through platform-trusted directories
(`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin` on macOS), and remember the discovered launcher
for later updates. Recovery never searches the workspace or the worker's `PATH`. Unix replacements
must be executable and owned by the current user or root, with no unprivileged write access to the
file or its parent directories. macOS administrator-writable Homebrew directories are permitted.
An unavailable or unsafe launcher fails explicitly without replacing the saved registration; retry
after installation finishes. Moving to a different installation requires setup.

The operator updates `config.json` and the manifest together, preserving credentials, ports, and
session state, and records the refresh in `broker.log`. Version reporting is optional metadata:
the probe is bounded to two seconds and 2 KiB, and failures are logged with a `local` metadata value.
The bridge independently rechecks the digest before spawning. Failed agent initialization does not
leave an unusable worker cached: the next connection can retry. Existing workers are not restarted
just because an update is installed, and pairing remains available while the agent is being updated.

This handles installation updates, not arbitrary future protocol incompatibilities. If an update
removes ACP support or changes required launch arguments, repair the installation or rerun setup
with compatible arguments; DapperCode never disables integrity checks to force it to run.

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
pnpm run operator discover-agent --agent-id opencode
pnpm run operator setup --workspace /path/to/repository \
  --network tailscale --agent-id opencode --agent-args acp
pnpm run operator start --workspace /path/to/repository --owner-pid $$
pnpm run operator status --workspace /path/to/repository --human
pnpm run operator restart --workspace /path/to/repository
pnpm run operator stop --workspace /path/to/repository
pnpm run operator list --human
pnpm run operator stop --all
pnpm run operator forget --workspace /path/to/repository
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

## Agent Phone Calls (Optional)

Active ACP sessions can place user-approved outbound phone calls through the bridge-owned
`start_phone_call`, `steer_phone_call`, `get_phone_call`, and `hangup_phone_call` MCP tools when
voice settings and a SIP trunk are configured on desktop.

Calling is optional: a host without SIP settings or a stored SIP password still starts the bridge
and runs coding agents normally. Mobile **Settings > Integrations > Phone calls** shows **Off**
with host setup guidance until both are configured. This is host-managed, not a mobile credential
editor; every enabled call still requires mobile approval.

After approval, **Dialing** includes preparing the local voice models before sending a SIP
invitation. **Hang Up** remains available during preparation. Supported warm-up responses must
finish completely; an actual preparation failure ends locally instead of ringing someone and
leaving them waiting for inference. Recognition providers without the optional Ollama warm-up API
are primed through their normal transcription endpoint with a generated silent clip. That clip
is neither played nor added to the call transcript. Speech providers without the optional API
are similarly primed with a short, discarded synthesis request with a 30-second deadline.
Other providers without the
optional API retain their normal inference path. Preparation time is separate from connected-call
duration.

The voice assistant waits through incomplete replies and ordinary pauses. Single-word
transcriptions are provisional and cannot authorize autonomous hang-up, even if the model invents a
completed outcome. Otherwise a spoken closing and two-second quiet grace period are required. A
short reply such as "Bye" or a noise burst after the closing still ends the call; a substantive
reply or user steering cancels the hang-up and gives the assistant another turn. User hang-up and
remote disconnect always work.

Ordinary mobile steering lets the sentence already being spoken finish, then discards subsequent
superseded speech and actions. An explicit instruction such as "stop speaking" interrupts
immediately, as do recipient barge-in and hang-up. A temporary synthesis gap does not turn ordinary
steering into an immediate interruption. Interrupted history includes only fully played sentences;
an unfinished sentence is represented as `[partially spoken sentence] [interrupted]`, not as if
the recipient heard its complete text. Earlier completed answers remain in the history.

Completed recipient utterances remain ordered while transcription runs; a later correction no
longer replaces pending audio. The backlog is bounded, and an overflow fails explicitly rather
than dropping words. End-of-speech detection also uses the elapsed quiet interval, so a caller
whose endpoint suppresses silent RTP or sends sparse comfort noise can still finish a turn.
Silence is never treated as consent, refusal, or task completion.

When asked to hold, the assistant acknowledges and waits silently through music, silence, and
recorded queue announcements until a live person returns. The mobile card shows **On hold** while
keeping **Hang Up** available; `get_phone_call` reports `onHold: true` and `status: "in_progress"`.
SIP hold/resume via in-dialog `INVITE` or `UPDATE` is also supported, including renegotiated RTP
ports and offerless re-`INVITE`s answered in the `ACK`. Live steering remains available while held.
Hold time counts toward the existing 15-minute maximum call duration; user hang-up, remote
disconnect, and shutdown still end the call.

Empty or incomplete synthesis is an explicit voice error, not a successful spoken closing.
The same applies to all-zero PCM, nonzero samples that become silence after telephone encoding,
and punctuation-only closings that contain no speakable words. An omitted structured hold decision
is rejected rather than silently interpreted as ordinary listening.
Likewise, a recognition response missing its required text field is an error, not silence.
Already played speech stays in the failed call's transcript and report if a later sentence cannot
be synthesized.

Spoken turns pair the reply and its next action in one validated JSON `phone_turn` response.
Only its `speech` field is synthesized; JSON, internal actions, and competing assistant content
are never read aloud. Native `phone_turn` tool responses and legacy separate phone-tool responses
remain supported. Structured responses and native `phone_turn` arguments must explicitly include
the boolean `on_hold`; the older separate tool schemas retain their compatibility behavior.
Hold-listening
checks classify only the latest recipient speech or mobile instruction, without the booking
objective or previous tool instructions competing with the decision to keep waiting or resume.

Conversation guidance covers context-sensitive acknowledgement of distress, frustration and good
news, short replies for rushed recipients, corrections and interruptions, and limits on payment
or other commitments. These are behavioral instructions, not a guarantee: the dialogue model sees
transcribed words, not vocal emotion. Real-call listening tests are still needed to assess prosody,
noise, accents, and total response latency; no model is guaranteed to handle every situation or be
indistinguishable from a person. Routine "Who's calling?" questions get the caller and purpose,
not an automation announcement. Direct questions about being human, AI, or automated must still
be answered truthfully and briefly.
Model evaluation must check both acknowledgement and factual role correctness: a polite reply that
speaks as the business instead of the caller is still a failure. Passing transport/audio tests does
not qualify a model for arbitrary conversations; keep held-out dialogue failures visible rather
than weakening them to promote a faster model.

For local source validation, the ignored `local_full_audio_pipeline` regression runs the production
call service against an isolated loopback telephone participant with real local recognition,
dialogue, and synthesis. It measures recipient speech end to received audible RTP, not just
text generation, and captures model residency, stage timings, controlled-noise recognition,
live controls, and settled reports. Synthetic speech/noise is not an accents or human-listening
evaluation. Warm pipeline runs may still include model loads when memory pressure evicts a model;
do not substitute the faster dialogue-only figures for full-call latency.

Speech intelligibility is a separate offline gate, not a check added to live calls.
`scripts/voice-intelligibility.mjs` requires an independent local recognizer's exact
normalized transcription of each complete waveform. Nonzero PCM, generated text, and
successful playback alone do not prove intelligibility. Transcribe the native waveform
and its telephone-path version without giving ASR the expected text or vocabulary hints.
The gate compares a fixed spoken reference against each transcription, preserves
negation and meaningful numeric distinctions, and fails the whole batch on any mismatch,
unverified completion, missing sample, empty recognition, or ASR error.

Run `node scripts/voice-intelligibility.mjs /absolute/manifest.json`. The manifest must
contain `expectedSamples` and exactly that many `samples`, each with a unique `id`,
`reference`, `audioFile` (relative to the manifest), `completion: { verified, reason }`,
and `recognition: { status: "ok", text, model, audioSha256, prompted: false }`.
`audioSha256` must identify the exact WAV passed to ASR. Keep runtime/model revisions
and the observed completion/drain evidence with the manifest; setting `verified` is
not itself evidence of completion. No failed samples may be filtered out or retried
to obtain a passing batch.

Normalization ignores case, ordinary punctuation, and whitespace; it equates standalone
digits zero through nineteen with their spoken words. Apostrophes, number signs, decimal
and time notation, currency/percent signs, and leading zeros are not discarded.
It does not equate synonyms, homophones, or alternative AM/PM expressions. Exact matching
may therefore reject understandable speech because of ASR mistakes; report those as
failed or inconclusive qualification, not automatically as unintelligible generation.
An ASR pass means **ASR-verified; listening/naturalness unverified**.

For production telephone conversion without a second codec implementation, place bounded
mono PCM16 little-endian 24 kHz inputs in a scenario-owned directory and list their flat
filenames in `intelligibility-inputs.json`. The ignored test below writes new
`*-telephone.wav` files using the production FIR filter, headroom, PCMU encoding/decoding,
and 20 ms frames. It does not place calls or exercise SIP transport:

```bash
DAPPERCODE_TEST_VOICE_AUDIO_DATA_DIR=/absolute/scenario-owned-data \
  pnpm run cargo test --locked --package dappercode-bridge --features e2e-agent \
  --manifest-path services/rust-bridge/Cargo.toml \
  local_intelligibility_telephone_conversion -- --ignored --nocapture --test-threads=1
node --test scripts/__tests__/voice-intelligibility.test.mjs
```

By default, speech-to-text, tool-calling voice turns, and 24 kHz streaming text-to-speech run
against one local Ollama daemon (`>= v0.40.9`, `http://127.0.0.1:11434/v1`):

```bash
ollama pull gemma4:e4b
ollama pull gpt-oss:20b
ollama pull phonon
```

`gemma4:e4b` handles `/v1/audio/transcriptions`; `gpt-oss:20b` handles `/v1/chat/completions`
conversation turns with low reasoning effort and reduced sampling variability.
`phonon` handles `/v1/audio/speech` 24 kHz PCM synthesis (`--tts-voice` defaults to `default`). To
override narrowband 8 kHz transcription with a dedicated local server—for example `mlx_audio.server`
serving `mlx-community/parakeet-tdt-0.6b-v2`—pass `--stt-base-url` and `--stt-model` (and optionally
`--llm-base-url` / `--llm-model` or `--tts-base-url` / `--tts-model`).
All three URLs, all three model IDs, and the TTS voice can be changed independently with
`voice configure`; omitted flags preserve the existing values rather than resetting them to defaults.
Existing configurations keep their saved model. After pulling the new model, select it with
`dappercode voice configure --llm-model gpt-oss:20b`; this preserves SIP settings, transcription,
and the TTS voice. Existing workers keep the environment they started with; finish active calls
before restarting the affected worker to pick up changed settings.
The local LLM endpoint must support streaming OpenAI-compatible JSON-schema `response_format`
for spoken turns and silent hold-listening decisions. The transcription request explicitly asks
for `response_format=json`; a provider's default streaming/NDJSON format is not assumed to be a
single JSON transcript.

Configure, inspect, or remove voice settings through the operator CLI (`dappercode voice ...` or
`pnpm run operator voice ...` from a source checkout), piping the SIP password over stdin so it
never appears in process arguments:

```bash
printf '%s\n' "$SIP_PASSWORD" | dappercode voice configure \
  --sip-server sip.provider.example:5061 \
  --sip-transport tls \
  --sip-username sip-user \
  --caller-id +15551234567 \
  --display-name "Your Name" \
  --sip-password-stdin
dappercode voice status --human
dappercode voice clear
```

### Dedicated local recognition on Apple silicon

For broader conversational quality, the evaluated local profile pairs `gemma4:12b` dialogue
with `mlx-community/parakeet-tdt-0.6b-v2` recognition and the existing `phonon` voice. It avoids
keeping a second large generative model resident just for transcription. This is an optional,
host-managed profile, not an automatic change to saved settings or a guarantee of human likeness.

The recognition provider used for validation is `mlx-audio[server,stt]==0.6.5` in a separate Python
environment outside repositories (Python 3.10+ on Apple silicon). Start that provider on loopback:

```bash
python -m pip install 'mlx-audio[server,stt]==0.6.5'
python -m uvicorn mlx_audio.server:app --host 127.0.0.1 --port 0
```

Set `STT_BASE_URL` to the server's printed loopback URL with `/v1` appended.
Validation used separate loopback Ollama providers for dialogue and synthesis, both with
`OLLAMA_CONTEXT_LENGTH=8192`, `OLLAMA_NUM_PARALLEL=1`, and `OLLAMA_NO_CLOUD=true`.
The dialogue provider used `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_KEEP_ALIVE=15m`; synthesis
used `OLLAMA_MAX_LOADED_MODELS=3`, `OLLAMA_KEEP_ALIVE=30m`. Set `LLM_BASE_URL` and
`TTS_BASE_URL` to their respective loopback URLs with `/v1` appended. A shared Ollama provider
is supported, but may evict models and is not the measured topology.

Load the recognition model, ensure both Ollama providers have their selected models, then,
after configuring SIP above, select the complete profile:

```bash
curl --fail --request POST \
  "$STT_BASE_URL/models?model_name=mlx-community%2Fparakeet-tdt-0.6b-v2"
OLLAMA_HOST="${LLM_BASE_URL%/v1}" ollama pull gemma4:12b
OLLAMA_HOST="${TTS_BASE_URL%/v1}" ollama pull phonon
dappercode voice configure \
  --llm-base-url "$LLM_BASE_URL" \
  --llm-model gemma4:12b \
  --stt-base-url "$STT_BASE_URL" \
  --stt-model mlx-community/parakeet-tdt-0.6b-v2 \
  --tts-base-url "$TTS_BASE_URL" \
  --tts-model phonon \
  --tts-voice default
```

Model weights may download during host setup; inference remains local. Keep all providers
running, and use stable, available host-service ports for ongoing use rather than a workspace's
bridge port. Existing workers require an explicit restart after their active calls finish to
pick up changed settings. No credentials need to be re-entered, and no secret belongs in a
repository.

Validate the complete audio path on the intended host. Larger models alone can worsen recognition
or exhaust available memory; paging and other model workloads can introduce long pauses. Synthetic
noise checks do not replace accent coverage, consented listening tests, or review of a real call.

### Conversational female voice on Apple silicon

The opt-in `conversational-female` voice profile uses
`mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit` through a local MLX Audio
server. It targets the warm, conversational US-English female delivery evaluated
with the listening samples, rather than cloning the macOS system voice.
It changes speech synthesis only: dialogue, private text steering, sentence-boundary
ordinary steering, immediate stop, DTMF, holds, and hang-up remain bridge-controlled.
Existing Phonon defaults and saved voice selections are unchanged.

Use the same separate Python environment described above. The verified provider
version is `mlx-audio[server,stt]==0.6.5`; keep it outside repositories:

```bash
python -m pip install 'mlx-audio[server,stt]==0.6.5'
python -m uvicorn mlx_audio.server:app --host 127.0.0.1 --port 0
```

Set `TTS_BASE_URL` to the printed loopback URL with `/v1` appended. Choose a stable
available service port for ongoing use; do not use a workspace bridge port.
Load the speech model, then select the profile using the existing voice settings:

```bash
curl --fail --request POST \
  "$TTS_BASE_URL/models?model_name=mlx-community%2FQwen3-TTS-12Hz-1.7B-VoiceDesign-8bit"
dappercode voice configure \
  --tts-base-url "$TTS_BASE_URL" \
  --tts-model mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit \
  --tts-voice conversational-female
dappercode voice status --human
```

The alias requires that exact model ID; incompatible model/profile combinations
are rejected instead of silently falling back to another voice. The bridge sends
the female voice description, conversational style, English language, and the
evaluated sampling parameters separately from the spoken text. No style instructions
are inserted into the callee transcript or read aloud as part of the speech input.
Providers other than this selected profile retain the original speech request shape.

The provider is host-managed; the bridge does not install or supervise Python or
download voice weights during a call. Model downloads may happen during setup,
but inference remains local. Keep the provider running and finish active calls
before explicitly restarting an affected worker to pick up changed settings.
No SIP credentials need to be re-entered. Changing other settings without voice
flags preserves the selected profile.

Speech generation and memory use must be validated on the intended host. VoiceDesign
does not guarantee an identical speaker across generations, and the approved short
sample does not establish naturalness for every sentence. The earlier Phonon latency
measurements do not apply to this profile. Use the independent waveform-ASR gate
above for intelligibility; listening is still needed for accent, prosody, and
context-sensitive delivery.

To return to Phonon, explicitly select the original local Ollama endpoint,
`--tts-model phonon`, and `--tts-voice default`. This profile does not adopt MiniCPM
or remove the existing approval/authorization safeguards.

Security and storage boundaries:

- **Secrets vs. config**: the SIP password is stored in `SecretStore` under service
  `dev.dappercode.desktop` (shared Keychain vault on macOS, Credential Manager entry
  `__phone-call-sip-password` on Windows, or restrictive `0600` file fallback under `secrets/`) and
  injected into bridge workers only in memory (`PHONE_CALL_*`). Non-secret SIP and model settings
  live in `config.json`.
- **Consistent account reads**: configuration changes and worker startup read/write SIP settings
  and credentials under the same central config lease. Platform-specific credential handling stays
  inside the desktop platform adapter. Returning from the Windows file backend preserves the SIP
  secret before retiring its shared fallback vault.
- **Windows credential capacity**: valid SIP passwords exceeding the native credential limit
  (1,200 UTF-16 code units) stay in the dedicated private-file fallback, up to the normal 4,096-byte
  SIP password limit. Recovering bridge tokens from the shared file vault still succeeds, and
  replacing an existing native SIP credential with that fallback preserves its value on failure.
- **Current credential layouts only**: obsolete per-profile token JSON files and the old Windows
  shared-keychain vault are neither imported nor deleted. Hosts relying only on those obsolete
  credentials must configure and pair again. The shared private-file vault remains a supported
  backend for headless hosts and credential-service outages; recovering from it still preserves
  both bridge tokens and the SIP password.
- **Loopback-only inference**: `--stt-base-url`, `--llm-base-url`, and `--tts-base-url` must resolve
  to loopback hosts (`localhost`, `127.0.0.1`, or `::1`); remote model URLs are rejected.
- **Mandatory mobile approval**: `start_phone_call` blocks on a non-dismissible mobile approval
  modal before sending a single SIP packet. Declining or timing out cancels the call locally.
- **Outbound-only SIP/RTP**: the bridge dials outbound SIP (`udp` or `tls`) and 20 ms G.711 PCMU RTP
  directly from ephemeral local ports—no public webhooks, tunnels, or inbound listeners are opened.
- **Caller-identifying introductions and text-only transcripts**: the assistant's first sentence
  says who it is calling for and why (for example, "Hi, I'm calling for Your Name to book a table"),
  without volunteering that it is an AI. It must not impersonate the user or claim to be human.
  Routine caller-identification answers use no automation labels; direct questions about being
  human, AI, or automated get truthful answers. Only bounded text transcripts (never raw call audio)
  are shown in the live card or enqueued back to the owning ACP session when the call settles.

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
The standalone `pnpm run bridge` development flow remains workspace-bound and keeps its existing
owner behavior. The native shell restores the broker once, regardless of profile count.
While the broker is running, the desktop shell keeps one authenticated broker-level WebSocket
observer open. A broker crash or external kill closes it and triggers immediate operator
reconciliation. Reconnects use bounded backoff, while full operator reconciliation runs only on
launch, foreground presentation, explicit actions, or disconnect instead of continuously spawning
`status` and `list` processes.

## Runtime Configuration

The broker builds each worker environment in memory and passes it directly to the child process.
External workspace credentials never reach workers; worker-only credentials never reach disk.
Workers remain configured through the existing environment contract, which keeps `pnpm run bridge`
working:

- `BRIDGE_HOST`, `BRIDGE_PORT`
- `BRIDGE_PREVIEW_HOST`, `BRIDGE_PREVIEW_PORT`
- `BRIDGE_DISABLE_BROWSER_PREVIEW`: disables the preview listener when `true`; intended for isolated
  test workers that do not exercise browser preview
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

HTTPS preview targets must present an unexpired certificate valid for the target hostname and
trusted by the bridge machine's operating system. For local development, use a certificate issued
by a local CA you explicitly trust on that machine, or use HTTP over loopback. Untrusted self-signed
certificates are rejected; there is no certificate-validation bypass.

## Development

For native offline iPhone usage, see [On this iPhone](on-device.md). A bridge is not needed for that
mode. Its native build requires CMake, the pinned libgit2 build, and a rebuilt iOS application;
Expo Go or a JavaScript-only update cannot add the native inference/Git libraries.

Start Expo independently after the desktop app has configured the bridge:

```bash
pnpm run mobile
```

The Expo bootstrap reads the bridge host from the central `config.json`, falling back to a repo-root
`.env.secure` for the `pnpm run bridge` development flow. Physical devices must use a LAN or Tailscale
bridge URL, not localhost.

iOS permits native HTTP requests to user-configured bridge hosts, including private DNS names,
through an app-wide App Transport Security exception. The Expo
`withIosBridgeTransportSecurity` plugin removes granular ATS keys that would override this exception
during prebuild. This also covers clipboard, photo-library, and document attachment uploads. Bearer
authentication and insecure-host warnings still apply; HTTP does not encrypt tokens or attachments.
Use HTTPS or an encrypted private network such as Tailscale, and never expose the bridge publicly.
The exception needs an App Review justification for connections to user-managed private hosts.

ATS changes require a new native iOS build, not an OTA update or JavaScript reload. For an existing
local native project, run `pnpm --filter @dappercode/mobile exec expo prebuild --platform ios --no-install`
before rebuilding. Native transport regression coverage can be run with
`node .agents/skills/local-e2e-validation/scripts/run.mjs apps/mobile/plugins/tests/native-ats.mjs`.

The mobile app uses Expo Router with the `dappercode` scheme. Canonical links include
`dappercode://profiles/<profile-id>/chats/<thread-id>` and
`/profiles/<profile-id>/chats/<thread-id>` on web. Web output is a client-rendered single-page app;
any production host must rewrite unmatched paths to `index.html` so profile and chat URLs survive a
direct load or browser refresh.

## Distribution

`pnpm run desktop:build:macos` creates:

- `apps/desktop/dist/DapperCode.app`
- `apps/desktop/dist/DapperCode-<version>-<arch>.zip`

The build fails if the app contains Node, package-manager executables, JavaScript, package manifests,
`node_modules`, or Slint artifacts. Local builds are ad-hoc signed. Public distribution requires project-owned Apple
Developer signing and notarization.

The Windows build produces a test-signed x64/ARM64 MSIX bundle and its local test certificate. The
production path uploads an inspected unsigned artifact, then signs it in the protected, main-only
workflow job described above so release automation never treats the development certificate as
production identity. Each Windows package includes the C# WinUI 3 shell, both Rust executables, the
DapperCode license, and platform-aware third-party notices covering the Cargo and restored NuGet
dependency closures. The installed copies are `Licenses\DapperCode-LICENSE.txt` and
`Licenses\THIRD_PARTY_NOTICES.txt`.

Run `pnpm run desktop:test:windows` on Windows to inspect bundle signatures, identity, architectures,
native executable architecture, required payloads, and forbidden runtime content.

To uninstall, first choose **Quit** from the tray menu, then remove DapperCode from **Settings → Apps
→ Installed apps**. For a complete reset, remove credentials before deleting
`%APPDATA%\DapperCode`: in **Credential Manager → Windows Credentials**, remove every Generic
Credential for service `dev.dappercode.desktop` whose account matches `bridge-auth-token:v2:*`, the
`bridge-auth-vault:v2` layout marker, any legacy `bridge-auth-vault:v1` shared vault, and any legacy
`bridge-auth-token:<profile-id>` entry. Only then delete `%APPDATA%\DapperCode`. Removing that data
discards every configured workspace, bridge token, session snapshot, attachment, and log;
reinstalling or relaunching then requires setup and pairing again.
