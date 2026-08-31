# Mobile end-to-end layout tests

The `e2e/` suite boots the real mobile app against a **harness bridge** and makes assertions about
where things actually end up on screen: alignment, spacing, stacking order, overlap, containment,
and touch-target size.

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

| Path            | Responsibility                                                    |
| --------------- | ----------------------------------------------------------------- |
| `e2e/harness/`  | The fake bridge, the static file server, and the web build cache. |
| `e2e/fixtures/` | Playwright fixtures, app-state seeding, and named selectors.      |
| `e2e/layout/`   | Geometry reading, layout assertions, and shell detection.         |
| `e2e/specs/`    | The specs themselves.                                             |

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

### Keeping the harness honest

A fake bridge is only useful while it still resembles the real one. The failure is quiet: if the
harness stops handling a method, it answers `methodNotFound`, the app degrades gracefully, and the
tests keep passing against a protocol nobody speaks any more.

Three layers close that gap, all anchored to `contracts/bridge-rpc/v2/manifest.json` — the same
manifest `scripts/validate-rpc-contract-fixtures.mjs` already checks the Rust bridge and the mobile
client against.

1. **Derived constants.** `e2e/harness/contract.ts` reads the manifest at import, and
   `e2e/harness/protocol.ts` takes the stream id and every error code from it, so the harness cannot
   hardcode a value the contract has moved on from. The protocol version is deliberately _not_
   inherited: `IMPLEMENTED_PROTOCOL_VERSION` is pinned, and the harness refuses to start when the
   manifest moves past it. Inheriting the number would let the harness advertise support for a
   protocol nobody had implemented, which is the exact failure this is meant to prevent.
2. **Runtime guards.** `setHandler` refuses a method the manifest does not declare, and `emit`
   refuses an undeclared notification, so a typo fails loudly instead of registering a handler the
   app will never call. Any inbound call the harness does not handle is recorded as contract drift
   and thrown at fixture teardown, which turns a silently degraded run into a failed test.
3. **A static gate.** `scripts/validate-e2e-harness-contract.mjs` starts the harness with no browser
   and checks that every handler is declared, that every method the mobile client can send is either
   handled or listed in `intentionallyUnmodelled` with a reason, and that no exclusion has gone
   stale. It reads the client's methods from the TypeScript AST rather than by pattern-matching the
   source, because a regex silently under-reported — it missed calls the formatter had split across
   lines, which is how two push methods went unnoticed. Method names that are not string literals
   are reported as failures, since a computed name makes coverage unprovable. It runs as part of
   `pnpm run contract:check`, so CI catches drift without installing Playwright.

Adding a bridge method therefore surfaces here as a build failure with the method name in it. Either
teach the harness to answer it, or record why the layout suite does not need it.

4. **Shape conformance.** Names alone were not enough, and provably so: the harness had been
   answering `bridge/workspaces/list` with `{path, name, isGitRepository}` while the bridge sends
   `{path, chatCount, updatedAt}`, and every name-level check passed. `e2e/harness/shapes.ts` now
   routes those payloads through `conforms<T>()`, typed against the mobile client's own response
   interfaces — the types the app is written against, which `contract:check` already holds against
   the Rust bridge. Because the values are object literals, TypeScript rejects both missing and
   invented fields, so `typecheck:e2e` fails on a drifted shape.

Coverage is honest about its own limits. `conforms` is applied where the client exports a response
type; methods whose payloads the client treats as opaque are still only checked by name, and the
`intentionallyUnmodelled` list records which methods the layout suite deliberately does not model.
That list is a coverage declaration, not a conformance claim.

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
