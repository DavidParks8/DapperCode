import { useCallback, useEffect, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';
import { BackHandler } from 'react-native';

import type { Chat } from '../api/types';
import type { AppSettingsState, AppStateStore } from '../appState';
import type { BrowserScreenHandle } from '../screens/BrowserScreen';
import type { MainScreenHandle } from '../screens/MainScreen';
import type { OnboardingMode } from '../screens/OnboardingScreen';
import type { AppScreen, Screen } from './appConstants';

interface UseAppNavigationActionsArgs {
  appStateStore: AppStateStore;
  currentScreen: Screen;
  onboardingMode: OnboardingMode;
  activeBridgeProfile: unknown;
  browserReturnScreen: AppScreen;
  mainOpeningChatId: string | null;
  activeChat: Chat | null;
  gitChat: Chat | null;
  selectedChatId: string | null;
  browserRef: RefObject<BrowserScreenHandle | null>;
  mainRef: RefObject<MainScreenHandle | null>;
  chatTransitionRequestIdRef: MutableRefObject<number>;
  drawerOpenRef: MutableRefObject<boolean>;
  drawerVisibleRef: MutableRefObject<boolean>;
  setCurrentScreen: Dispatch<SetStateAction<Screen>>;
  setBrowserReturnScreen: Dispatch<SetStateAction<AppScreen>>;
  setPendingBrowserTargetUrl: Dispatch<SetStateAction<string | null>>;
  setChatTransitionChatId: Dispatch<SetStateAction<string | null>>;
  setMainOpeningChatId: Dispatch<SetStateAction<string | null>>;
  setPendingMainChatId: Dispatch<SetStateAction<string | null>>;
  setPendingMainChatSnapshot: Dispatch<SetStateAction<Chat | null>>;
  setSelectedChatId: Dispatch<SetStateAction<string | null>>;
  setActiveChat: Dispatch<SetStateAction<Chat | null>>;
  setGitChat: Dispatch<SetStateAction<Chat | null>>;
  setSettingsAllowsDrawerGesture: Dispatch<SetStateAction<boolean>>;
  closeDrawer: () => void;
  openChatWithTransition: (id: string, snapshot?: Chat | null, options?: { immediate?: boolean }) => Promise<void>;
  handleCancelOnboarding: () => void;
}

export function useAppNavigationActions({
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
  drawerOpenRef,
  drawerVisibleRef,
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
  closeDrawer,
  openChatWithTransition,
  handleCancelOnboarding,
}: UseAppNavigationActionsArgs) {
  const handleLastUsedThreadSettingsChange = useCallback(
    (agentId: string, collaborationMode: 'default' | 'plan') => {
      appStateStore.dispatch({ type: 'settings/remember-thread', agentId, collaborationMode });
    },
    [appStateStore]
  );

  const updateSettings = useCallback(
    (patch: Partial<AppSettingsState>) => {
      appStateStore.dispatch({ type: 'settings/update', patch });
    },
    [appStateStore]
  );

  const navigate = useCallback(
    (screen: Screen) => {
      if (screen !== 'Main') {
        chatTransitionRequestIdRef.current += 1;
        setChatTransitionChatId(null);
        setMainOpeningChatId(null);
      }
      setCurrentScreen(screen);
      closeDrawer();
    },
    [chatTransitionRequestIdRef, closeDrawer, setChatTransitionChatId, setCurrentScreen, setMainOpeningChatId]
  );

  const handleSelectChat = useCallback(
    (id: string) => {
      const currentChatId = activeChat?.id ?? selectedChatId;
      closeDrawer();
      if (currentScreen === 'Main' && currentChatId === id) {
        return;
      }

      void openChatWithTransition(id, null, { immediate: true });
    },
    [activeChat?.id, closeDrawer, currentScreen, openChatWithTransition, selectedChatId]
  );

  const handleNewChat = useCallback(() => {
    chatTransitionRequestIdRef.current += 1;
    setChatTransitionChatId(null);
    setMainOpeningChatId(null);
    setPendingMainChatId(null);
    setPendingMainChatSnapshot(null);
    setSelectedChatId(null);
    setActiveChat(null);
    setGitChat(null);
    setCurrentScreen('Main');
    mainRef.current?.startNewChat();
    closeDrawer();
  }, [
    chatTransitionRequestIdRef,
    closeDrawer,
    mainRef,
    setActiveChat,
    setChatTransitionChatId,
    setCurrentScreen,
    setGitChat,
    setMainOpeningChatId,
    setPendingMainChatId,
    setPendingMainChatSnapshot,
    setSelectedChatId,
  ]);

  const openBrowser = useCallback(
    (targetUrl?: string | null) => {
      if (typeof targetUrl === 'string' && targetUrl.trim().length > 0) {
        setPendingBrowserTargetUrl(targetUrl.trim());
      }
      setBrowserReturnScreen(currentScreen === 'Browser' || currentScreen === 'Onboarding' ? 'Main' : currentScreen);
      chatTransitionRequestIdRef.current += 1;
      setChatTransitionChatId(null);
      setMainOpeningChatId(null);
      setCurrentScreen('Browser');
      closeDrawer();
    },
    [
      chatTransitionRequestIdRef,
      closeDrawer,
      currentScreen,
      setBrowserReturnScreen,
      setChatTransitionChatId,
      setCurrentScreen,
      setMainOpeningChatId,
      setPendingBrowserTargetUrl,
    ]
  );

  const handleOpenChatGit = useCallback(
    (chat: Chat) => {
      chatTransitionRequestIdRef.current += 1;
      setChatTransitionChatId(null);
      setMainOpeningChatId(null);
      setGitChat(chat);
      setSelectedChatId(chat.id);
      setCurrentScreen('ChatGit');
    },
    [chatTransitionRequestIdRef, setChatTransitionChatId, setCurrentScreen, setGitChat, setMainOpeningChatId, setSelectedChatId]
  );

  const handleChatContextChange = useCallback(
    (chat: Chat | null) => {
      setActiveChat(chat);
      setSelectedChatId((previous) => {
        if (chat?.id) {
          return chat.id;
        }
        return mainOpeningChatId ? previous : null;
      });
    },
    [mainOpeningChatId, setActiveChat, setSelectedChatId]
  );

  const handleGitChatUpdated = useCallback(
    (chat: Chat) => {
      setGitChat(chat);
      setActiveChat((prev) => (prev?.id === chat.id ? chat : prev));
    },
    [setActiveChat, setGitChat]
  );

  const handleCloseGit = useCallback(() => {
    const chatId = gitChat?.id ?? activeChat?.id ?? selectedChatId;
    const resumeChat =
      gitChat && gitChat.id === chatId
        ? gitChat
        : activeChat && activeChat.id === chatId
          ? activeChat
          : null;
    if (chatId) {
      void openChatWithTransition(chatId, resumeChat);
      return;
    }
    setCurrentScreen('Main');
    setGitChat(null);
  }, [activeChat, gitChat, openChatWithTransition, selectedChatId, setCurrentScreen, setGitChat]);

  useEffect(() => {
    if (currentScreen !== 'Settings') {
      setSettingsAllowsDrawerGesture(true);
    }
  }, [currentScreen, setSettingsAllowsDrawerGesture]);

  const openPrivacy = useCallback(() => {
    chatTransitionRequestIdRef.current += 1;
    setChatTransitionChatId(null);
    setMainOpeningChatId(null);
    setCurrentScreen('Privacy');
  }, [chatTransitionRequestIdRef, setChatTransitionChatId, setCurrentScreen, setMainOpeningChatId]);

  const openTerms = useCallback(() => {
    chatTransitionRequestIdRef.current += 1;
    setChatTransitionChatId(null);
    setMainOpeningChatId(null);
    setCurrentScreen('Terms');
  }, [chatTransitionRequestIdRef, setChatTransitionChatId, setCurrentScreen, setMainOpeningChatId]);

  const handleHardwareBackPress = useCallback(() => {
    if (drawerVisibleRef.current || drawerOpenRef.current) {
      closeDrawer();
      return true;
    }

    if (currentScreen === 'Onboarding') {
      if (onboardingMode !== 'initial' && activeBridgeProfile) {
        handleCancelOnboarding();
        return true;
      }
      return false;
    }

    switch (currentScreen) {
      case 'ChatGit':
        handleCloseGit();
        return true;
      case 'Browser':
        if (browserRef.current?.handleHardwareBackPress()) {
          return true;
        }
        setCurrentScreen(browserReturnScreen);
        return true;
      case 'Settings':
        setCurrentScreen('Main');
        return true;
      case 'Privacy':
      case 'Terms':
        setCurrentScreen('Settings');
        return true;
      case 'Main':
      default:
        return false;
    }
  }, [
    activeBridgeProfile,
    browserRef,
    browserReturnScreen,
    closeDrawer,
    currentScreen,
    drawerOpenRef,
    drawerVisibleRef,
    handleCancelOnboarding,
    handleCloseGit,
    onboardingMode,
    setCurrentScreen,
  ]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', handleHardwareBackPress);
    return () => subscription.remove();
  }, [handleHardwareBackPress]);

  return {
    handleLastUsedThreadSettingsChange,
    updateSettings,
    navigate,
    handleSelectChat,
    handleNewChat,
    openBrowser,
    handleOpenChatGit,
    handleChatContextChange,
    handleGitChatUpdated,
    handleCloseGit,
    openPrivacy,
    openTerms,
    handleHardwareBackPress,
  };
}
