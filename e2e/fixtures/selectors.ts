import type { Locator, Page } from '@playwright/test';

/**
 * Centralized selectors for the surfaces the layout suite measures.
 *
 * React Native's `testID` becomes `data-testid` under react-native-web, which is what
 * `getByTestId` targets. Where a surface has no `testID`, the app's existing `accessibilityLabel`
 * is used instead — those are stable because they are user-facing accessibility contracts.
 */
export const selectors = {
  drawer: (page: Page): Locator => page.getByTestId('drawer-glass-surface'),
  drawerChatRow: (page: Page, chatId: string): Locator =>
    page.getByTestId(`drawer-chat-row-${chatId}`),
  drawerChatRows: (page: Page): Locator => page.locator('[data-testid^="drawer-chat-row-"]'),
  drawerNewChat: (page: Page): Locator => page.getByLabel('New chat').first(),
  drawerSearch: (page: Page): Locator => page.getByLabel('Search sessions'),
  drawerSettings: (page: Page): Locator => page.getByLabel('Open settings'),
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
