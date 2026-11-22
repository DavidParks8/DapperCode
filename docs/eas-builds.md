# EAS Builds and Distribution

Use this guide for standalone app builds/distribution.

## Where To Run EAS Commands

Run EAS commands from `apps/mobile`.

Why:

- Expo app config is in `apps/mobile/app.json`
- EAS config is in `apps/mobile/eas.json`

```bash
cd apps/mobile
```

You can also run from repo root with workspace scoping:

```bash
pnpm --dir apps/mobile dlx eas-cli <command>
```

## Prerequisites

- pnpm 11.1.2
- Logged in (`pnpm dlx eas-cli login`)
- Access to the Expo organization `davidparks8s-team`

The active app is linked as `@davidparks8s-team/dappercode` with EAS project ID
`dc4bb45d-72cf-4c82-8fcd-f841b1ef6c71`. Verify it from `apps/mobile`:

```bash
pnpm dlx eas-cli project:info
```

## Dependency Compatibility

The mobile app uses Expo SDK 58 and React Native 0.88.1. Keep native dependencies aligned with
`pnpm --filter @dappercode/mobile exec expo install --check`, rather than independently selecting
the latest version of each native package:

- React, React DOM, and React Test Renderer stay at **19.3.0** instead of 19.3.1 so their renderer
  versions match the SDK's supported React version.
- Gesture Handler stays on **~3.3.0** rather than 3.5.0; Reanimated stays on **4.7.1** rather than
  4.8.0; SVG stays at **15.16.0** rather than 15.16.1; Worklets stays at **0.13.0** rather than
  0.14.0. These are SDK 58's recommended versions.
  Application gestures use Gesture Handler 3's hook API, including its renamed activation and
  deactivation callbacks.
- TypeScript stays on **~6.0.3**, not 7.0.2. On-device code intelligence packages the JavaScript
  compiler API (`typescript/lib/typescript.js`) into a browser/Hermes runtime; TypeScript 7
  removes that implementation. The installed typescript-eslint 8 parser also supports TypeScript
  **<6.1**, so upgrading the compiler independently breaks both runtime preparation and linting.
- Babel runtime stays on **7.x** because Expo's Babel preset requires `^7.20.0`; it is a direct
  dependency so generated helpers resolve under pnpm's isolated linker.
- Workspace script Node types stay on **22.x** to match the minimum supported Node runtime.
- React Native 0.88 defaults to generated strict API declarations, but the current masked-view
  declarations still require the legacy `NativeMethods` interface. `apps/mobile/tsconfig.json`
  selects React Native's official `react-native-legacy-deep-imports` compatibility condition.
  Remove that condition only after native-library declarations and component/ref consumers can
  migrate together; do not add local ambient type shims.
- React Native Testing Library **14.1.0** is required by Expo Router 58. Its render, hook, event,
  and lifecycle APIs must be awaited. It uses **test-renderer 1.3.1** for React 19.3 and exposes
  host elements rather than the removed composite `UNSAFE_*` queries. React Test Renderer remains
  for the existing lower-level component suites, with its version matched to React.

Expo Router 58 requires each drawer destination to be declared with `Drawer.Screen`; filesystem
routes alone no longer make drawer screens visible. The history-based drawer has no chat anchor:
an anchor would instantiate an unrelated chat beneath a cold Settings link. Chat and Settings keep
their own Stack anchors for deep links and connection modals. Navigation tests trigger modal
launches through user actions after mounting, not through effects before the imperative router is
ready.

Expo File System 58 makes `File.write()` asynchronous. Native validation journals use
`writeSync()` so a recorded checkpoint is durable before process termination or a gate reports
success. A dependency upgrade is not validated by JavaScript typechecking alone: rebuild the native
iOS app, run the on-device capability/inference/download/code-intelligence gates, and run the real
layout suite before release. Do not reuse an older SDK's simulator binary as evidence for SDK 58.

## Build Profiles

Current profiles in `apps/mobile/eas.json`:

- `development` (dev client, internal distribution)
- `preview` (internal distribution)
- `production` (store/prod, auto-increment)

## Common Build Commands

From `apps/mobile`:

```bash
# Internal/dev-client builds
pnpm dlx eas-cli build --platform ios --profile development
pnpm dlx eas-cli build --platform android --profile development

# Internal preview builds
pnpm dlx eas-cli build --platform ios --profile preview
pnpm dlx eas-cli build --platform android --profile preview

# Production builds
pnpm dlx eas-cli build --platform ios --profile production
pnpm dlx eas-cli build --platform android --profile production

# Both platforms
pnpm dlx eas-cli build --platform all --profile preview
```

Track builds:

```bash
pnpm dlx eas-cli build:list --limit 10
pnpm dlx eas-cli build:view <BUILD_ID>
```

## Release To TestFlight

Use the wrapper rather than remembering flags. It runs preflight checks, builds, and submits in one
step, from the repository root:

```bash
pnpm run release:testflight
```

Preflight refuses a dirty working tree, because EAS archives the *local* git state: releasing with
uncommitted changes ships work that no commit records. It also verifies the requested profile
exists, that `submit.<profile>.ios.ascAppId` is configured, and that you are signed in to an EAS
account with access to `davidparks8s-team`.

Options:

```bash
pnpm run release:testflight --dry-run                      # preflight only, print the command
pnpm run release:testflight --no-submit                    # build without submitting
pnpm run release:testflight --no-wait                      # queue and return immediately
pnpm run release:testflight --platform android --profile preview
pnpm run release:testflight --allow-dirty                  # opt out of the clean-tree check
```

The script lives at `scripts/release-testflight.mts` and runs through Node's built-in TypeScript
support, so there is no build step.

## Release Latest Main and Start the Tray

To fast-forward to `origin/main`, rebuild and launch the macOS tray app, and submit a local iOS
production archive to TestFlight with one command:

```bash
pnpm run release:latest
```

This command requires macOS, Xcode 27.1 or newer, CocoaPods, CMake (`brew install cmake`), and an
authenticated EAS account. CMake builds the on-device Git library during iOS prebuild. It uses a
local EAS build so it is not blocked by the account's cloud iOS build quota, submits the resulting
IPA, and removes the temporary archive afterward. Tracked working-tree changes must be committed
beforehand; untracked local files are left untouched.

When updating `esbuild`, `llama.rn`, or `@parcel/watcher`, update the matching version-scoped `allowBuilds` approval in
`pnpm-workspace.yaml` too. A clean EAS install refuses unapproved dependency build scripts.

Use `pnpm run release:latest --dry-run` to print the workflow without changing the checkout or
starting a build.

## Submit To Stores Manually

```bash
pnpm dlx eas-cli submit --platform ios --latest --profile production
pnpm dlx eas-cli submit --platform android --latest --profile production
```

For App Review, do not make the bridge public. Prepare an isolated private VPN or overlay,
temporary reviewer enrollment, a separate bridge token, sanitized repositories, and post-review
credential revocation.

## GitHub Actions

Run the protected `Mobile Release` workflow manually. It accepts `ios`, `android`, or `all`, uses
the `preview` or `production` EAS profile, and can auto-submit production builds when explicitly
requested. Configure an `EXPO_TOKEN` secret in the protected `mobile-release` environment before
running it. Store credentials remain in EAS or the platform stores, not in this repository.

DapperCode currently includes no payment SDK, offering, tip jar, subscription, or inherited store
product configuration.

## Local Native Build Option (No EAS Cloud)

If you want local native builds instead:

```bash
pnpm --filter @dappercode/mobile exec expo run:ios
pnpm --filter @dappercode/mobile exec expo run:android
```

For iOS local device/signed builds, Apple signing/tooling is still required.

### Xcode 27 and native launch validation

Use Xcode 27.1 or newer and install its iOS 27 simulator runtime. Builds from older SDKs run
letterboxed on iPhone Duo instead of extending to the edges of both displays. They also cannot
report the fold. `pnpm run release:latest` refuses older Xcode versions, and every `eas.json` build
profile pins the `macos-tahoe-26.6-xcode-27.1` cloud image instead of relying on the SDK's default
Xcode version:

```bash
xcodebuild -version
xcodebuild -downloadPlatform iOS -buildVersion 27.1 -architectureVariant arm64
xcrun simctl list runtimes
```

To check iPhone Duo layouts, create a simulator with
`xcrun simctl create "Duo QA" com.apple.CoreSimulator.SimDeviceType.iPhone-Duo` and switch poses
(closed, open, book, laptop) in Xcode's Device Hub. `simctl` cannot change poses. Check each pose:
- **Closed and open landscape:** the status bar and camera sit in a vertical column on the trailing
  edge. All header buttons, including **New chat**, move to a vertical bar in that column, below
  the clock. **New chat** stays visible ahead of the other actions when space is limited and joins
  the system's Liquid Glass More menu when the keyboard leaves room for only navigation and
  overflow. iOS uses a native SwiftUI pull-down menu, not a custom action sheet; the system owns
  its material, anchoring, dismissal, and accessibility.
  Content and other controls stay inside the safe area. When closed, the chat's Send (or Stop)
  button sits on that bar, centered in the column and bottom-aligned with the composer's input box;
  the bar's other buttons fold into More rather than overlapping it, including while the keyboard
  is up.
- **Book:** the chat keeps the full width, the session list stays behind the menu, and the
  composer and sheets sit on the right page, off the hinge.
- **Laptop:** the window is portrait. The chat's title and chips stay at the top of the upper half,
  and its header buttons stand on a vertical rail along the trailing edge, ending above the
  hinge. The composer focuses automatically and keeps the keyboard on the lower half, with the
  composer directly above the fold; scrolling the transcript does not dismiss it. Opening the menu
  hides the keyboard, and closing it brings the keyboard back. In Xcode 27 the simulator renders the inner
  display separately: capture it with `xcrun simctl io <udid> screenshot --display=primary-1`, and
  drive it with element-targeted XCUITest gestures, because coordinate taps land on the outer
  display. Pose changes need the Mac unlocked. Android foldables
report folds through the same module. Use a `pixel_9_pro_fold` emulator and its fold controls.

SDK 58's generated AppDelegate already uses Expo's native scene lifecycle.
The retained `withIosSceneLifecycle` plugin validates that startup, installs or checks the
`UIApplicationSceneManifest`, and ensures Expo's scene delegate owns the window and starts React
Native exactly once. It preserves SDK 58's generated `SceneDelegate` configuration and the
previous Expo delegate configuration, but rejects unexpected startup code or custom manifests
rather than silently overwriting them. Review the plugin again on the next SDK upgrade.

Build a standalone simulator release without reading local bridge credentials or starting Metro:

```bash
EXPO_NO_DOTENV=1 pnpm --filter @dappercode/mobile exec expo prebuild --platform ios
EXPO_NO_DOTENV=1 xcodebuild \
  -workspace apps/mobile/ios/DapperCode.xcworkspace \
  -scheme DapperCode -configuration Release -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath apps/mobile/ios/build \
  CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES build
```

With Appium and its XCUITest driver installed, run the native launch regression from the repository
root. Set `IOS_LAUNCH_APP` if the build output is somewhere other than
`apps/mobile/ios/build/Build/Products/Release-iphonesimulator/DapperCode.app`:

```bash
node .agents/skills/local-e2e-validation/scripts/run.mjs \
  --evidence /absolute/path/to/new-ios-launch-evidence.jsonl \
  apps/mobile/plugins/tests/native-launch.mjs
```

The scenario uses a fresh iOS 27 simulator and a private copy of the signed release bundle with no
Metro dependency. Keep Xcode's normal simulator signing enabled: disabling it breaks SecureStore's
keychain access. It checks cold launch, onboarding interaction, a second cold launch,
background/foreground recovery, and cold/warm deep links. It never uses
a paired device or the user's app container or bridge. Appium's fixed ports are serialized with
harness leases, and the scenario deletes only its own simulator when finished. Use
`IOS_RUNTIME=com.apple.CoreSimulator.SimRuntime.iOS-26-5` for an older-runtime compatibility run
before uninstalling that runtime. If the selected runtime does not support iPhone 17 Pro, set
`IOS_DEVICE_TYPE` to one of its supported device identifiers (for example,
`com.apple.CoreSimulator.SimDeviceType.iPhone-Duo` for the iOS 27.1 Duo runtime).

After verifying the replacement runtime, remove obsolete runtimes by their exact identifiers
from `xcrun simctl runtime list`, using `xcrun simctl runtime delete <identifier>`. This removes
the runtime image, not simulator app data. Do not use `simctl delete unavailable` to reclaim
space unless you also intend to delete those simulators' data.

## iOS Distribution Reality

Without a public App Store release, iOS distribution still requires Apple provisioning paths:

1. Internal/dev provisioning with device allowlist
2. TestFlight private testing

Cloud builds are possible without public App Store listing, but signing/provisioning requirements still apply.
