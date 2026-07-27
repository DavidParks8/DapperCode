import { normalizeBridgeUrlInput } from './bridgeUrl';

export const BRIDGE_TRANSPORT_MODES = ['privateBearer', 'tailnetPinnedTls'] as const;
export type BridgeTransportMode = (typeof BRIDGE_TRANSPORT_MODES)[number];

export interface BridgeProfile {
  id: string;
  name: string;
  transportMode: BridgeTransportMode;
  bridgeUrl: string;
  bridgeToken: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BridgeProfileStore {
  activeProfileId: string | null;
  profiles: BridgeProfile[];
}

export interface BridgeProfileDraft {
  id?: string | null;
  name?: string | null;
  transportMode?: BridgeTransportMode;
  bridgeUrl: string;
  bridgeToken: string | null;
  activate?: boolean;
}

export function createEmptyBridgeProfileStore(): BridgeProfileStore {
  return {
    activeProfileId: null,
    profiles: [],
  };
}

export function parseBridgeProfileStore(raw: string | null | undefined): BridgeProfileStore {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return createEmptyBridgeProfileStore();
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return createEmptyBridgeProfileStore();
    }

    const record = parsed as {
      activeProfileId?: unknown;
      profiles?: unknown;
    };
    const profiles = Array.isArray(record.profiles)
      ? record.profiles
          .map((entry) => normalizeBridgeProfile(entry))
          .filter((entry): entry is BridgeProfile => entry !== null)
      : [];
    const activeProfileId =
      typeof record.activeProfileId === 'string' &&
      profiles.some((profile) => profile.id === record.activeProfileId)
        ? record.activeProfileId
        : null;

    return {
      activeProfileId,
      profiles,
    };
  } catch {
    return createEmptyBridgeProfileStore();
  }
}

export function upsertBridgeProfile(
  store: BridgeProfileStore,
  draft: BridgeProfileDraft,
): { profile: BridgeProfile; store: BridgeProfileStore } {
  const normalizedUrl = normalizeBridgeUrlInput(draft.bridgeUrl);
  const normalizedToken = normalizeBridgeToken(draft.bridgeToken);
  const existing = draft.id
    ? (store.profiles.find((profile) => profile.id === draft.id) ?? null)
    : null;
  const transportMode = draft.transportMode ?? existing?.transportMode ?? 'privateBearer';
  if (!normalizedUrl) {
    throw new Error('Bridge URL is required.');
  }
  if (transportMode === 'tailnetPinnedTls') {
    throw new Error(
      'tailnetPinnedTls profiles cannot be created until pinned TLS device pairing is available.',
    );
  }
  if (!normalizedToken) {
    throw new Error('Bridge URL and token are required.');
  }

  const now = new Date().toISOString();
  const profileId = existing?.id ?? createBridgeProfileId();
  const resolvedName = deriveBridgeProfileName(draft.name, normalizedUrl);
  const nextProfile: BridgeProfile = {
    id: profileId,
    name: resolvedName,
    transportMode,
    bridgeUrl: normalizedUrl,
    bridgeToken: normalizedToken,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const nextProfiles = [...store.profiles];
  const existingIndex = nextProfiles.findIndex((profile) => profile.id === profileId);
  if (existingIndex >= 0) {
    nextProfiles[existingIndex] = nextProfile;
  } else {
    nextProfiles.push(nextProfile);
  }

  const nextStore = sanitizeBridgeProfileStore({
    activeProfileId: draft.activate === false ? store.activeProfileId : profileId,
    profiles: nextProfiles,
  });

  return {
    profile: nextProfile,
    store: nextStore,
  };
}

export function setActiveBridgeProfile(
  store: BridgeProfileStore,
  profileId: string | null,
): BridgeProfileStore {
  if (profileId === null) {
    return {
      ...store,
      activeProfileId: null,
    };
  }

  if (!store.profiles.some((profile) => profile.id === profileId)) {
    return sanitizeBridgeProfileStore(store);
  }

  return {
    ...store,
    activeProfileId: profileId,
  };
}

export function renameBridgeProfile(
  store: BridgeProfileStore,
  profileId: string,
  nextName: string | null | undefined,
): BridgeProfileStore {
  const existing = store.profiles.find((profile) => profile.id === profileId);
  if (!existing) {
    return sanitizeBridgeProfileStore(store);
  }

  const updatedAt = new Date().toISOString();
  return sanitizeBridgeProfileStore({
    ...store,
    profiles: store.profiles.map((profile) =>
      profile.id === profileId
        ? {
            ...profile,
            name: deriveBridgeProfileName(nextName, profile.bridgeUrl),
            updatedAt,
          }
        : profile,
    ),
  });
}

export function removeBridgeProfile(
  store: BridgeProfileStore,
  profileId: string,
): BridgeProfileStore {
  const nextProfiles = store.profiles.filter((profile) => profile.id !== profileId);
  const nextActiveProfileId =
    store.activeProfileId === profileId ? (nextProfiles[0]?.id ?? null) : store.activeProfileId;

  return sanitizeBridgeProfileStore({
    activeProfileId: nextActiveProfileId,
    profiles: nextProfiles,
  });
}

export function getActiveBridgeProfile(store: BridgeProfileStore): BridgeProfile | null {
  if (!store.activeProfileId) {
    return null;
  }

  return store.profiles.find((profile) => profile.id === store.activeProfileId) ?? null;
}

export function isBridgeProfileUsable(
  profile: BridgeProfile,
  platform: 'native' | 'web',
  fallbackToken?: string | null,
  fallbackBridgeUrl?: string | null,
): boolean {
  if (profile.transportMode === 'tailnetPinnedTls') {
    return false;
  }
  if (platform !== 'native' && platform !== 'web') {
    return false;
  }
  if (normalizeBridgeToken(profile.bridgeToken) !== null) {
    return true;
  }
  return (
    normalizeBridgeToken(fallbackToken) !== null &&
    normalizeBridgeUrlInput(fallbackBridgeUrl ?? '') === profile.bridgeUrl
  );
}

export function getActiveUsableBridgeProfile(
  store: BridgeProfileStore,
  platform: 'native' | 'web',
  fallbackToken?: string | null,
  fallbackBridgeUrl?: string | null,
): BridgeProfile | null {
  const profile = getActiveBridgeProfile(store);
  return profile && isBridgeProfileUsable(profile, platform, fallbackToken, fallbackBridgeUrl)
    ? profile
    : null;
}

export function deriveBridgeProfileName(
  value: string | null | undefined,
  bridgeUrl: string,
): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length > 0) {
    return trimmed;
  }

  try {
    const parsed = new URL(bridgeUrl);
    const host = parsed.hostname.trim();
    return host.length > 0 ? host : 'Bridge';
  } catch {
    return 'Bridge';
  }
}

function sanitizeBridgeProfileStore(store: BridgeProfileStore): BridgeProfileStore {
  const profiles = Array.isArray(store.profiles)
    ? store.profiles
        .map((entry) => normalizeBridgeProfile(entry))
        .filter((entry): entry is BridgeProfile => entry !== null)
    : [];
  const activeProfileId =
    typeof store.activeProfileId === 'string' &&
    profiles.some((profile) => profile.id === store.activeProfileId)
      ? store.activeProfileId
      : null;

  return {
    activeProfileId,
    profiles,
  };
}

function normalizeBridgeProfile(value: unknown): BridgeProfile | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as {
    id?: unknown;
    name?: unknown;
    transportMode?: unknown;
    bridgeUrl?: unknown;
    bridgeToken?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
  };
  const id = normalizeNonEmptyString(record.id);
  const transportMode = normalizeBridgeTransportMode(record.transportMode);
  const bridgeUrl =
    typeof record.bridgeUrl === 'string' ? normalizeBridgeUrlInput(record.bridgeUrl) : null;
  const bridgeToken = normalizeBridgeToken(record.bridgeToken);
  if (
    !id ||
    !transportMode ||
    !bridgeUrl ||
    (transportMode === 'tailnetPinnedTls' &&
      (!bridgeUrl.startsWith('https://') || bridgeToken !== null))
  ) {
    return null;
  }

  return {
    id,
    name: deriveBridgeProfileName(normalizeNonEmptyString(record.name), bridgeUrl),
    transportMode,
    bridgeUrl,
    bridgeToken,
    createdAt: normalizeTimestamp(record.createdAt),
    updatedAt: normalizeTimestamp(record.updatedAt),
  };
}

function normalizeBridgeTransportMode(value: unknown): BridgeTransportMode | null {
  if (value === undefined) {
    return 'privateBearer';
  }
  return typeof value === 'string' && BRIDGE_TRANSPORT_MODES.includes(value as BridgeTransportMode)
    ? (value as BridgeTransportMode)
    : null;
}

function normalizeBridgeToken(value: unknown): string | null {
  const normalized = normalizeNonEmptyString(value);
  return normalized && normalized.length > 0 ? normalized : null;
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeTimestamp(value: unknown): string {
  const normalized = normalizeNonEmptyString(value);
  return normalized ?? new Date().toISOString();
}

function createBridgeProfileId(): string {
  return `bridge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
