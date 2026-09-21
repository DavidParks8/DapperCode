# Managed worktrees

On **New chat**, choose your workspace, **Local** or **New worktree**, and the branch.
Send your first message to start. **Local** uses the source checkout (switching to your chosen
branch); **New worktree** automatically creates an isolated checkout on a generated branch
from the selected source branch and starts the chat there. There is no checkout picker or
separate create/select step. Existing chats keep their workspace.

The base reference is local: fetch remote updates with your agent before using an updated
remote-tracking branch. Uncommitted changes in the original checkout are not copied.
Setup scripts, dependency installation, and copying local environment files remain explicit
agent tasks.

Chats retain their checkout path across reconnects and desktop restarts. Retrying interrupted
chat creation reuses the same checkout and chat submission ID. The original workspace stays
selected for subsequent new chats; generated paths are never installed as the workspace default.

The bridge's `bridge/worktrees/remove` maintenance RPC removes only the working directory and Git registration.
The branch and its commits are kept. Delete chats using that checkout first; this also prevents
queued work, scheduled prompts, or a live agent from losing its directory. Git refuses removal
of locked worktrees, and DapperCode refuses modified, untracked, or ignored files. It never
uses force removal. There is no automatic cleanup or automatic branch deletion.

## Storage and RPC

The desktop's per-workspace central state directory holds `managed-worktrees.json` and
`worktrees/<uuid>`. They are not written into the source repository. Standalone bridge setups
must set `BRIDGE_STATE_DIR` outside their repositories. The path policy grants access to this
worker's checkout directory, not to sibling profiles or the rest of its state directory.

The bridge must be updated before mobile. The new-chat flow directly calls the current contract
without a capability probe or older-bridge fallback.

`bridge/thread/create` accepts `workspace: { mode: 'local' | 'worktree', branch: string }` alongside
`submissionId` and `threadStart`. `HEAD` means the current branch. The bridge prepares the checkout
before starting the agent and returns the actual checkout in `thread.cwd`. Worktree IDs and branch
names are derived from the thread submission ID; retries reuse the saved base commit. Cached chat
creation returns before any checkout mutation. Existing clients omitting `workspace` retain the
ordinary thread creation behavior.

Protocol v2 also exposes `supports.managedWorktrees` and these maintenance RPCs:

- `bridge/worktrees/list` → `{ worktrees: ManagedWorktree[] }` (excludes removed entries).
- `bridge/worktrees/create` accepts `{ id, cwd, branch, baseRef }` and returns `{ worktree }`.
  `id` is a canonical UUID supplied by the client. Reuse it only with identical parameters.
  The bridge saves the resolved base commit before invoking Git, then marks the checkout ready.
- `bridge/worktrees/remove` accepts `{ id }` and returns `{ removed: true }`; retries are safe.

Each entry includes `id`, `repository`, `path`, `branch`, `baseRef`, `baseCommit`, and `status`
(`creating`, `ready`, or the internal tombstone `removed`). Removed IDs cannot be reused.

## Validation

The mobile layout suite creates a real checkout and sends a chat into it on phone and tablet.
For authenticated RPC, persistence, and removal checks against isolated real Git/ACP processes:

```bash
pnpm run cargo build --locked --manifest-path services/rust-bridge/Cargo.toml --features e2e-agent --bins
node .agents/skills/local-e2e-validation/scripts/run.mjs \
  --evidence /absolute/path/to/new-evidence.jsonl e2e/scenarios/managed-worktrees.mjs
```

Use a new evidence filename for every invocation. The runner cleans up its own processes,
credentials, checkouts, and state after success or failure.
