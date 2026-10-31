import type { Ionicons } from '@expo/vector-icons';

import { isLocalProfile, LOCAL_PROFILE_NAME, type ShellProfile } from '@shell/state/localProfile';
import type { LocalSetupState } from './localSetup';

export interface ProfilePresentation {
  icon: keyof typeof Ionicons.glyphMap;
  /** Where the profile's agents run, such as a bridge host or "Private offline models". */
  detail: string;
  /** Live state when it is known: connection for the open bridge, setup for the local profile. */
  status: string | null;
}

export interface ProfilePresentationContext {
  active: boolean;
  bridgeConnected: boolean;
  /** Setup progress of the open local runtime, or null when it is not running. */
  localSetup: LocalSetupState | null;
}

/** The host and port a bridge URL points at, without scheme, credentials, or path. */
export function bridgeHost(bridgeUrl: string): string {
  const withoutScheme = bridgeUrl.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const authority = withoutScheme.split(/[/?#]/)[0] ?? '';
  return authority.slice(authority.lastIndexOf('@') + 1) || bridgeUrl.trim();
}

/**
 * The single place that knows how each kind of profile is presented, so the drawer, new chat,
 * onboarding, and Settings describe profiles the same way.
 */
export function describeProfile(
  profile: ShellProfile,
  context: ProfilePresentationContext,
): ProfilePresentation {
  if (isLocalProfile(profile)) {
    return {
      icon: 'phone-portrait-outline',
      detail: 'Private offline models',
      status: context.active ? (context.localSetup?.summary ?? null) : null,
    };
  }
  return {
    icon: 'desktop-outline',
    detail: bridgeHost(profile.bridgeUrl),
    status: context.active ? (context.bridgeConnected ? 'Connected' : 'Disconnected') : null,
  };
}

/** One line for lists: the live status when known, then where the agents run. */
export function profileSummary(presentation: ProfilePresentation): string {
  return [presentation.status, presentation.detail].filter(Boolean).join(' · ');
}

export function installedAgentsFooter(profile: ShellProfile | null): string {
  return isLocalProfile(profile)
    ? 'The built-in agent runs models downloaded to this iPhone.'
    : 'Agents are installed and registered on the desktop host.';
}

export function profilesFooter(profiles: readonly ShellProfile[]): string {
  return profiles.some(isLocalProfile)
    ? `Switching profiles opens a new chat there. ${LOCAL_PROFILE_NAME} runs private models offline; a bridge runs the agents installed on your computer.`
    : 'Switching profiles opens a new chat there.';
}
