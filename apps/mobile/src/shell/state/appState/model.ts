import type {
  AgentDefaultSettingsMap,
  AgentId,
  ApprovalMode,
  CollaborationMode,
} from '@bridge/types/types';
import {
  APP_SETTINGS_VERSION,
  DEFAULT_WORKSPACE_CHAT_LIMIT,
  parseAppSettings,
  type WorkspaceChatLimit,
} from '@shell/state/appSettings';
import {
  createEmptyBridgeProfileStore,
  parseBridgeProfileStore,
  type BridgeProfileDraft,
  type BridgeProfileStore,
} from '@shell/state/bridgeProfiles';
import {
  dedupeRecentPreviewTargets,
  normalizePreviewTargetInput,
} from '../../../features/browser/preview';

const DEFAULT_PUSH_EVENT_PREFERENCES: PushEventPreferences = {
  turnCompleted: true,
  approvalRequested: true,
};

export interface PushEventPreferences {
  turnCompleted: boolean;
  approvalRequested: boolean;
}

export const APP_STATE_VERSION = 3;

export interface PushProfileRegistration {
  profileId: string;
  registrationId: string;
  token: string | null;
}

export interface PushSettingsState {
  optedOut: boolean;
  events: PushEventPreferences;
  registrations: PushProfileRegistration[];
}

export interface AppSettingsState {
  defaultStartCwd: string | null;
  preferredAgentId: AgentId | null;
  agentSettings: AgentDefaultSettingsMap;
  approvalMode: ApprovalMode;
  showToolCalls: boolean;
  confirmSessionDeletion: boolean;
  workspaceChatLimit: WorkspaceChatLimit;
  recentBrowserTargetUrls: string[];
}

export interface AppStateData {
  settings: AppSettingsState;
  bridgeProfiles: BridgeProfileStore;
  push: PushSettingsState;
}

export type AppStatePersistenceOperation = 'load' | 'write';
export type AppStatePersistenceErrorCode = 'read_failed' | 'invalid_data' | 'write_failed';

export class AppStatePersistenceError extends Error {
  readonly code: AppStatePersistenceErrorCode;
  readonly operation: AppStatePersistenceOperation;
  override readonly cause: unknown;

  constructor(
    code: AppStatePersistenceErrorCode,
    operation: AppStatePersistenceOperation,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'AppStatePersistenceError';
    this.code = code;
    this.operation = operation;
    this.cause = cause;
  }
}

export interface AppStatePersistenceAdapter {
  readCurrent(): Promise<string | null>;
  writeCurrent(raw: string): Promise<void>;
}

export interface AppStateSnapshot {
  loaded: boolean;
  data: AppStateData;
  persistenceError: AppStatePersistenceError | null;
}

export type AppStateAction =
  | { type: 'settings/update'; patch: Partial<AppSettingsState> }
  | {
      type: 'settings/remember-thread';
      agentId: AgentId;
      collaborationMode: CollaborationMode;
    }
  | { type: 'profiles/save'; draft: BridgeProfileDraft }
  | { type: 'profiles/switch'; profileId: string }
  | { type: 'push/update'; patch: Partial<Pick<PushSettingsState, 'optedOut' | 'events'>> }
  | { type: 'push/ensure-registration'; profileId: string; registrationId: string }
  | {
      type: 'push/registered';
      profileId: string;
      registrationId: string;
      token: string;
    }
  | { type: 'push/unregistered'; profileId: string; registrationId: string };

export function createDefaultAppSettings(): AppSettingsState {
  return {
    defaultStartCwd: null,
    preferredAgentId: null,
    agentSettings: {},
    approvalMode: 'normal',
    showToolCalls: true,
    confirmSessionDeletion: true,
    workspaceChatLimit: DEFAULT_WORKSPACE_CHAT_LIMIT,
    recentBrowserTargetUrls: [],
  };
}

export function createDefaultAppStateData(): AppStateData {
  return {
    settings: createDefaultAppSettings(),
    bridgeProfiles: createEmptyBridgeProfileStore(),
    push: createDefaultPushSettings(),
  };
}

export function createDefaultPushSettings(): PushSettingsState {
  return {
    optedOut: false,
    events: { ...DEFAULT_PUSH_EVENT_PREFERENCES },
    registrations: [],
  };
}

export function normalizeAppStateData(data: {
  settings: unknown;
  bridgeProfiles: BridgeProfileStore;
  push?: unknown;
}): AppStateData {
  const bridgeProfiles = parseBridgeProfileStore(JSON.stringify(data.bridgeProfiles));
  return {
    settings: normalizeAppSettings(data.settings),
    bridgeProfiles,
    push: normalizePushSettings(data.push, bridgeProfiles),
  };
}

export function normalizePushSettings(
  value: unknown,
  profiles: BridgeProfileStore,
): PushSettingsState {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const events =
    record['events'] && typeof record['events'] === 'object'
      ? (record['events'] as Record<string, unknown>)
      : {};
  const registrations = normalizePushRegistrations(record['registrations'], profiles);
  return {
    optedOut: record['optedOut'] === true,
    events: {
      turnCompleted:
        typeof events['turnCompleted'] === 'boolean'
          ? events['turnCompleted']
          : DEFAULT_PUSH_EVENT_PREFERENCES.turnCompleted,
      approvalRequested:
        typeof events['approvalRequested'] === 'boolean'
          ? events['approvalRequested']
          : DEFAULT_PUSH_EVENT_PREFERENCES.approvalRequested,
    },
    registrations,
  };
}

function normalizePushRegistrations(
  value: unknown,
  profiles: BridgeProfileStore,
): PushProfileRegistration[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const knownProfiles = new Set(profiles.profiles.map((profile) => profile.id));
  const seenProfiles = new Set<string>();
  const seenRegistrations = new Set<string>();
  return value.flatMap((entry) => {
    const registration = toPushRegistration(entry, knownProfiles, seenProfiles, seenRegistrations);
    return registration ? [registration] : [];
  });
}

function toPushRegistration(
  value: unknown,
  knownProfiles: ReadonlySet<string>,
  seenProfiles: Set<string>,
  seenRegistrations: Set<string>,
): PushProfileRegistration | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const registration = value as Record<string, unknown>;
  const profileId = normalizeNullableString(registration['profileId']);
  const registrationId = normalizeNullableString(registration['registrationId']);
  if (
    !profileId ||
    !registrationId ||
    !knownProfiles.has(profileId) ||
    seenProfiles.has(profileId) ||
    seenRegistrations.has(registrationId)
  ) {
    return null;
  }
  seenProfiles.add(profileId);
  seenRegistrations.add(registrationId);
  return { profileId, registrationId, token: normalizeNullableString(registration['token']) };
}

export function updatePushRegistration(
  state: AppStateData,
  profileId: string,
  registrationId: string,
  token: string,
): AppStateData {
  const normalizedToken = normalizeRequiredString(token, 'token');
  const existing = state.push.registrations.find(
    (registration) => registration.profileId === profileId,
  );
  if (!existing || existing.registrationId !== registrationId) {
    return state;
  }
  return {
    ...state,
    push: {
      ...state.push,
      registrations: state.push.registrations.map((registration) =>
        registration.profileId === profileId
          ? { ...registration, token: normalizedToken }
          : registration,
      ),
    },
  };
}

export function normalizeRequiredString(value: unknown, name: string): string {
  const normalized = normalizeNullableString(value);
  if (!normalized) {
    throw new Error(`${name} must not be empty.`);
  }
  return normalized;
}

export function normalizeAppSettings(value: unknown): AppSettingsState {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const parsed = parseAppSettings(
    JSON.stringify({
      version: APP_SETTINGS_VERSION,
      defaultStartCwd: record['defaultStartCwd'],
      preferredAgentId: record['preferredAgentId'],
      agentSettings: record['agentSettings'],
      approvalMode: record['approvalMode'],
      showToolCalls: record['showToolCalls'],
      confirmSessionDeletion: record['confirmSessionDeletion'],
      workspaceChatLimit: record['workspaceChatLimit'],
      recentBrowserTargetUrls: record['recentBrowserTargetUrls'],
    }),
  );
  return {
    defaultStartCwd: parsed.defaultStartCwd,
    preferredAgentId: parsed.preferredAgentId,
    agentSettings: parsed.agentSettings,
    approvalMode: parsed.approvalMode,
    showToolCalls: parsed.showToolCalls,
    confirmSessionDeletion: parsed.confirmSessionDeletion,
    workspaceChatLimit: parsed.workspaceChatLimit,
    recentBrowserTargetUrls: dedupeRecentPreviewTargets(
      parsed.recentBrowserTargetUrls
        .map(normalizePreviewTargetInput)
        .filter((target): target is string => target !== null),
    ),
  };
}

export function normalizeNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function normalizeCollaborationMode(value: CollaborationMode): CollaborationMode {
  return value === 'plan' ? value : 'default';
}

export function persistenceError(
  code: AppStatePersistenceErrorCode,
  operation: AppStatePersistenceOperation,
  message: string,
  cause: unknown,
): AppStatePersistenceError {
  return cause instanceof AppStatePersistenceError
    ? cause
    : new AppStatePersistenceError(code, operation, message, cause);
}
