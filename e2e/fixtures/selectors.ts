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

  topChrome: (page: Page): Locator => page.getByTestId('main-screen-top-chrome'),
  chatHeaderRow: (page: Page): Locator => page.getByTestId('chat-header-row'),
  chatHeaderTitleRow: (page: Page): Locator => page.getByTestId('chat-header-title-row'),
  sessionMetaRow: (page: Page): Locator => page.getByTestId('session-meta-row'),

  transcript: (page: Page): Locator => page.getByTestId('chat-transcript'),
  transcriptItems: (page: Page): Locator => page.locator('[data-testid^="transcript-item-"]'),
  message: (page: Page, role: 'user' | 'assistant', messageId: string): Locator =>
    page.getByTestId(`transcript-item-message-${role}-${messageId}`),
  messages: (page: Page): Locator => page.locator('[data-testid^="transcript-item-message-"]'),
  assistantMessages: (page: Page): Locator =>
    page.locator('[data-testid^="transcript-item-message-assistant-"]'),
  userMessages: (page: Page): Locator =>
    page.locator('[data-testid^="transcript-item-message-user-"]'),
  toolRows: (page: Page): Locator => page.locator('[data-testid^="transcript-item-tool-"]'),

  composer: (page: Page): Locator => page.getByTestId('chat-composer'),
  composerControls: (page: Page): Locator => page.getByTestId('composer-control-groups'),
  composerInputSurface: (page: Page): Locator => page.getByTestId('composer-input-glass-surface'),
  composerInput: (page: Page): Locator => page.getByLabel('Message'),
  composerSubmitSlot: (page: Page): Locator => page.getByTestId('composer-submit-slot'),
  composerStopSlot: (page: Page): Locator => page.getByTestId('composer-stop-slot'),
  composerAttachment: (page: Page): Locator => page.getByLabel('Add attachment'),

  activityEvent: (page: Page): Locator => page.getByTestId('transcript-activity-event'),
  transcriptBottomScrim: (page: Page): Locator => page.getByTestId('transcript-bottom-scrim'),
} as const;
