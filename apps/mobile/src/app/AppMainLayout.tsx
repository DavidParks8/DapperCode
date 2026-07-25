import { ActivityIndicator, Text, View } from 'react-native';
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';

import type { Chat } from '../api/types';
import type { HostBridgeApiClient } from '../api/client';
import type { HostBridgeWsClient } from '../api/ws';
import type { AppStateSnapshot, AppStateStore } from '../appState';
import type { BridgeProfile } from '../bridgeProfiles';
import { DrawerContent } from '../navigation/DrawerContent';
import type { BrowserScreenHandle } from '../screens/BrowserScreen';
import type { MainScreenHandle } from '../screens/MainScreen';
import { AppThemeProvider, type AppTheme } from '../theme';
import { TABLET_SIDEBAR_WIDTH, type AppScreen, type Screen } from './appConstants';
import { AppScreenRenderer } from './AppScreenRenderer';
import type { AppStyles } from './appStyles';
import type { useDrawerController } from './useDrawerController';

interface AppMainLayoutProps {
  theme: AppTheme;
  styles: AppStyles;
  usesTabletLayout: boolean;
  tabletLayoutTransition: unknown;
  screenWidth: number;
  drawerWidth: number;
  currentScreen: Screen;
  activeBridgeProfile: BridgeProfile | null;
  selectedChatId: string | null;
  gitChat: Chat | null;
  pendingMainChatId: string | null;
  pendingMainChatSnapshot: Chat | null;
  pendingBrowserTargetUrl: string | null;
  browserReturnScreen: AppScreen;
  approvalMode: AppStateSnapshot['data']['settings']['approvalMode'];
  showToolCalls: boolean;
  workspaceChatLimit: AppStateSnapshot['data']['settings']['workspaceChatLimit'];
  defaultStartCwd: string | null;
  preferredAgentId: string | null;
  agentSettings: AppStateSnapshot['data']['settings']['agentSettings'];
  appearancePreference: AppStateSnapshot['data']['settings']['appearancePreference'];
  darkUiPalette: AppStateSnapshot['data']['settings']['darkUiPalette'];
  fontPreference: AppStateSnapshot['data']['settings']['fontPreference'];
  recentBrowserTargetUrls: string[];
  appStateStore: AppStateStore;
  appStateSnapshot: AppStateSnapshot;
  pushSettings: AppStateSnapshot['data']['push'];
  bridgeProfiles: BridgeProfile[];
  api: HostBridgeApiClient;
  ws: HostBridgeWsClient;
  browserRef: React.RefObject<BrowserScreenHandle | null>;
  mainRef: React.RefObject<MainScreenHandle | null>;
  chatTransitionChatId: string | null;
  mainOpeningChatId: string | null;
  setMainOpeningChatId: React.Dispatch<React.SetStateAction<string | null>>;
  setPendingMainChatId: React.Dispatch<React.SetStateAction<string | null>>;
  setPendingMainChatSnapshot: React.Dispatch<React.SetStateAction<Chat | null>>;
  setPendingBrowserTargetUrl: React.Dispatch<React.SetStateAction<string | null>>;
  setSettingsAllowsDrawerGesture: React.Dispatch<React.SetStateAction<boolean>>;
  drawer: ReturnType<typeof useDrawerController>;
  navActions: {
    navigate: (screen: Screen) => void;
    handleSelectChat: (id: string) => void;
    handleNewChat: () => void;
    openBrowser: (targetUrl?: string | null) => void;
    handleLastUsedThreadSettingsChange: (agentId: string, collaborationMode: 'default' | 'plan') => void;
    handleOpenChatGit: (chat: Chat) => void;
    handleChatContextChange: (chat: Chat | null) => void;
    handleCloseGit: () => void;
    handleGitChatUpdated: (chat: Chat) => void;
    openPrivacy: () => void;
    openTerms: () => void;
    updateSettings: (patch: Partial<AppStateSnapshot['data']['settings']>) => void;
  };
  profileActions: {
    handleEditBridgeProfile: () => void;
    handleAddBridgeProfile: () => void;
    handleOpenBridgeRecoveryGuide: () => void;
    handleSwitchBridgeProfile: (profileId: string) => Promise<void>;
    handleRenameBridgeProfile: (profileId: string, nextName: string) => Promise<void>;
    handleDeleteBridgeProfile: (profileId: string) => Promise<void>;
    handleClearSavedBridges: () => Promise<void>;
  };
}

export function AppMainLayout(props: AppMainLayoutProps) {
  const {
    theme,
    styles,
    usesTabletLayout,
    tabletLayoutTransition,
    screenWidth,
    drawerWidth,
    currentScreen,
    activeBridgeProfile,
    selectedChatId,
    gitChat,
    pendingMainChatId,
    pendingMainChatSnapshot,
    pendingBrowserTargetUrl,
    browserReturnScreen,
    approvalMode,
    showToolCalls,
    workspaceChatLimit,
    defaultStartCwd,
    preferredAgentId,
    agentSettings,
    appearancePreference,
    darkUiPalette,
    fontPreference,
    recentBrowserTargetUrls,
    appStateStore,
    appStateSnapshot,
    pushSettings,
    bridgeProfiles,
    api,
    ws,
    browserRef,
    mainRef,
    chatTransitionChatId,
    mainOpeningChatId,
    setMainOpeningChatId,
    setPendingMainChatId,
    setPendingMainChatSnapshot,
    setPendingBrowserTargetUrl,
    setSettingsAllowsDrawerGesture,
    drawer,
    navActions,
    profileActions,
  } = props;

  return (
    <AppThemeProvider theme={theme}>
      <GestureHandlerRootView style={styles.root}>
        <SafeAreaProvider initialMetrics={initialWindowMetrics}>
          <View style={[styles.root, usesTabletLayout && styles.tabletShell]}>
            {usesTabletLayout ? (
              <Animated.View
                layout={tabletLayoutTransition as never}
                pointerEvents={drawer.tabletSidebarVisible ? 'auto' : 'none'}
                style={[styles.tabletSidebarClip, { width: drawer.tabletSidebarVisible ? TABLET_SIDEBAR_WIDTH : 0 }]}
              >
                <View style={styles.tabletSidebarContent}>
                  <DrawerContent
                    key={activeBridgeProfile?.id}
                    api={api}
                    ws={ws}
                    active
                    workspaceChatLimit={workspaceChatLimit}
                    selectedChatId={selectedChatId}
                    onSelectChat={navActions.handleSelectChat}
                    onNewChat={navActions.handleNewChat}
                    onNavigate={navActions.navigate}
                  />
                </View>
              </Animated.View>
            ) : null}
            <GestureDetector gesture={drawer.openDrawerGesture as never}>
              <Animated.View
                layout={usesTabletLayout ? (tabletLayoutTransition as never) : undefined}
                pointerEvents={drawer.drawerVisible && drawer.drawerCapturesTouches ? 'none' : 'auto'}
                accessibilityElementsHidden={drawer.drawerVisible && drawer.drawerCapturesTouches}
                importantForAccessibility={drawer.drawerVisible && drawer.drawerCapturesTouches ? 'no-hide-descendants' : 'auto'}
                style={[
                  styles.screenFrame,
                  usesTabletLayout && styles.tabletScreenFrame,
                  drawer.screenFrameAnimatedStyle,
                  usesTabletLayout ? null : { width: screenWidth },
                ]}
              >
                <GestureDetector gesture={drawer.backSwipeGesture as never}>
                  <View style={styles.screen}>
                    <AppScreenRenderer
                      currentScreen={currentScreen}
                      activeApi={api}
                      activeWs={ws}
                      appStateStore={appStateStore}
                      appStateSnapshot={appStateSnapshot}
                      pushSettings={pushSettings}
                      bridgeProfiles={bridgeProfiles}
                      activeBridgeProfile={activeBridgeProfile}
                      bridgeUrl={activeBridgeProfile?.bridgeUrl ?? ''}
                      bridgeToken={activeBridgeProfile?.bridgeToken ?? null}
                      browserRef={browserRef}
                      mainRef={mainRef}
                      gitChat={gitChat}
                      selectedChatId={selectedChatId}
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
                      onOpenDrawer={drawer.handleNavigationToggle}
                      onOpenGit={navActions.handleOpenChatGit}
                      onOpenLocalPreview={navActions.openBrowser}
                      onOpenBridgeRecoveryGuide={profileActions.handleOpenBridgeRecoveryGuide}
                      onLastUsedThreadSettingsChange={navActions.handleLastUsedThreadSettingsChange}
                      onChatContextChange={navActions.handleChatContextChange}
                      onChatOpeningStateChange={setMainOpeningChatId}
                      onPendingOpenChatHandled={() => {
                        setPendingMainChatId(null);
                        setPendingMainChatSnapshot(null);
                      }}
                      onApprovalModeChange={(value) => navActions.updateSettings({ approvalMode: value })}
                      onShowToolCallsChange={(value) => navActions.updateSettings({ showToolCalls: value })}
                      onWorkspaceChatLimitChange={(value) => navActions.updateSettings({ workspaceChatLimit: value })}
                      onAppearancePreferenceChange={(value) => navActions.updateSettings({ appearancePreference: value })}
                      onDarkUiPaletteChange={(value) => navActions.updateSettings({ darkUiPalette: value })}
                      onFontPreferenceChange={(value) => navActions.updateSettings({ fontPreference: value })}
                      onRetryPersistence={() => appStateStore.retryPersistence()}
                      onEditBridgeProfile={profileActions.handleEditBridgeProfile}
                      onAddBridgeProfile={profileActions.handleAddBridgeProfile}
                      onSwitchBridgeProfile={profileActions.handleSwitchBridgeProfile}
                      onRenameBridgeProfile={profileActions.handleRenameBridgeProfile}
                      onDeleteBridgeProfile={profileActions.handleDeleteBridgeProfile}
                      onClearSavedBridges={profileActions.handleClearSavedBridges}
                      onDrawerGestureEnabledChange={setSettingsAllowsDrawerGesture}
                      onOpenPrivacy={navActions.openPrivacy}
                      onOpenTerms={navActions.openTerms}
                      onRecentTargetUrlsChange={(value) => navActions.updateSettings({ recentBrowserTargetUrls: value })}
                      onPendingTargetHandled={() => setPendingBrowserTargetUrl(null)}
                      onCloseGit={navActions.handleCloseGit}
                      onGitChatUpdated={navActions.handleGitChatUpdated}
                    />
                    {chatTransitionChatId || (currentScreen === 'Main' && mainOpeningChatId) ? (
                      <View style={styles.chatTransitionOverlay}>
                        <View style={styles.chatTransitionCard} accessibilityRole="progressbar" accessibilityLabel="Opening chat" accessibilityLiveRegion="polite">
                          <ActivityIndicator size="small" color={theme.colors.textPrimary} />
                          <Text style={styles.chatTransitionTitle}>Opening chat...</Text>
                        </View>
                      </View>
                    ) : null}
                  </View>
                </GestureDetector>
              </Animated.View>
            </GestureDetector>

            {!usesTabletLayout ? (
              <View pointerEvents={drawer.drawerVisible && drawer.drawerCapturesTouches ? 'auto' : 'none'} style={styles.drawerLayer}>
                <GestureDetector gesture={drawer.visibleDrawerGesture as never}>
                  <View style={styles.drawerGestureSurface}>
                    <GestureDetector gesture={drawer.visibleDrawerTapGesture as never}>
                      <Animated.View style={[styles.overlay, drawer.overlayAnimatedStyle]} />
                    </GestureDetector>
                    <Animated.View style={[styles.drawer, { width: drawerWidth }, drawer.drawerAnimatedStyle]}>
                      <Animated.View
                        style={[styles.drawerContentShell, drawer.drawerContentAnimatedStyle]}
                        accessibilityViewIsModal={drawer.drawerVisible}
                        importantForAccessibility={drawer.drawerVisible ? 'yes' : 'auto'}
                      >
                        <DrawerContent
                          key={activeBridgeProfile?.id}
                          api={api}
                          ws={ws}
                          active={drawer.drawerVisible}
                          workspaceChatLimit={workspaceChatLimit}
                          selectedChatId={selectedChatId}
                          onSelectChat={navActions.handleSelectChat}
                          onNewChat={navActions.handleNewChat}
                          onNavigate={navActions.navigate}
                          onClose={drawer.closeDrawer}
                        />
                      </Animated.View>
                    </Animated.View>
                  </View>
                </GestureDetector>
              </View>
            ) : null}
          </View>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </AppThemeProvider>
  );
}