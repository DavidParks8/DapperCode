# Mobile end-to-end layout tests

The `e2e/` suite boots the real mobile app against the **production Rust bridge**, backed by a
deterministic typed ACP fixture, and makes assertions about where things actually end up on screen:
alignment, spacing, stacking order, overlap, containment, and touch-target size.

It is designed so that any number of runs can execute at the same time, on the same machine, as
other test runs.

## Running

```bash
pnpm run e2e            # both viewport projects
pnpm run e2e:phone      # 390x844
pnpm run e2e:tablet     # 834x1112
pnpm run typecheck:e2e
```

The first run exports the app for web, which takes a minute or two. Later runs reuse that bundle
until something it depends on changes.

CI runs the suite in the `Mobile E2E` job of `.github/workflows/build-and-test.yml`. It installs the
pinned Chromium separately, because dependency installation does not fetch browser binaries.

## What it is made of

| Path            | Responsibility                                                       |
| --------------- | -------------------------------------------------------------------- |
| `e2e/harness/`  | Production bridge lifecycle, the static server, and web build cache. |
| `e2e/fixtures/` | Playwright fixtures, app-state seeding, and named selectors.         |
| `e2e/layout/`   | Geometry reading, layout assertions, and shell detection.            |
| `e2e/specs/`    | The specs themselves.                                                |

### The bridge topology

The suite does not implement or mock the bridge protocol. `e2e/harness/realBridge.ts` launches the
same `dappercode-bridge` binary used in production. The only fake is
`dappercode-e2e-agent`, a typed ACP process compiled against the same Rust ACP SDK as the bridge.
It supplies deterministic sessions, history, streaming chunks, failures, and hold/release points.

Every request and notification between the app and bridge therefore passes through production
authentication, WebSocket framing, routing, serialization, replay, projection, and error handling.
The app under test is unmodified: no test-only branches and no stubbed transport.

The scenario (`e2e/harness/scenario.ts`) defines the sessions and messages the app will see. The
default one is built for layout work:

- `thread-layout` — a user message and a long, wrapping assistant answer.
- `thread-short` — a minimal thread.
- `thread-long-title` — a title far wider than the drawer, for truncation checks.

### Why the bridge cannot drift

There is no second bridge implementation to synchronize. A bridge RPC change immediately changes
the binary exercised by these tests. If its request shape, response shape, auth behavior, event
ordering, or projection changes incompatibly, the real mobile client sees that change in E2E.

The typed ACP fixture is deliberately on the other side of the boundary under test. It uses
`agent-client-protocol` request and response types instead of hand-written ACP JSON, and Cargo
compiles it only with the `e2e-agent` feature. It is not included in production builds.

`e2e/specs/bridge-workflows.spec.ts` also exercises the non-layout bridge workflows that are easiest
for a shallow fake to omit: forking a loaded conversation, starting/committing/cancelling a queued
message edit, and steering that queued message into an active turn. Fork and steer cross the typed
DapperCode ACP extensions; queue edits execute the production queue service.

### Seeding

`e2e/fixtures/seed.ts` writes the app's persisted state to `localStorage` before the first script
runs, so the app boots straight into a connected profile pointed at the isolated production bridge. Its
`version` must match `APP_STATE_VERSION` in `apps/mobile/src/shell/state/appState/model.ts`; if the
two drift, the app discards the seed and falls back to onboarding.

## Writing a layout assertion

Assertions live in `e2e/layout/assertions.ts`. They re-measure until they pass or time out, and
report the real measured boxes on failure:

```
Expected a vertical gap of 40px (±1), measured 0px.
  above: x=0 y=0 w=390 h=780 (right=390, bottom=780)
  below: x=0 y=780 w=390 h=64 (right=390, bottom=844)
```

Available: `expectVisible`, `expectLeftAligned`, `expectRightAligned`,
`expectSymmetricHorizontalInsets`, `expectVerticalGap`, `expectHorizontalGap`, `expectNoOverlap`,
`expectStackedVertically`, `expectRowOrder`, `expectContainedWithin`, `expectWithinViewport`,
`expectTouchTarget`, `expectStableDuring`.

Group assertions accept either an array of locators or a single locator that matches many, so list
rows can be passed straight in.

Prefer relationships over pixel constants. `expect(composer.width).toBe(transcript.width)` keeps
holding when the design changes; `expect(composer.width).toBe(390)` does not.

## The two shells

The app switches shells at `TABLET_LAYOUT_MIN_WIDTH` (700):

- **overlay** (narrow) — the drawer parks off-screen and slides over the chat.
- **pinned** (wide) — the drawer is docked and the chat occupies the remaining width.

`e2e/layout/shell.ts` independently states the intended breakpoint and measures the rendered shell
mode from the pane geometry. Assert against `shell.pane` rather than the viewport, or specs will fail
on tablet for the wrong reason. `app.openDrawer()` is shell-aware: on the pinned shell there is no
toggle, so it just waits for the docked drawer.

## Observing transient state

State that only exists mid-turn — the stop button, running indicators — must not be observed by
racing a timer. Pass `whileRunning` to `streamAssistantTurn`; the harness holds the run open until
your callback resolves:

```ts
await app.bridge.streamAssistantTurn({
  threadId: E2E_THREADS.layout,
  chunks: ['Working on it.'],
  whileRunning: async () => {
    await expectVisible(selectors.composerStopSlot(app.page));
  },
});
```

For live tool state, pass `toolSteps` containing typed ACP `tool_call` / `tool_call_update`
notifications and an optional `whilePaused` callback on each step. The fixture sends that update,
then holds until the callback finishes before sending the next update. Each hold is bounded to 30
seconds; failed observations release all remaining holds during cleanup. Tool steps run before
assistant chunks and the optional final `whileRunning` callback.

`patch-progress.spec.ts` exercises pending → running → revised same-file counts → a second long
path → status-only completion, plus a failed edit with missing/oversized diff counts. Both viewport
projects verify that per-file rows remain visible while details are collapsed, paths stay in stable
order without duplicates, counts and accessible labels agree, and rows do not overlap or escape the
transcript. It also verifies settled shimmer/stop/composer state and preservation through a page
reload from the real bridge snapshot. Running and settled screenshots use `testInfo.outputPath`
(`patch-running.png`, `patch-settled.png`, `patch-before-failure.png`, `patch-failed.png`).
It also streams unfinished `apply_patch` input one file header at a time, before any structured
diff or end marker. Add/update/move/delete chips appear immediately; partial filenames and raw
patch bodies stay hidden. Later diffs, completion/failure, and a snapshot reload preserve chip order.
These cases capture `patch-input-running.png` and `patch-input-settled.png`.

Run just this regression with `pnpm run e2e -- patch-progress.spec.ts`. When using the
`local-e2e-validation` skill, execute that command through its scripted runner rather than manually
orchestrating services.

## How parallel safety works

Nothing in the suite uses a fixed port or a shared mutable path.

- The production bridge, its preview listener, and the static server bind port `0`, so the OS
  assigns free ports.
- The web bundle is content-addressed: its directory name is a hash of `apps/mobile/src`, the app
  configs, and the build environment. Concurrent runs coordinate through a lock directory, build at
  most once, and publish by atomic rename, so no run can read a half-written bundle.
- Playwright's fixed `test-results` directory is redirected to `.e2e/runs/<runId>/`, and the run id
  is published to the environment so every worker in a run agrees on it.
- Each test copies both Rust executables into a unique runtime directory and gets unique state,
  workspace, manifest, control files, token, bridge process, and ACP process.

This is verified by running three full suites simultaneously and confirming all of them pass.

## Adding test handles

The suite targets `testID` (which react-native-web renders as `data-testid`) and existing
`accessibilityLabel` values. Add new selectors to `e2e/fixtures/selectors.ts` rather than inlining
raw strings in specs.

## Known web caveats

The app runs under react-native-web here, so a few things differ from a device:

- `expo-glass-effect` falls back to plain views, so glass surfaces are unblurred. Geometry is
  unaffected.
- Push registration is skipped, so `bridge/push/register` is never called.
- Attachment upload relies on native file handling and is not exercised.
- Gesture-driven interactions should be driven through their labeled buttons rather than simulated
  drags.
