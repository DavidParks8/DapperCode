import 'react-native-gesture-handler';

import { useFonts } from 'expo-font';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useColorScheme, useWindowDimensions } from 'react-native';
import { Easing, LinearTransition } from 'react-native-reanimated';

import { HostBridgeApiClient } from '../api/client';
import { type ChatSnapshotCache } from '../chatSnapshotCache';
import type { Chat } from '../api/types';
import { HostBridgeWsClient } from '../api/ws';
import { createAppStateStore } from '../appState';
import { createAppStatePersistence } from '../appStatePersistence';
import { env } from '../config';
import { APP_FONT_ASSETS, DEFAULT_FONT_PREFERENCE } from '../fonts';
import { getActiveBridgeProfile } from '../bridgeProfiles';
import { type BrowserScreenHandle } from '../screens/BrowserScreen';
import { type MainScreenHandle } from '../screens/MainScreen';
import { type OnboardingMode } from '../screens/OnboardingScreen';
import { createAppTheme, resolveThemeMode } from '../theme';
import { CHAT_TRANSITION_MIN_MS, TABLET_LAYOUT_MIN_WIDTH, TABLET_SIDEBAR_ANIMATION_MS, type AppScreen, type Screen } from './appConstants';
import { getDrawerWidth } from './appDrawerUtils';
import { createStyles } from './appStyles';
import { LoadingShell, OnboardingShell, PersistenceRecoveryShell } from './AppShells';
import { AppMainLayout } from './AppMainLayout';
import { useAppBridgeLifecycle } from './useAppBridgeLifecycle';
import { useAppNavigationActions } from './useAppNavigationActions';
import { useAppProfileActions } from './useAppProfileActions';
import { useAppStoreReview } from './useAppStoreReview';
import { useDrawerController } from './useDrawerController';
import { usePushNotificationsLifecycle } from './usePushNotificationsLifecycle';
import type { PushResponseController } from '../pushResponseController';

export function AppRoot() {
  const systemColorScheme = useColorScheme();
  const appStateStore = useMemo(() => createAppStateStore(createAppStatePersistence()), []);
  const appStateSnapshot = useSyncExternalStore(
    appStateStore.subscribe,
    appStateStore.getSnapshot,
    appStateStore.getSnapshot
  );

  const settingsLoaded = appStateSnapshot.loaded;
  const {
    settings: {
      defaultStartCwd,
      preferredAgentId,
      agentSettings,
      approvalMode,
      showToolCalls,
      workspaceChatLimit,
      appearancePreference,
      darkUiPalette,
      fontPreference,
      recentBrowserTargetUrls,
    },
    bridgeProfiles: currentBridgeProfileStore,
    push: pushSettings,
  } = appStateSnapshot.data;

  const { activeProfileId: activeBridgeProfileId, profiles: bridgeProfiles } = currentBridgeProfileStore;
  const [onboardingMode, setOnboardingMode] = useState<OnboardingMode>('initial');
  const [onboardingReturnScreen, setOnboardingReturnScreen] = useState<AppScreen>('Settings');
  const [currentScreen, setCurrentScreen] = useState<Screen>('Main');
  const [browserReturnScreen, setBrowserReturnScreen] = useState<AppScreen>('Main');
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const [gitChat, setGitChat] = useState<Chat | null>(null);
  const [chatTransitionChatId, setChatTransitionChatId] = useState<string | null>(null);
  const [mainOpeningChatId, setMainOpeningChatId] = useState<string | null>(null);
  const [pendingMainChatId, setPendingMainChatId] = useState<string | null>(null);
  const [pendingMainChatSnapshot, setPendingMainChatSnapshot] = useState<Chat | null>(null);
  const [chatSnapshotCache, setChatSnapshotCache] = useState<ChatSnapshotCache | null>(null);
  const [settingsAllowsDrawerGesture, setSettingsAllowsDrawerGesture] = useState(true);
  const [pendingBrowserTargetUrl, setPendingBrowserTargetUrl] = useState<string | null>(null);
  const [, setBridgeConnected] = useState(false);
  const [fontsLoaded, fontsError] = useFonts(APP_FONT_ASSETS);

  const mainRef = useRef<MainScreenHandle>(null);
  const browserRef = useRef<BrowserScreenHandle>(null);
  const pushResponseControllerRef = useRef<PushResponseController | null>(null);
  const chatTransitionRequestIdRef = useRef(0);
  const chatSnapshotPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backSwipeHandlerRef = useRef<() => void>(() => undefined);

  const activeBridgeProfile = useMemo(
    () => getActiveBridgeProfile({ activeProfileId: activeBridgeProfileId, profiles: bridgeProfiles }),
    [activeBridgeProfileId, bridgeProfiles]
  );
  const bridgeUrl = activeBridgeProfile?.bridgeUrl ?? null;
  const bridgeToken = activeBridgeProfile?.bridgeToken ?? null;

  const ws = useMemo(
    () =>
      bridgeUrl
        ? new HostBridgeWsClient(bridgeUrl, {
            authToken: bridgeToken ?? env.hostBridgeToken,
            allowQueryTokenAuth: env.allowWsQueryTokenAuth,
          })
        : null,
    [bridgeToken, bridgeUrl]
  );
  const api = useMemo(
    () =>
      ws
        ? new HostBridgeApiClient({
            ws,
            bridgeUrl: bridgeUrl ?? undefined,
            authToken: bridgeToken ?? env.hostBridgeToken,
          })
        : null,
    [bridgeToken, bridgeUrl, ws]
  );

  const { width: screenWidth } = useWindowDimensions();
  const usesTabletLayout = screenWidth >= TABLET_LAYOUT_MIN_WIDTH;
  const themeFontPreference = fontsLoaded ? fontPreference : DEFAULT_FONT_PREFERENCE;
  const resolvedThemeMode = resolveThemeMode(appearancePreference, systemColorScheme);
  const theme = useMemo(
    () => createAppTheme(resolvedThemeMode, themeFontPreference, resolvedThemeMode === 'dark' ? darkUiPalette : 'classic'),
    [darkUiPalette, resolvedThemeMode, themeFontPreference]
  );
  const styles = useMemo(() => createStyles(theme), [theme]);
  const drawerWidth = useMemo(() => getDrawerWidth(screenWidth), [screenWidth]);
  const tabletLayoutTransition = useMemo(
    () => LinearTransition.duration(TABLET_SIDEBAR_ANIMATION_MS).easing(Easing.out(Easing.cubic)),
    []
  );

  const openChatWithTransition = useMemo(
    () => async (id: string, snapshot?: Chat | null, options?: { immediate?: boolean }) => {
      const requestId = chatTransitionRequestIdRef.current + 1;
      chatTransitionRequestIdRef.current = requestId;
      const startedAt = Date.now();
      const nextSnapshot = snapshot && snapshot.id === id ? snapshot : api?.peekChatShell(id) ?? null;
      const hasHydratedSnapshot = Boolean(nextSnapshot && nextSnapshot.messages.length > 0);
      const shouldShowTransition = !hasHydratedSnapshot && !options?.immediate;

      setChatTransitionChatId(shouldShowTransition ? id : null);
      setMainOpeningChatId(hasHydratedSnapshot ? null : id);

      const remainingMs = shouldShowTransition ? Math.max(0, CHAT_TRANSITION_MIN_MS - (Date.now() - startedAt)) : 0;
      if (remainingMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, remainingMs));
      }
      if (chatTransitionRequestIdRef.current !== requestId) {
        return;
      }

      setSelectedChatId(id);
      setActiveChat(nextSnapshot);
      setGitChat(null);
      setCurrentScreen('Main');
      setPendingMainChatId(id);
      setPendingMainChatSnapshot(hasHydratedSnapshot ? nextSnapshot : null);
      setChatTransitionChatId(null);
      if (hasHydratedSnapshot) {
        setMainOpeningChatId(null);
      }
    },
    [api]
  );

  const handleBackSwipe = useCallback(() => {
    backSwipeHandlerRef.current();
  }, []);

  const drawer = useDrawerController({
    currentScreen,
    usesTabletLayout,
    drawerWidth,
    settingsAllowsDrawerGesture,
    onBackSwipe: handleBackSwipe,
  });

  const profileActions = useAppProfileActions({
    appStateStore,
    activeBridgeProfile,
    activeBridgeProfileId,
    currentBridgeProfileStore,
    bridgeProfiles,
    bridgeUrl,
    currentScreen,
    onboardingMode,
    onboardingReturnScreen,
    setCurrentScreen,
    setOnboardingMode,
    setOnboardingReturnScreen,
    setSelectedChatId,
    setActiveChat,
    setGitChat,
    setChatTransitionChatId,
    setMainOpeningChatId,
    setPendingMainChatId,
    setPendingMainChatSnapshot,
    setChatSnapshotCache,
    closeDrawer: drawer.closeDrawer,
  });

  const navActions = useAppNavigationActions({
    appStateStore,
    currentScreen,
    onboardingMode,
    activeBridgeProfile,
    browserReturnScreen,
    mainOpeningChatId,
    activeChat,
    gitChat,
    selectedChatId,
    browserRef,
    mainRef,
    chatTransitionRequestIdRef,
    drawerOpenRef: drawer.drawerOpenRef,
    drawerVisibleRef: drawer.drawerVisibleRef,
    setCurrentScreen,
    setBrowserReturnScreen,
    setPendingBrowserTargetUrl,
    setChatTransitionChatId,
    setMainOpeningChatId,
    setPendingMainChatId,
    setPendingMainChatSnapshot,
    setSelectedChatId,
    setActiveChat,
    setGitChat,
    setSettingsAllowsDrawerGesture,
    closeDrawer: drawer.closeDrawer,
    openChatWithTransition,
    handleCancelOnboarding: profileActions.handleCancelOnboarding,
  });

  const { handleHardwareBackPress } = navActions;
  useEffect(() => {
    backSwipeHandlerRef.current = handleHardwareBackPress;
  }, [handleHardwareBackPress]);

  usePushNotificationsLifecycle({
    activeBridgeProfileId,
    registrations: pushSettings.registrations,
    api,
    ws,
    pushResponseControllerRef,
    setCurrentScreen,
    setPendingMainChatId,
    setPendingMainChatSnapshot,
  });

  useAppBridgeLifecycle({
    ws,
    api,
    appStateStore,
    settingsLoaded,
    currentScreen,
    activeBridgeProfileId,
    activeBridgeProfile,
    setBridgeConnected,
    setChatSnapshotCache,
    setSelectedChatId,
    setActiveChat,
    setPendingMainChatId,
    setPendingMainChatSnapshot,
    selectedChatId,
    activeChat,
    chatSnapshotCache,
    chatSnapshotPersistTimerRef,
  });

  useAppStoreReview({ settingsLoaded, currentScreen });

  if (!settingsLoaded || (!fontsLoaded && !fontsError)) {
    return <LoadingShell theme={theme} styles={styles} />;
  }

  if (appStateSnapshot.persistenceError && appStateSnapshot.persistenceError.operation !== 'write') {
    return (
      <PersistenceRecoveryShell
        theme={theme}
        styles={styles}
        appStateSnapshot={appStateSnapshot}
        appStateStore={appStateStore}
      />
    );
  }

  if (!bridgeUrl || !api || !ws || currentScreen === 'Onboarding') {
    const mode: OnboardingMode = bridgeUrl ? onboardingMode : 'initial';
    return (
      <OnboardingShell
        theme={theme}
        styles={styles}
        bridgeUrl={bridgeUrl}
        activeBridgeProfile={
          activeBridgeProfile
            ? {
                id: activeBridgeProfile.id,
                bridgeUrl: activeBridgeProfile.bridgeUrl,
                bridgeToken: activeBridgeProfile.bridgeToken,
              }
            : null
        }
        onboardingMode={mode}
        onSave={profileActions.handleBridgeProfileSaved}
        onCancel={mode !== 'initial' && activeBridgeProfile ? profileActions.handleCancelOnboarding : undefined}
      />
    );
  }

  return (
    <AppMainLayout
      theme={theme}
      styles={styles}
      usesTabletLayout={usesTabletLayout}
      tabletLayoutTransition={tabletLayoutTransition}
      screenWidth={screenWidth}
      drawerWidth={drawerWidth}
      currentScreen={currentScreen}
      activeBridgeProfile={activeBridgeProfile}
      selectedChatId={selectedChatId}
      gitChat={gitChat}
      pendingMainChatId={pendingMainChatId}
      pendingMainChatSnapshot={pendingMainChatSnapshot}
      pendingBrowserTargetUrl={pendingBrowserTargetUrl}
      browserReturnScreen={browserReturnScreen}
      approvalMode={approvalMode}
      showToolCalls={showToolCalls}
      workspaceChatLimit={workspaceChatLimit}
      defaultStartCwd={defaultStartCwd}
      preferredAgentId={preferredAgentId}
      agentSettings={agentSettings}
      appearancePreference={appearancePreference}
      darkUiPalette={darkUiPalette}
      fontPreference={fontPreference}
      recentBrowserTargetUrls={recentBrowserTargetUrls}
      appStateStore={appStateStore}
      appStateSnapshot={appStateSnapshot}
      pushSettings={pushSettings}
      bridgeProfiles={bridgeProfiles}
      api={api}
      ws={ws}
      browserRef={browserRef}
      mainRef={mainRef}
      chatTransitionChatId={chatTransitionChatId}
      mainOpeningChatId={mainOpeningChatId}
      setMainOpeningChatId={setMainOpeningChatId}
      setPendingMainChatId={setPendingMainChatId}
      setPendingMainChatSnapshot={setPendingMainChatSnapshot}
      setPendingBrowserTargetUrl={setPendingBrowserTargetUrl}
      setSettingsAllowsDrawerGesture={setSettingsAllowsDrawerGesture}
      drawer={drawer}
      navActions={navActions}
      profileActions={profileActions}
    />
  );
}
