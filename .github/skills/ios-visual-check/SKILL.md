---
name: ios-visual-check
description: Inspect a live iOS app through Appium after UI changes. Use for screenshot-driven visual QA, measuring native element geometry, checking alignment and spacing, reading render errors, and verifying a fix in the iOS simulator without restarting an HMR-enabled app.
user-invocable: true
---

# iOS Visual Check with Appium

Use this skill to turn screenshot feedback into measured, bounded UI verification on a running
iOS simulator. It is optimized for React Native and Expo apps using HMR.

## Principles

- **Do not relaunch for ordinary JS/TS edits.** Wait briefly for HMR, then inspect the existing
  Appium session. Relaunch only if the bundle is unresponsive, native code changed, or the user
  explicitly requests it.
- **Screenshots establish visual truth; geometry explains it.** Inspect both when alignment,
  spacing, clipping, overlap, or target size is involved.
- **Measure before changing constants.** State the relevant element bounds and derive the delta.
- **Verify in bounded passes.** Inspect once, make one coherent edit batch, confirm once, and stop.
- **Test behavior separately.** Appium visual checks complement, not replace, unit tests, lint, and
  typecheck.
- Never start, stop, or restart Metro or a user bridge unless explicitly requested.

## Prerequisites

The workflow expects:

- Appium listening at `http://127.0.0.1:4723`
- A live XCUITest session
- The app already running in the iOS simulator
- Node.js with direct TypeScript execution support

Prefer an existing session ID. Common locations include `/tmp/appium_sid` or an environment
variable set by the current workspace.

```bash
APPIUM_URL="${APPIUM_URL:-http://127.0.0.1:4723}"
SID="${APPIUM_SID:-$(cat /tmp/appium_sid)}"
```

Confirm the session before interacting with it:

```bash
curl -fsS --max-time 15 "$APPIUM_URL/session/$SID"
```

## 1. Wait for HMR

After a JS/TS edit, wait two or three seconds. Do not terminate or launch the app.

```bash
sleep 3
```

If the app displays a redbox or render error, inspect source text immediately:

```bash
curl -fsS --max-time 30 "$APPIUM_URL/session/$SID/source" \
  | grep -Eo 'label="[^"]+"' \
  | grep -iE 'error|exception|property|undefined|cannot|failed' \
  | head -20
```

## 2. Measure the surface

The bundled TypeScript helper accepts the Appium JSON envelope directly:

```bash
SKILL_DIR=".github/skills/ios-visual-check"
curl -fsS --max-time 30 "$APPIUM_URL/session/$SID/source" \
  | node "$SKILL_DIR/scripts/geometry.ts" --max-y 220
```

Filter to a component, test ID, or accessibility label:

```bash
curl -fsS --max-time 30 "$APPIUM_URL/session/$SID/source" \
  | node "$SKILL_DIR/scripts/geometry.ts" \
      --match 'header|model|session-meta|glass' \
      --max-y 240
```

Useful checks:

- shared left/right rails
- adjacent row boundaries (`bottom` of row A vs `y` of row B)
- symmetric margins
- clipping at the viewport or glass edge
- visual control size and effective touch-target coverage
- overlap between controls

XCUITest reports points; Appium screenshots may be device pixels. Use the source geometry for
measurements instead of inferring points from screenshot pixels.

## 3. Capture the current state

Write screenshots to `/tmp` or the session artifact directory, never into the repository:

```bash
curl -fsS --max-time 30 "$APPIUM_URL/session/$SID/screenshot" \
  | node -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => input += chunk);
      process.stdin.on("end", () => {
        const { value } = JSON.parse(input);
        require("node:fs").writeFileSync("/tmp/appium-current.png", Buffer.from(value, "base64"));
      });
    '
```

Open `/tmp/appium-current.png` with the available image viewer. Prefer a full-screen screenshot
unless a crop is necessary to make a small defect legible.

## 4. Interact deliberately

Prefer accessibility IDs when available. Coordinates are acceptable for one-off visual navigation
after confirming the target geometry.

Tap a known coordinate:

```bash
curl -fsS --max-time 30 \
  -X POST "$APPIUM_URL/session/$SID/actions" \
  -H 'Content-Type: application/json' \
  -d '{
    "actions": [{
      "type": "pointer",
      "id": "finger",
      "parameters": {"pointerType": "touch"},
      "actions": [
        {"type": "pointerMove", "duration": 0, "x": 100, "y": 120},
        {"type": "pointerDown", "button": 0},
        {"type": "pause", "duration": 80},
        {"type": "pointerUp", "button": 0}
      ]
    }]
  }'
```

After navigation or sheet animation, wait for the UI to settle before measuring:

```bash
sleep 1
```

## 5. Make the fix

Change the lowest layer that owns the defect:

- shared tokens/components for repeated controls
- layout style for geometry defects
- picker option builder for meaningless row metadata
- glass/sheet primitive for material defects

For a bug fix, add a regression test that asserts the broken relationship, not merely a helper's
final value. Examples: top margin tightened while bottom margin remains positive, model rows omit
irrelevant metadata, or overlapping controls preserve the upper row's touch priority.

## 6. Confirm once

After HMR:

1. Re-run the focused geometry query.
2. Capture one final screenshot.
3. Confirm the original defect is gone and nearby controls did not regress.
4. Run the smallest targeted tests, then the repository's required lint/typecheck/test commands.

Report concrete results: bounds, point deltas, test counts, and whether validation passed. Do not
claim a visual fix based only on compilation.

## Troubleshooting

### Appium session expired

List sessions and use the live one:

```bash
curl -fsS --max-time 15 "$APPIUM_URL/sessions"
```

Create a new session only when none exists. Reuse the simulator UDID and bundle ID from the
workspace; do not hard-code machine-specific values into this skill.

### HMR did not update

First wait and inspect the current screen source for a bundle error. Relaunch the app only after
confirming HMR is stuck. Do not restart Metro automatically.

### Duplicate geometry rows

The accessibility tree wraps controls and may expose the same bounds multiple times. The helper
deduplicates identical bounds and labels, but parent and child labels with different bounds are
both useful and remain visible.

### Element absent from source

Add a stable `testID` or accessibility label in the app. Do not rely on brittle source ordering or
screen coordinates for recurring checks.
