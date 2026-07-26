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

## Known follow-up

`MainScreen` is fed from atoms and registers its imperative commands through
`mainScreenCommandsAtom`, but its internal 35-hook context-accumulation chain (the `mainScreen*`
modules) still threads a growing `context` object. Converting that chain to atoms is the remaining
step; until then `MainScreen` is still remounted per bridge profile via a `key`.
