import { useAtomValue, useSetAtom } from 'jotai';
import { createContext, Fragment, useContext, useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { switchBridgeProfileAtom } from '@shell/state/bridge/actions';
import {
  activeProfileIdAtom,
  bridgeProfileTransitioningAtom,
  shellProfilesAtom,
  wsClientAtom,
} from '@shell/state/bridge/atoms';
import { isLocalProfileId } from '@shell/state/localProfile';
import { useAppTheme } from '@shared/theme';
import { RouteErrorScreen } from '@shell/navigation/RouteErrorScreen';
import { dismissAllPresentedRoutes } from '@shell/navigation/routeNavigation';

interface ProfileRouteBoundaryProps {
  profileId: string;
  children: ReactNode;
}

const ProfileRouteReadyContext = createContext(false);

export function useProfileRouteReady(): boolean {
  return useContext(ProfileRouteReadyContext);
}

export function ProfileRouteContent({ children }: { children: ReactNode }) {
  return useProfileRouteReady() ? <Fragment>{children}</Fragment> : null;
}

export function ProfileRouteBoundary({ profileId, children }: ProfileRouteBoundaryProps) {
  const theme = useAppTheme();
  const profiles = useAtomValue(shellProfilesAtom);
  const ws = useAtomValue(wsClientAtom);
  const activeProfileId = useAtomValue(activeProfileIdAtom);
  const profileTransitioning = useAtomValue(bridgeProfileTransitioningAtom);
  const switchProfile = useSetAtom(switchBridgeProfileAtom);
  const [activationError, setActivationError] = useState<string | null>(null);
  const profileExists = profiles.some((profile) => profile.id === profileId);

  useEffect(() => {
    if (!profileExists || activeProfileId === profileId) {
      return;
    }
    let cancelled = false;
    setActivationError(null);
    dismissAllPresentedRoutes();
    void switchProfile(profileId).catch((error: unknown) => {
      if (!cancelled) {
        setActivationError(
          error instanceof Error ? error.message : 'The bridge profile could not be activated.',
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeProfileId, profileExists, profileId, switchProfile]);

  const local = isLocalProfileId(profileId);
  if (!profileExists) {
    return local ? (
      <RouteErrorScreen
        title="On this iPhone is unavailable"
        message="Local models need the DapperCode iPhone app. Your desktop profiles are unchanged."
      />
    ) : (
      <RouteErrorScreen
        title="Bridge profile not found"
        message="This link points to a bridge profile that is no longer saved on this device."
      />
    );
  }

  if (activationError) {
    return (
      <RouteErrorScreen
        title="Could not open bridge profile"
        message={activationError}
        actionLabel="Choose another profile"
      />
    );
  }

  // The local profile's transport only exists once its runtime host has started the runtime.
  const activating =
    activeProfileId !== profileId || profileTransitioning || (local && ws === null);
  return (
    <ProfileRouteReadyContext.Provider value={!activating}>
      <View style={styles.root}>
        <View
          style={styles.root}
          pointerEvents={activating ? 'none' : 'auto'}
          accessibilityElementsHidden={activating}
          importantForAccessibility={activating ? 'no-hide-descendants' : 'auto'}
        >
          {children}
        </View>
        {activating ? (
          <View
            style={[styles.loading, { backgroundColor: theme.colors.bgMain }]}
            accessibilityRole="progressbar"
            accessibilityLabel={local ? 'Opening On this iPhone' : 'Opening bridge profile'}
          >
            <ActivityIndicator color={theme.colors.textPrimary} />
          </View>
        ) : null}
      </View>
    </ProfileRouteReadyContext.Provider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  loading: {
    ...StyleSheet.absoluteFill,
    zIndex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
