# Window Layout

This local Expo module reports window traits that React Native cannot observe on its own. The
adaptive shell uses them on foldables and other resizable windows, following Apple's iPhone Duo
design guidance without branching on the device.

- `WindowLayoutObserver` (`src/shell/layout`) mounts one full-window, non-interactive native view
  at the app root on iOS and Android. It reports in window points and emits only when something
  changes. Web keeps a no-op observer.
  - **iOS** reports the size classes, the edge where the system lays bars out vertically
    (`UITraitCollection.verticalBarEdge`), the `.division` reserved regions such as a fold, and the
    `.occlusion` regions such as the camera and the vertical status column. It also reports the
    `.bar(onEdge:extent:)` layout region for 48pt controls, aligning them with the system icons
    rather than the center of the wider safe-area inset. UIKit tracks what
    `layoutSubviews` reads, so opening, closing, folding, and rotating trigger a new report without
    polling. These APIs ship in the iOS 27.1 SDK; a `canImport(UIKit, _version:)` guard lets older
    Xcode versions compile the module, with every bar horizontal.
  - **Android** reports Jetpack WindowManager `FoldingFeature`s that currently separate the window,
    such as a half-open Pixel Fold. It reports no size classes and no vertical bars.
- `shell/state/layout/atoms.ts` stores the latest report. `resolveShellLayout` turns it into the
  same decisions on every platform:
  - **Sidebar:** the session sidebar docks only when the window is at least
    `TABLET_LAYOUT_MIN_WIDTH` wide, and a compact size class can still veto it. On wide windows
    the navigation button hides or shows the docked sidebar, and the `sidebarHidden` setting
    remembers the choice.
  - **Toolbar placement:** when the system reports a vertical-bar edge, scene toolbar buttons
    move into a vertical bar in that edge's native bar region, below the status column. Older
    native binaries fall back to the safe-area column. Text stays
    horizontal, so headers keep their titles. On a device folded like a laptop, the chat's chrome
    moves to the lower half, just above the composer. Otherwise buttons stay in the header.
  - **Book pose:** a vertical fold that leaves two usable panes keeps the chat at full width. The
    session list moves behind the menu button and, when opened, covers only the leading page.
    Discrete controls avoid the hinge: the composer, the empty-state actions, and
    jump-to-latest move to the trailing page, and sheets slide onto it. Scrolling text may cross
    the hinge.
  - **Readable width:** the transcript and composer cap at `READABLE_COLUMN_WIDTH`. The composer
    uses spare column gutters to balance asymmetric side insets and center across the wide window,
    including beneath its rail, without shrinking narrow layouts or crossing safe areas. Folded
    layouts still keep it on the trailing page. Sheets cap at `SHEET_MAX_WIDTH` and center on wide
    windows. On wide windows the transcript keeps its messages clear of the pinned message rail,
    which spans only the visible transcript between the top chrome and the composer.

Screens declare their icon buttons once as `SceneToolbarItem`s, grouped as `navigation`, `action`,
or `bottom`. `SceneVerticalToolbar` renders them as round 48pt glass controls, 12pt apart, when bars
are vertical,
using the shared themed fallback where native glass is unavailable. When the
column runs out of room, lower-priority items collapse into a standard "More" (ellipsis)
overflow menu; navigation never collapses. Screens whose root pads for safe areas wrap themselves
in `SceneToolbarHost`, because the bar lives in that padding. Text-heavy bars, such as the
workspace picker's, stay horizontal.

The full-window session menu uses the same rail for Close, Select sessions, New chat, and Settings.
Selection mode replaces those actions with Cancel while keeping the bulk-selection controls below
the list. Docked and book-pose sidebars keep their controls inline because they do not reach the
window's vertical-bar column.

When bars move to the side, `.safeArea(cornerAdaptation: .horizontal)` supplies horizontal corner
clearance for the chat title and session menu. It supplements the existing rectangular safe area
and content padding without adding header height or reducing the title's 48pt drag target. A
docked chat skips the leading corner owned by the sidebar, and laptop chrome does not apply
top-edge clearance. Other platforms and older native binaries retain their existing layout.

Side insets are separate from this module. `useSceneHorizontalInsets` pads drawer-scene content
away from a status column or camera beside it. It skips the leading edge while the docked sidebar
owns it, because `SafeAreaView` applies window-wide insets regardless of where the view sits.
Backgrounds such as the transcript scrim bleed under those insets. Keyboard overlap is measured
against the window, because React Native's screen can be a different display from the one
showing the app.

## Build

A new native build is required (`pnpm run ios` or `pnpm run android`). Expo autolinking discovers
`modules/` without a package dependency or config plugin.
