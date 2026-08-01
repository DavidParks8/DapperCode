import {
  createEmptyBridgeProfileStore,
  parseBridgeProfileStore,
  removeBridgeProfile,
  renameBridgeProfile,
  setActiveBridgeProfile,
  upsertBridgeProfile,
} from '../bridgeProfiles';
import { normalizeBridgeUrlInput } from '../bridgeUrl';
import {
  APP_STATE_VERSION,
  type AppStateAction,
  type AppStateData,
  AppStatePersistenceError,
  type LegacyAppStateSource,
  createDefaultPushSettings,
  normalizeAppSettings,
  normalizeAppStateData,
  normalizeCollaborationMode,
  normalizeNullableString,
  normalizePushSettings,
  normalizeRequiredString,
  persistenceError,
  updatePushRegistration,
} from './model';
import { parseAppSettings } from '../appSettings';

export function appStateReducer(state: AppStateData, action: AppStateAction): AppStateData {
  switch (action.type) {
    case 'settings/update':
      return {
        ...state,
        settings: normalizeAppSettings({ ...state.settings, ...action.patch }),
      };
    case 'settings/remember-thread': {
      const agentId = normalizeNullableString(action.agentId);
      if (!agentId) return state;
      return {
        ...state,
        settings: {
          ...state.settings,
          preferredAgentId: agentId,
          agentSettings: {
            ...state.settings.agentSettings,
            [agentId]: {
              collaborationMode: normalizeCollaborationMode(action.collaborationMode),
            },
          },
        },
      };
    }
    case 'profiles/save': {
      const existing = action.draft.id
        ? state.bridgeProfiles.profiles.find((profile) => profile.id === action.draft.id)
        : null;
      const bridgeIdentityChanged = Boolean(
        existing &&
        (existing.transportMode !== (action.draft.transportMode ?? 'privateBearer') ||
          existing.bridgeUrl !== normalizeBridgeUrlInput(action.draft.bridgeUrl) ||
          existing.bridgeToken !== (action.draft.bridgeToken?.trim() || null)),
      );
      return {
        ...state,
        bridgeProfiles: upsertBridgeProfile(state.bridgeProfiles, action.draft).store,
        push: bridgeIdentityChanged
          ? {
              ...state.push,
              registrations: state.push.registrations.filter(
                (registration) => registration.profileId !== existing?.id,
              ),
            }
          : state.push,
      };
    }
    case 'profiles/switch': {
      if (!state.bridgeProfiles.profiles.some((profile) => profile.id === action.profileId)) {
        throw new Error('The selected bridge profile no longer exists.');
      }
      return {
        ...state,
        bridgeProfiles: setActiveBridgeProfile(state.bridgeProfiles, action.profileId),
      };
    }
    case 'profiles/rename':
      return {
        ...state,
        bridgeProfiles: renameBridgeProfile(state.bridgeProfiles, action.profileId, action.name),
      };
    case 'profiles/remove':
      return {
        ...state,
        bridgeProfiles: removeBridgeProfile(state.bridgeProfiles, action.profileId),
        push: {
          ...state.push,
          registrations: state.push.registrations.filter(
            (registration) => registration.profileId !== action.profileId,
          ),
        },
      };
    case 'profiles/clear':
      return {
        ...state,
        bridgeProfiles: createEmptyBridgeProfileStore(),
        push: { ...state.push, registrations: [] },
      };
    case 'push/update':
      return {
        ...state,
        push: normalizePushSettings({ ...state.push, ...action.patch }, state.bridgeProfiles),
      };
    case 'push/ensure-registration': {
      if (!state.bridgeProfiles.profiles.some((profile) => profile.id === action.profileId)) {
        return state;
      }
      const existing = state.push.registrations.find(
        (registration) => registration.profileId === action.profileId,
      );
      if (existing) {
        return state;
      }
      return {
        ...state,
        push: {
          ...state.push,
          registrations: [
            ...state.push.registrations,
            {
              profileId: action.profileId,
              registrationId: normalizeRequiredString(action.registrationId, 'registrationId'),
              token: null,
            },
          ],
        },
      };
    }
    case 'push/registered':
      return updatePushRegistration(state, action.profileId, action.registrationId, action.token);
    case 'push/unregistered':
      return {
        ...state,
        push: {
          ...state.push,
          registrations: state.push.registrations.filter(
            (registration) =>
              registration.profileId !== action.profileId ||
              registration.registrationId !== action.registrationId,
          ),
        },
      };
  }
}

export function serializeAppState(data: AppStateData): string {
  const normalized = normalizeAppStateData(data);
  return JSON.stringify({
    version: APP_STATE_VERSION,
    settings: normalized.settings,
    bridgeProfiles: normalized.bridgeProfiles,
    push: normalized.push,
  });
}

export function parsePersistedAppState(raw: string): AppStateData {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== APP_STATE_VERSION)
    ) {
      throw new Error(`Unsupported app-state version: ${String(parsed?.version)}`);
    }
    return normalizeAppStateData({
      settings: normalizeAppSettings(parsed.settings),
      bridgeProfiles: parseBridgeProfileStore(JSON.stringify(parsed.bridgeProfiles ?? {})),
      push: parsed.push,
    });
  } catch (error) {
    if (error instanceof AppStatePersistenceError) {
      throw error;
    }
    throw new AppStatePersistenceError(
      'invalid_data',
      'load',
      'Saved app state is invalid and was not overwritten.',
      error,
    );
  }
}

export function importLegacyAppState(source: LegacyAppStateSource): AppStateData {
  const parsedSettings = parseAppSettings(source.settingsRaw ?? '');
  let bridgeProfiles = parseBridgeProfileStore(source.bridgeProfilesRaw);
  if (
    bridgeProfiles.profiles.length === 0 &&
    parsedSettings.bridgeUrl &&
    parsedSettings.bridgeToken
  ) {
    bridgeProfiles = upsertBridgeProfile(bridgeProfiles, {
      name: null,
      bridgeUrl: parsedSettings.bridgeUrl,
      bridgeToken: parsedSettings.bridgeToken,
      activate: true,
    }).store;
  }

  return {
    settings: normalizeAppSettings(parsedSettings),
    bridgeProfiles,
    push: createDefaultPushSettings(),
  };
}

export { persistenceError };
