# Composer Photo Paste

This local Expo module wraps the existing multiline React Native input. Long-press the
composer and choose **Paste** after copying a photo. No attachment menu or photo-library
permission is needed. Ordinary text paste still uses the input's native selection behavior.

- iOS uses `UITextPasteDelegate` and explicit image acceptance. UIKit also requires
  `allowsEditingTextAttributes` for the image-only Paste action; image items are consumed
  without inserting rich text or replacing the selected draft. The original input settings
  are restored when detached. There is no method swizzling or React Native vendor patch.
- Android uses AndroidX receive-content on the existing AppCompat input, including its
  native Paste action. Clipboard items must expose readable image content URIs.
- Web keeps its existing text-only paste behavior.
- Native extraction emits busy state before handing cache files to JavaScript. Photos then
  use the existing 20 MB validation, JPEG preparation, bridge upload, retry, and removal flow.
- Scope changes discard stale extraction/upload results. JavaScript deletes the native
  source file after preparation; prepared files remain available for failed-upload retry.
- Existing message rules still require some text before sending attachments.

## Build

A new native build is required (`pnpm run ios` or `pnpm run android`); this is not an
OTA-only feature and is not included in Expo Go. Expo autolinking discovers `modules/`
without a package dependency or config plugin.

## Regression Checks

From the repository root, on an Apple Silicon Mac with Xcode and an iOS 26.5 simulator runtime:

```sh
node .agents/skills/local-e2e-validation/scripts/run.mjs \
  --evidence /absolute/path/to/new-evidence.jsonl \
  apps/mobile/modules/composer-paste/tests/native-paste.mjs
```

The test compiles the production UIKit handler into a standalone test app, creates a
dedicated simulator, and exercises actual native `paste:` actions. It proves image-only
Paste availability, busy-to-settled events, image bytes/metadata, unchanged selected draft,
normal text replacement, disabled paste, navigation during extraction, and delegate cleanup.
The simulator and app data are deleted afterward. This complements, rather than replaces,
the React screen integration test that proves upload-to-send wiring.

Before release, also check the rebuilt production app on both platforms: copy a photo from
Photos or a browser, paste into a selected draft, wait for the attachment chip, and send.
Repeat with ordinary text, a failed upload/retry, and a chat change during upload.
