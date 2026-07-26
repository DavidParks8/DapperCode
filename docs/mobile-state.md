# Mobile state management

The Expo app uses [jotai](https://jotai.org) for state that crosses component boundaries. Everything
lives under `apps/mobile/src/state`.

## Layout

| Path | Contents |
| --- | --- |
| `state/store.ts` | `createAppStore()` and the `AppStateProvider` mounted in `App.tsx` |
| `state/types.ts` | The `AppStore` type alias |
| `state/appState/atoms.ts` | Persisted app-state snapshot plus derived settings/profile/push selectors |
| `state/appState/actions.ts` | `initialize` / `dispatch` / `dispatchDurable` / `retryPersistence` / `flushPersistence` write atoms |
| `state/appState/settings.ts` | Read/write atoms for individual settings (`approvalModeAtom`, …) |
| `state/appState/persistenceCoordinator.ts` | Mutable write machinery behind the app-state atoms |
| `state/bridge/*` | Active bridge profile, WS/API clients, profile lifecycle actions |
| `state/navigation/*` | Current screen, onboarding mode, browser return screen, navigation actions |
| `state/chat/*` | Selected/active/pending chat routing and the chat-open transition |
| `state/drawer/atoms.ts` | Drawer visibility plus the imperative drawer commands |
| `state/commands.ts` | Screen-registered imperative entry points (replaces `useImperativeHandle` refs) |
| `state/theme.ts` | Theme derived from settings and the system colour scheme |
| `state/mainScreen/*` | MainScreen screen state, grouped by domain, plus the reset registry |
| `state/testing.ts` | `createAppStore` helpers for tests (`createTestStore`, `createBridgeTestStore`, `withAppStore`) |

## Conventions

- **Only lift state that crosses components.** State used inside a single component stays `useState`.
  Animation values (`useSharedValue`) and gesture objects stay local.
- **Actions are write-only atoms.** Anything that used to be a `useCallback` handler passed down as a
  prop should be an `atom(null, (get, set, …) => …)` so any component can trigger it with `useSetAtom`.
- **Read synchronously with `useStore()`** when a callback needs the current value without
  subscribing (for example the hardware back handler). This replaces the old "mirror state into a ref"
  pattern.
- **Never put a thenable in an atom.** jotai suspends on any value with a `then` method, which renders
  the subtree as `null` with no error. Test doubles built from `Proxy` must return `undefined` for
  `then`.
- **`wsClientAtom` / `apiClientAtom` are derived but writable.** Writing installs an override; that is
  the injection seam used by tests.

## App-state persistence

`appStateSnapshotAtom` is the single source of truth for persisted state (`{ loaded, data,
persistenceError }`). Everything else derives from it, so a publish that only changes the persistence
error does not re-render settings consumers.

`AppStatePersistenceCoordinator` owns the write machinery:

- a coalescing write loop that keeps only the newest pending payload,
- a serialized durable-write chain (`dispatchDurable`) that resolves only after the write succeeds and
  returns the next state,
- actions dispatched while a durable write is in flight are queued and replayed afterwards,
- write failures publish a typed `AppStatePersistenceError` without dropping in-memory state,
- `retryPersistence()` re-runs `initialize()` when the initial load failed.

One coordinator exists per store, resolved through a `WeakMap` keyed by the store.

## Testing

```ts
const store = createBridgeTestStore({ api, ws });
render(withAppStore(store, <SomeScreen />));
expect(store.get(currentScreenAtom)).toBe('Settings');
```

- `createTestStore({ data })` returns a store that is already loaded, backed by in-memory persistence.
- `createBridgeTestStore({ api, ws, … })` additionally hydrates an active bridge profile and injects
  the bridge clients.
- `createAppStateHarness(persistence)` exposes the coordinator through a small store-like facade for
  persistence tests.

Assert on store state rather than on callback props: screens no longer receive their wiring as props.

## MainScreen state

Every MainScreen state slot lives in `state/mainScreen/*`; there is no `useState` left in the
`mainScreen*` modules. Atoms are grouped by domain (`session`, `turn`, `models`, `workspace`,
`composer`, `modals`, `gitCheckout`, `toolInvocations`).

- **Always create them with `screenAtom`,** never `atom`. `screenAtom` registers the atom with
  `resetMainScreenStateAtom`, which `MainScreen` runs once per mount. Screen atoms outlive the
  component, so a bare `atom()` would leak state into the next bridge profile. `registry.test.ts`
  scans these files and fails on any bare `atom(`.
- **Action atoms live in `*Actions.ts`.** Write-only action atoms hold no state, so they are exempt
  from the `screenAtom` rule; in exchange `registry.test.ts` fails if an `*Actions.ts` module
  declares a `screenAtom`. `workspaceActions.ts` is the workspace browsing and git checkout
  behaviour: the workspace picker and git checkout are their own screens, so MainScreen is unmounted
  while they run and cannot own their callbacks.
- **Object and array atoms take a factory,** e.g. `screenAtom((): string[] => [])`. The type
  signature enforces it. Reset assigns whatever the factory returns, so a shared literal would let
  one in-place mutation poison the baseline for every later reset, in every store.
- **Non-React helpers use the store, not hooks.** The WS event processors (`processAgUiRunEvents`,
  `processTurnLifecycleEvents`, …) and the command executors (`executeSendMessage`,
  `executeSlashCommand`, …) are plain functions. They take the jotai store from `context.store` and
  use `store.get(atom)` / `screenSetter(store, atom)`.
- **Prefer `screenRefView` over mirroring state into a ref.** Jotai reads are already live, so
  `screenRefView(store, someAtom)` gives a read-only `{ current }` view with no duplicated state.

### Why `MainScreen` is still keyed by bridge profile

`AppScreenRenderer` renders `<MainScreen key={activeBridgeProfileId} />`. That remount is what clears
the component-local state the atoms deliberately do not cover:

- ~38 `useRef` caches in the hook chain (thread runtime snapshots, reasoning buffers, model
  preferences, parent-chat cache) and their pending timers.
- The feature controllers under `screens/controllers/` (`useDraftController`,
  `useAttachmentController`), which own their own `useState` and persistence and are tested
  standalone.

Remounting is the cheapest correct way to reset that state, and it is the mechanism those pieces were
already designed around. Atoms needed an explicit registry precisely *because* they cannot be cleared
by remounting. Both mechanisms are in place, and both are covered by tests.

## What is intentionally not in atoms

- **Feature controllers** (`screens/controllers/*`). They are cohesive, separately tested units that
  own their state and persistence. Moving them into atoms would relocate complexity, not remove it.
- **The accumulated `context` in the MainScreen hook chain.** It no longer carries raw state; what
  remains is effects, action callbacks, controllers and ref caches. Several modules named like
  selectors (`mainScreenSelectedRuntimeSelectors`) are actually effects that write atoms from ref
  caches, so they cannot become derived atoms. Converting the chain further would be churn rather
  than simplification.
- **Animation values and gesture objects**, which must stay component-local.
