# Managed worktrees

From the workspace picker, open **More actions → Managed worktrees** (or a folder's
context menu). Enter a new branch name and a starting reference such as `HEAD`, `main`,
or `origin/main`. **Create worktree** checks out the committed reference in a separate
directory. **Use worktree** selects it for a new chat. Existing chats keep their workspace.

The base reference is local: fetch remote updates with your agent before using an updated
remote-tracking branch. Uncommitted changes in the original checkout are not copied.
Setup scripts, dependency installation, and copying local environment files remain explicit
agent tasks.

Managed checkouts appear in this screen after reconnecting or restarting the desktop app.
Chats retain their checkout path. Multiple chats can use a checkout. A failed or interrupted
creation can be retried from its entry without creating a second checkout.

**Remove checkout** removes only the managed working directory and Git worktree registration.
The branch and its commits are kept. Delete chats using that checkout first; this also prevents
queued work, scheduled prompts, or a live agent from losing its directory. Git refuses removal
of locked worktrees, and DapperCode refuses modified, untracked, or ignored files. It never
uses force removal. There is no automatic cleanup or automatic branch deletion.

## Storage and RPC

The desktop's per-workspace central state directory holds `managed-worktrees.json` and
`worktrees/<uuid>`. They are not written into the source repository. Standalone bridge setups
must set `BRIDGE_STATE_DIR` outside their repositories. The path policy grants access to this
worker's checkout directory, not to sibling profiles or the rest of its state directory.

Protocol v2 adds the optional `supports.managedWorktrees` capability and:

- `bridge/worktrees/list` → `{ worktrees: ManagedWorktree[] }` (excludes removed entries).
- `bridge/worktrees/create` accepts `{ id, cwd, branch, baseRef }` and returns `{ worktree }`.
  `id` is a canonical UUID supplied by the client. Reuse it only with identical parameters.
  The bridge saves the resolved base commit before invoking Git, then marks the checkout ready.
- `bridge/worktrees/remove` accepts `{ id }` and returns `{ removed: true }`; retries are safe.

Each entry includes `id`, `repository`, `path`, `branch`, `baseRef`, `baseCommit`, and `status`
(`creating`, `ready`, or the internal tombstone `removed`). Removed IDs cannot be reused.
An older bridge shows an update message instead of enabling creation.

## Validation

The mobile layout suite creates a real checkout and sends a chat into it on phone and tablet.
For authenticated RPC, persistence, and removal checks against isolated real Git/ACP processes:

```bash
pnpm run cargo build --locked --manifest-path services/rust-bridge/Cargo.toml --features e2e-agent --bins
node .agents/skills/local-e2e-validation/scripts/run.mjs \
  --evidence /absolute/path/to/new-evidence.jsonl scripts/validate-managed-worktrees.mjs
```

Use a new evidence filename for every invocation. The runner cleans up its own processes,
credentials, checkouts, and state after success or failure.
