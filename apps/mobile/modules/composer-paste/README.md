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
- Each paste accepts at most eight photos. An oversized batch is rejected in full with an
  error, while any accompanying text still pastes normally. iOS counts photos at UIKit's
  `combineItemAttributedStrings` transaction boundary, not by concurrent file loads.
- Disabled or overlapping photo pastes report an error without starting more work.
  `enabled` controls admission only: disabling it during upload does not drop other photos
  from an already accepted batch.
- Scope changes and detach settle native busy state and discard stale extraction results.
  Android completion uses the main looper rather than the detached view's deferred queue,
  so stale cache files are deleted even if the view never reattaches.
- Native events keep the existing opaque string `scopeKey`. JavaScript supplies
  `JSON.stringify([draftScopeKey, generation])` and advances the generation on every clear,
  including same-draft resets. Native code echoes the string unchanged; old events cannot
  repopulate a cleared draft.
- JavaScript deletes native source files after preparation and logs deletion failures.
  Prepared JPEGs are deleted on success, removal, clear, unmount, and stale completion;
  failed uploads retain them only for retry.
- A new native busy period clears the previous paste error. Individual image successes
  do not erase errors from the same mixed-result batch.
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
Multi-item text paste is compared with a stock `UITextView`, including spaces, newlines,
empty items, and mixed image batches; both final text and selection must match UIKit.
It also verifies nine-photo rejection, eight-photo recovery, mixed text/overflow paste,
overlapping and disabled rejection, and controlled slow providers across scope changes,
detach, reattach, and provider failure. Late callbacks must delete their cache files without
altering newer busy state or emitting stale images/errors.
The simulator and app data are deleted afterward. This complements, rather than replaces,
the React screen integration test that proves upload-to-send wiring.

Android does not yet have an executable instrumentation harness in this module. Its native
runtime regression still requires verification in a rebuilt Android app with the Android
Gradle toolchain; source inspection is not behavioral proof. Pause the worker immediately
before its successful completion post, detach the composer, and resume the worker without
reattaching the view. The copied `pasted-photo-*` file must be deleted, with no stale image or
error event. Repeat after changing scope while a new paste is active; the old completion must
not clear the new busy state. Then reattach and verify a normal photo paste succeeds.

Before release, also check the rebuilt production app on both platforms: copy a photo from
Photos or a browser, paste into a selected draft, wait for the attachment chip, and send.
Repeat with ordinary text, a failed upload/retry, and a chat change during upload.
