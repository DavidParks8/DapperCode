# Mobile end-to-end layout tests

The `e2e/` suite boots the real mobile app against a **harness bridge** and makes assertions about
where things actually end up on screen: alignment, spacing, stacking order, overlap, containment,
and touch-target size.

It is designed so that any number of runs can execute at the same time, on the same machine, as
other test runs.

## Running

```bash
npm run e2e            # both viewport projects
npm run e2e:phone      # 390x844
npm run e2e:tablet     # 834x1112
npm run typecheck:e2e
```

The first run exports the app for web, which takes a minute or two. Later runs reuse that bundle
until something it depends on changes.

## What it is made of

| Path                     | Responsibility                                                     |
| ------------------------ | ------------------------------------------------------------------ |
| `e2e/harness/`           | The fake bridge, the static file server, and the web build cache.   |
| `e2e/fixtures/`          | Playwright fixtures, app-state seeding, and named selectors.        |
| `e2e/layout/`            | Geometry reading, layout assertions, and shell detection.           |
| `e2e/specs/`             | The specs themselves.                                              |

### The harness bridge

`e2e/harness/bridgeServer.ts` implements the app's real wire protocol rather than mocking the
client: JSON-RPC-style frames over a WebSocket at `/rpc`, plus `GET /health` and
`POST /attachments`. On connect it pushes an unnumbered `bridge/connection/state` frame carrying
`protocolVersion: 2` and a stream id, then answers requests and emits notifications with
contiguous event ids.

Because it speaks the protocol, the app under test is unmodified: no test-only branches, no stubbed
transport.

The scenario (`e2e/harness/scenario.ts`) defines the sessions and messages the app will see. The
default one is built for layout work:

- `thread-layout` — a user message and a long, wrapping assistant answer.
- `thread-short` — a minimal thread.
- `thread-long-title` — a title far wider than the drawer, for truncation checks.

### Seeding

`e2e/fixtures/seed.ts` writes the app's persisted state to `localStorage` before the first script
runs, so the app boots straight into a connected profile pointed at the harness bridge. Its
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

Available: `expectVisible`, `expectLeftAligned` / `Right` / `Top` / `Bottom`,
`expectHorizontallyCentered`, `expectSymmetricHorizontalInsets`, `expectVerticalGap`,
`expectVerticalGapWithin`, `expectHorizontalGap`, `expectNoOverlap`, `expectOverlaps`,
`expectStackedVertically`, `expectRowOrder`, `expectContainedWithin`, `expectWithinViewport`,
`expectNotClipped`, `expectTouchTarget`, `expectSameSize`, `expectStableLayout`,
`expectStableDuring`.

Group assertions accept either an array of locators or a single locator that matches many, so list
rows can be passed straight in.

Prefer relationships over pixel constants. `expect(composer.width).toBe(transcript.width)` keeps
holding when the design changes; `expect(composer.width).toBe(390)` does not.

## The two shells

The app switches shells at `TABLET_LAYOUT_MIN_WIDTH` (700):

- **overlay** (narrow) — the drawer parks off-screen and slides over the chat.
- **pinned** (wide) — the drawer is docked and the chat occupies the remaining width.

`e2e/layout/shell.ts` imports that breakpoint from the app itself and exposes `readShell(page)`,
which reports the current mode plus the **chat pane** rect. Assert against `shell.pane` rather than
the viewport, or specs will fail on tablet for the wrong reason. `app.openDrawer()` is shell-aware:
on the pinned shell there is no toggle, so it just waits for the docked drawer.

## Observing transient state

State that only exists mid-turn — the stop button, running indicators — must not be observed by
racing a timer. Pass `whileRunning` to `streamAssistantTurn`; the harness holds the run open until
your callback resolves:

```ts
await app.bridge.streamAssistantTurn({
  threadId: 'thread-layout',
  chunks: ['Working on it.'],
  whileRunning: async () => {
    await expectVisible(selectors.composerStopSlot(app.page));
  },
});
```

## How parallel safety works

Nothing in the suite uses a fixed port or a shared mutable path.

- The harness bridge and the static server bind port `0`, so the OS assigns free ports.
- The web bundle is content-addressed: its directory name is a hash of `apps/mobile/src`, the app
  configs, and the build environment. Concurrent runs coordinate through a lock directory, build at
  most once, and publish by atomic rename, so no run can read a half-written bundle.
- Playwright's fixed `test-results` directory is redirected to `.e2e/runs/<runId>/`, and the run id
  is published to the environment so every worker in a run agrees on it.
- Each test gets its own bridge instance, so scenario mutations never leak between specs.

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
