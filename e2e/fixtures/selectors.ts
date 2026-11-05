import type { Locator, Page } from '@playwright/test';

/**
 * XCUITest handles for the native On this iPhone product scenario
 * (`apps/mobile/modules/on-device-agent/tests/native-product.mjs`). A string is an accessibility
 * id (a `testID` or an accessibility label); `{ predicate }` is an iOS predicate string for labels
 * that carry live values. `{ classChain }` scopes descendants to their owning native control.
 */
export const nativeOnDeviceSelectors = {
  entry: 'onboarding-choice-local',
  runTarget: 'new-chat-profile-switcher',
  setupGuide: 'local-setup-guide',
  openDrawer: 'Open navigation drawer',
  newChat: { predicate: 'type == "XCUIElementTypeButton" AND label == "New chat"' },
  settings: 'Open settings',
  // The testID, not the label: it names the page Back returns to, and a testID is the iOS name.
  settingsBack: 'settings-back-button',
  // Scoped to buttons: the group footer "Models, workspaces, and conversations…" also matches.
  settingsModels: { predicate: 'type == "XCUIElementTypeButton" AND label BEGINSWITH "Models, "' },
  showToolCalls: {
    predicate: 'type == "XCUIElementTypeSwitch" AND label == "Show tool calls"',
  },
  toolRows: { predicate: 'type == "XCUIElementTypeButton" AND name == "tool-row"' },
  modelLibrary: 'settings-local-models-screen',
  modelSearch: 'settings-local-models-search',
  downloadedOnly: { predicate: 'type == "XCUIElementTypeSwitch" AND label == "Downloaded only"' },
  includeLargeModels: {
    predicate:
      'type == "XCUIElementTypeSwitch" AND label == "Include models too large for this iPhone"',
  },
  qwen35Family: 'settings-local-family-qwen3.5',
  bonsaiFamily: 'settings-local-family-bonsai-2',
  gemmaFamily: 'settings-local-family-gemma-4',
  modelFamily: (id: string) => `settings-local-family-${id}`,
  modelDownload: (id: string) => `local-model-download-${id}`,
  modelPause: (id: string) => `local-model-pause-${id}`,
  modelCancel: (id: string) => `local-model-cancel-${id}`,
  modelProgress: (id: string) => `local-model-progress-${id}`,
  modelLoad: (id: string) => `local-model-load-${id}`,
  modelUnload: (id: string) => `local-model-unload-${id}`,
  modelRow: (id: string) => `local-model-${id}`,
  modelUseForNewChats: (id: string) => `local-model-select-${id}`,
  modelDelete: (id: string) => `local-model-delete-${id}`,
  modelOption: (model: { name: string; quantization: string }) => ({
    predicate: `type == "XCUIElementTypeButton" AND label == ${JSON.stringify(`${model.name} ${model.quantization}`)}`,
  }),
  familyPage: 'settings-local-family-screen',
  gitAccount: {
    predicate: 'type == "XCUIElementTypeButton" AND label BEGINSWITH "Git & GitHub, "',
  },
  gitAccountPage: 'settings-local-account-screen',
  gitAuthorName: 'settings-local-author-name',
  gitAuthorEmail: 'settings-local-author-email',
  gitAuthorSave: 'settings-local-author-save',
  githubUnavailable: { predicate: 'label == "GitHub sign-in, Unavailable"' },
  workspace: { predicate: 'label BEGINSWITH "Workspace, "' },
  modelChip: { predicate: 'label BEGINSWITH "Model, "' },
  sheetClose: 'selection-sheet-close',
  downloadMoreModels: 'Download more models',
  downloadAModel: 'Download a model',
  message: { predicate: 'type == "XCUIElementTypeTextView" AND label BEGINSWITH "Message"' },
  userMessageText: (value: string) => ({
    classChain: `**/XCUIElementTypeOther[\`name BEGINSWITH "message-timestamp-reveal-"\`]/**/XCUIElementTypeStaticText[\`label == ${JSON.stringify(value)} AND accessible == true\`]`,
  }),
  send: 'Send message',
  stop: 'Stop agent',
  stopping: 'Stopping agent',
  activityEvent: 'transcript-activity-event',
  activityError: 'activity-error-surface',
  approvalAllow: 'Allow',
  approvalDeny: 'Deny',
  gitPushFailed: {
    predicate: 'type == "XCUIElementTypeButton" AND label == "Failed Git push"',
  },
  declinedToolOutput: {
    predicate:
      'label BEGINSWITH "Tool output: " AND label CONTAINS "The user declined this request"',
  },
  reviewNotNow: 'Not Now',
  addBridge: 'Add bridge',
  localProfile: 'On this iPhone',
  bridgeUrl: 'Bridge URL',
  cancelConnection: 'Cancel connection setup',
  chatRowPrefix: 'drawer-chat-row-',
  newWorkspace: 'New workspace',
  workspaceCreateInput: 'workspace-create-sheet-input',
  workspaceCreateSubmit: 'workspace-create-sheet-submit',
  workspaceRenameInput: 'workspace-rename-sheet-input',
  workspaceRenameSubmit: 'workspace-rename-sheet-submit',
  workspaceRow: (name: string) => ({
    predicate: `type == "XCUIElementTypeButton" AND label BEGINSWITH ${JSON.stringify(`${name}, `)}`,
  }),
  workspaceDelete: (name: string) => `Delete workspace ${name}`,
  renameAction: 'Rename',
  workspaceDone: 'Done',
  openGit: 'Open Git',
  gitSetup: 'git-repository-setup',
  gitInitialize: 'git-initialize',
  gitOrigin: 'Remote URL, optional',
  gitBack: 'Back to chat',
  gitRefresh: 'Refresh Git status',
  gitStageAll: 'Stage all',
  gitUnstageAll: 'Unstage all',
  gitChangeBranch: 'Change branch',
  gitNewBranch: 'New branch name',
  gitCreateBranch: 'Create branch',
  gitSwitchBranch: 'Switch',
  gitSelectedBranch: (name: string) => ({
    predicate: `label == ${JSON.stringify(`Selected: ${name}`)}`,
  }),
  gitBranch: (name: string) => ({
    predicate: `label == ${JSON.stringify(`${name}, Local`)}`,
  }),
  gitDiscardAll: 'git-discard-all',
  gitDiscardFile: (name: string) => `Discard changes to ${name}`,
  gitFile: (name: string) => `git-file-${name}`,
  gitDiscarding: { predicate: 'label BEGINSWITH "Discarding"' },
  editSessionTitle: 'Edit session title',
  sessionTitle: 'Session title',
  cancelRename: 'Cancel rename',
  saveSessionTitle: 'Save session title',
  deleteChat: (title: string) => `Delete ${title}`,
  deleteSessionDialog: {
    predicate: 'type == "XCUIElementTypeAlert" AND label BEGINSWITH "Delete session?"',
  },
  deleteSessionCancel: { predicate: 'type == "XCUIElementTypeButton" AND label == "Cancel"' },
  deleteSessionConfirm: { predicate: 'type == "XCUIElementTypeButton" AND label == "Delete"' },
  textLabel: (value: string) => ({ predicate: `label CONTAINS ${JSON.stringify(value)}` }),
  cancelCheckout: 'Cancel git checkout',
  checkoutName: 'Workspace name',
  checkoutUrlError: 'git-checkout-url-error',
  stopCloning: 'git-checkout-stop',
  checkoutStopping: { predicate: 'label BEGINSWITH "Stopping"' },
  gitCommitMessage: 'git-commit-message',
  gitCommit: 'Commit',
  gitFetch: 'Fetch',
  gitPull: 'Pull',
  cloneRepository: {
    predicate: 'type == "XCUIElementTypeButton" AND label == "Clone repository"',
  },
  cloneUrl: 'Repository URL',
  cloneStop: 'git-checkout-stop',
  browseFiles: 'git-open-files',
  filesScreen: 'files-screen',
  filesNew: 'files-new',
  filesRefresh: 'Refresh files',
  filesCreateInput: 'files-create-sheet-input',
  filesCreateSubmit: 'files-create-sheet-submit',
  filesRenameInput: 'files-rename-sheet-input',
  filesRenameSubmit: 'files-rename-sheet-submit',
  filesEditor: 'files-editor',
  filesSave: 'files-save',
  filesBack: 'files-back',
  filesDirty: 'files-dirty-indicator',
  fileOpen: (name: string) => `Open ${name}`,
  fileDelete: (name: string) => `Delete ${name}`,
  filesReadOnly: 'files-readonly-notice',
  filesUnsaved: 'files-unsaved-banner',
  filesDiscardEdits: 'files-discard-edits',
  filesKeepEditing: { predicate: 'type == "XCUIElementTypeButton" AND label == "Keep editing"' },
  filesSaveBanner: 'files-save-banner',
  filesConflict: {
    predicate: 'label BEGINSWITH "This file changed since you opened it."',
  },
  filesOverwrite: { predicate: 'type == "XCUIElementTypeButton" AND label == "Overwrite"' },
  filesDiscardLatest: { predicate: 'type == "XCUIElementTypeButton" AND label == "Discard edits"' },
  folderOpen: (name: string) => `Open folder ${name}`,
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
