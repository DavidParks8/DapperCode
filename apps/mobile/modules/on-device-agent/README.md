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
  operations. `GitNetworkOperation.swift` provides cooperative cancellation/progress; a small C
  boundary configures libgit2's 15-second connection and read/write timeouts.
- `ios/WorkspaceStore.swift` and `WorkspaceFileTools.swift` own actor-serialized workspace
  publication, containment, revision checks, and bounded UTF-8 operations.
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
- The native ABI is versioned (currently 7). An old binary is rejected before loading model
  variants that need the newer inference engine, including Bonsai 2's activation transforms.
- `scripts/build-git.mjs` builds pinned libgit2 1.9.7 for iOS arm64 and simulator arm64/x86_64.
  The source archive is SHA-256 verified. HTTPS uses SecureTransport; SSH, the CLI, and tests are
  excluded from the app library. Unmodified upstream notices (including bundled dependency
  licenses, llama.rn, and llama.cpp/ggml) are copied into the `OnDeviceAgentNotices` app resource bundle.
- Inference uses pinned `llama.rn` 0.13.0-rc.8, loaded only by the on-device feature. This maintained
  pre-release includes the upstream Hadamard runtime needed by Bonsai 2 Q2_0 weights. Its install script
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

## Validation

Native fixtures declare Expo's Metro types explicitly so lint/type-check works on a clean checkout,
without relying on the ignored `expo-env.d.ts` generated by local Expo commands.

```bash
pnpm --filter @dappercode/mobile run test --runInBand src/features/on-device/auth/github.test.ts
pnpm --filter @dappercode/mobile run typecheck:native
node --test scripts/__tests__/mobile-runtime-boundaries.test.mjs
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

It requires the iOS 27.0 iPhone 18 Pro simulator runtime and downloads a checksum-verified Qwen3-1.7B
Q4_K_M fixture (approximately 1.3 GB) into test-owned storage. The runner removes the fixture and
simulator after the run. It asserts structured tool calls, actual file reads, JSON tool-result
consumption, streaming, cancellation, unload/reload, and native credential storage/removal.
Set `DAPPERCODE_NATIVE_TEST_MODEL` to a bundled catalog ID to run the same complete-tool-schema
gate for another model. The original Qwen3 entries and ABI-6 representatives of Bonsai 2, Qwen3.5,
and Gemma 4 have passed the simulator gate. Prism-only Bonsai packings are explicitly unavailable.
This is not proof
of physical-iPhone Metal performance or measured phone RAM compatibility.

The separate native Git scenario runs the production Swift implementation against an isolated
authenticated HTTPS Git server. It installs a test CA only in its disposable simulator and checks
clone, status, edits/commits, deletion, literal paths, credential-origin restrictions, remote
rejection, credential redaction, branch switching, bounded diffs, cancellation/timeouts, recovery,
and successful push. The fixture server runs Git on the test host;
no Git executable or shell is shipped in the app.

The Git regression also stages an edit, restores only the working file, and verifies that both
opposing patches remain independently labelled under one output budget. It then commits and checks
the actual committed blob and unchanged working file, along with clean, staged-only, unstaged-only,
untracked, and UTF-8 truncation cases.

```bash
node .agents/skills/local-e2e-validation/scripts/run.mjs \
  --evidence /absolute/path/to/new-git-evidence.jsonl \
  apps/mobile/modules/on-device-agent/tests/native-git.mjs
```

The model-file scenario also exercises verification progress and cooperative cancellation (without
blocking other models' file operations), the storage overview, atomic local runtime documents,
preservation on rejected writes, prefix enumeration, and idempotent removal:

```bash
node .agents/skills/local-e2e-validation/scripts/run.mjs \
  --evidence /absolute/path/to/new-storage-evidence.jsonl \
  apps/mobile/modules/on-device-agent/tests/native-model-files.mjs
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

`native-product.mjs` bundles the production router/screens behind an isolated fixture bootstrap.
It requires an installed Appium/XCUITest driver, owns its Appium server and disposable simulator,
and serializes the WDA ports. Its native model/workspace preparation does not change the user app,
Metro, or a desktop bridge. All fixture bundles disable `.env` loading and public environment
overrides so they cannot inherit a user's configured bridge credentials.

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
- Test model: [Qwen3-1.7B GGUF](https://huggingface.co/ggml-org/Qwen3-1.7B-GGUF).
  Model weights are test downloads, not committed application assets.
