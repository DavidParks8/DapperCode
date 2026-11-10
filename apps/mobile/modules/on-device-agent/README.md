# On-device agent native services

This module owns native services for the experimental iOS offline agent. It does not modify the
desktop bridge or start a server. Enter **On this iPhone** through onboarding or desktop Settings.
See [product setup and limitations](../../../../docs/on-device.md).

- `ios/OnDeviceAgentModule.swift` is the thin Expo boundary.
- `ios/GitCredentialStore.swift` stores host-scoped credentials in a separate, device-only Keychain
  service. JavaScript receives opaque references; there is no exported token-reading method.
- `ios/NativeGit.swift` owns the linked-library Git operations. Credential callbacks enforce the
  authorized HTTPS origin. Remote rejections are explicit errors, not successful push results.
- `ios/NativeGitRead.swift` and `ios/NativeGitMutations.swift` own bounded Git queries and index/branch
  operations. `GitNetworkOperation.swift` provides cooperative cancellation and progress, pushed to
  JavaScript as the throttled `onGitTransferProgress` module event; a small C
  boundary configures libgit2's 15-second connection and read/write timeouts.
- `ios/NativeGitRemote.swift` owns fetch, fast-forward-only pull, `git init` (with an optional
  HTTPS origin), branch creation, discard/restore, and origin/upstream/ahead/behind status.
- `ios/WorkspaceStore.swift` and `WorkspaceFileTools.swift` own actor-serialized workspace
  publication, rename, deletion (atomically unpublished before removal), containment, revision
  checks, bounded UTF-8 operations, and an in-memory per-workspace change token. The workspace root is
  the empty path; `"."` is accepted as a root alias where the root is allowed.
  `WorkspaceSize.swift` measures a workspace's allocated bytes (`.git` included, symlinks never
  followed) off the actor, bounded to 50,000 entries or 2 seconds, and reports `truncated`.
- `ios/NativeServiceError.swift` defines the stable error codes. Every workspace, Git, and credential
  failure is described as `[ondevice:CODE] message`; `src/features/on-device/native/services.errors.ts`
  maps Expo's wrapped rejections to `OnDeviceNativeError` with that code and a clean message. Model
  file and download failures are untagged and surface as `NATIVE_FAILURE` with a clean message.
- `ios/ModelFileStore.swift` verifies size/SHA-256 before atomic ready publication. Hashing runs off
  the store actor in 1 MiB chunks, reports progress (`getModelVerificationProgress`), and stops
  cooperatively (`cancelModelVerification`) while keeping the staged file for a later retry. It also
  reports model disk usage and free/total capacity (`getModelStorageInfo`).
- `ios/ModelDownloadSession.swift` owns one background `URLSession`; each task's description is its
  model ID, so several models transfer concurrently and keep running while the app is suspended.
  `attachModelDownloads` adopts tasks that outlived the process. Completed files are moved to
  `partial.gguf` by the delegate even when JavaScript is not running; pause and system interruptions
  persist resume data (`resume.data`/`transfer.json`). When iOS relaunches the app for transfer events,
  `ModelDownloadEvents.swift` recreates the session and takes the system completion handler
  directly: `plugins/withOnDeviceAgentNative.js` adds an `AppDelegate` override ahead of Expo's
  subscriber aggregation, because in SDK 57 expo-file-system's handler and
  `EXLegacyAppDelegateWrapper` never complete their share for another library's session, so the
  aggregated handler would never reach iOS. A checksum or size mismatch deletes the staged file so
  a corrupt download is not re-verified on every activation. A pause whose checkpoint cannot be
  written releases the transfer and records the failure. Checkpoints from the earlier
  JavaScript transfer (`resume.json`) are imported on the next resume.
  `RuntimeDocumentStore.swift` owns separate atomic, size-limited local journals/preferences.
- `LocalRunActivity.swift` keeps a local agent turn running after the app leaves the foreground:
  an iOS 26 `BGContinuedProcessingTask` (registered on demand as `<bundle id>.localrun.<n>`,
  permitted by `plugins/withOnDeviceAgentNative.js`, never queued), otherwise ordinary background
  task time. JavaScript reports generic progress and ends the activity when the turn settles; an
  expiration event (`onLocalRunExpired`) stops the turn. On the short budget the event fires once
  `backgroundReserve` (10 s) remains, while the task is still held; module destruction ends every
  activity.
- The native ABI is versioned (currently 12: local run activities, LFM3 inference, bounded glob/regex search, synchronous workspace
  cancellation, observed-revision coordinated patches, workspace rename/delete, change tokens, UI file
  rename/delete, fetch/pull, init, branch creation, discard, remote-aware status, typed errors,
  background model downloads, verification progress/cancellation, storage info, Git transfer
  progress events, and workspace size). An old binary is
  rejected before loading model variants that need the newer inference engine, including
  LFM3's hybrid architecture and Bonsai 2's activation transforms.
- `scripts/build-git.mjs` builds pinned libgit2 1.9.7 for iOS arm64 and simulator arm64/x86_64.
  The source archive is SHA-256 verified. HTTPS uses SecureTransport; SSH, the CLI, and tests are
  excluded from the app library. Unmodified upstream notices (including bundled dependency
  licenses, llama.rn, and llama.cpp/ggml) are copied into the `OnDeviceAgentNotices` app resource bundle.
- Inference uses pinned `llama.rn` 0.13.0-rc.10 (llama.cpp b12211), loaded only by the on-device feature.
  This maintained pre-release supports LFM3's architecture/tool template and the upstream Hadamard
  runtime needed by Bonsai 2 Q2_0 weights. Its install script
  verifies the downloaded native artifacts. Android autolinking is disabled for this iOS-only
  feature so existing Android clients do not acquire an unused native runtime.
- Authentication strategies live under `src/features/on-device/auth`; they do not implement Git
  operations or expose credentials to model tools.

## Native build

Install Xcode and CMake on macOS. `DAPPERCODE_CMAKE` may name a specific CMake executable. Expo
prebuild invokes the native Git build through `plugins/withOnDeviceAgentNative.js`; unchanged builds
reuse the versioned result. Build output and downloaded sources stay under `ios/build/git` and are
ignored by Git, Metro, and Jest.

```bash
pnpm install --frozen-lockfile
pnpm --filter @dappercode/mobile exec expo prebuild --platform ios --no-install
cd apps/mobile/ios
pod install
```

The config plugin adds Apple's `com.apple.developer.kernel.increased-memory-limit` entitlement, a
self-service capability for apps that need a larger memory limit. It does not change admission:
models are admitted only against a fresh `os_proc_available_memory()` measurement. Do not enable
JIT, extended virtual addressing, or other entitlements to make a model appear compatible.
Physical iPhone measurements are still required before publishing model/RAM compatibility claims.
The native memory API is advisory; a simulator's host memory is not an iPhone memory budget.

The app disables Reanimated's `FORCE_REACT_RENDER_FOR_SETTLED_ANIMATIONS` optimization in
`apps/mobile/package.json`. With it enabled, a settled closed drawer can become visible again
after a new chat's first Send, covering generation and approval controls even though the navigator
still reports it closed. The native edge-flow scenario checks the real screen before and after
Send, pending-approval cancellation, and the next turn. Keep the normal drawer animations; do not
replace this with navigation retries or hide the drawer after sending. Changing this static flag
requires `pod install` and a native rebuild, not just a JavaScript rebundle.

## Validation

Native fixtures declare Expo's Metro types explicitly so lint/type-check works on a clean checkout,
without relying on the ignored `expo-env.d.ts` generated by local Expo commands.

```bash
pnpm --filter @dappercode/mobile run test --runInBand src/features/on-device/auth/github.test.ts
pnpm --filter @dappercode/mobile run typecheck:native
node --test scripts/__tests__/mobile-runtime-boundaries.test.mjs
```

Workspace search/patch regressions compile the production Swift actor and linked Git library in
an isolated simulator (no model weights or bridge needed):

`workspaces/fileTools.ts` exports `workspacePatchPaths` for before-tool rule loading. It extracts
add/update/delete/move candidates only; native remains the authoritative parser, path validator,
and revision owner. `search_files` and `glob_files` expose their directory scope as `path`.

```bash
node apps/mobile/modules/on-device-agent/scripts/build-git.mjs
node .agents/skills/local-e2e-validation/scripts/run.mjs \
  --evidence /absolute/path/to/new-workspace-tools-evidence.jsonl \
  apps/mobile/modules/on-device-agent/tests/native-workspace-tools.mjs
```

The native inference scenario uses the existing local E2E runner, an isolated simulator, real model
weights, and a bundled JavaScript entry. It never restarts Metro or a user bridge. Before running it,
build a signed simulator Release app in `apps/mobile/local-builds/on-device-gate`:

```bash
xcodebuild -workspace apps/mobile/ios/DapperCode.xcworkspace -scheme DapperCode \
  -configuration Release -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath apps/mobile/local-builds/on-device-gate \
  CODE_SIGNING_ALLOWED=YES CODE_SIGNING_IDENTITY=- build
node .agents/skills/local-e2e-validation/scripts/run.mjs \
  --evidence /absolute/path/to/new-evidence.jsonl \
  apps/mobile/modules/on-device-agent/tests/native-inference.mjs
```

It requires the iOS 27.0 iPhone 18 Pro simulator runtime and downloads a checksum-verified Qwen3.5-2B
Q4_K_M fixture (approximately 1.3 GB) into test-owned storage. The runner removes the fixture and
simulator after the run. It asserts structured tool calls, actual file reads, JSON tool-result
consumption, streaming, cancellation, unload/reload, and native credential storage/removal.
It also runs the production history projection after a stopped push and a successful file read,
requiring a genuine answer from the tool result without an extra user instruction or retry.
Set `DAPPERCODE_NATIVE_TEST_MODEL` to a bundled catalog ID to run the same complete-tool-schema
gate or native product scenario for another model. Both default to `qwen35-2b-q4-k-m`.
For LFM3, use `DAPPERCODE_NATIVE_TEST_MODEL=lfm3-1.7b-q4-k-m`. The gate mirrors production
reasoning for catalog models marked `thinking` (enabled formatting and completion, plus 1,024
output tokens so a budget never truncates reasoning). LFM3's gate also checks research routing over
three seeds: project-symbol questions must use workspace tools on every seed (a privacy rule), and
current library questions must call `web_search` on at least two of three (a measured rate, about 9
in 10 host seeds). LFM3's template supplies its own assistant generation boundary after a tool
result; the history projection must not insert the empty completed assistant turn needed by the
older templates. The stopped-push continuation imports the production stopped-approval result, so
the gate and the app cannot drift.

All catalog models now size context from fresh app headroom, including the full KV estimate and
reserve, rather than stopping at 8K/16K. Native GGUF ceilings are 40K for Qwen3, 128K for Gemma 4,
and 256K for Qwen3.5, Bonsai 2, and LFM3. A load chooses power-of-two tiers through that ceiling
(including Qwen3's final 40K tier); unload/reload re-measures. Existing 4K/8K compaction fixtures
explicitly constrain memory so the larger catalog ceilings cannot silently bypass their assertions.
The original Qwen3 entries and ABI-6 representatives of Bonsai 2, Qwen3.5,
and Gemma 4 have passed the simulator gate, and LFM3 1.7B Q4_K_M passes it on ABI 11 (131,072-token
context). Prism-only Bonsai packings are explicitly unavailable.
This is not proof
of physical-iPhone Metal performance or measured phone RAM compatibility.

The separate native Git scenario runs the production Swift implementation against an isolated
authenticated HTTPS Git server. It installs a test CA only in its disposable simulator and checks
clone, status, edits/commits, deletion, literal paths, credential-origin restrictions, remote
rejection, credential redaction, branch switching, bounded diffs, cancellation/timeouts, recovery,
and successful push. The fixture server runs Git on the test host;
no Git executable or shell is shipped in the app.

It then exercises branch creation and publication (upstream recording), ahead/behind counts,
credential-origin-bound fetch, fast-forward pull, pull rejection for local conflicts and diverged
histories (with the working tree and branch unchanged), typed non-fast-forward push rejection,
per-file and all-file discard, `git init` with an origin followed by an initial pull, and cancelled
fetch transfers. The remote confirmation verifies the fast-forwarded branch and that the rejected
diverged commit never reached the remote.

The Git regression also stages an edit, restores only the working file, and verifies that both
opposing patches remain independently labelled under one output budget. It then commits and checks
the actual committed blob and unchanged working file, along with clean, staged-only, unstaged-only,
untracked, and UTF-8 truncation cases.

```bash
node .agents/skills/local-e2e-validation/scripts/run.mjs \
  --evidence /absolute/path/to/new-git-evidence.jsonl \
  apps/mobile/modules/on-device-agent/tests/native-git.mjs
```

The workspace scenario compiles the production workspace actor with its file and Git tools. Beyond
containment, revisions, and search limits, it covers root listing with `''` and `"."`, typed error
codes, total-size reads, change tokens, UI rename/delete, workspace rename/delete (no leftovers),
non-repository status, `git init`, unborn-branch renaming, branch creation, staged counts, empty
commit rejection, missing-origin rejection, and discard.

It also persists a workspace under an owned iOS-style `/var` storage alias, reopens it through a
new store, and exercises root/nested listing, file reads, search-relative paths, and size. This
reproduces the real-device `/var` versus `/private/var` enumeration mismatch. Physical-root
normalization must preserve entry-symlink and traversal rejection; `~` must not expand to phone home.

Run the native regression:

```bash
node .agents/skills/local-e2e-validation/scripts/run.mjs \
  --evidence /absolute/path/to/new-workspace-evidence.jsonl \
  apps/mobile/modules/on-device-agent/tests/native-workspaces.mjs
```

The model-file scenario also exercises verification progress and cooperative cancellation (without
blocking other models' file operations), the storage overview, atomic local runtime documents,
preservation on rejected writes, prefix enumeration, and idempotent removal:

```bash
node .agents/skills/local-e2e-validation/scripts/run.mjs \
  --evidence /absolute/path/to/new-storage-evidence.jsonl \
  apps/mobile/modules/on-device-agent/tests/native-model-files.mjs
```

The local-run scenario compiles the production `LocalRunActivity` into a minimal app, starts a run
in the foreground, sends the app to the background, and checks that the process keeps running
until the run is warned with background time to spare and ends its activity, then that it is
suspended. The simulator has no
continued-processing scheduler, so it exercises the background-task fallback; continued
processing needs an iOS 26 device:

```bash
node .agents/skills/local-e2e-validation/scripts/run.mjs \
  --evidence /absolute/path/to/new-local-run-evidence.jsonl \
  apps/mobile/modules/on-device-agent/tests/native-local-run.mjs
```

The download scenario bundles the production `ModelDownloadController` against a local HTTPS
fixture. It downloads two models concurrently, pauses one while the other continues, resumes with
an HTTP Range request, then terminates the app mid-transfer and relaunches it. The background
session must re-attach (or have delivered the finished file) without restarting either transfer,
before verification, checksum rejection (which discards the staged file), the storage overview,
removal, and a pause whose checkpoint cannot be written are checked. While the app is terminated,
the scenario waits for iOS to relaunch it in the background and asserts (from the simulator log)
that the system's background-session completion handler is called. It needs the
Release simulator build above:

```bash
node .agents/skills/local-e2e-validation/scripts/run.mjs \
  --evidence /absolute/path/to/new-downloads-evidence.jsonl \
  apps/mobile/modules/on-device-agent/tests/native-downloads.mjs
```

`native-product.mjs` bundles the production router behind an isolated fixture bootstrap and drives
the unified experience as a new user would: onboarding → **On this iPhone** → a new chat in the
shared chat shell, Settings → Models and Git & GitHub, the shared model sheet and workspace chip, a
real Settings-driven model download and load, an offline file/stage/commit turn, every local file
tool plus Git inspection through chat, and a second workspace created and initialized through the
UI with its first file and commit. It also checks draft and history recovery across cold launches,
read-only file previews, dirty-edit protection, branch creation/switching, approved and denied
network tools, and a public HTTPS clone/file-commit-push round trip against its own loopback Git
server. No GitHub account is used. Automatic rating prompts are rejected during active work and
can be dismissed normally while idle. It also covers stop on background and the profile switcher.
Its handles live in `nativeOnDeviceSelectors`
(`e2e/fixtures/selectors.ts`). It requires an installed Appium/XCUITest driver, owns its Appium
server and disposable simulator, and serializes the WDA ports. Its native workspace
preparation and app-driven model download do not change the user app, Metro, or a desktop bridge.
Polling deadlines use monotonic elapsed time, so host clock corrections cannot prematurely
expire a stable-control check.
WDA's normal build cache is kept in this worktree's `local-builds/on-device-wda`, protected by that
lease; simulator state, logs, certificates, and app containers remain per-run.
All fixture bundles disable `.env` loading and public environment
overrides so they cannot inherit a user's configured bridge credentials.

The product fixture uses its own Metro configuration, never the release Metro configuration, to
route the fixed Exa MCP request through an owned loopback HTTPS transport. Approval, the production
request/response parser, streamed body handling, query and destination checks all remain real; no
workspace content or credentials are substituted. The scenario verifies zero requests before
approval and exactly one after Allow. Live Exa quota failures remain recorded separately, rather
than weakening a successful-search assertion or retrying them into passes.
The bundle helper scopes `EXPO_OVERRIDE_METRO_CONFIG` to the fixture exporter child process and
checks the adapter marker before starting Appium; Expo's embed exporter does not forward its
legacy `--config` option to Metro. Production builds continue using the unmodified default config.

Same-model transfer recovery copies this run's already verified genuine weights into its owned
HTTPS range server before deletion. It slows only that fixture transfer so Resume/Cancel cannot
race a nearly completed public CDN response, then explicitly enables fast transfer for the final
retry. Native URLSession, pause/resume/cancel, actual bytes, pinned SHA verification, and model
loading are unchanged. Initial model downloads still use the real catalog CDN.

`native-model-management.mjs` reuses that bootstrap for two-model transitions: a downloaded but
nonresident new-chat choice, matching Settings/default/header state, a Settings round trip,
an existing chat's lazy model change, real inference after switching the resident context,
and deletion of selected weights without deleting history or the remaining model.
The secondary download also exercises real Pause, Resume, Cancel, and a fresh verified retry,
while preserving the resident primary model.
Run it with each in-scope representative: secondary models cycle Qwen3.5 -> Bonsai 2 ->
Gemma 4 -> Qwen3.5 so every family is exercised as both the deleted model and the surviving fallback.

`native-model-transitions.mjs` specifically creates a Bonsai conversation before downloading
Qwen3.5 0.8B through that chat's model-picker link. It returns through the original drawer row,
asserts unchanged chat route keys and the retained draft, selects B, and immediately sends without
Settings Load or a replacement conversation. Fresh file probes require actual native tool reads,
not answers copied from earlier history. It then verifies independent conversation/default
choices and lazy B-to-A-to-B replacements:

```bash
DAPPERCODE_NATIVE_TEST_MODEL=bonsai-2-2b-q2-0 \
node .agents/skills/local-e2e-validation/scripts/run.mjs \
  --evidence /absolute/path/to/new-model-transitions.jsonl \
  apps/mobile/modules/on-device-agent/tests/native-model-transitions.mjs
```

`native-workspace-upgrade.mjs` compiles the production workspace/Git sources from release commit
`179be2006dc1d352df47a5a6653fbf381fd076e4` into a standalone native writer. It persists files,
literal-tilde paths, metadata and a Git commit, then installs the current native reader over the
same owned app container without uninstalling or resetting data. This verifies authentic
prior-production storage compatibility, not a physical-device OS upgrade or an old full app binary.
The separate `native-workspaces.mjs` gate covers retained storage through `/var`/`/private/var`
aliases and preserves containment, symlink and hard-link defenses.

`native-sibling-branches.mjs` covers deliberate Git discard gestures (including staged-byte
preservation), chat rename/delete confirmations and exact surviving history, and clone Stop/retry.
Selected-chat deletion must leave the surviving session list visible after navigation to New chat,
not merely preserve its persisted data.
It disables automatic alert acceptance so cancellation is actually exercised. The clone test pauses
only its tracked loopback Git-server PID, resumes it in `finally`, and verifies a real retry.
Run it with the same E2E runner and a new evidence path.

Tool-result expansion/collapse uses one physical tap at the measured header center per toggle.
The fixture's read-only shell journal records expansion state, distinguishing native hit routing
from application-state and rendering failures without a second, failure-hiding tap.
The product scenario also changes **Show tool calls** off/on through Settings while approval is
pending, verifies that approval stays available, and checks that one denied result renders once.
Focused single-model campaigns can pass `singleModelFamily: true` to the product or sibling scenario
to omit unrelated family browsing. The edge scenario's `sharedWorkflowOnly: true` retains shared
file-conflict and cancellation checks while omitting model-specific unsupported-request wording.
The original full scenario defaults remain unchanged.

```bash
DAPPERCODE_NATIVE_TEST_MODEL=qwen35-2b-q4-k-m \
node .agents/skills/local-e2e-validation/scripts/run.mjs \
  --evidence /absolute/path/to/new-model-management.jsonl \
  apps/mobile/modules/on-device-agent/tests/native-model-management.mjs
```

GitHub sign-in uses the bundled public DapperCode client ID. Forks can override
`EXPO_PUBLIC_GITHUB_CLIENT_ID` with their own Device Flow-enabled OAuth app, or set it empty to
disable sign-in. Native fixture bundles explicitly disable it. Never add a client secret. The
current strategy requests `repo` scope for private clone/push access; signing out locally does not
revoke the authorization at GitHub. Expiring tokens require signing in again; refresh is not yet
implemented.

## Dependencies and licenses

- [llama.rn](https://github.com/mybigday/llama.rn) and
  [llama.cpp](https://github.com/ggml-org/llama.cpp): MIT.
- [libgit2](https://github.com/libgit2/libgit2/tree/v1.9.7): GPLv2 with its linking exception.
  Retain upstream and bundled-dependency notices when distributing the native library.
- Test weights come from the selected entry in the [model catalog](../../src/features/on-device/models/catalog.json),
  with its pinned revision, checksum, and license. They are downloads, not committed application assets.
