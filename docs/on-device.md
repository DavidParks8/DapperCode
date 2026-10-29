# On this iPhone

The iOS app can run a coding model and its file/Git tools locally. This is a separate execution
target, not a bridge profile or a localhost server. Android and web continue to use desktop agents.

## First run

1. Choose **On this iPhone** on onboarding, or in a desktop connection's Settings.
2. Open **Model library**, choose a family, then compare its sizes and quants on the next page.
   Download a compatible quant and choose **Load and use**. Search and **Downloaded only** narrow
   the family list. Back returns from the quant page to the family list; selecting for an existing
   conversation returns directly to that conversation.
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
includes weights, the configured FP16 KV cache, working space, and a 384 MiB reserve. A model switch
releases the previous context before checking memory again. A loaded model is not double-counted
when starting generation. iOS can still reclaim memory or terminate an app; admission is an
estimate, not a Jetsam exemption.

The three original Qwen3 variants have passed simulator CPU checks with the complete production tool
schemas, native file reads, JSON tool-result consumption, streaming, stop, and unload/reload.
Representative modern-family checks on ABI 6 also pass for Bonsai 2 2B Q2_0, Qwen3.5 0.8B Q4_0,
and Gemma 4 E2B Q4_0. These are native tool-calling checks, not just successful model loads.
Other size/quant variants share those architectures but do not constitute measured phone support.
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
