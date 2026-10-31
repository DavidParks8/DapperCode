# On this iPhone audit traceability

This maps every finding of the On this iPhone (local/offline) audit to its outcome, the change that
addressed it, and the automated tests that prove it. Each claim was checked against the code on
`on-device/overhaul` (after #61–#69), not only against pull request descriptions.

- **Fixed:** the defect is gone in the code the app ships, and a test asserts the fixed behavior.
- **Fixed by removal:** the defect lived only in the legacy `/on-device` screens or the
  `LocalPage`/`LocalAction`/`LocalText` kit. The shared shell surface that replaced it doesn't have
  the defect. Since #65–#69, the legacy screens are unreachable except by typing a deep link. The
  **wave 3 legacy sweep** deletes them (`src/app/on-device/**`, `src/features/on-device/screens/**`).
- **Partially fixed:** part of the finding remains; the reason is given.
- **Excluded by user (#117):** confirmation dialogs were intentionally not added. Where a finding
  bundles a confirmation with other work, only the confirmation is excluded.
- **Requires physical device verification:** the code is fixed and unit-tested, but the behavior
  depends on hardware (memory limits, background `URLSession`, performance, foldable layouts).

Paths are relative to `apps/mobile/src` unless they start with `modules/` (`apps/mobile/modules`)
or `scripts/`. Test files are named in the table and listed in the [test index](#test-index).

## Findings

### A. Product structure, discovery, and unification

| # | Finding | Status | PR | Evidence | Tests |
|---|---|---|---|---|---|
| 1 | Discovery nearly invisible | Fixed | #66 | `shell/profiles/ProfileSwitcher.tsx`; `DrawerProfileRow` in `shell/navigation/DrawerContentView.tsx`; `NewChatRunTarget` in `features/chat/screen/Presentation.tsx` | ProfileSwitcher "switches a bridge chat to On this iPhone, guides setup, and switches back"; e2e `profile-switcher.spec.ts` |
| 2 | Settings entry visually foreign | Fixed | #65, #66 | Hero card removed from Settings; a Profiles row and `LocalProfileSection` (`SettingsGroup`/`SettingsRow`). `OnDeviceEntry` is used only by onboarding | SettingsScreen "presents On this iPhone as a profile with setup state…"; LocalProfileSection test |
| 3 | Onboarding copy contradicts the feature | Fixed | #66 | `features/onboarding/screen/IntroSection.tsx` variants; pairing first and primary | OnboardingScreen "presents both places agents can run…" |
| 4 | Local is a global mode | Fixed | #65 | `LOCAL_PROFILE_ID` profile; `preferredExecutionTarget` migrated and dropped (`shell/state/localProfile.ts`) | localProfile "migrates the legacy global on-device mode…"; LocalRuntimeShell "disposes the runtime when switching to a desktop profile and restores chats on return" |
| 5 | Local mode is a separate app | Fixed | #65; wave 3 legacy sweep | `/on-device` and `/on-device/chat/[id]` redirect into the shell; the remaining legacy model/account routes have no links and are deleted by the sweep | localProfileRouting "redirects the legacy on-device hub and chat links into the unified shell" |
| 6 | Local chat reimplements the shell | Fixed | #65, #68 | Local chats run in `MainScreen` over `LocalBridgeWsClient` → `LocalBridgeServer` | MainScreen.local (all); LocalRuntimeShell (all) |
| 7 | Parallel Git/workspace/model copies | Fixed | #65, #67, #69 | Shared `GitScreen`, workspace picker, Files, and model sheet over `transport/gitHandlers.ts`, `workspaceHandlers.ts`, `modelOptions.ts` | GitScreen.local; ManagedView; Files Screen; server "`model/list` states and default" |
| 8 | Settings unreachable in local mode | Fixed | #65, #69 | Drawer Settings works for the local profile; `features/settings/local/*` pages | SettingsScreen local test; LocalProfileSection; localProfileRouting "opens On this iPhone in the regular profile routes…" |

### B. Blocking functional defects (P0)

| # | Finding | Status | PR | Evidence | Tests |
|---|---|---|---|---|---|
| 9 | Files can't open the workspace root | Fixed | #63, #67 | The root is `''` (`workspaces/types.ts`); native also accepts `'.'` (`WorkspaceStore.swift`); the shared Files screen lists `''` | Files Screen.runtime "lists the workspace root with the empty root path…" (real runtime → native); Files Screen "shows the workspace name at the root…"; `native-workspaces.mjs` |
| 10 | Raw native exceptions leak | Fixed | #63, #67 | `NativeServiceError.swift` codes; `native/services.errors.ts` `withNativeErrorMapping`; `describeHostError` in shared screens | services "untagged native failures never surface exception names or Swift source locations"; server "maps typed native and offline failures to stable reasons"; Files Screen.runtime (no exception text) |
| 11 | `inactive` tears everything down | Fixed | #61 | `runtime/OnDeviceProvider.tsx` suspends only on `background` | OnDeviceProvider "only a real background transition suspends…"; **LocalRuntimeShell "keeps a turn and its model through inactive states, stops on background, and warms on return"** (real runtime, transport, and shell) |
| 12 | Context budget can't fit a conversation | Fixed | #62 | Catalog `maxContextTokens` 8K/16K; `models/contextWindow.ts` reserve; bounded `read_file` (3 KiB default, 16 KiB max) and `list_directory` | contextWindow "token budgets reserve generation room…"; fileTools "model reads are bounded…"; memory "loaded context grows to the catalog maximum…" |
| 13 | Full context kills the conversation | Fixed | #62 | `promptCandidates` compaction in `contextWindow.ts`, used by `session.preparePrompt` | session "a full context compacts earlier tool output and turns…"; **runtimePort "keeps a conversation usable after its tool output exceeds the context window"** (fails with compaction disabled) |
| 14 | `n_predict: 512` caps every round | Fixed | #62 | `generationTokenBudget` in `contextWindow.ts` | session "generation may use all remaining context…"; agentLoop "long write_file payloads reach the tool intact" |
| 15 | New conversation silently disabled | Fixed | #62, #66, #68 | `localConversationReadiness` (`runtime/status.ts`); presence in `shell/runtime/localAgentPresence.ts`; setup checklist | status "readiness explains exactly why…"; MainScreen.local "explains why a new local chat cannot start…"; ProfileSwitcher setup flow |
| 16 | Load gated on memory the old model holds | Fixed | #62, #69 | `modelMemoryAdmission(model, memory, resident)`; `session.performLoad` releases before measuring; `LocalModelRow` credits the resident model | memory "switching models credits memory…"; session "model switching releases the old native context before fresh memory admission…"; **LocalModelsScreen.runtime "loads a larger model that only fits once the resident model is released"**; **runtimePort "switches a chat to a larger model under memory pressure…"** |
| 17 | Model errors invisible | Fixed | #62, #68 | `localAgentStatus` never reports an errored, missing, or undownloaded model as ready; drawer and new-chat presence | status "an errored, missing, unsupported, or undownloaded model is never reported as ready"; LocalRuntimeShell "labels stopping and load errors in the transcript, composer, and drawer" |
| 18 | Memory headroom may refuse most models | Requires physical device verification | #62 | `plugins/withOnDeviceAgentNative.js` adds `increased-memory-limit`; state-cache bytes in admission. Code is fixed | `scripts/__tests__/ios-on-device-memory.test.mjs`; memory tests |

### C. Model lifecycle and load/unload state (P1)

| # | Finding | Status | PR | Evidence | Tests |
|---|---|---|---|---|---|
| 19 | "Model not loaded" for every non-ready phase | Fixed | #62, #68; wave 3 legacy sweep | `localAgentStatus` labels every phase; Home is removed | status "every run and model phase has a user-facing label…"; LocalRuntimeShell drawer labels |
| 20 | Generation error leaves phase `error` | Fixed | #62 | `session.performGeneration` publishes `ready` after turn failures | session "a native completion failure leaves the healthy resident model ready…"; runtimePort "retries a failed turn in place without reloading the model…" |
| 21 | Stop can't cancel a model load | Fixed | #62 | `session.stop` → `cancelLoad`; the loop races the load against Stop | session "stop during a native load returns promptly…"; agentLoop "stop during a model load settles promptly…"; runtimePort "stops a turn while the model loads without recording it…" |
| 22 | Load progress hidden during a send | Fixed | #62, #68 | `runStatus` shows `Loading … · N%` while preparing; the projector sends load activity before `RUN_STARTED` | server "names each phase of a run as activity…"; MainScreen.local "shows what the local run is doing…"; runtimePort "reports load progress before the run starts…"; LocalRuntimeShell (drawer `Loading Qwen3 1.7B Q4_K_M · 42%`) |
| 23 | Home mixes two models; raw IDs | Fixed | #62, #68 | `localModelDisplayName`; presence resolves one model | status "ready states distinguish a loaded model from one that loads on send"; LocalRuntimeHost "publishes the local agent status…" |
| 24 | Unrelated actions interrupt the run | Fixed | #61 | `runtime.ts` `selectWorkspace`/`signOut`/`removeModel` no longer stop; run-affecting actions reject | runtime "selecting the loaded model for another conversation, the workspace, and signing out keep the run going", "actions that would affect the run are rejected…" |
| 25 | Every foreground pays a full reload | Fixed | #61 | `ModelResidency.warm` on `foreground()` | runtime "backgrounding unloads… returning warms the model…"; LocalRuntimeShell (warm-up after `active`) |
| 26 | Concurrency errors leak raw text | Fixed | #62 | The latest load supersedes instead of raising; the old string no longer exists | session "a newer load request supersedes an in-flight one instead of failing as busy" |
| 27 | `stopping`/`running`/`error` unlabeled | Fixed | #62 | `runStatus`/`residentModelStatus` | status phase-label test; LocalRuntimeShell "labels stopping and load errors…" |

### D. Downloads (P1)

| # | Finding | Status | PR | Evidence | Tests |
|---|---|---|---|---|---|
| 28 | One transfer at a time | Fixed | #64, #69 | `MAX_CONCURRENT_MODEL_DOWNLOADS = 2` with a queue (`models/downloads.ts`) | downloads "two models download concurrently…", "downloads beyond the concurrency limit queue…"; **LocalModelsScreen.runtime "runs two downloads at once, queues a third, and pauses one model…"** |
| 29 | Family screen locks up during a download | Fixed | #64, #69; wave 3 legacy sweep | Actions resolve on acceptance; per-row operations in `LocalModelRow` | LocalModelsScreen "loads, announces, and keeps action errors on the model row"; LocalModelsScreen.runtime (other rows stay actionable) |
| 30 | Downloads are foreground-only | Requires physical device verification | #64 | `modules/on-device-agent/ios/ModelDownloadSession.swift` background session, relaunch adoption, `AppDelegate` hook. Code is fixed | `scripts/__tests__/on-device-background-events.test.mjs`; downloads "a new controller re-attaches a transfer that kept running…"; `native-downloads.mjs` |
| 31 | Progress ticks re-render every screen | Fixed | #61, #65 | Per-slice emitter; transport subscribes to `threads`/`loop`/`models` only | emitter tests; runtime "token streaming notifies thread subscribers at most once per interval and never download subscribers" |
| 32 | Progress is a floored percentage | Fixed | #64, #69 | Snapshot bytes, speed, ETA; `SettingsProgressBar` | downloads "progress publishes are throttled per model and include speed and remaining time"; LocalModelsScreen "shows two downloads in parallel with readable, accessible progress…" |
| 33 | SHA-256 verify has no progress or cancel | Fixed | #64 | `getModelVerificationProgress`, `cancelModelVerification` | downloads "verification reports progress and can be paused or cancelled cooperatively"; LocalModelsScreen "Verifying 46%" |
| 34 | Delete/cancel act without confirmation | Excluded by user (#117) | #64 | No dialogs by design. The related safety fix landed: cancel never deletes an installed model, and only Delete removes one | downloads "removing an installed model deletes it without disturbing another transfer"; LocalModelsScreen per-model cancel |
| 35 | Pause/cancel errors go to the global error | Fixed | #64, #69 | Failures recorded on the model snapshot; row-scoped errors | downloads "pause and cancel failures are recorded on that model instead of rejecting"; LocalModelsScreen row errors |
| 36 | No storage overview | Fixed | #64, #69 | `getModelStorageInfo`; Storage group | LocalModelsScreen "shows storage used and free…" |

### E. Errors, recovery, persistence (P1)

| # | Finding | Status | PR | Evidence | Tests |
|---|---|---|---|---|---|
| 37 | Startup fails closed | Fixed | #61, #71, #72 | `runtime/quarantine.ts`; recovery notices shown in Settings (`settings/local/LocalIssueNotices.tsx`) and the drawer status (#71), and announced to VoiceOver once (`LocalIssueAnnouncer` in `shell/runtime/LocalRuntimeHost.tsx`, #72). An older draft that would replace a newer composer draft is set aside with its bytes preserved and a notice (#72) | runtime "damaged and unexpected conversation files are set aside…"; LocalRuntimeShell "surfaces set-aside files and failed writes in the drawer and Settings until resolved"; LocalRuntimeHost "announces each runtime issue to VoiceOver once"; localDraftImport "never replaces a newer composer draft…" |
| 38 | Retry doesn't wait for the old runtime | Fixed | #61 | Module-level `settling` chain in `OnDeviceProvider.tsx` | OnDeviceProvider "retry waits for the failed runtime to finish disposing…", "a remounted provider starts its runtime only after…" |
| 39 | No retry for a failed send | Fixed | #62, #68 | Load before recording; `bridge/turn/retry`; composer Retry | agentLoop "a model load failure keeps the unsent draft…", "retry continues after completed tools and never replays them"; MainScreen.local "surfaces a failed local turn… retries it in place"; LocalRuntimeShell (Retry and kept draft over the real runtime) |
| 40 | Global errors sticky and mislabeled | Fixed | #61, #71, #72 | Typed `OnDeviceIssue`s with "Retry saving" (persistence) or "Dismiss", listed in Settings and the drawer status (#71) and announced once (#72) | runtime "a failed conversation write is a retryable persistence issue that clears after retry"; LocalRuntimeShell "surfaces set-aside files and failed writes…"; LocalRuntimeHost "announces each runtime issue to VoiceOver once" |
| 41 | Only one error shown | Fixed | #61, #68, #71, #72 | All issues listed in Settings; turn failures in the composer alert; stale `lastError` dismissible; every new issue is announced, not only the first (#72) | runtime "a stale conversation error can be dismissed…"; LocalRuntimeShell issues test; MainScreen.local failure alert; LocalRuntimeHost "announces each runtime issue to VoiceOver once" |
| 42 | No network awareness | Fixed | #61, #67 | `expo-network` via `runtime/expoNetwork.ts`; `requireNetwork` | runtime "offline clone, push, sign-in, and download fail fast…"; network tests; GitScreen.local "blocks push and sync while offline" |

### F. Missing core capabilities (P1)

| # | Finding | Status | PR | Evidence | Tests |
|---|---|---|---|---|---|
| 43 | No workspace delete/rename | Fixed | #63, #67 | `runtime/workspaceAdmin.ts`; managed picker | runtime "deleting the selected workspace clears the new-conversation default…", "renaming a workspace refreshes…"; ManagedView "renames…", "deletes by swipe action…" |
| 44 | No fetch or pull | Fixed | #63, #67 | `fetchWorkspaceGit`/`pullWorkspaceGit` (fast-forward only) | GitScreen.local "shows ahead/behind, fetches, pulls, and explains a diverged pull"; `native-git.mjs` |
| 45 | No branch create, discard, or init | Fixed | #63, #67 | `createWorkspaceGitBranch`, `discardWorkspaceGit`, `initWorkspaceGit` | GitScreen.local "discards one file…", "creates and switches to a new branch…", "offers Initialize Git…"; `native-workspaces.mjs` |
| 46 | Unapproved `git_push` tool | Fixed | #62, #65, #68 | `gitToolApproval`; loop `approval` phase; relayed as `bridge/approval.requested` (`commandExecution`) | agentLoop "push waits for approval…", "stop while awaiting approval interrupts without pushing"; MainScreen.local Deny; **runtimePort "asks before a model-initiated push and honours reject-once/allow-once"**; **LocalRuntimeShell "runs a model push only after Allow on the shared banner…"** |
| 47 | Thin conversation management | Fixed | #65, #68 | Shared drawer list, rename, swipe-to-delete, new chat | LocalBridgeWsClient "renames and deletes chats through the existing drawer API"; DrawerContent "offers delete as a VoiceOver action…" |
| 48 | Push without remote; commit with nothing staged | Fixed | #63, #67 | Remote-aware status; disabled reasons | GitScreen.local "disables commit until something is staged and explains why push and sync are unavailable" |
| 49 | No file delete, rename, or refresh | Fixed | #63, #67 | `renameWorkspaceEntry`/`removeWorkspaceEntry`; change-token refresh | Files Screen "renames by long press and deletes by swipe action", "refreshes the listing when the workspace change token moves" |

### G. Visual consistency

All local surfaces now use the shared shell, Settings, Git, workspace, and Files components. The
items below were defects of the legacy kit or legacy screens.

| # | Finding | Status | PR | Evidence | Tests |
|---|---|---|---|---|---|
| 50 | No shared design system | Fixed by removal | #65–#69; wave 3 legacy sweep | Replacements use `SettingsGroup`/`SettingsRow`, `SwipeToDeleteRow`, shared header and theme tokens | Covered by the replacement surface tests below |
| 51 | Off-scale radii | Fixed by removal | #65–#69; wave 3 legacy sweep | Replacement surfaces use theme radii | — (visual) |
| 52 | Header unlike every other screen | Fixed by removal | #65, #68; wave 3 legacy sweep | Shared `ChatHeader` and Settings headers | MainScreen.local |
| 53 | "Offline" in the back slot | Fixed by removal | #61, #66; wave 3 legacy sweep | No static "Offline" text in any shell surface | — |
| 54 | Inverted type hierarchy | Fixed by removal | #66–#69; wave 3 legacy sweep | Shared typography | — (visual) |
| 55 | Every action looks the same | Fixed by removal | #66–#69; wave 3 legacy sweep | Rows, inline capsule actions with icons and tones | LocalModelsScreen per-row actions |
| 56 | Disabled controls nearly vanish | Fixed by removal | #66–#69; wave 3 legacy sweep | Shared disabled styling (`textMuted`) | — (visual) |
| 57 | Nested cards | Fixed by removal | #67, #68; wave 3 legacy sweep | Flat grouped lists in Git, Files, and the drawer | — (visual) |
| 58 | Model library inconsistent with itself | Fixed | #69 | One row style and one "Recommended" badge in `LocalModelRow` | LocalModelsScreen "lists quants per size with one Recommended badge style…" |
| 59 | Bare toggles | Fixed | #69 | Both filters are `SettingsToggleRow`s in one grouped card on the Models and family pages | — (visual) |
| 60 | Search is a form field | Fixed | #69 | `SettingsSearchField` with a magnifier | LocalModelsScreen search test |
| 61 | Quant cards long and raw | Fixed | #69 | Compact subtitle ("547 MB · 4K–16K context") and plain-word states | LocalModelsScreen progress and state labels |
| 62 | License casing inconsistent | Fixed | #69 | Catalog uses `Apache-2.0` | catalog "catalog licenses use one SPDX casing and family copy never refers to another page" |
| 63 | Family pages repeat the description | Fixed | #69 | Family page shows publisher and quantization note only | catalog test above; LocalModelsScreen quant list |
| 64 | Git diff is a raw dump | Fixed | #67 | Shared diff/review sections over `bridge/git/diff` | `features/git/diff/unified.test.ts`; GitScreen.local |
| 65 | Git status cryptic | Fixed | #67 | Human change labels; Stage per file; branch checkmark; dated history | GitScreen.local "shows human change labels and lets new files be staged"; `features/git/screen/utils.test.ts` |
| 66 | Wrong empty-diff copy | Fixed by removal | #67; wave 3 legacy sweep | The copy exists only in legacy `GitScreen.tsx`; the shared Git screen has correct copy | GitScreen.local |
| 67 | Commit field single-line | Fixed | #67 | Shared multiline commit field (`features/git/screen/sections/ReviewSection.tsx`) | — (visual) |
| 68 | Files shows "." and text prefixes | Fixed | #67 | Workspace name title; folder icons | Files Screen "shows the workspace name at the root and folders by icon…" |
| 69 | Workspaces form muddled | Fixed | #67 | Managed picker with branch/origin, checkmark, New/Clone rows | ManagedView "lists workspaces with Git metadata…", "summarizes Git state" |
| 70 | Developer paragraph; plain code | Fixed | #69 | Large monospace code; "Unavailable" without configuration text | LocalGitAccountScreen "hides build configuration details…", "shows and copies the device code…" |
| 71 | Chat header differs from bridge | Fixed | #65, #68 | Shared `ChatHeader`; single-mode chip hidden | HeaderAndWorkflow "hides the agent mode chip when the agent offers only one mode"; MainScreen.local |
| 72 | Grey shadow band above the composer | Fixed by removal | #65; wave 3 legacy sweep | Local chats use `MainScreen`'s overlay composer | MainScreen.local; layout e2e covers the shared composer |
| 73 | Raw model ID in the composer footer | Fixed by removal | #65, #69; wave 3 legacy sweep | Shared composer; model shown in the model chip and sheet | server `model/list` test |
| 74 | Attach button does nothing | Fixed | #65 | `attachments` feature off for the local profile | MainScreen.local "starts a local chat…" (attachment disabled) |
| 75 | Placeholder wording differs | Fixed | #65 | Shared placeholder "Message On this iPhone..." | MainScreen.local "starts a local chat…" |
| 76 | Turn errors as red header text | Fixed | #68 | Composer failure alert with Retry | MainScreen.local "surfaces a failed local turn in the composer…"; LocalRuntimeShell |
| 77 | No activity during a run | Fixed | #68 | `dappercode.dev/activity` events in the transcript activity row | MainScreen.local "shows what the local run is doing…"; LocalRuntimeShell |
| 78 | Tool cards "Read read_file"; interrupted shows failed | Fixed | #68, #73 | `describeLocalTool` titles and verbs; tool rows follow `showToolCalls`. Tool metadata gained an additive `interrupted: true` flag (`interruptedToolMeta` in `contracts/bridge-rpc/v2/manifest.json`); the status stays ACP's `failed`, so installed clients still show a failure rather than `pending`. The Rust bridge sets it on calls left active by a cancelled run (`agui.rs`, `acp/snapshot.rs`), the local transport does the same, and `parseToolMeta` maps it to a neutral row ("Stopped editing …", muted stop icon) | server "titles local tools with their subject and marks interrupted ones as interrupted"; ToolInvocation "renders an interrupted tool neutrally instead of as a failure"; toolInvocationPresentation "keeps an interrupted call interrupted…"; agUi "reads interrupted tools from a flag that keeps installed clients on failed"; chatMapping "maps a persisted tool the user interrupted…"; Rust `agui::tests::cancelled_run_flags_a_dangling_tool_interrupted_and_keeps_it_failed`, `rpc::tests::contract_fixture_manifest` |
| 79 | Dark-mode accent pills low contrast | Fixed by removal | #66–#69; wave 3 legacy sweep | Legacy `LocalAction` pills removed | `shared/theme.test.ts` contrast tests |
| 80 | Content scrolls under a hard-cut header | Fixed by removal | #65–#69; wave 3 legacy sweep | Shared headers | — (visual) |
| 81 | Busy spinner scrolls away; no bottom inset | Fixed by removal | #65–#69; wave 3 legacy sweep | `LocalPage` removed; the sweep replaces the provider's startup and recovery page | — |
| 82 | No `SceneToolbarHost` | Requires physical device verification | #65 | Local screens are now shell screens inside the adaptive toolbar layout. Foldable and landscape behavior can't be measured in jest | `shell/layout/SceneToolbar.test.tsx` (shared) |
| 83 | Home has no hierarchy | Fixed by removal | #65, #66; wave 3 legacy sweep | Home replaced by the chat-first shell | — |

### H. Accessibility

| # | Finding | Status | PR | Evidence | Tests |
|---|---|---|---|---|---|
| 84 | `ChoiceAction` unlabeled | Fixed | #66 | `accessibilityRole="button"`, label without empty segments, decorative glyphs | ChoiceAction "exposes one labelled button with decorative icons and no empty spoken segments" |
| 85 | No announcements | Fixed | #68, #69 | Run phases (`runAnnouncement.ts`), model and download changes, sign-in | MainScreen.local announcements; LocalModelsScreen "announces each change once…"; LocalGitAccountScreen "announces a completed sign-in once…" |
| 86 | Download progress not a progress value | Fixed | #69 | `accessibilityRole="progressbar"` with `accessibilityValue` | LocalModelsScreen parallel-progress test; LocalModelsScreen.runtime (`now: 50`) |
| 87 | Disabled contrast fails | Fixed by removal | #66–#69; wave 3 legacy sweep | See #56 | — |
| 88 | Every `LocalText` selectable | Fixed by removal | wave 3 legacy sweep | Legacy kit removed | — |
| 89 | Conversation rows read poorly | Fixed | #68 | Drawer rows expose Delete as a VoiceOver custom action | DrawerContent "offers delete as a VoiceOver action on the single session row" |

### I. Screen-level UX (P2)

| # | Finding | Status | PR | Evidence | Tests |
|---|---|---|---|---|---|
| 90 | Raw status enum; no preview | Fixed by removal | #65, #68; wave 3 legacy sweep | Shared drawer rows with preview and time | DrawerContent (shared) |
| 91 | "Git changes" dead end | Fixed | #67 | Git opens on the chat's workspace | GitScreen.local "shows the workspace by name with a Files shortcut…" |
| 92 | No setup checklist | Fixed | #66 | "Set up On this iPhone" checklist | ProfileSwitcher "switches a bridge chat to On this iPhone, guides setup…", "follows the first model download…" |
| 93 | Delete has no confirmation; draft not pruned | Excluded by user (#117) | #61, #72 | Confirmation excluded. Draft pruning is fixed: `runtime.deleteThread` removes any legacy draft, and the shared composer owns current drafts (#72) | runtime "deleting a conversation prunes its legacy draft" |
| 94 | Inconsistent "Workspace unavailable" wording | Fixed by removal | #68; wave 3 legacy sweep | "Unavailable workspace" remains only in legacy `ChatScreen.tsx` | — |
| 95 | Draft not re-synced on `threadId` change | Fixed by removal | #65; wave 3 legacy sweep | The shared draft controller is keyed per chat | `features/chat/composer/controllers/draftController.test.ts` |
| 96 | Confusing missing-thread message | Fixed by removal | #65; wave 3 legacy sweep | Shared chat routing handles missing chats | — |
| 97 | Title cut mid-word | Fixed | #68 | `localConversationTitle` (word boundary, ellipsis) | agentLoop "titles a conversation from its first message without cutting a word in half" |
| 98 | Name required for clone | Fixed | #67 | Name derived from the URL | checkout Screen.local "validates HTTPS before cloning and derives the workspace name from the URL" |
| 99 | No URL validation | Fixed | #67 | `workspace/api/remoteUrl.ts` | checkout Screen.local (above); `remoteUrl.test.ts` |
| 100 | Clone progress objects only; push warning | Fixed | #67 | "Receiving files: x of y", Stop, no push text | checkout Screen.local "shows clone progress and lets the user stop the transfer" |
| 101 | Create-file in the wrong folder | Fixed | #63, #67 | Create in the open folder | Files Screen "creates new files in the folder being viewed" |
| 102 | Editor loses edits; proportional font | Fixed | #67 | Monospace editor, dirty dot, Save/Discard guard | Files Screen "never drops unsaved edits…", "discards edits only when asked…" |
| 103 | Large files without total size | Fixed | #63, #67 | `totalBytes`; read-only preview | Files Screen "opens large files read-only with their total size" |
| 104 | Missing `workspaceId` raw error | Fixed | #63, #67 | `WORKSPACE_REQUIRED`; friendly message | Files Screen "explains a missing workspace instead of showing a native error" |
| 105 | No ahead/behind; no confirmations | Fixed (confirmation excluded by user, #117) | #63, #67 | Ahead/behind shown; a dirty branch switch is rejected with friendly copy | GitScreen.local "shows ahead/behind…" |
| 106 | Non-Git raw error | Fixed | #63, #67 | "Initialize Git" state | GitScreen.local "offers Initialize Git instead of a raw error…" |
| 107 | Jargon copy | Fixed by removal | #67; wave 3 legacy sweep | The sentence remains only in legacy `GitScreen.tsx` | — |
| 108 | Safari opens before the code | Fixed | #69 | Code shown and copied; **Open GitHub** on request | LocalGitAccountScreen "shows and copies the device code, and opens GitHub only when asked" |
| 109 | Author form feedback/validation | Fixed | #69 | Validation, `textContentType`/`autoComplete`, Save only on change, "Saved" | LocalGitAccountScreen "validates the commit author, saves only changes, and confirms the save" |
| 110 | Sign-out unconfirmed; leaving cancels sign-in | Fixed (confirmation excluded by user, #117) | #69 | `localSignInAtom` keeps the attempt | LocalGitAccountScreen "keeps an in-progress sign-in when the page is left…", "signs out in place without a confirmation dialog" |
| 111 | Awkward title | Fixed | #69 | "Git & GitHub" (`LOCAL_GIT_ACCOUNT_TITLE`) | LocalProfileSection test |
| 112 | Search misses sizes and quants | Fixed | #69 | Search matches size and quant | LocalModelsScreen "…finds families by size or quant" |
| 113 | Memory sampled once | Fixed | #69 | `MEMORY_REFRESH_MS` re-measure | LocalModelsScreen "re-measures memory instead of keeping a stale reading" |
| 114 | "Load and use" gives no feedback | Fixed | #69 | Load announcement; **Start a new chat** in the In use group | LocalModelsScreen "loads, announces…", "shows which model is loaded…" |
| 115 | Unsupported packings as disabled buttons | Fixed | #69 | "Not supported in this build" badge | LocalModelsScreen "…labels unsupported packings" |
| 116 | Selected vs loaded unclear | Fixed | #69 | In use group separates loaded from used-for-new-chats | LocalModelsScreen "shows which model is loaded and which one new chats use, separately" |

### J. Consistency, performance, code quality (P3)

| # | Finding | Status | PR | Evidence | Tests |
|---|---|---|---|---|---|
| 117 | Destructive actions lack confirmation | Excluded by user (#117) | — | No confirmation dialogs were added anywhere | Tests assert no `Alert` (for example LocalModelsScreen, ManagedView, LocalGitAccountScreen) |
| 118 | Typing rewrites `preferences.json` | Fixed | #61, #72 | Local chats use the shell's debounced per-profile composer draft store, the same as bridge chats; the runtime no longer writes drafts (`runtime/drafts.ts` is a read-only `LegacyDraftReader`). Drafts from older builds (inline in `preferences.json` and per-thread draft documents) are imported once into the composer store before local chats open (`shell/runtime/localDraftImport.ts`) and removed only after that write succeeds | runtime "backgrounding flushes history…", "inline drafts from older builds are offered for import…", "draft documents from older builds are removed only once imported…", "a failed settle keeps the legacy draft so the import is retried"; localDraftImport "moves inline and per-conversation drafts into the shared composer once…", "keeps every legacy byte when the composer write fails…"; LocalRuntimeHost "imports drafts from older builds before any local chat can open…"; preferences "legacy inline drafts are read for migration but never written back…" |
| 119 | Every token re-renders everything | Fixed | #61, #65 | Coalesced `threads` slice; memoized projection; the transport ignores download slices | runtime "token streaming notifies thread subscribers at most once per interval…"; emitter tests |
| 120 | Whole thread rewritten per save | Fixed | #61, thread journal | Coalesced progress writes; unchanged content skipped. Each save now appends a small `threadseg-<id>-<position>.json` segment with only the changed fields and messages after a compact `thread-<id>.json` base; the journal is compacted once when a run settles or when it outgrows its base (`runtime/threads.ts`, `runtime/threadJournal.ts`). Tool intent is still durable before execution; older whole-thread documents are read as the base | runtime "a turn journals the user message immediately and coalesces progress into one later write"; agentLoop "a tool turn appends journal segments whose size does not grow with the conversation", "recovery never replays pending edits and supplies results for unadmitted tool calls"; threads "older whole-conversation documents are read as the base…", "a crash after journaling tool intent replays the segments, interrupts the tool, and never replays it", "a crash between compaction and segment removal…", "a damaged segment and every later one are set aside…", "a damaged trailing segment that cannot be moved is left in place…", "a damaged base is set aside together with its segments", "deleting a conversation removes every segment…", "segments stay small and bounded…" |
| 121 | `GitTransferProgress` polls every 500 ms | Fixed | #67, #73; wave 3 legacy sweep | The legacy component is removed. `GitNetworkOperation.swift` pushes throttled `onGitTransferProgress` module events (ABI 8) for clone, fetch, pull, and push; the transport forwards them as `workspace/clone/progressChanged`, and the shared clone screen subscribes (`workspace/checkout/parts.tsx`) with one snapshot read and no polling. Native delivery was typechecked, not run (see [Gaps](#gaps)) | checkout Screen.local "shows clone progress…", "follows native clone progress events with one snapshot read and no polling", "keeps a newer progress event over a slower snapshot read"; runtimePort "forwards native Git transfer progress events…"; workspaceHandlers "forwards native transfer progress as host notifications until stopped"; native `NativeGitTestApp.swift` "clone progress is pushed to the observer from start to finish" |
| 122 | Persisted `'on-device'` target dead-ends off iOS | Fixed | #65 | Local profile resolves only where supported | localProfile "never detects local support on android/web/macos"; localProfileRouting "never resolves a saved local selection where the local agent is unsupported" |
| 123 | `ReturnToDesktop` exits inconsistently | Fixed | #65 | `ReturnToDesktop`/`OnDeviceTargets` deleted; exit is profile switching plus disposal | LocalProfileExit "closes the local profile before onboarding…"; LocalRuntimeHost "owns a runtime and transport only while the local profile is open" |
| 124 | `targets.ts` import at the bottom | Fixed | #65 | `shell/runtime/targets.ts` deleted | — |
| 125 | Inference tuning reprocesses the prompt | Requires physical device verification | #62 | `nativeContextParams`: `n_threads` 4/6, `n_batch` 512, `n_ubatch` 256, state-cache budget (`models/engine.ts`). The simulator gate showed prefix reuse; device performance is unmeasured | session "native context tuning uses the admitted context, one sequence, and hybrid prompt reuse" |
| 126 | Template rendered twice per round | Fixed | #62 | `preparePrompt` formats once; `completionParams` passes the prompt | session "each round renders the chat template once and completes from that formatted prompt" |
| 127 | Test gaps | Fixed | this PR | Real-runtime harness `features/on-device/runtime/testing.ts` (in-memory native module and scripted llama.rn) and integration tests through the transport, Settings, Files, and the shell; see [the next section](#coverage-added-for-127) | All tests marked **bold** above |

## Coverage added for #127

Before this PR, every transport and shell test of the local profile used `FakeAgentPort`, so none
exercised the real runtime's ordering. `transport/runtimePort.ts` had no tests. The new tests run
the real `OnDeviceRuntime` (agent loop, model session, residency, downloads controller, threads,
and issues) over `createFakeOnDeviceNative` and `FakeLlama`:

| Area | Test |
|---|---|
| `inactive` doesn't stop turns, unload, or pause; `background` stops and unloads; foreground warms without replay | `shell/runtime/LocalRuntimeShell.integration.test.tsx` "keeps a turn and its model through inactive states…" (fails if `inactive` suspends) |
| Load-state UI (loading %, generating, stopping, load error) in the transcript, composer, and drawer | LocalRuntimeShell "keeps a turn…", "labels stopping and load errors…"; runtimePort "reports load progress before the run starts…" |
| Context exhaustion and compaction | `features/on-device/transport/runtimePort.test.ts` "keeps a conversation usable after its tool output exceeds the context window" (fails with compaction disabled) |
| Model switching under memory pressure (resident credit) | runtimePort "switches a chat to a larger model under memory pressure…"; `features/settings/local/LocalModelsScreen.runtime.test.tsx` "loads a larger model that only fits once the resident model is released" (fails if admission ignores the release) |
| Concurrent downloads, queue, per-model pause | LocalModelsScreen.runtime "runs two downloads at once, queues a third, and pauses one model…" |
| Files root listing through the shared Files screen | `features/workspace/files/Screen.runtime.test.tsx` "lists the workspace root with the empty root path…" |
| Approval flow | runtimePort "asks before a model-initiated push and honours reject-once/allow-once"; LocalRuntimeShell "runs a model push only after Allow…" |
| Retry and kept drafts | runtimePort "retries a failed turn in place…", "keeps a failed load out of history…", "stops a turn while the model loads…"; LocalRuntimeShell (composer Retry and kept draft) |
| Profile switching | LocalRuntimeShell "disposes the runtime when switching to a desktop profile and restores chats on return" |
| Runtime issues in the unified shell (#37, #40, #41) | LocalRuntimeShell "surfaces set-aside files and failed writes in the drawer and Settings until resolved" |
| `FakeAgentPort` mirrors real ordering | runtimePort "is mirrored by the FakeAgentPort used by shell tests, phase for phase" |

`FakeAgentPort` had encoded an order the real loop doesn't produce: it settled without the loop's
`persisting` ("Saving") phase, and it titled chats with a 60-character slice. It now follows the
real loop, the parity test pins its activity phases and AG-UI lifecycle to the real runtime, and the
two `server.test.ts` sequences that encoded the old order now include "Saving".

**End-to-end selectors.** The local profile is iOS-only and can't render in the web layout suite.
Shared handles for its entry points (`drawerProfileSwitcher`, `newChatProfileSwitcher`,
`localSetupGuide`, `onboardingLocalChoice`) are in `e2e/fixtures/selectors.ts` and exercised by
`e2e/specs/profile-switcher.spec.ts`. The local flows themselves are covered by the jest
integration tests above. `nativeOnDeviceSelectors` (used by `native-product.mjs`) still names
legacy test IDs and is updated by the wave 3 legacy sweep.

## Gaps

1. **Needs a physical device:** #18 (memory headroom with the entitlement), #30 (background
   `URLSession` across lock, kill, and relaunch), #82 (foldable and landscape toolbar layout), and
   #125 (inference throughput and prompt-cache reuse on device). Live simulator runs were blocked
   during this work: Xcode needed its first-launch setup, so `xcodebuild -checkFirstLaunchStatus`
   returned 69. For the same reason, #121's native event delivery (`Events`/`sendEvent` and the
   `NativeGitTestApp.swift` observer check) was typechecked with `swiftc` against the module sources
   and a stub of the ExpoModulesCore API, and its throttling was exercised in a macOS harness, but it
   was not run in the simulator.
2. **Excluded by user (#117):** confirmations for #34, #93, #105, #110, and #117.
3. **Depends on the wave 3 legacy sweep:** the "Fixed by removal" rows (#50–#57, #66, #72, #73,
   #79–#81, #83, #87, #88, #90, #94–#96, #107) are complete once the sweep deletes the legacy
   routes and screens. The sweep must also:
   - replace `OnDeviceProvider`'s `LocalPage` startup and recovery page, keeping a retry that
     waits for disposal (#38);
   - move `runtime.test.ts` off `screens/chatControls`.

## Test index

Short names in the tables refer to these files (under `apps/mobile/src` unless noted):

| Short name | File |
|---|---|
| runtime | `features/on-device/runtime/runtime.test.ts` |
| agentLoop | `features/on-device/runtime/agentLoop.test.ts` |
| threads | `features/on-device/runtime/threads.test.ts` |
| status | `features/on-device/runtime/status.test.ts` |
| OnDeviceProvider | `features/on-device/runtime/OnDeviceProvider.test.tsx` |
| emitter, network, preferences | `features/on-device/runtime/{emitter,network,preferences}.test.ts` |
| session, contextWindow, memory, downloads, catalog | `features/on-device/models/*.test.ts` |
| fileTools | `features/on-device/workspaces/fileTools.test.ts` |
| services | `features/on-device/native/services.test.ts` |
| server | `features/on-device/transport/server.test.ts` |
| runtimePort | `features/on-device/transport/runtimePort.test.ts` |
| MainScreen.local | `features/chat/screen/MainScreen.local.test.tsx` |
| HeaderAndWorkflow | `features/chat/screen/HeaderAndWorkflow.test.tsx` |
| GitScreen.local | `features/git/GitScreen.local.test.tsx` |
| Files Screen, Files Screen.runtime | `features/workspace/files/Screen{,.runtime}.test.tsx` |
| ManagedView | `features/workspace/picker/ManagedView.test.tsx` |
| checkout Screen.local | `features/workspace/checkout/Screen.local.test.tsx` |
| workspaceHandlers | `features/on-device/transport/workspaceHandlers.test.ts` |
| ToolInvocation, toolInvocationPresentation | `features/chat/message/{ToolInvocation.test.tsx,toolInvocationPresentation.test.ts}` |
| agUi, chatMapping | `bridge/agui/agUi.test.ts`, `bridge/mapping/chatMapping.test.ts` |
| LocalModelsScreen, LocalModelsScreen.runtime | `features/settings/local/LocalModelsScreen{,.runtime}.test.tsx` |
| LocalGitAccountScreen | `features/settings/local/LocalGitAccountScreen.test.tsx` |
| LocalProfileSection, SettingsScreen | `features/settings/{LocalProfileSection,SettingsScreen}.test.tsx` |
| ChoiceAction, OnboardingScreen | `features/onboarding/ChoiceAction.test.tsx`, `features/onboarding/screen/OnboardingScreen.test.tsx` |
| ProfileSwitcher | `shell/profiles/ProfileSwitcher.test.tsx` |
| LocalRuntimeShell | `shell/runtime/LocalRuntimeShell.integration.test.tsx` |
| LocalRuntimeHost, LocalBridgeWsClient, LocalProfileExit, localDraftImport | `shell/runtime/*.test.ts(x)` |
| localProfile, localProfileRouting | `shell/state/localProfile.test.ts`, `shell/navigation/localProfileRouting.test.tsx` |
| DrawerContent | `shell/navigation/DrawerContent.test.tsx` |
| Native scenarios | `modules/on-device-agent/tests/native-{workspaces,git,downloads,inference}.mjs` |
| Script tests | `scripts/__tests__/{ios-on-device-memory,on-device-background-events}.test.mjs` |
