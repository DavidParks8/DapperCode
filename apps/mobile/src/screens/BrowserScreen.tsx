import { useAtomValue, useSetAtom } from 'jotai';
import { useEffect, useMemo } from 'react';
import { Animated as RNAnimated, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAppTheme } from '../theme';
import { BrowserPreviewSurface } from './BrowserPreviewSurface';
import { BrowserBottomBar, BrowserStartPage } from './BrowserScreenStartBottom';
import { BrowserTopBar, StatusBanner, ViewportTray } from './BrowserScreenTopSections';
import { ViewportMenu } from './BrowserScreenViewportMenu';
import { createBrowserScreenStyles } from './browserScreenStyles';
import { browserScreenCommandsAtom } from '../state/commands';
import { drawerCommandsAtom } from '../state/drawer/atoms';
import { useBrowserScreenCoreHandlers } from './useBrowserScreenCoreHandlers';
import { useBrowserScreenModel } from './useBrowserScreenModel';
import { useBrowserScreenViewport } from './useBrowserScreenViewport';

export { type BrowserScreenHandle } from './browserScreenShared';

export function BrowserScreen() {
    const theme = useAppTheme();
    const styles = useMemo(() => createBrowserScreenStyles(theme), [theme]);
    const model = useBrowserScreenModel(theme);
    const handlers = useBrowserScreenCoreHandlers(model);
    const viewport = useBrowserScreenViewport(model);
    const drawerCommands = useAtomValue(drawerCommandsAtom);
    const setBrowserCommands = useSetAtom(browserScreenCommandsAtom);

    useEffect(() => {
      setBrowserCommands({
        handleHardwareBackPress: () => {
          if (!model.previewUrl || !model.canGoBack) {
            return false;
          }
          handlers.handleGoBackPress();
          return true;
        },
      });
      return () => {
        setBrowserCommands(null);
      };
    }, [handlers, model.canGoBack, model.previewUrl, setBrowserCommands]);

    return (
      <View style={styles.container}>
        <SafeAreaView edges={['top']} style={styles.safeArea}>
          <View style={styles.chrome}>
            <BrowserTopBar
              onOpenDrawer={() => drawerCommands?.toggleNavigation()}
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

          {model.capabilitiesError ? (
            <StatusBanner tone="error" message={model.capabilitiesError} />
          ) : null}
          {!model.supportsBrowserPreview ? (
            <StatusBanner
              tone="warning"
              message="This bridge did not start its preview server. Check bridge logs for preview port conflicts."
            />
          ) : null}

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

          <View style={styles.contentArea}>
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

          <RNAnimated.View
            style={[
              styles.bottomBarWrap,
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
        </SafeAreaView>
      </View>
    );
}
