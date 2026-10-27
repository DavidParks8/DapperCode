# On this iPhone

The iOS app can run a coding model and its file/Git tools locally. This is a separate execution
target, not a bridge profile or a localhost server. Android and web continue to use desktop agents.

## First run

1. Choose **On this iPhone** on onboarding, or in a desktop connection's Settings.
2. Open **Model library**, download a compatible model, and choose **Load and use**.
   Search and **Downloaded only** narrow the catalog; downloaded and recommended models appear first.
   Downloads are pinned by revision, byte count, and SHA-256. Interrupted transfers can be paused,
   resumed, or removed; unverified weights cannot be loaded.
3. Open **Workspaces** and clone an HTTPS repository. Public repositories need no account.
   Sign in under **GitHub and author** before cloning a private GitHub repository.
   An empty file workspace is also available, but Git actions require a repository.
4. Set your Git author name/email, then start a **New local conversation**.
5. After preparation, inference, file edits, search, diffs, staging, branches, history, and commits
   work without internet. Push, cloning, sign-in, and new downloads require connectivity.

Existing desktop profiles and conversations are not migrated or deleted. The last explicitly
selected target is restored at startup. Switching back settles local work and unloads its model
before desktop lifecycle effects are mounted.

## Models and memory

The bundled catalog contains Qwen3 0.6B Q4_0, 1.7B Q4_K_M (recommended), and 4B Q4_K_M.
Catalog artifacts are immutable; arbitrary model URLs/imports are not supported.

Compatibility uses physical RAM plus a fresh native app-memory-headroom measurement. Admission
includes weights, the configured FP16 KV cache, working space, and a 384 MiB reserve. A model switch
releases the previous context before checking memory again. A loaded model is not double-counted
when starting generation. iOS can still reclaim memory or terminate an app; admission is an
estimate, not a Jetsam exemption.

All three catalog models have passed simulator CPU checks with the complete production tool
schemas, native file reads, JSON tool-result consumption, streaming, stop, and unload/reload.
Simulator headroom is explicitly labelled as host estimation. Physical-iPhone RAM limits, Metal
performance, thermal behavior, and offline battery use have **not** been certified. Do not publish
specific supported-phone or performance claims from simulator results.

Only one local context and one local turn run at a time. Context is bounded rather than silently
discarding history: start a new conversation or request smaller file chunks if a context fills.

## Tool and lifecycle boundaries

- Tools can list/read/write/exactly edit/rename/delete/search inside the selected app-private
  workspace. Paths cannot escape through traversal, symlinks, hard links, or Git metadata.
- Replacing existing files requires their last read revision. Output, search, and file sizes are
  bounded; truncation is explicit.
- Git uses linked libgit2, not a Git executable. Hooks, shell commands, package managers,
  interpreters, test runners, downloaded executable plugins, and JIT workarounds are unavailable.
  SSH, submodule/LFS hydration, custom providers' private credentials, and force-push are out of scope.
- Local tools run without per-tool approval dialogs. Choose workspaces accordingly and review
  changes before pushing. Desktop approval settings are unchanged.
- Stop waits for current work to settle. Git cancellation is cooperative; unresponsive transports
  have a 15-second connection/read/write timeout. A cancelled push may already have reached its remote.
- Backgrounding or a memory warning stops local work, pauses downloads, unloads the context, and
  flushes drafts/history. There is no promise of continuous background inference on iOS.
- User turns and tool intent are journaled before execution. After an interrupted launch, uncertain
  tools are marked interrupted and are **never automatically replayed**. Inspect the workspace and,
  for push, the remote before retrying.
- There is no automatic desktop/cloud fallback or synchronization of local workspaces.

## GitHub configuration

Register a GitHub OAuth app with Device Flow enabled. Put its **public client ID** in
`apps/mobile/.env` as `EXPO_PUBLIC_GITHUB_CLIENT_ID`, then rebuild the JavaScript/native application.
Never include a client secret. A build without a client ID explicitly disables sign-in; public
clones, local commits, and offline inference still work.

The user authorizes the displayed short-lived code on GitHub. The requested `repo` scope enables
private clone/push. Tokens are held in a separate device-only Keychain service; JavaScript stores
only an opaque credential reference, and models cannot read tokens. Credentials are restricted to
the authorized HTTPS origin. Redirects are not followed.

Signing out removes the local credential, not GitHub's authorization. Revoke the OAuth application
in GitHub account settings when necessary. Other authentication providers can implement the
feature's `GitProviderAuthStrategy`; the agent loop and file tools are provider-independent.

## Ownership and testing

`src/app/on-device` owns a separate route/provider subtree. `src/features/on-device` owns local
models, authentication, workspaces, tool dispatch, journals, and screens. The Expo module under
`modules/on-device-agent` owns native memory, Keychain, workspace containment, atomic document/model
storage, and Git. Native ABI version mismatches fail locally with a rebuild message.

`shell/runtime` selects target lifecycle at composition. Generic app-state hydration is independent
of the bridge lifecycle. Existing bridge clients, WebSocket/replay, ACP recovery, and `MainScreen`
do not acquire local-mode branches. Local chat directly reuses the existing transcript, composer,
theme, and layout primitives with projected chat DTOs.

See the [native module guide](../apps/mobile/modules/on-device-agent/README.md) for build and native
scenario commands. Run mobile lint/typecheck/tests, `typecheck:native`, architectural boundary tests,
and the production-bridge layout suite for integration changes. Real GitHub authorization requires
a configured client ID; physical-device validation remains a separate release gate.
