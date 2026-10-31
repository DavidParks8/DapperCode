# On this iPhone

The iOS app can run a coding model and its file/Git tools locally. **On this iPhone** is a built-in
profile next to your desktop bridge profiles: its chats use the same drawer, chat screen, model sheet,
workspace picker, Git screen, and Settings. It is not a localhost server, and Android and web
continue to use desktop agents.

## First run

1. Choose **On this iPhone** wherever you pick where agents run: the onboarding choices, the
   **Runs on** row in the drawer, the profile capsule under **Let's build** in a new chat, or
   **Settings → Profiles**. Each opens a new chat in the local profile.
2. Until a model and a workspace are ready, the new chat shows a **Set up On this iPhone**
   checklist whose rows open Settings → Models and the workspaces screen. On **Settings → On this
   iPhone → Models**, search across families, sizes, and quants (for example "q8" or "2b");
   **Downloaded only** and **Include models too large for this iPhone** sit together under the
   search field. Choose a family to compare its sizes and quants, then **Download** one and
   **Load** it. Loading also makes it the model new chats use. The page shows storage used and
   free, every queued or running download, and, under **In use**, which model is loaded and which
   one new chats use (they can differ, for example after **Unload**).
   Downloads are pinned by revision, byte count, and SHA-256; unverified weights cannot be loaded.
   See [Model downloads](#model-downloads).
3. Open the chat's workspace picker and choose **Clone repository** with an HTTPS URL (the name is
   taken from the URL; progress shows and **Stop** cancels). Public repositories need no account.
   Sign in under **Settings → On this iPhone → Git & GitHub** before cloning a private GitHub
   repository. **New workspace** creates an empty one; **Initialize Git** on its Git page
   (optionally with an HTTPS origin) to stage, commit, and later push or pull. Touch and hold a
   workspace to rename it or browse its files, and swipe left to delete it; deleting removes its
   files but keeps conversations that used it readable.
4. Set your commit author name/email on the same **Git & GitHub** page, then start a **New chat**.
   Pick the model with the chat's **Choose a model** sheet and the workspace with the workspace
   picker. The sheet lists downloaded models with whether each is loaded, marks the one new chats
   use as **Default**, and links to **Download more models** in Settings. Choosing a model there
   changes it for that chat and for new chats without loading it; it loads when you send.
5. After preparation, inference, file edits, search, diffs, staging, discarding, branch creation and
   switching, history, and commits work without internet. Push, fetch, pull, cloning, sign-in, and
   new downloads require connectivity.

Existing desktop profiles and conversations are not migrated or deleted. The last selected profile,
local or desktop, is restored at startup. Builds that stored the old global "On this iPhone" mode
open the local profile instead. Switching to another profile settles local work and unloads its
model.

## Model downloads

- Up to two models download at once; further downloads wait in a visible **Queued** state and
  start automatically when a slot frees. Pause, resume, and cancel apply to one model at a time.
- Download actions return as soon as the transfer is accepted, so other models stay usable while
  it runs. Each model row shows its state in words ("Downloading 42% · 310 MB of 740 MB · 2 min
  left", "Queued", "Paused at 42%", "Verifying 30%", "Downloaded") with a progress bar that VoiceOver
  reads as a percentage; starts, completions, pauses, and failures are announced. Verification can
  be paused (the downloaded file is kept) or cancelled. Pause, resume, cancel, and delete act
  immediately on that one model; their errors stay on its row.
- Transfers use an iOS background URL session: locking the phone or switching apps does not stop
  them. If iOS terminates the app, a running transfer continues and is re-attached on the next
  launch; a transfer that finished meanwhile is verified when the app becomes active. Force-quitting
  from the app switcher makes iOS cancel the transfer; it resumes from its checkpoint next time.
- Free-space checks reserve the bytes still needed by every queued or running transfer, plus a
  64 MiB margin.
- Cancel discards partial data but never deletes an installed model; **Delete** does.

## Models and memory

The family-first catalog includes **Bonsai 2**, **Qwen3.5**, and **Gemma 4**, with pinned public GGUF
variants. Qwen3.5 has 0.8B/2B choices across Q4, Q5, and Q8 formats; Gemma 4 exposes E2B Q4_0/Q8_0.
The original Qwen3 variants remain under **More families**, preserving existing downloads and chats.
Catalog artifacts are immutable; arbitrary model URLs/imports are not supported.

Bonsai 2 exposes the publisher's 2B/4B ternary packings. Q2_0 uses upstream llama.cpp support.
PQ2_0/PTQ1_0 are displayed with an explicit unavailable reason: they require PrismML-specific
kernels that are not in this build. These packings contain the same ternary weights, not different
precision levels. Unsupported packings cannot be downloaded or passed to inference through the
controller APIs. The app does not download draft heads or multimodal projectors; these models run
text-only here.

The maintained `llama.rn` engine is pinned to `0.13.0-rc.8` for the upstream Hadamard activation
support needed by Bonsai 2 Q2_0. This is a pre-release binding and requires a rebuilt native app
(on-device ABI 6). Old binaries fail with a rebuild message rather than attempting unsupported
inference through a JavaScript-only update.

Compatibility uses physical RAM plus a fresh native app-memory-headroom measurement. Admission
includes weights, an FP16 KV cache at the model's minimum context (4,096 tokens), working space, the
prompt-state budget of hybrid/sliding-window models, and a 384 MiB reserve. When fresh headroom
allows, a load doubles the context up to the catalog maximum (8,192 tokens for Qwen3; 16,384 for
Qwen3.5, Bonsai 2, and Gemma 4). The Models page credits the memory of a currently loaded model when
judging another one ("Loading replaces the current model in memory"), because loading always
releases the previous context first and then checks memory again. Free memory is re-measured every
few seconds while the page is open and whenever the loaded model changes, so there is no manual
refresh. A loaded model is not double-counted when starting generation.

iOS builds request Apple's `com.apple.developer.kernel.increased-memory-limit` entitlement (added by
`plugins/withOnDeviceAgentNative.js`) so local models can use the larger per-app limit iOS grants
on supported devices. It raises the limit `os_proc_available_memory()` reports; it is not a Jetsam
exemption, and admission still uses the fresh measurement. iOS can still reclaim memory or terminate
an app; admission is an estimate.

The three original Qwen3 variants have passed simulator CPU checks with the complete production tool
schemas, native file reads, JSON tool-result consumption, streaming, stop, and unload/reload.
Representative modern-family checks on ABI 6 also pass for Bonsai 2 2B Q2_0, Qwen3.5 0.8B Q4_0,
and Gemma 4 E2B Q4_0. These are native tool-calling checks, not just successful model loads.
Other size/quant variants share those architectures but do not constitute measured phone support.
Simulator headroom is explicitly labelled as host estimation. Physical-iPhone RAM limits, Metal
performance, thermal behavior, and offline battery use have **not** been certified. Do not publish
specific supported-phone or performance claims from simulator results.

Only one local context and one local turn run at a time. Each round measures the prompt with the
model's real chat template and tokenizer, then lets generation use all remaining context (minus a
small safety margin) rather than a fixed output cap, so long `write_file`/`edit_file` payloads are
not cut off. A round starts only if at least a quarter of the context (up to 2,048 tokens) remains
free. When it would not, the model input is compacted, while the saved conversation and transcript
stay unchanged:

1. Earlier turns' tool output is replaced by a short `{"elided": true, ...}` marker that keeps
   identifying fields such as `path`, `revision`, and `error`, and long earlier tool arguments and
   reasoning are dropped.
2. The oldest turns are omitted, with a note to the model.
3. Only if the current turn still does not fit are its older tool results elided.

The current user message is never removed. If a single turn cannot fit even then, it fails with a
clear message and the next conversation turn can continue. File reads default to 3 KiB chunks (16 KiB
maximum) and directory listings to 64 entries (200 maximum).

Native tuning (verify on a physical iPhone): 4 CPU threads on device with every layer on Metal, 6 on
the CPU-only simulator, 512-token batches, one sequence, and native prompt-prefix reuse across rounds
(state snapshots for hybrid/sliding-window models). The chat template is rendered once per attempt
and that prompt is passed straight to completion.

## Tool and lifecycle boundaries

- Tools can list/read/write/exactly edit/rename/delete/search inside the selected app-private
  workspace. Paths cannot escape through traversal, symlinks, hard links, or Git metadata.
- Replacing existing files requires their last read revision. Output, search, and file sizes are
  bounded; truncation is explicit.
- Git uses linked libgit2, not a Git executable. Hooks, shell commands, package managers,
  interpreters, test runners, downloaded executable plugins, and JIT workarounds are unavailable.
  SSH, submodule/LFS hydration, custom providers' private credentials, and force-push are out of scope.
- The workspace root is the empty path `''` everywhere (`'.'` is accepted as an alias for listing).
  The Files screen (from the Git screen or the workspace picker) creates files in the open folder,
  shows the total size of large read-only previews, renames (touch and hold) or deletes (swipe)
  entries, and refreshes when a native change token moves after agent edits.
- Git status reports origin, upstream, ahead/behind counts, and staged-file counts. Push, fetch, and
  pull are disabled without an origin; commit is disabled (and rejected natively) with nothing staged.
- Pull fetches origin and only fast-forwards. Diverged histories (`GIT_NON_FAST_FORWARD`) and local
  changes the update would overwrite (`GIT_CONFLICT`) are rejected before anything changes. Fetch and
  pull share push's HTTPS-only, origin-bound credential, redirect, cancellation, and timeout rules.
  The first push of a new branch records `origin/<branch>` as its upstream.
- Discard restores working-tree files from the index (staged content is kept); discarding a single
  untracked file deletes it, and discard-all removes untracked files only when asked. Ignored files
  (including inside untracked folders) and files staged for deletion but still on disk are never
  removed; unstage a staged deletion before discarding it.
- Native failures reach the UI as `OnDeviceNativeError` values with stable codes (for example
  `GIT_NOT_REPOSITORY`, `PATH_OUTSIDE_WORKSPACE`, `GIT_NO_ORIGIN`) and never include native exception
  names or Swift source locations. These capabilities require on-device ABI 7.
- Clone, fetch, pull, and push progress is pushed by the native module as the
  `onGitTransferProgress` event (ABI 8): once when a transfer begins, is cancelled, or ends, and at
  most every 100 ms (plus the final object) while objects arrive. `getGitTransferProgress` remains for
  a single read.
- Git diffs label staged (HEAD to index) and unstaged (index to working tree) patches separately.
  Opposing changes are not collapsed away; only the staged content is committed. Both sections,
  including their labels, share the reported output byte limit.
- File, status, diff, history, stage, and commit tools run without per-tool approval. A
  model-requested `git_push` always waits for explicit approval in the conversation; declining
  returns a tool error to the model, and Stop leaves the push unrun. Manual pushes from the Git
  screen are user actions and are unaffected. Desktop approval settings are unchanged.
- Stop waits for current tool work to settle. Stop during a model load settles the turn immediately;
  the native load cannot be aborted, so its context is released as soon as it returns. Git
  cancellation is cooperative; unresponsive transports have a 15-second connection/read/write
  timeout. A cancelled push may already have reached its remote.
- A message is recorded (journaled), and the composer draft cleared, only after the model has
  loaded. If loading fails or is stopped, the draft stays in the composer. A failed or stopped turn
  can be retried: an answer with no tool activity is regenerated, and a turn whose tools already ran
  continues from their recorded results. Tools are never replayed. Like sending, retrying waits for
  a pending model load/unload and is refused during workspace operations, backgrounding, or disposal.
- A generation failure is a conversation failure; the resident model stays loaded and ready.
- Only moving to the **background** stops local work, unloads the context, and flushes
  drafts/history; model downloads keep running (see [Model downloads](#model-downloads)).
  Transient `inactive` states (Control Center, Notification Center, the app switcher, calls,
  Face ID, system alerts) do not interrupt anything. At startup and on each return, downloads are
  re-attached, transfers or verification the system interrupted continue (once the network is
  reachable), and the previously loaded model is reloaded if memory admission still passes. Interrupted turns are not resumed or replayed. There
  is no promise of continuous background inference on iOS.
- A memory warning stops local work and unloads the context but leaves downloads running.
- Unrelated actions never stop a running conversation. Selecting the already-loaded model,
  choosing a workspace for new conversations, deleting an unrelated download, and signing out (when
  no Git transfer is active) proceed alongside the run. Actions that would replace or remove the
  model a run is using are rejected with an explanation instead of silently stopping it.
- User turns and tool intent are journaled before execution. After an interrupted launch, uncertain
  tools are marked interrupted and are **never automatically replayed**. Inspect the workspace and,
  for push, the remote before retrying. Streamed text, tool results, and run settlement are
  coalesced into one write shortly afterwards (and on backgrounding).
- Conversations are stored append-first (`runtime/threads.ts`, `runtime/threadJournal.ts`) using
  only the native runtime-document store. `thread-<id>.json` is the base: the whole conversation
  plus `segment`, the last journal position it contains. Each save after that writes one small
  `threadseg-<id>-<position>.json` segment holding only what changed (conversation fields, updated
  or new messages, removed message ids), so a tool turn writes a few hundred bytes per journal step
  regardless of conversation length. A segment is durable before the step it journals continues.
  The journal is compacted into a new base when a run settles, when a change would exceed a 512 KiB
  segment, or when the journal reaches 64 segments or the base's size (at least 256 KiB); every
  document stays far below the native 8 MiB limit. The base is written first and the segments it
  contains are removed afterwards, so a crash at any point replays to the same conversation.
- At startup, the contiguous segments after the base are replayed; segments the base already
  contains (an interrupted compaction) are discarded. A damaged, unreadable, or out-of-order segment
  ends the replay: it and every later segment are set aside with their bytes preserved, the
  conversation opens at the last good step, and its next write is a new base positioned past every
  set-aside segment, so no name is ever reused. A damaged base is set aside together with its
  segments. Whole-conversation documents from older builds are read as a base at position 0 and
  are never rewritten just to migrate them; older builds never list segments, so they still open
  the base. Deleting a conversation removes the base first and then its segments; segments left
  without a base by an interrupted delete are discarded at the next start.
- Composer drafts are the shared chat drafts, stored per profile and chat exactly like desktop
  chats; the runtime never writes drafts. Unsent drafts from older builds (inline in
  `preferences.json` or in per-conversation `draft-…` documents) are imported once into the
  composer's store for the matching local chat before any local chat opens
  (`shell/runtime/localDraftImport.ts`). The runtime removes its copies only after that write
  succeeds, so a failed import is retried at the next start and never loses text. A chat that
  already has a newer composer draft keeps it; the older text is set aside with its bytes preserved
  and a notice. Deleting a conversation also deletes any legacy draft it still has.
- Startup is not fail-closed. Damaged or unexpected conversation, draft, or settings files are
  moved to a `quarantine-…` name with their bytes unchanged (or skipped and left in place when they
  cannot be moved), a dismissible notice explains what happened, and the rest of the mode starts.
- Problems are reported as typed issues: persistence failures (retryable, cleared by a later
  successful write), transient operation failures, and startup recovery notices. All are
  dismissible and several can be shown at once. Settings → On this iPhone lists them, the drawer
  status points there, and VoiceOver announces each new issue once.
- Network reachability is observed with `expo-network`. When the device is known to be offline,
  clone, push, sign-in, and model downloads fail immediately with a friendly message.
- There is no automatic desktop/cloud fallback or synchronization of local workspaces.

## GitHub configuration

DapperCode bundles its registered **public client ID**, so GitHub Device Flow sign-in is available
without additional build configuration. No client secret is needed or included.

For a fork, register your own GitHub OAuth app with Device Flow enabled and override
`EXPO_PUBLIC_GITHUB_CLIENT_ID` in the build environment (or `apps/mobile/.env`). An explicitly empty
value disables sign-in, including in isolated native test bundles. Rebuild the JavaScript bundle
after changing this value; existing installed builds do not acquire it automatically. Public
clones, local commits, and offline inference do not require sign-in.

The user authorizes the displayed short-lived code on GitHub. The requested `repo` scope enables
private clone/push. Tokens are held in a separate device-only Keychain service; JavaScript stores
only an opaque credential reference, and models cannot read tokens. Credentials are restricted to
the authorized HTTPS origin. Redirects are not followed.

The current app does not refresh expiring GitHub tokens. If token expiration is enabled for the
OAuth app, sign in again when GitHub expires the credential.

Signing out removes the local credential, not GitHub's authorization. Revoke the OAuth application
in GitHub account settings when necessary. Other authentication providers can implement the
feature's `GitProviderAuthStrategy`; the agent loop and file tools are provider-independent.

## Unified shell architecture

The chat shell has no local-mode branches. The local agent speaks the bridge's JSON-RPC protocol
in-process, so `HostBridgeApiClient`, `MainScreen`, the drawer, and the Git and workspace screens drive
it unchanged.

```text
MainScreen / drawer / Git / picker ── HostBridgeApiClient ── HostBridgeWsClient seam
                                                                  │
                                    shell/runtime/LocalBridgeWsClient (extends it, no socket)
                                                                  │
                         features/on-device/transport/LocalBridgeServer (wire shapes + events)
                                                                  │
                         LocalAgentPort ── runtimePort.ts ── OnDeviceRuntime (models, loop, Git)
```

### Profile model

- `shell/state/localProfile.ts` defines the built-in profile (`LOCAL_PROFILE_ID = 'on-device'`) and
  the `ShellProfile` union. Bridge profile ids are `bridge-…`, so the id cannot collide.
- `bridgeProfiles.activeProfileId` may be `'on-device'`; the local profile itself is never stored.
  `activeProfileAtom` resolves it only when `localProfileAvailableAtom` is true: iOS with the
  on-device native module at the expected ABI (`shell/runtime/localProfileSupport.ts`). Android, web,
  and old builds fall back to a bridge profile or onboarding.
- `activeBridgeProfileAtom` is bridge-only (`null` while the local profile is open). Use
  `activeProfileAtom`/`activeProfileIdAtom` for anything profile-scoped (routes, caches, drawer).
- Migration: a persisted `settings.preferredExecutionTarget === 'on-device'` becomes
  `activeProfileId = 'on-device'` when app state loads, and the setting no longer exists.
- Startup restores the chat snapshot cache of the resolved active profile, including the local
  profile, so a relaunch reopens the last local chat.
- `defaultStartCwdAtom` keeps a separate `localDefaultStartCwd`, so local workspace paths never
  become a desktop bridge's new-chat path.
- Routes are the regular `/profiles/on-device/(drawer)/…` routes. There are no separate local
  screens: links from older builds (`/on-device/*`) are redirects in `src/app/on-device`
  (`shell/navigation/legacyOnDeviceLinks.ts`) to the matching profile route — the old home and
  `chat/[threadId]` to chats, `models` and `models/[familyId]` to Settings → Models, `account` to
  Settings → Git & GitHub, and anything else to a new chat.

### Runtime ownership and lifecycle

`shell/runtime/LocalRuntimeHost.tsx`, mounted once by `RootLayout`, owns the single
`OnDeviceRuntime` through `OnDeviceProvider` while the local profile is open. While the runtime
starts, the host draws nothing and `ProfileRouteBoundary` shows its **Opening On this iPhone**
indicator, exactly as for a bridge profile. If it fails to start, `LocalRuntimeRecovery` covers the
shell with a standard Settings page: the error notice (announced as an alert), **Retry without
resetting storage**, and ordinary profile switches (`LocalProfileExit`; with no desktop profile the
local profile is closed before onboarding opens). The host never renders over `/onboarding`. When
ready, the host publishes
`localRuntimeAtom` and a `LocalBridgeWsClient` in `localTransportAtom`; `wsClientAtom` returns that
transport for the local profile, and `ProfileRouteBoundary` keeps local routes in their loading
state until it exists. Leaving the profile unmounts the host, which disposes the transport and the
runtime (stop, unload, pause downloads, cancel sign-in) — every exit path is the same.

Profile lifecycles in `useAppBridgeLifecycle` keep running (capabilities, prefetch, snapshot cache),
but WebSocket foreground/background handling, push presence, and push registration are skipped for
the local profile. `LocalBridgeWsClient` is connected from creation until disposal and ignores
`disconnect()`.

### Implemented RPCs

`LOCAL_IMPLEMENTED_METHODS` in `transport/server.ts` is authoritative:

| Area         | Methods                                                                                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session      | `bridge/capabilities/read`, `bridge/health/read`, `thread/approvalPolicy/set` (accepted, no approvals locally)                                                     |
| Chats        | `thread/list`, `thread/loaded/list`, `bridge/thread/list/stream/start`/`cancel`, `thread/read`, `thread/start`, `bridge/thread/create`, `thread/name/update`, `thread/delete`, `thread/config/set` (model), `thread/resume` |
| Turns        | `bridge/thread/queue/send`, `turn/start`, `turn/interrupt`, `bridge/turn/retry` (local only), `bridge/thread/queue/read`, `bridge/thread/schedules/read` (always empty) |
| Models       | `model/list` (downloaded, runnable catalog models with load state in `description` and the new-chat model as `isDefault`)                                         |
| Workspaces   | `bridge/workspaces/list`, `bridge/fs/list` (workspace roots only), `bridge/git/clone` (HTTPS, into a new workspace)                                               |
| Attention    | `bridge/approvals/list`, `bridge/approvals/resolve` (the loop's pending tool approval, such as a push), `bridge/userInput/list` (always empty)                     |
| Git          | `bridge/git/status`, `diff`, `history`, `branches`, `stage`, `stageAll`, `unstage`, `unstageAll`, `commit`, `switch`, `push`                                     |
| Extensions   | `workspace/list`, `select`, `create`, `rename`, `delete`, `changeToken`, `clone/progress`, `clone/cancel`, `workspace/git/fetch`, `pull`, `init`, `discard`, `branch/create`, `workspace/files/list`, `read`, `write`, `create`, `rename`, `remove` |

The transport forwards each native progress event as the host notification
`workspace/clone/progressChanged` (params match `workspace/clone/progress`) while the server is
started.

Every other method rejects with JSON-RPC `-32601` and `data.error = 'unsupported_on_device'`
(surfaced as `RpcRequestError`). Other stable `data.error` reasons are `thread_not_found`,
`on_device_model_required`, `on_device_workspace_required`, `on_device_busy`, `on_device_offline`,
`on_device_not_repository`, and `on_device_failed`; typed native failures also carry
`data.nativeCode`. A tool approval requested by the agent loop is sent as
`bridge/approval.requested`/`bridge/approval.resolved` with the bridge's `commandExecution` kind
(the banner shows the tool's summary as the command), so the shared approval banner answers it,
including Deny. Only one local chat runs at a time; there is no queue or steering.

`bridge/turn/retry` (`transport/retry.ts`) continues a failed or interrupted turn in place through
`runtime.retryTurn`, without resending the user message or replaying tools. It resolves with the new
turn id once the run has started. A failed thread's snapshot lists its last turn as `failed` with
the runtime's message, so a reopened chat shows the failure.

Local workspaces are presented as `/On this iPhone/<name>` paths (duplicate names gain an id
suffix). A chat's model is an ACP config option (`id: 'model'`), so the existing model sheet changes
it through `thread/config/set`, which also makes it the default for new chats without loading it. `thread/create` falls back to the runtime's remembered workspace and
model when the composer sends none or a desktop path.

### Capability flags

- Wire capabilities (`localCapabilities()`): one agent, `threadDelete` only; steer, fork, plan mode,
  review, browser preview, bridge UI surfaces, and fast mode are false, so the shell hides them.
- Client profile features (`activeProfileFeaturesAtom`): `attachments`, `pushNotifications`,
  `connectionSettings`, and `browserPreview` are false for the local profile; `managedWorkspaces`,
  `workspaceFiles`, `gitSync`, `gitDiscard`, `gitBranchCreate`, `gitInit`, and `turnRetry` are true
  only for it (see [Workspaces, Git, and Files](#workspaces-git-and-files)). The composer disables
  attach/paste, the drawer hides **Browser**, and Settings hides notifications and approvals. With
  `turnRetry` the composer's failure alert offers **Retry**, which calls `bridge/turn/retry`
  (`features/chat/turn/turnRetry.ts`). `modelLibrary` is also true only for the local profile: the
  model sheet then uses device wording, hides the agent-side "Use server default" row, labels an
  empty choice "Choose a model", and links to Settings → Models. The local API client reads
  `model/list` fresh each time (`modelListCacheTtlMs: 0`) because downloads and loads change it.
- The agent mode chip is hidden once the agent's capabilities are known and it offers a single
  mode (no plan mode and no advertised ACP modes), which is the case for the local agent.

### Status, readiness, and activity

- `LocalRuntimeHost` publishes `localAgentPresenceAtom` (`shell/runtime/localAgentPresence.ts`):
  the agent status line from `localAgentStatus` and new-chat readiness from
  `localConversationReadiness`, using the same model and workspace fallbacks as the server. It is
  null for desktop profiles. The drawer footer shows the status line (with a dot for ready, busy,
  attention, and error), and the empty new chat shows the readiness reason with **Get a model**
  (`LOCAL_SETUP_DESTINATIONS.models`) when no model is usable; suggestions are hidden until a chat can start. When the
  local new-chat workspace is unset, the host seeds it with the workspace the agent would use.
- Run phases stream as the `dappercode.dev/activity` custom AG-UI event (`bridge/runActivity.ts`).
  The loop loads the model before it records the message, so load progress is sent for the turn
  the loop is starting before `RUN_STARTED`; a failed or stopped load stays a rejected send (the
  draft is kept) rather than a run. Phases:
  `Preparing`, `Loading <model> · N%`, `Generating`, the running tool's action (for example
  `Reading README.md`, from `describeLocalTool`), `Stopping`, and `Saving`. The shell shows the
  title (and detail) in the transcript activity row instead of a rotating working phrase; a later
  generic "Working" from the shell does not replace a reported phase. VoiceOver hears reported
  phases (not progress) and the completion of a turn the screen watched running, never the
  shell's own transitions such as opening a settled chat.
- Tool titles come from `describeLocalTool`. Like the Rust bridge, an interrupted tool keeps the
  wire's `failed` status and adds `interrupted: true` (in `tool-meta` and the snapshot), so the
  transcript shows it neutrally, for example "Stopped editing src/app.ts".

### Streaming

The runtime publishes state, not events. `LocalEventProjector` (`transport/events.ts`) diffs each
thread against the last state it delivered and emits the bridge notifications the shell already
consumes: `thread/started`, `thread/name/updated`, `thread/deleted`, and `bridge/agui.event` with
`RUN_STARTED`, reasoning and text message start/content/end, `TOOL_CALL_START/ARGS/END/RESULT`, the
`dappercode.dev/tool-meta` custom event, and `RUN_FINISHED` or `RUN_ERROR` (`code: 'interrupted'` for
stops). Snapshot message, reasoning, and tool ids match the event ids, so the reload the shell
performs after a run converges with what was streamed. Text that is not an append of the streamed
draft is corrected by that reload.

### Workspaces, Git, and Files

The shared screens serve the local profile through the transport; nothing branches on "local".

- **Workspace host extensions.** Methods beyond the Rust bridge contract are declared once in
  `features/workspace/api/protocol.ts` (`WORKSPACE_HOST_METHODS`) and called through
  `WorkspaceHostClient` (`workspaceHostClientAtom`). They are only called when the active profile
  advertises the matching `activeProfileFeaturesAtom` flag, so desktop bridges are never asked.
  They are deliberately outside `src/bridge`, whose requests must match the contract manifest.
  `transport/workspaceHandlers.ts` and `transport/gitHandlers.ts` implement them over
  `LocalAgentPort` (`git`, `workspaceAdmin`, `files`, `network`), with mutations serialized by
  `runtime.workspaceTask`.
- **Git status** keeps the bridge shape: untracked files are stageable, `raw` starts with the
  porcelain `## branch...upstream [ahead n, behind m]` header, and an optional `remote`
  (`GitRemoteState`: origin, upstream, ahead/behind, detached, unborn, reachability) lets the Git
  screen disable push, fetch, and pull with a reason. Typed native failures reach the screen as
  `data.nativeCode` and are shown through `describeHostError` copy; `on_device_not_repository`
  turns into the **Initialize Git** card (`gitInit`).
- **Git screen** (`features/git`): human change labels, swipe-to-discard per file and a
  press-and-hold **Discard all** (no dialogs; discarding never touches staged or ignored files),
  **Fetch**/**Pull** (fast-forward only), and branch creation in the branch panel. With
  `managedWorkspaces` the workspace row is read-only and links to Files.
- **Workspace picker** (`picker/ManagedView.tsx`, `managedWorkspaces`): a flat list from
  `workspace/list` with branch and origin, tap to use, touch-and-hold to rename or browse files,
  swipe to delete, plus **New workspace** and **Clone repository**. Choosing a workspace also calls
  `workspace/select`, so the runtime's remembered workspace (first-run setup, new-chat fallback)
  matches the picker. The clone screen validates
  HTTPS (`api/remoteUrl.ts`), derives the name from the URL, follows `workspace/clone/progressChanged`
  notifications (with one `workspace/clone/progress` read when it subscribes; no polling), and
  offers **Stop**.
- **Files** (`features/workspace/files`, route `chats/[chatId]/files?cwd=…`, `workspaceFiles`):
  grouped-list browser and monospace editor. Edits are explicit: a dirty dot, **Save**, and leaving
  a dirty file or the screen is refused with an inline Save/Discard banner. The listing follows
  `workspace/changeToken`, so agent edits appear without re-entering; a dirty file that changes on
  disk is flagged and a stale save offers **Overwrite** or **Discard edits**. Files over 64 KiB open
  read-only with their total size.


### Extension points for the next tracks

- **Chat parity** (activity, tool titles, errors, retry): implemented as described above. Run
  failures arrive as `RUN_ERROR` with the runtime's message; add richer error data in `events.ts`
  `finish()` and in `server.ts` error reasons rather than branching in `MainScreen`.
- **Git, workspaces, files**: implemented; see [Workspaces, Git, and Files](#workspaces-git-and-files).
- **Models and account in Settings**: `features/settings/LocalProfileSection.tsx` links to
  `routes.settingsModels` (`settings/models`, `settings/models/[familyId]`) and
  `routes.settingsGitHub` (`settings/github`), built from `SettingsGroup`/`SettingsRow` in
  `features/settings/local`. Those pages read the runtime from `localRuntimeAtom`. GitHub device-flow
  progress lives in `localSignInAtom`, so leaving the page never cancels a sign-in.
- **Discovery and onboarding**: every "where to run" surface lists the same `shellProfilesAtom`
  through `shell/profiles`: `useProfileChoices` (profiles with live state plus **Add bridge**),
  `describeProfile` (the only place that varies copy, icon, and status by profile kind), and
  `openProfileAtom`. Onboarding offers `OnDeviceEntry` beside pairing when
  `localProfileAvailableAtom` is true and words its hero for the choices actually offered. The
  drawer's **Runs on** row (`DrawerProfileRow`) and the new-chat capsule (`NewChatRunTarget`) open
  the same sheet; Settings' Connection/Profiles rows use the same presentation, so the local row
  reports setup (`Needs a model`, `Ready`) rather than a connection.
- **First-run setup**: `useLocalSetup` derives model and workspace steps from the open runtime via
  `localConversationReadiness`, resolving the model the way the server's `resolveModel` does (the
  selected model when downloaded, otherwise any downloaded runnable model, otherwise a download in
  progress), so a first download started from the library without selecting a model still counts; `LocalSetupGuide` renders them in the new chat until a chat can
  start. The workspace step opens the chat's workspace picker (`openWorkspaceModalAtom`); the model
  step opens Settings → Models through `LOCAL_SETUP_DESTINATIONS` (`shell/profiles/localSetup.ts`,
  `/profiles/on-device/settings/models`). Missing
  prerequisites still reject chat creation with `on_device_model_required`/
  `on_device_workspace_required`.
- **Profile routes**: `app/profiles/_layout.tsx` gives `[profileId]` its own stack. Expo Router only
  notices a changed dynamic segment on a route named exactly `[param]`, so without it a profile
  switch left the previous profile id on the parent route and returning from any root-level screen
  switched back.

## Ownership and testing

`src/features/on-device` owns local models, authentication, workspaces, tool dispatch, journals,
the runtime owner (`OnDeviceProvider`), and the in-process transport (`transport/`, which may use
bridge wire types but not bridge transports). It has no screens, routes, or UI kit: ESLint rejects
React Native view components, `expo-router`, the theme, shared UI, the shell, chat, and Settings in
its non-test files (`scripts/__tests__/mobile-runtime-boundaries.test.mjs`). Every local surface is
a shared one — the chat shell, Git, workspace, and Files screens over the transport, and
`features/settings/local` for models and Git & GitHub. The Expo module under
`modules/on-device-agent` owns native memory, Keychain, workspace containment, atomic
document/model storage, and Git. Native ABI version mismatches fail locally with a rebuild message.
`src/shell/runtime` composes the runtime host, its recovery page, and the `LocalBridgeWsClient`
adapter; `src/app/on-device` only redirects links from older builds.

Transport behaviour is covered by `transport/server.test.ts` (wire shapes, events, stop, unsupported
methods), `shell/runtime/LocalBridgeWsClient.test.ts` (the real API client over the transport), and
`features/chat/screen/MainScreen.local.test.tsx` (send, stream, and stop in the real chat screen).
Startup recovery is covered by `shell/runtime/LocalRuntimeRecovery.test.tsx` and retired links by
`shell/navigation/localProfileRouting.test.tsx`.
Workspaces, Git, and Files are covered over the real transport by
`transport/workspaceHandlers.test.ts`, `features/git/GitScreen.local.test.tsx`,
`features/workspace/picker/ManagedView.test.tsx`, `features/workspace/checkout/Screen.local.test.tsx`,
and `features/workspace/files/Screen.test.tsx`.

See the [native module guide](../apps/mobile/modules/on-device-agent/README.md) for build and native
scenario commands. Run mobile lint/typecheck/tests, `typecheck:native`, architectural boundary tests,
and the production-bridge layout suite for integration changes. Real GitHub authorization requires
a configured client ID; physical-device validation remains a separate release gate.
