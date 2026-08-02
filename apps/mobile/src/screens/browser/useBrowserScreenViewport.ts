import { useCallback, useEffect } from 'react';
import { Platform } from 'react-native';
import type { WebViewMessageEvent } from 'react-native-webview';

import {
  applyBrowserPreviewShellMode,
  getNativeBrowserPreviewShellMode,
  normalizePreviewTargetInput,
} from '../../browserPreview';
import {
  OVERVIEW_INJECTED_JAVASCRIPT,
  parseDesktopViewportValue,
  type ViewportPreset,
} from './browserScreenShared';
import type { BrowserScreenModel } from './useBrowserScreenModel';

export function useBrowserScreenViewport(model: BrowserScreenModel) {
  const {
    desktopViewportSize,
    previewUrl,
    viewportPreset,
    setOverviewMetrics,
    overviewHeightLockedRef,
    lastDesktopFitKeyRef,
    desktopOverviewEnabled,
    nativeOverviewShellEnabled,
    loadingPreview,
    nativePreviewLayout,
    overviewReady,
    desktopCanvasHeight,
    desktopScrollViewRef,
  } = model;

  useEffect(() => {
    overviewHeightLockedRef.current = false;
    lastDesktopFitKeyRef.current = null;
    setOverviewMetrics(null);
  }, [
    desktopViewportSize.height,
    desktopViewportSize.width,
    lastDesktopFitKeyRef,
    overviewHeightLockedRef,
    previewUrl,
    setOverviewMetrics,
    viewportPreset,
  ]);

  useEffect(() => {
    if (
      Platform.OS !== 'ios' ||
      !desktopOverviewEnabled ||
      nativeOverviewShellEnabled ||
      !previewUrl ||
      loadingPreview ||
      nativePreviewLayout.width <= 0 ||
      nativePreviewLayout.height <= 0 ||
      !overviewReady
    ) {
      lastDesktopFitKeyRef.current = null;
      return;
    }

    const fitKey = [
      viewportPreset,
      previewUrl,
      desktopViewportSize.width,
      desktopViewportSize.height,
      desktopCanvasHeight,
      nativePreviewLayout.width,
      nativePreviewLayout.height,
    ].join('|');
    if (lastDesktopFitKeyRef.current === fitKey) {
      return;
    }

    lastDesktopFitKeyRef.current = fitKey;
    const timeout = setTimeout(() => {
      desktopScrollViewRef.current?.scrollTo({ x: 0, y: 0, animated: false });
      setTimeout(() => {
        desktopScrollViewRef.current?.scrollTo({ x: 0, y: 0, animated: false });
        if (desktopOverviewEnabled) {
          overviewHeightLockedRef.current = true;
        }
      }, 32);
    }, 0);

    return () => clearTimeout(timeout);
  }, [
    desktopCanvasHeight,
    desktopOverviewEnabled,
    desktopScrollViewRef,
    desktopViewportSize.height,
    desktopViewportSize.width,
    lastDesktopFitKeyRef,
    loadingPreview,
    nativeOverviewShellEnabled,
    nativePreviewLayout.height,
    nativePreviewLayout.width,
    overviewHeightLockedRef,
    overviewReady,
    previewUrl,
    viewportPreset,
  ]);

  const handleOverviewMessage = useCallback(
    (event: WebViewMessageEvent) => {
      if (!model.desktopOverviewEnabled || model.nativeOverviewShellEnabled) {
        return;
      }

      try {
        const payload = JSON.parse(event.nativeEvent.data) as { type?: string; height?: number };
        if (payload.type !== 'dappercodeOverviewMetrics') {
          return;
        }
        const nextHeight = Math.round(Number(payload.height));
        if (!Number.isFinite(nextHeight) || nextHeight <= 0) {
          return;
        }

        const normalizedHeight = Math.max(model.desktopViewportSize.height, nextHeight);
        model.setOverviewMetrics((current) => {
          if (model.overviewHeightLockedRef.current) {
            return current;
          }
          if (current?.previewUrl === model.previewUrl && current.height === normalizedHeight) {
            return current;
          }
          return {
            previewUrl: model.previewUrl ?? '',
            height:
              current?.previewUrl === model.previewUrl
                ? Math.max(current.height, normalizedHeight)
                : normalizedHeight,
          };
        });
      } catch {
        return;
      }
    },
    [model],
  );

  const applyViewportSelection = useCallback(
    (nextPreset: ViewportPreset, nextDesktopViewport = model.desktopViewportSize) => {
      const requestId = model.previewRequestIdRef.current + 1;
      model.previewRequestIdRef.current = requestId;
      const nextViewport =
        nextPreset !== 'mobile'
          ? {
              preset: 'desktop' as const,
              width: nextDesktopViewport.width,
              height: nextDesktopViewport.height,
            }
          : { preset: 'mobile' as const };
      const reloadTarget = model.currentUrl ?? model.activeSession?.targetUrl ?? model.inputValue;
      const commitViewportSelectionState = () => {
        model.setViewportPreset(nextPreset);
        model.setBottomBarVisible(true);
        model.lastScrollYRef.current = 0;
        model.lastDesktopFitKeyRef.current = null;
        model.overviewHeightLockedRef.current = false;
        model.setOverviewMetrics(null);
        model.setCurrentPreviewNavigationUrl(null);
        model.setPageTitle(null);
        model.setCanGoBack(false);
        model.setCanGoForward(false);

        if (nextPreset !== 'mobile') {
          model.setDesktopViewportSize(nextDesktopViewport);
          model.setDesktopViewportDraft({
            width: String(nextDesktopViewport.width),
            height: String(nextDesktopViewport.height),
          });
        } else {
          model.setShowCustomViewportEditor(false);
        }
      };

      if (!model.previewUrl) {
        commitViewportSelectionState();
        return;
      }

      const normalizedReloadTarget = normalizePreviewTargetInput(reloadTarget);
      if (!normalizedReloadTarget) {
        commitViewportSelectionState();
        return;
      }

      model.setOpeningPreview(true);
      model.setLoadingPreview(true);
      model.setCapabilitiesError(null);
      void model
        .startPreviewSession(normalizedReloadTarget, nextViewport)
        .then(({ normalizedTarget, session, nextPreviewUrl }) => {
          if (model.previewRequestIdRef.current !== requestId) {
            model.sessionLifecycle.discard(session.sessionId);
            return;
          }
          const nextShellMode = getNativeBrowserPreviewShellMode(Platform.OS, nextPreset);
          const resolvedPreviewUrl =
            applyBrowserPreviewShellMode(nextPreviewUrl, nextShellMode) ?? nextPreviewUrl;
          model.sessionLifecycle.adopt(session.sessionId);
          commitViewportSelectionState();
          model.setInputValue(normalizedTarget);
          model.setActiveSession(session);
          model.setPreviewUrl(resolvedPreviewUrl);
          model.setCurrentPreviewNavigationUrl(resolvedPreviewUrl);
          model.setCurrentUrl(normalizedTarget);
          model.setPageTitle(null);
          model.setCanGoBack(false);
          model.setCanGoForward(false);
          model.setWebReloadKey((value) => value + 1);
          model.setNativeReloadKey((value) => value + 1);
        })
        .catch((error: unknown) => {
          if (model.previewRequestIdRef.current !== requestId) {
            return;
          }
          model.setLoadingPreview(false);
          model.setCapabilitiesError(
            error instanceof Error ? error.message : 'Could not reload local preview.',
          );
        })
        .finally(() => {
          if (model.previewRequestIdRef.current === requestId) {
            model.setOpeningPreview(false);
          }
        });
    },
    [model],
  );

  const handleSelectDesktopPreset = useCallback(
    (viewport: { width: number; height: number }) => {
      model.setDesktopViewportSize(viewport);
      model.setDesktopViewportDraft({
        width: String(viewport.width),
        height: String(viewport.height),
      });
      model.setShowCustomViewportEditor(false);
      model.setShowViewportMenu(false);
      if (model.viewportPreset !== 'mobile' && model.previewUrl) {
        applyViewportSelection(model.viewportPreset, viewport);
      }
    },
    [applyViewportSelection, model],
  );

  const handleOpenViewportMenu = useCallback(() => {
    model.setDesktopViewportDraft({
      width: String(model.desktopViewportSize.width),
      height: String(model.desktopViewportSize.height),
    });
    model.setShowViewportMenu(true);
  }, [model]);

  const handleCloseViewportMenu = useCallback(() => {
    model.setShowViewportMenu(false);
    model.setShowCustomViewportEditor(false);
  }, [model]);

  const handleShowCustomViewportEditor = useCallback(() => {
    model.setDesktopViewportDraft({
      width: String(model.desktopViewportSize.width),
      height: String(model.desktopViewportSize.height),
    });
    model.setShowViewportMenu(true);
    model.setShowCustomViewportEditor(true);
  }, [model]);

  const handleApplyDesktopViewport = useCallback(() => {
    const width = parseDesktopViewportValue(model.desktopViewportDraft.width);
    const height = parseDesktopViewportValue(model.desktopViewportDraft.height);

    if (!width || !height) {
      model.setCapabilitiesError('Use desktop viewport values between 320 and 4096.');
      return;
    }

    model.setCapabilitiesError(null);
    model.setDesktopViewportSize({ width, height });
    model.setDesktopViewportDraft({ width: String(width), height: String(height) });
    model.setShowCustomViewportEditor(false);
    model.setShowViewportMenu(false);
    if (model.viewportPreset !== 'mobile' && model.previewUrl) {
      applyViewportSelection(model.viewportPreset, { width, height });
    }
  }, [applyViewportSelection, model]);

  return {
    overviewInjectedJavaScript: OVERVIEW_INJECTED_JAVASCRIPT,
    handleOverviewMessage,
    applyViewportSelection,
    handleSelectDesktopPreset,
    handleOpenViewportMenu,
    handleCloseViewportMenu,
    handleShowCustomViewportEditor,
    handleApplyDesktopViewport,
  };
}
