/**
 * Storage seeding that runs before any app code, so the shell boots straight into a connected
 * profile instead of onboarding.
 *
 * On web the app persists its state to `localStorage` (`shell/state/appState/persistence.ts`), so
 * writing the same key with the same schema version is a supported, non-invasive way to configure
 * the app under test. The version must track `APP_STATE_VERSION`; a mismatch makes the app discard
 * the seed and fall back to onboarding.
 */

export const APP_STATE_STORAGE_KEY = 'dappercode.app-state.v1';
export const APP_STATE_VERSION = 3;
export const SEEDED_PROFILE_ID = 'harness-profile';

export interface SeedOptions {
  readonly bridgeUrl: string;
  readonly bridgeToken: string;
  readonly nowMs: number;
}

/**
 * Serialized into the page via `addInitScript`, so it must be self-contained: no imports, no
 * closure over module scope.
 */
export function seedBridgeProfileScript(options: SeedOptions): void {
  const timestamp = new Date(options.nowMs).toISOString();
  const state = {
    version: 3,
    settings: {
      defaultStartCwd: null,
      preferredAgentId: null,
      agentSettings: {},
      approvalMode: 'normal',
      showToolCalls: true,
      workspaceChatLimit: 20,
      recentBrowserTargetUrls: [],
    },
    bridgeProfiles: {
      activeProfileId: 'harness-profile',
      profiles: [
        {
          id: 'harness-profile',
          name: 'Harness',
          bridgeUrl: options.bridgeUrl,
          bridgeToken: options.bridgeToken,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    },
    push: {
      optedOut: true,
      events: { turnCompleted: true, approvalRequested: true },
      registrations: [],
    },
  };

  window.localStorage.setItem('dappercode.app-state.v1', JSON.stringify(state));
}
