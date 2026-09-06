# WebSocket background grace (iOS)

An Expo-autolinked app delegate subscriber requests a `UIApplication` background task
when the app enters the background. A main-run-loop timer releases it 12 seconds
after that transition, giving the JavaScript WebSocket lifecycle's 10-second
disconnect timer two seconds of scheduling headroom. Becoming active, OS expiration,
or termination releases it early. Duplicate notifications do not extend or restart
the current background budget; a later foreground/background cycle can request another.
Expo retains the subscriber for the application's lifetime.

There is no JavaScript API, additional dependency, background mode, or Android change.
A native rebuild is required; OTA updates and Expo Go cannot install this subscriber.
This is **best effort**, not a guarantee of background networking: iOS can deny or
expire the task early, suspend/terminate the app, or delay scheduled work.

## Native regression

On macOS with Xcode and the iOS 26.5 simulator runtime, from the repository root:

```sh
mkdir -p .e2e/native-websocket-background
TMPDIR="$PWD/.e2e/native-websocket-background" \
  node .agents/skills/local-e2e-validation/scripts/run.mjs \
  --evidence "$PWD/.e2e/native-websocket-background/evidence.jsonl" \
  apps/mobile/modules/websocket-background/tests/native-background.mjs
```

Use a new evidence filename for each invocation. The existing harness allocates and
cleans a unique run root. The scenario compiles the production subscriber against the
installed Expo subscriber base and real UIKit, checks Expo's autolinking/provider output,
and creates/deletes its own simulator and two minimal fixture apps. Switching between
those apps produces real background and foreground events, without Appium or a user bridge.
The runner schedules the rapid return after six seconds without waiting for a background
timer to fire. It deliberately waits eleven seconds before observing the result to cover
slow log consumers, while the native fixture still requires the actual foreground transition
to occur before ten seconds and the background task to remain held until that transition.

Checks cover execution at six seconds and return before ten, a ten-second run-loop callback
before the twelve-second budget release, foreground cleanup, duplicate notifications,
stale expiration callbacks, expiration/denial fault injection, and recovery on another cycle.
Fault injection observes the real `UIApplication` APIs; only denial and the OS expiration
callback are driven explicitly. It does not claim to force memory pressure or OS denial.

This native test complements the JavaScript lifecycle and full-app E2E tests. It does not
run React Native or a WebSocket, and does not validate physical-device lock, system power
policy, or receipt of data over a locked phone's network.
The real-time assertions deliberately fail if a saturated simulator host misses their
deadlines; do not treat a timeout as proof that iOS granted a reliable execution window.
