import { useAtom, useAtomValue } from 'jotai';
import { useCallback, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Animated as RNAnimated, Platform, type ScrollView, type Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { WebView } from 'react-native-webview';

import type { BrowserPreviewSession } from '@bridge/types/types';
import {
  applyBrowserPreviewShellMode,
  buildBrowserPreviewBootstrapUrl,
  type BrowserPreviewViewportSpec,
  getBrowserPreviewOrigin,
  getBrowserPreviewShellRequestKey,
  getNativeBrowserPreviewShellMode,
  normalizePreviewTargetInput,
  pushRecentPreviewTarget,
} from '../preview';
import { BrowserPreviewSessionLifecycle } from '../preview/sessionLifecycle';
import { useAccessibilityAnnouncement, useModalAccessibilityFocus } from '@shared/accessibility';
import { recentBrowserTargetUrlsAtom } from '@shell/state/appState/settings';
import { bridgeUrlAtom } from '@shell/state/bridge/atoms';
import { useBrowserTargetsResource } from '@shell/state/bridge/browserTargets';
import { useBridgeCapabilitiesResource } from '@shell/state/bridge/capabilities';
import { useBridgeApi } from '@shell/state/bridge/hooks';
import { pendingBrowserTargetUrlAtom } from '../state/browser';
import type { AppTheme } from '@shared/theme';
import {
  DEFAULT_DESKTOP_VIEWPORT,
  DESKTOP_PREVIEW_USER_AGENT,
  DESKTOP_VIEWPORT_PRESETS,
  getCompactBrowserLabel,
  type ViewportPreset,
} from './shared';

function resolveCapabilitiesError(
  localError: string | null,
  bridgeError: string | null,
): string | null {
  if (localError) {
    return localError;
  }
  if (bridgeError === 'Could not read bridge capabilities.') {
    return 'Could not load bridge capabilities.';
  }
  return bridgeError;
}

function resolveNativeUserAgent(
  platformOS: typeof Platform.OS,
  nativeShellMode: ReturnType<typeof getNativeBrowserPreviewShellMode>,
  desktopModeEnabled: boolean,
): string | undefined {
  if (platformOS === 'web' || nativeShellMode || !desktopModeEnabled) {
    return undefined;
  }
  return DESKTOP_PREVIEW_USER_AGENT;
}

function resolveNativeContentMode(
  platformOS: typeof Platform.OS,
  nativeShellMode: ReturnType<typeof getNativeBrowserPreviewShellMode>,
  desktopModeEnabled: boolean,
): 'mobile' | 'desktop' | undefined {
  if (platformOS === 'ios' || nativeShellMode) {
    return undefined;
  }
  return desktopModeEnabled ? 'desktop' : 'mobile';
}

function resolveBottomBarInset(insetsBottom: number, spacingMd: number, spacingXs: number): number {
  return insetsBottom > 0 ? Math.max(insetsBottom - spacingMd, spacingXs) : spacingXs;
}

function resolveOverviewContentHeight(
  desktopOverviewEnabled: boolean,
  nativeOverviewShellEnabled: boolean,
  previewUrl: string | null,
  overviewMetrics: { previewUrl: string; height: number } | null,
): number | null {
  if (
    desktopOverviewEnabled &&
    !nativeOverviewShellEnabled &&
    previewUrl &&
    overviewMetrics?.previewUrl === previewUrl
  ) {
    return overviewMetrics.height;
  }
  return null;
}

function resolveDesktopCanvasHeight(
  desktopOverviewEnabled: boolean,
  overviewContentHeight: number | null,
  desktopViewportHeight: number,
): number {
  if (desktopOverviewEnabled && overviewContentHeight) {
    return Math.max(desktopViewportHeight, overviewContentHeight);
  }
  return desktopViewportHeight;
}

function resolveOverviewReady(
  nativeOverviewShellEnabled: boolean,
  desktopOverviewEnabled: boolean,
  overviewContentHeight: number | null,
): boolean {
  return nativeOverviewShellEnabled || !desktopOverviewEnabled || overviewContentHeight !== null;
}

function resolveDesktopMinimumZoomScale(
  platformOS: typeof Platform.OS,
  nativePreviewLayout: { width: number; height: number },
  desktopViewportWidth: number,
  desktopCanvasHeight: number,
): number {
  if (platformOS === 'ios' && nativePreviewLayout.width > 0) {
    return Math.min(
      1,
      nativePreviewLayout.width / desktopViewportWidth,
      nativePreviewLayout.height / desktopCanvasHeight,
    );
  }
  return 1;
}

export function useBrowserScreenModel(theme: AppTheme) {
  const api = useBridgeApi();
  const bridgeCapabilities = useBridgeCapabilitiesResource();
  const browserTargets = useBrowserTargetsResource();
  // The resource hooks rebuild their result object every render; only the actions inside it are
  // referentially stable, so callbacks must depend on those rather than the container.
  const { revalidate: revalidateBridgeCapabilities } = bridgeCapabilities;
  const { refresh: refreshBrowserTargets } = browserTargets;
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
  const suggestionsLoading = browserTargets.refreshing && browserTargets.value === null;
  const suggestions = browserTargets.value ?? [];
  const [localCapabilitiesError, setCapabilitiesError] = useState<string | null>(null);
  const capabilitiesError = resolveCapabilitiesError(
    localCapabilitiesError,
    bridgeCapabilities.error,
  );
  const supportsBrowserPreview = bridgeCapabilities.value?.supports.browserPreview !== false;
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
  const [overviewMetrics, setOverviewMetrics] = useState<{
    previewUrl: string;
    height: number;
  } | null>(null);

  const submitDisabled = !supportsBrowserPreview || openingPreview;
  const viewportMenuFocusRef = useModalAccessibilityFocus(showViewportMenu);
  useAccessibilityAnnouncement(capabilitiesError);
  useAccessibilityAnnouncement(openingPreview ? 'Opening local preview' : null);
  useAccessibilityAnnouncement(loadingPreview && !openingPreview ? 'Loading preview' : null);

  const previewOrigin = useMemo(
    () =>
      activeSession
        ? getBrowserPreviewOrigin(
            bridgeUrl,
            activeSession.previewPort,
            activeSession.previewBaseUrl ?? null,
          )
        : null,
    [activeSession, bridgeUrl],
  );
  const currentShellRequestKey = useMemo(
    () => getBrowserPreviewShellRequestKey(previewUrl),
    [previewUrl],
  );
  const siteLabel = useMemo(
    () => getCompactBrowserLabel(currentUrl ?? activeSession?.targetUrl ?? inputValue),
    [activeSession?.targetUrl, currentUrl, inputValue],
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
    [desktopModeEnabled, desktopViewportSize.width, theme.colors.bgMain],
  );

  const bottomBarInset = resolveBottomBarInset(insets.bottom, theme.spacing.md, theme.spacing.xs);
  const bottomBarReservedSpace = bottomBarInset + 58;
  const webViewBottomInset = bottomBarVisible ? bottomBarReservedSpace : 0;

  const nativeUserAgent = resolveNativeUserAgent(Platform.OS, nativeShellMode, desktopModeEnabled);
  const nativeContentMode = resolveNativeContentMode(
    Platform.OS,
    nativeShellMode,
    desktopModeEnabled,
  );

  const browserViewport = useMemo<BrowserPreviewViewportSpec>(
    () =>
      desktopModeEnabled
        ? {
            preset: 'desktop',
            width: desktopViewportSize.width,
            height: desktopViewportSize.height,
          }
        : { preset: 'mobile' },
    [desktopModeEnabled, desktopViewportSize.height, desktopViewportSize.width],
  );

  const desktopViewportLabel = `${desktopViewportSize.width}×${desktopViewportSize.height}`;
  const desktopViewportMatchesPreset = DESKTOP_VIEWPORT_PRESETS.some(
    (preset) =>
      preset.width === desktopViewportSize.width && preset.height === desktopViewportSize.height,
  );
  const overviewContentHeight = resolveOverviewContentHeight(
    desktopOverviewEnabled,
    nativeOverviewShellEnabled,
    previewUrl,
    overviewMetrics,
  );
  const desktopCanvasHeight = resolveDesktopCanvasHeight(
    desktopOverviewEnabled,
    overviewContentHeight,
    desktopViewportSize.height,
  );
  const overviewReady = resolveOverviewReady(
    nativeOverviewShellEnabled,
    desktopOverviewEnabled,
    overviewContentHeight,
  );
  const desktopMinimumZoomScale = resolveDesktopMinimumZoomScale(
    Platform.OS,
    nativePreviewLayout,
    desktopViewportSize.width,
    desktopCanvasHeight,
  );

  const startPreviewSession = useCallback(
    async (rawTarget: string, viewport: BrowserPreviewViewportSpec) => {
      const normalizedTarget = normalizePreviewTargetInput(rawTarget);
      if (!normalizedTarget) {
        throw new Error('Use a loopback URL like localhost:3000 or just enter a port.');
      }
      const session = await sessionLifecycle.serializeCreate(() =>
        api.createBrowserPreviewSession(normalizedTarget),
      );
      const nextPreviewUrl = buildBrowserPreviewBootstrapUrl(
        bridgeUrl,
        session.previewPort,
        session.bootstrapPath,
        viewport,
        session.previewBaseUrl ?? null,
      );
      if (!nextPreviewUrl) {
        sessionLifecycle.discard(session.sessionId);
        throw new Error('Could not build preview bootstrap URL.');
      }
      return { normalizedTarget, session, nextPreviewUrl };
    },
    [api, bridgeUrl, sessionLifecycle],
  );

  const loadBrowserCapabilities = useCallback(async () => {
    setCapabilitiesError(null);
    await revalidateBridgeCapabilities();
  }, [revalidateBridgeCapabilities]);

  const loadSuggestions = useCallback(async () => {
    await refreshBrowserTargets();
  }, [refreshBrowserTargets]);

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
          browserViewport,
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
          error instanceof Error ? error.message : 'Could not open local preview.',
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
    ],
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
