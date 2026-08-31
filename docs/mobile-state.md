# Mobile state management

The Expo app uses [jotai](https://jotai.org) for state that crosses component boundaries. Everything
lives under `apps/mobile/src/shell/state`, with feature-owned state under each feature root.

## Layout

| Path                                       | Contents                                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `shell/state/store.ts`                     | `createAppStore()` and the `AppStateProvider` mounted in `src/app/_layout.tsx`                      |
| `shell/state/types.ts`                     | The `AppStore` type alias                                                                           |
| `shell/state/appState/atoms.ts`            | Persisted app-state snapshot plus derived settings/profile/push selectors                           |
| `shell/state/appState/actions.ts`          | `initialize` / `dispatch` / `dispatchDurable` / `retryPersistence` / `flushPersistence` write atoms |
| `shell/state/appState/settings.ts`         | Read/write atoms for individual settings (`approvalModeAtom`, …)                                    |
| `shell/state/appState/persistenceCoordinator.ts` | Mutable write machinery behind the app-state atoms                                            |
| `shell/state/bridge/*`                     | Active bridge profile, WS/API clients, profile lifecycle actions                                    |
| `src/app/*`                                | Expo Router layouts and thin route adapters; URL paths are navigation state                         |
| `shell/navigation/routes.ts`               | Typed builders for canonical profile, chat, settings, and pushed-screen URLs                        |
| `shell/navigation/actions.ts`              | Router-backed application commands that also coordinate related domain atoms                        |
| `shell/state/chat/*`                       | Selected/active/pending chat data and the chat-open transition                                      |
| `shell/state/drawer/atoms.ts`              | Imperative access to the Router drawer from custom in-screen headers                                |
| `shell/state/drawer/contentAtoms.ts`       | Per-drawer source, derived view-slice, and action atoms for loading, filtering, and selection        |
| `shell/state/commands.ts`                  | Screen-registered imperative entry points (replaces `useImperativeHandle` refs)                     |
| `shell/state/theme.ts`                     | Theme derived from settings and the system colour scheme                                            |
| `features/chat/state/*`                    | MainScreen screen state, grouped by domain, plus the reset registry                                 |
| `shell/state/testing.ts`                   | `createAppStore` helpers for tests (`createTestStore`, `createBridgeTestStore`, `withAppStore`)     |

## Conventions

- **Only lift state that crosses components.** State used inside a single component stays `useState`.
  Animation values (`useSharedValue`) and gesture objects stay local.
- **Actions are write-only atoms.** Anything that used to be a `useCallback` handler passed down as a
  prop should be an `atom(null, (get, set, …) => …)` so any component can trigger it with `useSetAtom`.
- **Read synchronously with `useStore()`** when a callback needs the current value without
  subscribing. This replaces the old "mirror state into a ref" pattern.
- **Scope transient view atoms by atom identity when component instances must not share them.** The
  drawer creates one stable atom bundle per profile/client and puts only those atom handles in
  context. Leaf components subscribe to narrow derived slices, so context never broadcasts changing
  view-model values and one profile cannot inherit another profile's search or selection state.
- **Never put a thenable in an atom.** jotai suspends on any value with a `then` method, which renders
  the subtree as `null` with no error. Test doubles built from `Proxy` must return `undefined` for
  `then`.
- **`wsClientAtom` / `apiClientAtom` are derived but writable.** Writing installs an override; that is
  the injection seam used by tests.

## Navigation

Expo Router is the only source of truth for navigation. Every screen has a profile-aware URL under
`/profiles/[profileId]`; chats and sub-agent transcripts use dynamic path parameters. Use the typed
builders in `shell/navigation/routes.ts`, clear nested detail history before selecting a profile or chat,
use `router.push` for hierarchical drill-in screens, and use `router.back` for one-level dismissal.
The one-shot new-chat handoff guard only prevents a superseded chat URL from rehydrating while `/new`
settles; it clears as soon as that route arrives and never determines the active route itself.

Do not put route names, path parameters, current-screen selectors, back-stack state, or drawer
visibility in Jotai. Ephemeral data needed by a destination may remain in atoms when it is not safe
or meaningful in a URL, such as a local browser-preview target. The anchored Expo Router chat Stack
keeps its index MainScreen mounted beneath Git, workspace, checkout, and nested sub-agent routes,
including on cold deep links.

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
expect(store.get(selectedChatIdAtom)).toBe('thread-1');
```

- `createTestStore({ data })` returns a store that is already loaded, backed by in-memory persistence.
- `createBridgeTestStore({ api, ws, … })` additionally hydrates an active bridge profile and injects
  the bridge clients.
- `createAppStateHarness(persistence)` exposes the coordinator through a small store-like facade for
  persistence tests.
- Use `expo-router/testing-library` and `renderRouter` for path, deep-link, stack, and back-navigation
  assertions. Component tests may use `shared/testing/expoRouterMock` when the URL itself is not under test.

Assert on store state rather than on callback props: screens no longer receive their wiring as props.

## MainScreen state

Every MainScreen state slot lives in `features/chat/state/*`; there is no `useState` left in the
`mainScreen*` modules. Atoms are grouped by domain (`session`, `turn`, `models`, `workspace`,
`composer`, `modals`, `gitCheckout`, `runtime`, `toolInvocations`).

- **Always create them with `screenAtom`,** never `atom`. `screenAtom` registers the atom with
  `resetMainScreenStateAtom`, which `MainScreen` runs once per mount. Screen atoms outlive the
  component, so a bare `atom()` would leak state into the next bridge profile. `registry.test.ts`
  scans these files and fails on any bare `atom(`.
- **Action atoms live in `*Actions.ts`.** Write-only action atoms hold no state, so they are exempt
  from the `screenAtom` rule; in exchange `registry.test.ts` fails if an `*Actions.ts` module
  declares a `screenAtom`. `workspaceActions.ts` is the workspace browsing and git checkout
  behaviour: the workspace picker and git checkout are pushed screens, so their callbacks cannot
  live inside MainScreen.
- **Object and array atoms take a factory,** e.g. `screenAtom((): string[] => [])`. The type
  signature enforces it. Reset assigns whatever the factory returns, so a shared literal would let
  one in-place mutation poison the baseline for every later reset, in every store.
- **Non-React helpers use the store, not hooks.** The WS event processors (`processAgUiRunEvents`,
  `processTurnLifecycleEvents`, …) and the command executors (`executeSendMessage`,
  `executeSlashCommand`, …) are plain functions. They take the jotai store from `context.store` and
  use `store.get(atom)` / `screenSetter(store, atom)`.
- **Prefer `screenRefView` over mirroring state into a ref.** Jotai reads are already live, so
  `screenRefView(store, someAtom)` gives a read-only `{ current }` view with no duplicated state.
  Thread runtime snapshots use this pattern: MainScreen helpers keep synchronous `.current` reads
  while the pushed sub-agent route subscribes to the same resettable atom.

### Why `MainScreen` remounts with route identity

The chat index keys MainScreen by bridge profile. Switching profile identity remounts MainScreen and
clears the component-local state the atoms deliberately do not cover:

- Dozens of `useRef` caches in the hook chain (reasoning buffers, model preferences, parent-chat
  cache) and their pending timers.
- The feature controllers under `features/chat/composer/controllers/` (`useDraftController`,
  `useAttachmentController`), which own their own `useState` and persistence and are tested
  standalone.

Remounting is the cheapest correct way to reset that state, and it is the mechanism those pieces were
already designed around. Atoms needed an explicit registry precisely _because_ they cannot be cleared
by remounting. Both mechanisms are in place, and both are covered by tests.

## What is intentionally not in atoms

- **Feature controllers** (`features/chat/composer/controllers/*`). They are cohesive, separately tested units that
  own their state and persistence. Moving them into atoms would relocate complexity, not remove it.
- **The accumulated `context` in the MainScreen hook chain.** It no longer carries raw state; what
  remains is effects, action callbacks, controllers and ref caches. Several modules named like
  selectors (`mainScreenSelectedRuntimeSelectors`) are actually effects that write atoms from ref
  caches, so they cannot become derived atoms. Converting the chain further would be churn rather
  than simplification.
- **Animation values and gesture objects**, which must stay component-local.

## Liquid glass

`shared/ui/glass/GlassSurface.tsx` is the only app-level primitive for native iOS Liquid Glass. It
always renders Expo's `GlassView`; Expo itself degrades that view to an ordinary native view on
unsupported platforms. The app's `isGlassAvailable()` gate additionally requires iOS, the Liquid
Glass design, and the runtime Glass Effect API, because some iOS 26 beta releases exposed an
incomplete API.

When the gate is false, `GlassSurface` sets `glassEffectStyle="none"` and applies the theme role's
solid fallback surface. Both are required: a plain `GlassView` is otherwise transparent, while an
opaque fallback background placed under an active effect would flatten it. The primitive owns
background and border treatment; callers provide layout only and should never add `backgroundColor`.

Pass the app's resolved `theme.mode` to the native surface rather than letting it follow the OS:
the user may choose an app appearance different from the system appearance. Do not set or animate
`opacity` on a glass surface or any ancestor. UIKit can stop rendering the material at zero opacity;
animate the glass effect style instead when a transition is necessary.

The chat's `topChromeHeightAtom` carries the measured height of its floating header group to the
transcript, compose state, and opening state. It is a resettable `screenAtom` because it crosses
those components; keep one-component-only measurements local.
