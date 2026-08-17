---
name: local-e2e-validation
description: Design and run faithful, isolated local end-to-end validation for defects and behavior changes. Use when a bug spans processes, clients, services, transports, persistence, authentication, lifecycle transitions, retries, upgrades, crashes, or recovery and cannot be proved by unit tests alone.
user-invocable: true
---

# Local E2E Validation

Use this skill to turn a reported symptom into deterministic local end-to-end evidence. The goal is
not merely to show that the final value looks correct. Reproduce the real sequence at the public
boundary, observe the broken transition, apply the fix, and prove recovery across every coupled
state.

## Mandatory scripted workflow

Do not orchestrate E2E runs with an improvised sequence of shell commands. Encode the scenario as an
ES module and execute it with the bundled runner:

```bash
node .agents/skills/local-e2e-validation/scripts/run.mjs \
  --evidence /absolute/path/to/session-artifacts/evidence.jsonl \
  /absolute/path/to/scenario.mjs
```

The evidence path must be new for that invocation. The runner reserves it atomically and refuses to
overwrite another agent's evidence.

Start from:

```text
.agents/skills/local-e2e-validation/scripts/scenario-template.mjs
```

Store one-off scenarios in the session artifact directory, not the repository. Commit a scenario
only when it is intended to become permanent regression infrastructure.

The scenario must export:

```js
export const name = 'short-scenario-name';
export const contract = {
  requiredPhases: ['setup', 'baseline', 'trigger', 'broken-state', 'recovery', 'confirmation'],
};

export default async function scenario(e2e) {
  // Scripted phases and assertions.
}
```

The runner rejects missing phases, duplicate phases, reserved phase names, and any required phase
with no scripted assertions. It emits deterministic JSON Lines evidence, records the terminal run as
`pass`, `fail`, `aborted`, or `cleanup-fail`, and returns nonzero on any failed command, timeout,
assertion, transport error, abnormal termination, or cleanup error.

Use the harness instead of implementing these concerns again:

| Concern                               | Required API                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| Unique run root and directories       | Automatic: `root`, `runId`, `dataDir`, `workspaceDir`, `logDir`, `runtimeDir` |
| Structured phases                     | `e2e.phase(name, fn)`                                                         |
| Recorded assertions                   | `e2e.check`, `expectEqual`, `expectMatch`, `expectSubset`                     |
| Foreground commands                   | `e2e.run(command, args, options)`                                             |
| Background processes                  | `e2e.start` and exact-handle `stop`; Unix process groups are drained          |
| Bounded polling                       | `e2e.waitFor` and `e2e.waitForLog`                                            |
| HTTP                                  | `e2e.requestHttp`                                                             |
| WebSocket                             | `e2e.openWebSocket`                                                           |
| Secrets and output redaction          | `e2e.createSecret` and `registerSecret`                                       |
| Bounded shared-service names          | `e2e.namespace(label, maxLength)`                                             |
| Guarded test files/runtime copies     | `writeFile`, `readFile`, `copyIntoRun`, `remove`                              |
| Non-isolatable resource serialization | `e2e.acquireLease`                                                            |
| Process/socket/lease/temp cleanup     | Automatic in the runner's `finally` path                                      |

Direct shell or process logic is allowed only for the defect-specific operation itself, and even
then it must be launched through `e2e.run` or `e2e.start`. Do not hand-roll temp roots, process
tracking, timeouts, redaction, port polling, or cleanup in the scenario.

If the harness changes, run its deterministic self-test:

```bash
node --test .agents/skills/local-e2e-validation/scripts/harness.test.mjs
```

## Deterministic division of responsibility

The agent decides only what cannot be generalized:

1. the smallest faithful topology;
2. the exact production action that triggers the defect;
3. the intended recovery action;
4. the observable states that constitute failure and success.

Everything else belongs in code. The scenario must contain literal commands, arguments, timeouts,
predicates, expected values, and cleanup ownership. Do not rely on narrative instructions such as
"wait until ready," "verify it looks correct," or "restart if needed."

## Core principles

- **Test the reported sequence, not a proxy.** Match the order, timing, navigation, lifecycle, and
  state transitions that produce the defect.
- **Use the real public boundary.** Exercise the same UI action, CLI, HTTP route, WebSocket, RPC,
  queue, file, database, or process entry point used in production.
- **Keep the topology faithful.** Use real binaries, authentication, transport framing, persistence,
  and process boundaries whenever they own the behavior.
- **Isolate everything.** Use temporary state, workspaces, credentials, ports, databases, queues,
  caches, and logs. Never repurpose a user's running service.
- **Prove both sides.** Capture the failure before the fix when feasible, then run the same scenario
  after the fix.
- **Assert coupled states.** Verify all user-visible and operational states derived from the defect,
  not only the primary result.
- **Bound every wait.** Poll observed conditions with explicit deadlines. Never use an unbounded
  sleep or assume startup/recovery completed.
- **Clean up securely.** Stop only processes launched by the scenario and remove temporary secrets
  even after failure.
- **Assume concurrent agents.** Every invocation must own a unique namespace and must remain correct
  when other agents run the same skill at the same time.
- **Treat compilation and health checks as prerequisites, not proof.**

## Parallel execution contract

Parallel safety is a hard requirement. Assume every agent already runs in its own isolated git
worktree. The current worktree owns source files, generated files, dependency links, normal build
outputs, and packaged artifacts. Never read, write, build, or clean another agent's worktree or the
main checkout.

The worktree does not isolate runtime state outside the repository. The runner atomically creates a
unique root with `mkdtemp` and derives all standard runtime directories from it. Scenario code must
use the supplied paths rather than inventing paths from task names, branches, timestamps, PIDs, or a
shared location such as `/tmp/e2e`.

Every mutable or addressable resource must be per-run:

| Resource         | Parallel-safe rule                                                                      |
| ---------------- | --------------------------------------------------------------------------------------- |
| App data/config  | Store only under `e2e.dataDir`                                                          |
| Workspace/files  | Store only under `e2e.workspaceDir`                                                     |
| Logs/screenshots | Store only under `e2e.logDir`                                                           |
| Secrets/tokens   | Use `e2e.createSecret`; persist only through guarded run-root paths                     |
| SQLite/files     | Use a unique file under `e2e.dataDir`                                                   |
| PostgreSQL       | Name the database/schema with `e2e.namespace` and drop it afterward                     |
| Queues/topics    | Name topics, groups, and idempotency keys with `e2e.namespace`                          |
| Object storage   | Prefix buckets/keys with `e2e.namespace`                                                |
| Browser state    | Use a unique profile directory under `e2e.root`                                         |
| Mobile state     | Use a separate simulator/device or resettable app container assigned to the run         |
| Ports            | Bind port `0` or use the application's isolated allocator; record the actual bound port |
| Processes        | Record exact child PIDs/process handles in this run only                                |
| Runtime copies   | Use `e2e.copyIntoRun(source, 'runtime/...')` before mutating them                       |
| Build output     | Use only the current worktree's normal project build output                             |

Never select a port by guessing a random number and then closing a probe socket before launch. Prefer
one of:

1. pass port `0` and read the server's assigned address;
2. let the application's allocator reserve a port inside the run's isolated state;
3. keep an allocation lease open until the child accepts the inherited/reserved listener.

Machine-level caches managed safely by the project's existing build/package tooling may remain
shared. Do not manually clean, rewrite, or repurpose them.

For builds:

- Use the repository's supported build command inside the current worktree.
- Never point build output at the main checkout or another worktree.
- Once a scenario starts, copy any binary that will be deleted, replaced, corrupted, or versioned
  with `e2e.copyIntoRun`. Never mutate the worktree's canonical build artifact during failure
  injection.
- Launch services in foreground mode. If a launcher exits after daemonizing descendants, the harness
  terminates the remaining process group rather than allowing an untracked service to escape.
- On Windows, use the application's scoped stop command or an existing repository process-tree
  helper for services that create descendants; a bare Node child handle cannot provide Unix process
  group semantics.
- Do not override project-managed cache variables unless the repository requires it; a cache is not
  the runtime isolation boundary.

For non-isolatable resources:

- A single simulator, hardware device, fixed external account, system keychain item, singleton
  daemon, or fixed-port service cannot be used concurrently without a lease.
- Acquire an atomic, named loopback lease for that exact resource and `await` its release function.
- Lease ownership is an OS-held TCP listener derived from the resource name. Contenders receive
  `EADDRINUSE`, and crashes release the lease automatically without stale-lock reclamation.
- If the project has no lock helper, serialize that scenario. Do not claim it is parallel-safe.
- Holding a resource lock does not permit sharing test data; each run still needs its own namespace.

The runner records only its non-secret `runId` in normal evidence so failures can be attributed
without exposing credentials or full paths.

## 1. Define the behavioral contract

Encode the transition table as named scenario phases before running commands:

| Phase        | Action                             | Observable state            | Required assertion                    |
| ------------ | ---------------------------------- | --------------------------- | ------------------------------------- |
| Baseline     | Start the real topology            | System is ready             | Public operation succeeds             |
| Trigger      | Reproduce the reported sequence    | Defect appears              | Exact error/state is observed         |
| Intermediate | Inspect every affected surface     | Coupled state is consistent | No stale or success-shaped state      |
| Recovery     | Apply the intended recovery action | System settles              | Controls, processes, and status agree |
| Confirmation | Repeat the original operation      | Normal behavior returns     | Real public operation succeeds        |
| Cleanup      | Stop isolated resources            | No test state remains       | Processes and temp paths are gone     |

Be concrete. Each required observable becomes an `e2e.check` or `expect*` call. For a lifecycle
defect, assert status text, loading indicators, controls, connection state, process state, persisted
state, and retry behavior. For a data defect, assert writes, reads, indexes, caches, and restart
durability.

## 2. Map the owning layers

Trace the shortest complete path from the user action to the failing resource:

```text
client -> public transport -> coordinator -> worker/service -> persistence/external dependency
```

Identify:

- the public request or UI action;
- authentication and routing metadata;
- each process boundary;
- durable and in-memory state;
- retry, timeout, and cancellation owners;
- status/health surfaces;
- recovery and shutdown paths.

Test the lowest layer that owns the bug with an automated regression test. Add E2E when the failure
crosses layers, depends on wiring, or appears only during a real transition.

## 3. Choose the smallest faithful topology

Prefer the least expensive topology that preserves the defect:

| Defect class          | Minimum faithful topology                                       |
| --------------------- | --------------------------------------------------------------- |
| UI navigation/state   | Real screen tree, router, state providers, and user interaction |
| HTTP/API integration  | Real server, auth, route, persistence, and client request       |
| WebSocket/reconnect   | Real upgrade, framing, auth, disconnect, retry, and replay      |
| Queue/idempotency     | Real admission path, durable queue/state, worker, and retry     |
| Process lifecycle     | Real executable, owner/supervisor, signals, status, and restart |
| Upgrade/replacement   | Two independently copied builds or runtime layouts              |
| Persistence/recovery  | Real storage, process restart, re-read, and cache invalidation  |
| Background/foreground | Real lifecycle transition and every derived control/state       |

Mock only dependencies that cannot safely or deterministically run locally. Do not mock the layer
whose behavior is under test.

## 4. Configure the private test root

The runner has already created all test-owned directories:

```js
const appEnv = {
  APP_DATA_DIR: e2e.dataDir,
  APP_SECRETS_BACKEND: 'file',
  APP_ENV: 'test',
};
```

Adapt environment names to the project, pass `appEnv` explicitly to every `e2e.run`/`e2e.start`,
and add a scripted assertion that configuration resolved under `e2e.root`. Confirm from source that
each variable is actually honored.

Safety requirements:

- bind servers to loopback;
- allocate or reserve ports per run rather than hard-coding shared defaults;
- create test credentials with `e2e.createSecret`;
- never print credentials or raw pairing/config payloads;
- never read or modify the normal user data directory;
- stop only handles returned by `e2e.start`;
- create remote or shared-service object names with `e2e.namespace`;
- never use `pkill`, `killall`, wildcard deletion, or broad recursive cleanup.

## 5. Build once and freeze the artifacts

Build the exact artifacts under test in the current worktree before starting the scenario. For
lifecycle or upgrade defects, copy artifacts into independent runtime layouts under the run root:

```text
<test-root>/runtime-a/...
<test-root>/runtime-b/...
```

Use runtime A to establish the old state and runtime B to exercise replacement or recovery. This
avoids accidentally validating against a file that was rebuilt in place during the scenario.

Verify expected files, permissions, versions, and hashes before launch. Do not silently fall back to
another runtime from `PATH`.

## 6. Establish the baseline through the real boundary

Start the topology using project-supported commands through `e2e.start`. Wait for readiness with
`waitForLog`, `waitFor`, or a real transport probe, then perform a real operation.

Readiness is not the same as correctness:

- a health endpoint proves only that the listener responds;
- a connected socket proves only that the upgrade completed;
- a visible screen proves only that rendering occurred;
- an admitted queue item proves only that admission succeeded.

Follow readiness with the actual operation that matters: authenticated RPC, persisted write/read,
message completion, navigation result, worker output, or equivalent.

## 7. Reproduce the failure exactly

Trigger the real sequence without adding unrelated delays or actions. Examples:

- disconnect during an in-flight request;
- delete or replace a runtime after a supervisor starts;
- background then foreground during streaming;
- crash between durable admission and in-memory dispatch;
- rotate credentials while a connection is cached;
- navigate away and back before an async transition settles;
- restart after a write but before cache refresh.

Assert the first broken boundary and all coupled states with recorded checks. Capture structured
evidence such as:

- HTTP status and bounded response body;
- WebSocket open/close code and sanitized reason;
- RPC method/result/error;
- process PID, start identity, listener state, and exit status;
- queue item state and idempotency record;
- persisted row/document and cache state;
- visible text, enabled controls, loading indicators, and navigation route.

## 8. Exercise recovery

Use the same recovery path expected in production: retry, reconnect, restart, replacement, replay,
reload, foreground transition, or operator action.

Verify the transition from broken to settled:

1. Recovery is initiated once.
2. Stale work is cancelled or fenced.
3. Ownership and routing remain correct.
4. Durable state is preserved.
5. The old resource releases ports, locks, files, or leases.
6. Status and controls settle consistently.
7. The original public operation succeeds.

Then repeat one adjacent lifecycle operation, such as a second reconnect, explicit restart, process
crash, cache reload, or app navigation cycle. This catches fixes that work only once.

## 9. Use bounded observation

Use `e2e.waitFor`, `waitForLog`, `requestHttp`, WebSocket message waits, or process `wait`. Every API
has a deadline and names its failure boundary. Do not call a raw sleep to infer readiness. A short
sleep is acceptable only inside deterministic failure injection when elapsed time itself is the
input under test.

For asynchronous clients, set one timeout per phase and preserve structured close/error data before
disposing the client.

## 10. Clean up on every path

The runner installs cleanup before invoking the scenario. It closes tracked sockets, terminates
tracked process groups in reverse order, releases leases, emits cleanup evidence, and removes only
the root it created. A scenario must not install a competing global cleanup handler.

The runner blocks new phases, processes, sockets, files, and leases as soon as cleanup begins. On the
next invocation it removes abandoned run roots only when their owner marker identifies a dead PID.
The operating system releases loopback leases when the runner dies. Roots retained explicitly with
`--keep-artifacts` are never reaped automatically.

If the application has a graceful, isolated stop command, invoke it in a final scripted phase. The
runner remains the fallback and fails the run if a tracked process cannot be stopped. Cleanup never
matches by process name or port, so concurrent agents remain isolated.

Temporary artifacts may contain credentials. Persist only sanitized JSONL evidence with
`--evidence`. Preserve raw logs/state only with the runner's explicit `--keep-artifacts` option,
then remove the reported run root manually afterward.

## 11. Run repository validation

After E2E succeeds:

1. Run the smallest automated regression that owns the defect.
2. Run required formatting, lint, type-check, and test commands.
3. Build the production artifact used by the affected platform.
4. Repeat the E2E with the final built artifact if the build changed binaries or packaging.

Do not introduce a new test framework when the repository already has one.

## Evidence standard

Report:

- non-secret run ID;
- exact topology and isolation boundaries;
- original trigger sequence;
- observed pre-fix failure;
- recovery action;
- final public-boundary result;
- every coupled state asserted;
- timeout bounds;
- test/build counts;
- cleanup result.

The JSONL file passed to `--evidence` is the source of truth. Summarize it; do not reconstruct phase
outcomes from memory.

Example:

```text
Topology: isolated client + server + worker + temporary database on loopback
Run: project-e2e.A1b2C3
Trigger: disconnect after admission, before worker acknowledgement
Failure evidence: socket close 1013; item remained pending; retry control enabled
Recovery: reconnect and replay from event 42
Final evidence: operation completed once; pending cleared; control disabled; persisted result read
Validation: 84 targeted tests, full lint/typecheck, production build
Cleanup: all child PIDs exited; temporary root removed
```

## Anti-patterns

Do not accept:

- compilation as E2E proof;
- `/health` as proof the real operation works;
- a helper's final value instead of the transition sequence;
- mock-only coverage for a transport or process defect;
- a manual test with no assertions or bounded waits;
- a scenario that bypasses the bundled runner;
- a required phase with no `e2e.check`/`expect*` assertion;
- hand-written temp-root, process-tracking, timeout, redaction, or cleanup code;
- retries that hide the initial failure;
- success-shaped fallback after an error;
- testing against a user's configured service or data;
- hard-coded temp paths, ports, database names, queue names, or browser profiles;
- reading, building, cleaning, or mutating another agent's worktree;
- mutating the worktree's canonical build artifact during failure injection;
- name-based process termination;
- daemonizing a service outside the tracked process group;
- cleanup that can target paths or processes outside the scenario;
- preserving secret-bearing artifacts by default.

The scenario is complete only when the original operation succeeds through the real public boundary,
all coupled states agree, and the isolated environment is gone.
