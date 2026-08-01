import { useCallback, useEffect } from 'react';
import { Animated as RNAnimated, Platform, type LayoutChangeEvent } from 'react-native';
import type { WebViewMessageEvent, WebViewNavigation } from 'react-native-webview';

import {
  isLocalPreviewCandidateUrl,
  isSameOriginUrl,
  mapBrowserPreviewNavigationUrlToTargetUrl,
} from '../../browserPreview';
import { feedback } from '../../feedback';
import type { DesktopFrameMessage, WebViewScrollEvent } from './browserScreenShared';
import type { BrowserScreenModel } from './useBrowserScreenModel';

export function useBrowserScreenCoreHandlers(model: BrowserScreenModel) {
  const {
    pendingTargetUrl,
    onPendingTargetHandled,
    loadBrowserCapabilities,
    openPreview,
    sessionLifecycle,
    previewRequestIdRef,
    bottomBarTranslateY,
    bottomBarVisible,
    bottomBarReservedSpace,
  } = model;

  useEffect(() => {
    void loadBrowserCapabilities();
    return () => {
      previewRequestIdRef.current += 1;
      sessionLifecycle.dispose();
    };
  }, [loadBrowserCapabilities, previewRequestIdRef, sessionLifecycle]);

  useEffect(() => {
    if (!pendingTargetUrl) {
      return;
    }

    model.setInputValue(pendingTargetUrl);
    void openPreview(pendingTargetUrl);
    onPendingTargetHandled?.();
  }, [onPendingTargetHandled, openPreview, pendingTargetUrl, model.setInputValue]);

  useEffect(() => {
    RNAnimated.timing(bottomBarTranslateY, {
      toValue: bottomBarVisible ? 0 : bottomBarReservedSpace + 8,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, [bottomBarReservedSpace, bottomBarTranslateY, bottomBarVisible]);

  const executeDesktopFrameCommand = useCallback(
    (command: 'goBack' | 'goForward' | 'reload') => {
      model.webViewRef.current?.injectJavaScript(
        `window.__dappercodeDesktopFrame && window.__dappercodeDesktopFrame.${command} && window.__dappercodeDesktopFrame.${command}(); true;`,
      );
    },
    [model.webViewRef],
  );

  const handleNavigationStateChange = useCallback(
    (navigation: WebViewNavigation) => {
      if (model.nativeShellMode) {
        return;
      }

      const nextUrl = navigation.url || null;
      model.setCurrentPreviewNavigationUrl(nextUrl);
      const nextDisplayUrl =
        nextUrl && model.activeSession?.targetUrl
          ? (mapBrowserPreviewNavigationUrlToTargetUrl(
              nextUrl,
              model.previewOrigin,
              model.activeSession.targetUrl,
            ) ?? nextUrl)
          : nextUrl;
      model.setCurrentUrl(nextDisplayUrl);
      if (nextDisplayUrl) {
        model.setInputValue(nextDisplayUrl);
      }
      model.setPageTitle(navigation.title || null);
      model.setCanGoBack(navigation.canGoBack);
      model.setCanGoForward(navigation.canGoForward);
      model.setLoadingPreview(navigation.loading);
    },
    [model],
  );

  const handleDesktopFrameMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let payload: DesktopFrameMessage | null = null;
      try {
        payload = JSON.parse(event.nativeEvent.data) as DesktopFrameMessage;
      } catch {
        return;
      }

      if (
        !payload ||
        payload.type !== 'dappercodeDesktopFrameState' ||
        !model.activeSession?.targetUrl
      ) {
        return;
      }
      if (
        model.currentShellRequestKey &&
        payload.shellRequestKey !== model.currentShellRequestKey
      ) {
        return;
      }

      const rawUrl = typeof payload.rawUrl === 'string' && payload.rawUrl ? payload.rawUrl : null;
      const nextDisplayUrl =
        rawUrl && model.previewOrigin
          ? (mapBrowserPreviewNavigationUrlToTargetUrl(
              rawUrl,
              model.previewOrigin,
              model.activeSession.targetUrl,
            ) ?? rawUrl)
          : model.activeSession.targetUrl;
      model.setCurrentPreviewNavigationUrl(rawUrl);
      model.setCurrentUrl(nextDisplayUrl);
      model.setInputValue(nextDisplayUrl);
      model.setPageTitle(typeof payload.title === 'string' ? payload.title : null);
      model.setCanGoBack(Boolean(payload.canGoBack));
      model.setCanGoForward(Boolean(payload.canGoForward));
      model.setLoadingPreview(false);
    },
    [model],
  );

  const handleShouldStartLoad = useCallback(
    (request: { url: string }) => {
      const requestedUrl = request.url;
      if (
        requestedUrl === 'about:blank' ||
        requestedUrl.startsWith('data:') ||
        requestedUrl.startsWith('blob:')
      ) {
        return true;
      }

      if (isSameOriginUrl(requestedUrl, model.previewOrigin)) {
        return true;
      }

      if (isLocalPreviewCandidateUrl(requestedUrl)) {
        model.setInputValue(requestedUrl);
        setTimeout(() => {
          void model.openPreview(requestedUrl);
        }, 0);
      }

      return false;
    },
    [model],
  );

  const handleSubmitInput = useCallback(() => {
    void feedback.selection();
    void model.openPreview(model.inputValue);
  }, [model]);

  const handleReload = useCallback(() => {
    void feedback.selection();
    if (!model.previewUrl) {
      void model.loadSuggestions();
      return;
    }

    model.setCapabilitiesError(null);
    model.setLoadingPreview(true);
    if (Platform.OS === 'web') {
      model.setWebReloadKey((value) => value + 1);
      return;
    }

    if (model.nativeShellMode) {
      executeDesktopFrameCommand('reload');
      return;
    }

    model.webViewRef.current?.reload();
  }, [executeDesktopFrameCommand, model]);

  const handleGoBackPress = useCallback(() => {
    void feedback.selection();
    if (model.nativeShellMode) {
      executeDesktopFrameCommand('goBack');
      return;
    }

    model.webViewRef.current?.goBack();
  }, [executeDesktopFrameCommand, model]);

  const handleGoForwardPress = useCallback(() => {
    void feedback.selection();
    if (model.nativeShellMode) {
      executeDesktopFrameCommand('goForward');
      return;
    }

    model.webViewRef.current?.goForward();
  }, [executeDesktopFrameCommand, model]);

  const handleShowStartPage = useCallback(() => {
    model.previewRequestIdRef.current += 1;
    model.sessionLifecycle.clear();
    model.setPreviewUrl(null);
    model.setActiveSession(null);
    model.setCurrentPreviewNavigationUrl(null);
    model.setCurrentUrl(null);
    model.setPageTitle(null);
    model.setCanGoBack(false);
    model.setCanGoForward(false);
    model.setLoadingPreview(false);
    model.setBottomBarVisible(true);
    model.lastScrollYRef.current = 0;
  }, [model]);

  const handleContentProcessDidTerminate = useCallback(() => {
    if (model.nativeShellMode) {
      model.setLoadingPreview(false);
      return;
    }

    model.setLoadingPreview(true);
    model.setBottomBarVisible(true);
    model.lastScrollYRef.current = 0;
    model.setNativeReloadKey((value) => value + 1);
  }, [model]);

  const handleWebViewScroll = useCallback(
    (event: WebViewScrollEvent) => {
      const nextY = event.nativeEvent.contentOffset.y;
      const delta = nextY - model.lastScrollYRef.current;
      model.lastScrollYRef.current = nextY;

      if (nextY <= 8) {
        if (!model.bottomBarVisible) {
          model.setBottomBarVisible(true);
        }
        return;
      }

      if (Math.abs(delta) < 8) {
        return;
      }

      if (delta > 0) {
        if (model.bottomBarVisible) {
          model.setBottomBarVisible(false);
        }
        return;
      }

      if (!model.bottomBarVisible) {
        model.setBottomBarVisible(true);
      }
    },
    [model],
  );

  const handleNativePreviewViewportLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const nextWidth = Math.round(event.nativeEvent.layout.width);
      const nextHeight = Math.round(event.nativeEvent.layout.height);
      if (nextWidth <= 0 || nextHeight <= 0) {
        return;
      }

      model.setNativePreviewLayout((current) =>
        current.width === nextWidth && current.height === nextHeight
          ? current
          : { width: nextWidth, height: nextHeight },
      );
    },
    [model],
  );

  return {
    executeDesktopFrameCommand,
    handleNavigationStateChange,
    handleDesktopFrameMessage,
    handleShouldStartLoad,
    handleSubmitInput,
    handleReload,
    handleGoBackPress,
    handleGoForwardPress,
    handleShowStartPage,
    handleContentProcessDidTerminate,
    handleWebViewScroll,
    handleNativePreviewViewportLayout,
  };
}
