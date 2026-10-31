import type { Locator, Page } from '@playwright/test';

/**
 * XCUITest handles for the native On this iPhone product scenario
 * (`apps/mobile/modules/on-device-agent/tests/native-product.mjs`). A string is an accessibility
 * id (a `testID` or an accessibility label); `{ predicate }` is an iOS predicate string for labels
 * that carry live values.
 */
export const nativeOnDeviceSelectors = {
  entry: 'onboarding-choice-local',
  runTarget: 'new-chat-profile-switcher',
  setupGuide: 'local-setup-guide',
  openDrawer: 'Open navigation drawer',
  newChat: 'New chat',
  settings: 'Open settings',
  settingsBack: 'Back to Settings',
  settingsModels: { predicate: 'label BEGINSWITH "Models, "' },
  modelLibrary: 'settings-local-models-screen',
  qwen35Family: 'settings-local-family-qwen3.5',
  bonsaiFamily: 'settings-local-family-bonsai-2',
  gemmaFamily: 'settings-local-family-gemma-4',
  familyPage: 'settings-local-family-screen',
  gitAccount: { predicate: 'label BEGINSWITH "Git & GitHub, "' },
  gitAccountPage: 'settings-local-account-screen',
  githubUnavailable: { predicate: 'label == "GitHub sign-in, Unavailable"' },
  workspace: { predicate: 'label BEGINSWITH "Workspace, "' },
  modelChip: { predicate: 'label BEGINSWITH "Model, "' },
  sheetClose: 'selection-sheet-close',
  downloadMoreModels: 'Download more models',
  message: { predicate: 'type == "XCUIElementTypeTextView" AND label BEGINSWITH "Message"' },
  send: 'Send message',
  stop: 'Stop agent',
  stopping: 'Stopping agent',
  addBridge: 'Add bridge',
  localProfile: 'On this iPhone',
  bridgeUrl: 'Bridge URL',
  cancelConnection: 'Cancel connection setup',
  chatRowPrefix: 'drawer-chat-row-',
} as const;

/**
 * Centralized selectors for the surfaces the layout suite measures.
 *
 * React Native's `testID` becomes `data-testid` under react-native-web, which is what
 * `getByTestId` targets. Where a surface has no `testID`, the app's existing `accessibilityLabel`
 * is used instead — those are stable because they are user-facing accessibility contracts.
 */
export const selectors = {
  drawer: (page: Page): Locator => page.getByTestId('drawer-glass-surface'),
  drawerHeader: (page: Page): Locator => page.getByTestId('drawer-header'),
  drawerChatRow: (page: Page, chatId: string): Locator =>
    page.getByTestId(`drawer-chat-row-${chatId}`),
  drawerChatRows: (page: Page): Locator => page.locator('[data-testid^="drawer-chat-row-"]'),
  drawerNewChat: (page: Page): Locator => page.getByLabel('New chat').first(),
  drawerSearch: (page: Page): Locator => page.getByLabel('Search sessions'),
  drawerSettings: (page: Page): Locator => page.getByLabel('Open settings'),
  drawerProfileSwitcher: (page: Page): Locator => page.getByTestId('drawer-profile-switcher'),
  drawerFolderFilter: (page: Page): Locator => page.getByLabel(/^Filter sessions by folder/),
  newChatProfileSwitcher: (page: Page): Locator => page.getByTestId('new-chat-profile-switcher'),
  newChatWorkspace: (page: Page): Locator => page.getByLabel(/^Workspace, /),
  profileOption: (page: Page, name: string): Locator =>
    page.getByRole('button', { name, exact: true }),
  localSetupGuide: (page: Page): Locator => page.getByTestId('local-setup-guide'),
  onboardingBridgeChoice: (page: Page): Locator => page.getByTestId('onboarding-choice-bridge'),
  onboardingLocalChoice: (page: Page): Locator => page.getByTestId('onboarding-choice-local'),
  sceneToolbarButtonGlass: (page: Page, key: string): Locator =>
    page.getByTestId(`scene-toolbar-button-glass-${key}`),
  chatPreviewLink: (page: Page, url: string): Locator =>
    page.getByRole('button', { name: `Open ${url} in Browser`, exact: true }),
  browserReturnToChat: (page: Page): Locator => page.getByTestId('browser-return-to-chat'),
  browserAddress: (page: Page): Locator => page.getByLabel('Preview address', { exact: true }),
  browserUnavailable: (page: Page): Locator =>
    page.getByText('This bridge did not start its preview server.', { exact: false }),

  topChrome: (page: Page): Locator => page.getByTestId('main-screen-top-chrome'),
  chatHeaderRow: (page: Page): Locator => page.getByTestId('chat-header-row'),
  chatHeaderTitleRow: (page: Page): Locator => page.getByTestId('chat-header-title-row'),
  sessionMetaRow: (page: Page): Locator => page.getByTestId('session-meta-row'),

  transcript: (page: Page): Locator => page.getByTestId('chat-transcript'),
  historyRecovery: (page: Page): Locator => page.getByTestId('chat-history-recovery'),
  transcriptScroll: (page: Page): Locator =>
    page.getByTestId('chat-transcript').locator('[aria-label$=" transcript"]'),
  scrollRailBars: (page: Page): Locator => page.locator('[data-testid^="chat-scroll-rail-bar-"]'),
  jumpToLatest: (page: Page): Locator => page.getByLabel('Jump to latest message'),
  transcriptItems: (page: Page): Locator => page.locator('[data-testid^="transcript-item-"]'),
  message: (page: Page, role: 'user' | 'assistant', messageId: string): Locator =>
    page.getByTestId(`transcript-item-message-${role}-${messageId}`),
  messages: (page: Page): Locator => page.locator('[data-testid^="transcript-item-message-"]'),
  assistantMessages: (page: Page): Locator =>
    page.locator('[data-testid^="transcript-item-message-assistant-"]'),
  userMessages: (page: Page): Locator =>
    page.locator('[data-testid^="transcript-item-message-user-"]'),
  toolRows: (page: Page): Locator => page.locator('[data-testid^="transcript-item-tool-"]'),
  toolHeader: (root: Page | Locator): Locator => root.getByTestId('tool-row'),
  toolTitleToggle: (root: Page | Locator): Locator => root.getByTestId('tool-title-toggle'),
  toolOutput: (root: Page | Locator): Locator => root.getByTestId('tool-output-container'),
  toolTodoList: (root: Page | Locator): Locator => root.getByTestId('tool-todo-list'),
  toolTodoItems: (root: Page | Locator): Locator => root.getByTestId('tool-todo-item'),
  toolTodoText: (root: Page | Locator): Locator => root.getByTestId('tool-todo-text'),
  toolTextOutput: (root: Page | Locator): Locator => root.getByTestId('selectable-output-text'),
  toolShimmer: (root: Page | Locator): Locator => root.getByTestId('tool-header-shimmer'),
  toolPatchFiles: (root: Page | Locator): Locator => root.getByTestId('tool-patch-files'),
  toolPatchFile: (root: Page | Locator): Locator => root.getByTestId('tool-patch-file'),
  toolPatchName: (root: Page | Locator): Locator => root.getByTestId('tool-patch-name'),
  toolPatchPath: (root: Page | Locator): Locator => root.getByTestId('tool-patch-path'),
  toolPatchStats: (root: Page | Locator): Locator => root.getByTestId('tool-patch-stats'),

  composer: (page: Page): Locator => page.getByTestId('chat-composer'),
  composerControls: (page: Page): Locator => page.getByTestId('composer-control-groups'),
  composerInputSurface: (page: Page): Locator => page.getByTestId('composer-input-glass-surface'),
  composerInput: (page: Page): Locator =>
    page.getByRole('textbox', { name: 'Message', exact: true }),
  composerSubmitSlot: (page: Page): Locator => page.getByTestId('composer-submit-slot'),
  composerSend: (page: Page): Locator => page.getByLabel('Send message', { exact: true }),
  composerStopSlot: (page: Page): Locator => page.getByTestId('composer-stop-slot'),
  composerAttachment: (page: Page): Locator => page.getByLabel('Add attachment'),

  activityEvent: (page: Page): Locator => page.getByTestId('transcript-activity-event'),
  activityError: (page: Page): Locator => page.getByTestId('activity-error-surface'),
  runningGlyph: (page: Page): Locator => page.getByTestId('atom-glyph'),
  transcriptBottomScrim: (page: Page): Locator => page.getByTestId('transcript-bottom-scrim'),
} as const;
