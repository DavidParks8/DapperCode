import { useAtomValue } from 'jotai';
import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { Animated as RNAnimated, BackHandler, Platform, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAppTheme } from '@shared/theme';
import { GlassSurface } from '@shared/ui/glass/GlassSurface';
import { BrowserPreviewSurface } from './PreviewSurface';
import { BrowserBottomBar, BrowserStartPage } from './StartBottom';
import { BrowserChatReturn, BrowserTopBar, StatusBanner, ViewportTray } from './TopSections';
import { ViewportMenu } from './ViewportMenu';
import { createBrowserScreenStyles } from './styles';
import { useSceneHorizontalInsets } from '@shell/layout/useShellLayout';
import {
  SceneVerticalToolbar,
  useDrawerNavigationItem,
  useInlineToolbar,
  type SceneToolbarItem,
} from '@shell/layout/SceneToolbar';
import { drawerCommandsAtom } from '@shell/state/drawer/atoms';
import { useBrowserScreenCoreHandlers } from './useCoreHandlers';
import { useBrowserScreenModel } from './useModel';
import { useBrowserScreenViewport } from './useViewport';

export function BrowserScreen() {
  const theme = useAppTheme();
  const styles = useMemo(() => createBrowserScreenStyles(theme), [theme]);
  const model = useBrowserScreenModel(theme);
  const handlers = useBrowserScreenCoreHandlers(model);
  const handleGoBackPress = handlers.handleGoBackPress;
  const viewport = useBrowserScreenViewport(model);
  const drawerCommands = useAtomValue(drawerCommandsAtom);
  const sceneInsets = useSceneHorizontalInsets();
  const inlineToolbar = useInlineToolbar();
  const navigationItem = useDrawerNavigationItem();
  const toolbarItems = buildBrowserToolbarItems(navigationItem, model, handlers);

  useFocusEffect(
    useCallback(() => {
      if (Platform.OS === 'web') {
        return;
      }
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        if (!model.previewUrl || !model.canGoBack) {
          return false;
        }
        handleGoBackPress();
        return true;
      });
      return () => subscription.remove();
    }, [handleGoBackPress, model.canGoBack, model.previewUrl]),
  );

  return (
    <View style={styles.container}>
      <GlassSurface
        role="chrome"
        style={styles.chromeSurface}
        testID="browser-top-chrome-glass-surface"
      >
        <SafeAreaView edges={['top']} style={sceneInsets}>
          <View style={styles.chrome}>
            <BrowserChatReturn />
            <BrowserTopBar
              onOpenDrawer={inlineToolbar ? drawerCommands?.toggleNavigation : undefined}
              inputValue={model.inputValue}
              setInputValue={model.setInputValue}
              previewUrl={model.previewUrl}
              submitDisabled={model.submitDisabled}
              supportsBrowserPreview={model.supportsBrowserPreview}
              openingPreview={model.openingPreview}
              handleSubmitInput={handlers.handleSubmitInput}
            />
            <ViewportTray
              previewUrl={model.previewUrl}
              viewportPreset={model.viewportPreset}
              desktopViewportLabel={model.desktopViewportLabel}
              desktopModeEnabled={model.desktopModeEnabled}
              showViewportMenu={model.showViewportMenu}
              applyViewportSelection={viewport.applyViewportSelection}
              handleOpenViewportMenu={viewport.handleOpenViewportMenu}
            />
          </View>
        </SafeAreaView>
      </GlassSurface>

      <View style={sceneInsets}>
        {model.capabilitiesError ? (
          <StatusBanner tone="error" message={model.capabilitiesError} />
        ) : null}
        {!model.supportsBrowserPreview ? (
          <StatusBanner
            tone="warning"
            message="This bridge did not start its preview server. Check bridge logs for preview port conflicts."
          />
        ) : null}
      </View>

      <ViewportMenu
        showViewportMenu={model.showViewportMenu}
        handleCloseViewportMenu={viewport.handleCloseViewportMenu}
        viewportMenuFocusRef={model.viewportMenuFocusRef}
        desktopViewportSize={model.desktopViewportSize}
        showCustomViewportEditor={model.showCustomViewportEditor}
        desktopViewportMatchesPreset={model.desktopViewportMatchesPreset}
        desktopViewportDraft={model.desktopViewportDraft}
        setDesktopViewportDraft={model.setDesktopViewportDraft}
        handleSelectDesktopPreset={viewport.handleSelectDesktopPreset}
        handleShowCustomViewportEditor={viewport.handleShowCustomViewportEditor}
        handleApplyDesktopViewport={viewport.handleApplyDesktopViewport}
      />

      <View style={[styles.contentArea, sceneInsets]}>
        {model.previewUrl ? (
          <BrowserPreviewSurface
            previewUrl={model.previewUrl}
            loadingPreview={model.loadingPreview}
            desktopOverviewEnabled={model.desktopOverviewEnabled}
            nativeOverviewShellEnabled={model.nativeOverviewShellEnabled}
            overviewReady={model.overviewReady}
            desktopModeEnabled={model.desktopModeEnabled}
            theme={theme}
            bottomBarReservedSpace={model.bottomBarReservedSpace}
            webReloadKey={model.webReloadKey}
            nativeReloadKey={model.nativeReloadKey}
            viewportPreset={model.viewportPreset}
            pageTitle={model.pageTitle}
            siteLabel={model.siteLabel}
            iframeStyle={model.iframeStyle}
            handleNativePreviewViewportLayout={handlers.handleNativePreviewViewportLayout}
            nativeShellMode={model.nativeShellMode}
            webViewRef={model.webViewRef}
            webViewBottomInset={model.webViewBottomInset}
            nativeContentMode={model.nativeContentMode}
            nativeUserAgent={model.nativeUserAgent}
            handleDesktopFrameMessage={handlers.handleDesktopFrameMessage}
            handleNavigationStateChange={handlers.handleNavigationStateChange}
            handleShouldStartLoad={handlers.handleShouldStartLoad}
            handleContentProcessDidTerminate={handlers.handleContentProcessDidTerminate}
            setLoadingPreview={model.setLoadingPreview}
            setCapabilitiesError={model.setCapabilitiesError}
            desktopScrollViewRef={model.desktopScrollViewRef}
            desktopMinimumZoomScale={model.desktopMinimumZoomScale}
            desktopViewportSize={model.desktopViewportSize}
            desktopCanvasHeight={model.desktopCanvasHeight}
            overviewInjectedJavaScript={viewport.overviewInjectedJavaScript}
            handleOverviewMessage={viewport.handleOverviewMessage}
            handleWebViewScroll={handlers.handleWebViewScroll}
          />
        ) : (
          <BrowserStartPage
            suggestionsLoading={model.suggestionsLoading}
            suggestions={model.suggestions}
            recentTargetUrls={model.recentTargetUrls}
            bottomBarReservedSpace={model.bottomBarReservedSpace}
            openPreview={model.openPreview}
          />
        )}
      </View>

      {inlineToolbar ? (
        <RNAnimated.View
          style={[
            styles.bottomBarWrap,
            { left: sceneInsets.paddingLeft, right: sceneInsets.paddingRight },
            {
              paddingBottom: model.bottomBarInset,
              transform: [{ translateY: model.bottomBarTranslateY }],
            },
          ]}
        >
          <BrowserBottomBar
            canGoBack={model.canGoBack}
            canGoForward={model.canGoForward}
            loadingPreview={model.loadingPreview}
            previewUrl={model.previewUrl}
            handleGoBackPress={handlers.handleGoBackPress}
            handleGoForwardPress={handlers.handleGoForwardPress}
            handleReload={handlers.handleReload}
            handleShowStartPage={handlers.handleShowStartPage}
            loadSuggestions={model.loadSuggestions}
          />
        </RNAnimated.View>
      ) : null}
      <SceneVerticalToolbar items={toolbarItems} />
    </View>
  );
}

function buildBrowserToolbarItems(
  navigationItem: SceneToolbarItem | null,
  model: ReturnType<typeof useBrowserScreenModel>,
  handlers: ReturnType<typeof useBrowserScreenCoreHandlers>,
): SceneToolbarItem[] {
  const webNavigationDisabled = Platform.OS === 'web';
  return [
    ...(navigationItem ? [navigationItem] : []),
    {
      key: 'back',
      icon: 'chevron-back',
      label: 'Back',
      onPress: handlers.handleGoBackPress,
      group: 'bottom',
      disabled: webNavigationDisabled || !model.canGoBack,
    },
    {
      key: 'forward',
      icon: 'chevron-forward',
      label: 'Forward',
      onPress: handlers.handleGoForwardPress,
      group: 'bottom',
      disabled: webNavigationDisabled || !model.canGoForward,
    },
    {
      key: 'reload',
      icon: model.loadingPreview ? 'hourglass-outline' : 'refresh-outline',
      label: model.loadingPreview
        ? 'Preview loading'
        : model.previewUrl
          ? 'Reload preview'
          : 'Scan for local previews',
      onPress: handlers.handleReload,
      group: 'bottom',
      priority: 1,
    },
    {
      key: 'start',
      icon: model.previewUrl ? 'home-outline' : 'scan-outline',
      label: model.previewUrl ? 'Show preview start page' : 'Scan for local previews',
      onPress: model.previewUrl ? handlers.handleShowStartPage : () => void model.loadSuggestions(),
      group: 'bottom',
    },
  ];
}
