import type { BridgeProfile } from '@shell/state/bridgeProfiles';

/**
 * Reserved profile id for the built-in "On this iPhone" agent. Bridge profile ids are generated as
 * `bridge-…`, so this id can never collide with a saved bridge profile.
 */
export const LOCAL_PROFILE_ID = 'on-device';
export const LOCAL_PROFILE_NAME = 'On this iPhone';

/** The built-in local agent profile. It has no URL or token and is never persisted as a profile. */
export interface LocalProfile {
  kind: 'local';
  id: typeof LOCAL_PROFILE_ID;
  name: string;
}

export const LOCAL_PROFILE: LocalProfile = {
  kind: 'local',
  id: LOCAL_PROFILE_ID,
  name: LOCAL_PROFILE_NAME,
};

/** Any profile the shell can open: a saved bridge connection or the built-in local agent. */
export type ShellProfile = BridgeProfile | LocalProfile;

export function isLocalProfile(profile: ShellProfile | null | undefined): profile is LocalProfile {
  return Boolean(profile && 'kind' in profile && profile.kind === 'local');
}

export function isBridgeProfile(
  profile: ShellProfile | null | undefined,
): profile is BridgeProfile {
  return Boolean(profile) && !isLocalProfile(profile);
}

export function isLocalProfileId(profileId: string | null | undefined): boolean {
  return profileId === LOCAL_PROFILE_ID;
}

/** Changes whenever a cached resource scoped to the profile's connection must be refetched. */
export function profileIdentityKey(profile: ShellProfile): string {
  return isLocalProfile(profile)
    ? `${profile.id}\u0000local`
    : `${profile.id}\u0000${profile.updatedAt}\u0000${profile.bridgeUrl}`;
}
