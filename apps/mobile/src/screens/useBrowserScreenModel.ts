import { useAtom, useAtomValue } from 'jotai';
import { useCallback, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  Animated as RNAnimated,
  Platform,
  type ScrollView,
  type Text,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { WebView } from 'react-native-webview';

import type {
  BrowserPreviewDiscoveryResponse,
  BrowserPreviewSession,
  BrowserPreviewTargetSuggestion,
} from '../api/types';
import {
  applyBrowserPreviewShellMode,
  buildBrowserPreviewBootstrapUrl,
  type BrowserPreviewViewportSpec,
  getBrowserPreviewOrigin,
  getBrowserPreviewShellRequestKey,
  getNativeBrowserPreviewShellMode,
  normalizePreviewTargetInput,
  pushRecentPreviewTarget,
} from '../browserPreview';
import { BrowserPreviewSessionLifecycle } from '../browserPreviewSessionLifecycle';
import { useAccessibilityAnnouncement, useModalAccessibilityFocus } from '../accessibility';
import { recentBrowserTargetUrlsAtom } from '../state/appState/settings';
import { bridgeUrlAtom } from '../state/bridge/atoms';
import { useBridgeApi } from '../state/bridge/hooks';
import { pendingBrowserTargetUrlAtom } from '../state/navigation/atoms';
import type { AppTheme } from '../theme';
import {
  DEFAULT_DESKTOP_VIEWPORT,
  DESKTOP_PREVIEW_USER_AGENT,
  DESKTOP_VIEWPORT_PRESETS,
  getCompactBrowserLabel,
  type ViewportPreset,
} from './browserScreenShared';

export function useBrowserScreenModel(theme: AppTheme) {
  const api = useBridgeApi();
  const bridgeUrl = useAtomValue(bridgeUrlAtom) ?? '';
  const [recentTargetUrls, onRecentTargetUrlsChange] = useAtom(recentBrowserTargetUrlsAtom);
  const [pendingTargetUrl, setPendingTargetUrl] = useAtom(pendingBrowserTargetUrlAtom);
  const onPendingTargetHandled = useCallback(() => {
    setPendingTargetUrl(null);
  }, [setPendingTargetUrl]);

  const insets = useSafeAreaInsets();
  const webViewRef = useRef<WebView>(null);
  const desktopScrollViewRef = useRef<ScrollView>(null);
  const bottomBarTranslateY = useRef(new RNAnimated.Value(0)).current;
  const lastDesktopFitKeyRef = useRef<string | null>(null);
  const overviewHeightLockedRef = useRef(false);
  const lastScrollYRef = useRef(0);
  const previewRequestIdRef = useRef(0);
  const sessionLifecycle = useMemo(() => new BrowserPreviewSessionLifecycle(api), [api]);

  const [inputValue, setInputValue] = useState(recentTargetUrls[0] ?? 'http://127.0.0.1:3000');
  const [activeSession, setActiveSession] = useState<BrowserPreviewSession | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [, setCurrentPreviewNavigationUrl] = useState<string | null>(null);
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [pageTitle, setPageTitle] = useState<string | null>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [openingPreview, setOpeningPreview] = useState(false);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<BrowserPreviewTargetSuggestion[]>([]);
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null);
  const [supportsBrowserPreview, setSupportsBrowserPreview] = useState(true);
  const [webReloadKey, setWebReloadKey] = useState(0);
  const [nativeReloadKey, setNativeReloadKey] = useState(0);
  const [bottomBarVisible, setBottomBarVisible] = useState(true);
  const [viewportPreset, setViewportPreset] = useState<ViewportPreset>('mobile');
  const [desktopViewportSize, setDesktopViewportSize] = useState(DEFAULT_DESKTOP_VIEWPORT);
  const [desktopViewportDraft, setDesktopViewportDraft] = useState({
    width: String(DEFAULT_DESKTOP_VIEWPORT.width),
    height: String(DEFAULT_DESKTOP_VIEWPORT.height),
  });
  const [showCustomViewportEditor, setShowCustomViewportEditor] = useState(false);
  const [showViewportMenu, setShowViewportMenu] = useState(false);
  const [nativePreviewLayout, setNativePreviewLayout] = useState({ width: 0, height: 0 });
  const [overviewMetrics, setOverviewMetrics] = useState<{ previewUrl: string; height: number } | null>(
    null
  );

  const submitDisabled = !supportsBrowserPreview || openingPreview;
  const viewportMenuFocusRef = useModalAccessibilityFocus(showViewportMenu);
  useAccessibilityAnnouncement(capabilitiesError);
  useAccessibilityAnnouncement(openingPreview ? 'Opening local preview' : null);

  const previewOrigin = useMemo(
    () =>
      activeSession
        ? getBrowserPreviewOrigin(
            bridgeUrl,
            activeSession.previewPort,
            activeSession.previewBaseUrl ?? null
          )
        : null,
    [activeSession, bridgeUrl]
  );
  const currentShellRequestKey = useMemo(
    () => getBrowserPreviewShellRequestKey(previewUrl),
    [previewUrl]
  );
  const siteLabel = useMemo(
    () => getCompactBrowserLabel(currentUrl ?? activeSession?.targetUrl ?? inputValue),
    [activeSession?.targetUrl, currentUrl, inputValue]
  );

  const desktopModeEnabled = viewportPreset !== 'mobile';
  const nativeShellMode = getNativeBrowserPreviewShellMode(Platform.OS, viewportPreset);
  const desktopOverviewEnabled = desktopModeEnabled && nativeShellMode !== 'desktop';
  const nativeOverviewShellEnabled = nativeShellMode === 'overview';

  const iframeStyle = useMemo<CSSProperties>(
    () => ({
      border: 0,
      width: desktopModeEnabled ? `${desktopViewportSize.width}px` : '100%',
      height: '100%',
      display: 'block',
      backgroundColor: theme.colors.bgMain,
    }),
    [desktopModeEnabled, desktopViewportSize.width, theme.colors.bgMain]
  );

  const bottomBarInset =
    insets.bottom > 0
      ? Math.max(insets.bottom - theme.spacing.md, theme.spacing.xs)
      : theme.spacing.xs;
  const bottomBarReservedSpace = bottomBarInset + 58;
  const webViewBottomInset = bottomBarVisible ? bottomBarReservedSpace : 0;

  const nativeUserAgent =
    Platform.OS === 'web' || nativeShellMode || !desktopModeEnabled
      ? undefined
      : DESKTOP_PREVIEW_USER_AGENT;
  const nativeContentMode: 'mobile' | 'desktop' | undefined =
    Platform.OS === 'ios' || nativeShellMode
      ? undefined
      : desktopModeEnabled
        ? 'desktop'
        : 'mobile';

  const browserViewport = useMemo<BrowserPreviewViewportSpec>(
    () =>
      desktopModeEnabled
        ? {
            preset: 'desktop',
            width: desktopViewportSize.width,
            height: desktopViewportSize.height,
          }
        : { preset: 'mobile' },
    [desktopModeEnabled, desktopViewportSize.height, desktopViewportSize.width]
  );

  const desktopViewportLabel = `${desktopViewportSize.width}×${desktopViewportSize.height}`;
  const desktopViewportMatchesPreset = DESKTOP_VIEWPORT_PRESETS.some(
    (preset) =>
      preset.width === desktopViewportSize.width && preset.height === desktopViewportSize.height
  );
  const overviewContentHeight =
    desktopOverviewEnabled &&
    !nativeOverviewShellEnabled &&
    previewUrl &&
    overviewMetrics?.previewUrl === previewUrl
      ? overviewMetrics.height
      : null;
  const desktopCanvasHeight =
    desktopOverviewEnabled && overviewContentHeight
      ? Math.max(desktopViewportSize.height, overviewContentHeight)
      : desktopViewportSize.height;
  const overviewReady =
    nativeOverviewShellEnabled || !desktopOverviewEnabled || overviewContentHeight !== null;
  const desktopMinimumZoomScale =
    Platform.OS === 'ios' && nativePreviewLayout.width > 0
      ? Math.min(
          1,
          nativePreviewLayout.width / desktopViewportSize.width,
          nativePreviewLayout.height / desktopCanvasHeight
        )
      : 1;

  const startPreviewSession = useCallback(
    async (rawTarget: string, viewport: BrowserPreviewViewportSpec) => {
      const normalizedTarget = normalizePreviewTargetInput(rawTarget);
      if (!normalizedTarget) {
        throw new Error('Use a loopback URL like localhost:3000 or just enter a port.');
      }
      const session = await sessionLifecycle.serializeCreate(() =>
        api.createBrowserPreviewSession(normalizedTarget)
      );
      const nextPreviewUrl = buildBrowserPreviewBootstrapUrl(
        bridgeUrl,
        session.previewPort,
        session.bootstrapPath,
        viewport,
        session.previewBaseUrl ?? null
      );
      if (!nextPreviewUrl) {
        sessionLifecycle.discard(session.sessionId);
        throw new Error('Could not build preview bootstrap URL.');
      }
      return { normalizedTarget, session, nextPreviewUrl };
    },
    [api, bridgeUrl, sessionLifecycle]
  );

  const loadBrowserCapabilities = useCallback(async () => {
    try {
      const capabilities = await api.readBridgeCapabilities();
      setSupportsBrowserPreview(capabilities.supports.browserPreview !== false);
      setCapabilitiesError(null);
    } catch (error) {
      setSupportsBrowserPreview(true);
      setCapabilitiesError(
        error instanceof Error ? error.message : 'Could not load bridge capabilities.'
      );
    }
  }, [api]);

  const loadSuggestions = useCallback(async () => {
    setSuggestionsLoading(true);
    try {
      const response: BrowserPreviewDiscoveryResponse =
        await api.discoverBrowserPreviewTargets();
      setSuggestions(response.suggestions);
    } catch {
      setSuggestions([]);
    } finally {
      setSuggestionsLoading(false);
    }
  }, [api]);

  const openPreview = useCallback(
    async (rawTarget: string) => {
      const requestId = previewRequestIdRef.current + 1;
      previewRequestIdRef.current = requestId;
      setOpeningPreview(true);
      setLoadingPreview(true);
      setCapabilitiesError(null);
      try {
        const { normalizedTarget, session, nextPreviewUrl } = await startPreviewSession(
          rawTarget,
          browserViewport
        );
        if (previewRequestIdRef.current !== requestId) {
          sessionLifecycle.discard(session.sessionId);
          return;
        }
        const resolvedPreviewUrl =
          applyBrowserPreviewShellMode(nextPreviewUrl, nativeShellMode) ?? nextPreviewUrl;
        sessionLifecycle.adopt(session.sessionId);
        setInputValue(normalizedTarget);
        setActiveSession(session);
        setPreviewUrl(resolvedPreviewUrl);
        setCurrentPreviewNavigationUrl(resolvedPreviewUrl);
        setCurrentUrl(normalizedTarget);
        setPageTitle(null);
        setCanGoBack(false);
        setCanGoForward(false);
        setBottomBarVisible(true);
        lastScrollYRef.current = 0;
        setWebReloadKey((value) => value + 1);
        setNativeReloadKey((value) => value + 1);
        onRecentTargetUrlsChange(pushRecentPreviewTarget(recentTargetUrls, normalizedTarget));
      } catch (error) {
        if (previewRequestIdRef.current !== requestId) {
          return;
        }
        setLoadingPreview(false);
        setCapabilitiesError(
          error instanceof Error ? error.message : 'Could not open local preview.'
        );
      } finally {
        if (previewRequestIdRef.current === requestId) {
          setOpeningPreview(false);
        }
      }
    },
    [
      browserViewport,
      nativeShellMode,
      onRecentTargetUrlsChange,
      recentTargetUrls,
      sessionLifecycle,
      startPreviewSession,
    ]
  );

  return {
    pendingTargetUrl,
    onPendingTargetHandled,
    recentTargetUrls,
    webViewRef,
    desktopScrollViewRef,
    bottomBarTranslateY,
    lastDesktopFitKeyRef,
    overviewHeightLockedRef,
    lastScrollYRef,
    previewRequestIdRef,
    sessionLifecycle,
    inputValue,
    setInputValue,
    activeSession,
    setActiveSession,
    previewUrl,
    setPreviewUrl,
    setCurrentPreviewNavigationUrl,
    currentUrl,
    setCurrentUrl,
    pageTitle,
    setPageTitle,
    canGoBack,
    setCanGoBack,
    canGoForward,
    setCanGoForward,
    loadingPreview,
    setLoadingPreview,
    openingPreview,
    setOpeningPreview,
    suggestionsLoading,
    suggestions,
    capabilitiesError,
    setCapabilitiesError,
    supportsBrowserPreview,
    submitDisabled,
    webReloadKey,
    setWebReloadKey,
    nativeReloadKey,
    setNativeReloadKey,
    bottomBarVisible,
    setBottomBarVisible,
    viewportPreset,
    setViewportPreset,
    desktopViewportSize,
    setDesktopViewportSize,
    desktopViewportDraft,
    setDesktopViewportDraft,
    showCustomViewportEditor,
    setShowCustomViewportEditor,
    showViewportMenu,
    setShowViewportMenu,
    viewportMenuFocusRef: viewportMenuFocusRef as unknown as (instance: Text | null) => void,
    nativePreviewLayout,
    setNativePreviewLayout,
    overviewMetrics,
    setOverviewMetrics,
    previewOrigin,
    currentShellRequestKey,
    siteLabel,
    desktopModeEnabled,
    nativeShellMode,
    desktopOverviewEnabled,
    nativeOverviewShellEnabled,
    iframeStyle,
    bottomBarInset,
    bottomBarReservedSpace,
    webViewBottomInset,
    nativeUserAgent,
    nativeContentMode,
    browserViewport,
    desktopViewportLabel,
    desktopViewportMatchesPreset,
    desktopCanvasHeight,
    overviewReady,
    desktopMinimumZoomScale,
    startPreviewSession,
    loadBrowserCapabilities,
    loadSuggestions,
    openPreview,
  };
}

export type BrowserScreenModel = ReturnType<typeof useBrowserScreenModel>;
