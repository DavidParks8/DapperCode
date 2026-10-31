import { useAtomValue, useSetAtom } from 'jotai';
import { useMemo } from 'react';

import type { SelectionSheetOption } from '@shared/ui/SelectionSheet';
import {
  activeProfileAtom,
  bridgeConnectedAtom,
  localProfileAvailableAtom,
  shellProfilesAtom,
} from '@shell/state/bridge/atoms';
import type { ShellProfile } from '@shell/state/localProfile';
import { addBridgeProfileAtom, openProfileAtom } from './actions';
import { useLocalSetup } from './localSetup';
import { describeProfile, profileSummary, type ProfilePresentation } from './profilePresentation';

export interface ProfileChoices {
  active: ShellProfile | null;
  activePresentation: ProfilePresentation | null;
  /** Whether there is a choice to offer: several profiles, or the built-in local one. */
  offerChoice: boolean;
  /** Profiles, then "Add bridge". `onDone` runs before the selected action (closing a sheet). */
  options: (onDone: () => void) => SelectionSheetOption[];
}

/** Every place agents can run, with live state, shared by the drawer and new-chat switchers. */
export function useProfileChoices(): ProfileChoices {
  const profiles = useAtomValue(shellProfilesAtom);
  const active = useAtomValue(activeProfileAtom);
  const bridgeConnected = useAtomValue(bridgeConnectedAtom);
  const localAvailable = useAtomValue(localProfileAvailableAtom);
  const localSetup = useLocalSetup();
  const openProfile = useSetAtom(openProfileAtom);
  const addBridge = useSetAtom(addBridgeProfileAtom);

  return useMemo(() => {
    const present = (profile: ShellProfile) =>
      describeProfile(profile, {
        active: profile.id === active?.id,
        bridgeConnected,
        localSetup,
      });
    return {
      active,
      activePresentation: active ? present(active) : null,
      offerChoice: profiles.length > 1 || localAvailable,
      options: (onDone) => [
        ...profiles.map((profile) => {
          const presentation = present(profile);
          return {
            key: profile.id,
            title: profile.name,
            description: profileSummary(presentation),
            icon: presentation.icon,
            selected: profile.id === active?.id,
            onPress: () => {
              onDone();
              openProfile(profile.id);
            },
          };
        }),
        {
          key: 'add-bridge',
          title: 'Add bridge',
          description: 'Pair DapperCode on another computer',
          icon: 'add-circle-outline' as const,
          onPress: () => {
            onDone();
            addBridge();
          },
        },
      ],
    };
  }, [active, addBridge, bridgeConnected, localAvailable, localSetup, openProfile, profiles]);
}
