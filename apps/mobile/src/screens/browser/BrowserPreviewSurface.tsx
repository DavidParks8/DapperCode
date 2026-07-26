import { createElement, type CSSProperties } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from 'react-native-webview';

import type { AppTheme } from '../../theme';
import { createBrowserScreenStyles } from './browserScreenStyles';
import type { ViewportPreset, WebViewScrollEvent } from './browserScreenShared';

export function BrowserPreviewSurface({
  previewUrl,
  loadingPreview,
  desktopOverviewEnabled,
  nativeOverviewShellEnabled,
  overviewReady,
  desktopModeEnabled,
  theme,
  bottomBarReservedSpace,
  webReloadKey,
  nativeReloadKey,
  viewportPreset,
  pageTitle,
  siteLabel,
  iframeStyle,
  handleNativePreviewViewportLayout,
  nativeShellMode,
  webViewRef,
  webViewBottomInset,
  nativeContentMode,
  nativeUserAgent,
  handleDesktopFrameMessage,
  handleNavigationStateChange,
  handleShouldStartLoad,
  handleContentProcessDidTerminate,
  setLoadingPreview,
  setCapabilitiesError,
  desktopScrollViewRef,
  desktopMinimumZoomScale,
  desktopViewportSize,
  desktopCanvasHeight,
  overviewInjectedJavaScript,
  handleOverviewMessage,
  handleWebViewScroll,
}: {
  previewUrl: string;
  loadingPreview: boolean;
  desktopOverviewEnabled: boolean;
  nativeOverviewShellEnabled: boolean;
  overviewReady: boolean;
  desktopModeEnabled: boolean;
  theme: AppTheme;
  bottomBarReservedSpace: number;
  webReloadKey: number;
  nativeReloadKey: number;
  viewportPreset: ViewportPreset;
  pageTitle: string | null;
  siteLabel: string;
  iframeStyle: CSSProperties;
  handleNativePreviewViewportLayout: (event: LayoutChangeEvent) => void;
  nativeShellMode: string | null;
  webViewRef: React.RefObject<WebView | null>;
  webViewBottomInset: number;
  nativeContentMode: 'mobile' | 'desktop' | undefined;
  nativeUserAgent: string | undefined;
  handleDesktopFrameMessage: (event: WebViewMessageEvent) => void;
  handleNavigationStateChange: (navigation: WebViewNavigation) => void;
  handleShouldStartLoad: (request: { url: string }) => boolean;
  handleContentProcessDidTerminate: () => void;
  setLoadingPreview: (value: boolean) => void;
  setCapabilitiesError: (value: string | null) => void;
  desktopScrollViewRef: React.RefObject<ScrollView | null>;
  desktopMinimumZoomScale: number;
  desktopViewportSize: { width: number; height: number };
  desktopCanvasHeight: number;
  overviewInjectedJavaScript: string;
  handleOverviewMessage: (event: WebViewMessageEvent) => void;
  handleWebViewScroll: (event: WebViewScrollEvent) => void;
}) {
  const styles = createBrowserScreenStyles(theme);

  return (
    <View
      style={[
        styles.previewSurface,
        {
          marginBottom: Platform.OS === 'web' ? bottomBarReservedSpace : 0,
          backgroundColor: desktopModeEnabled ? theme.colors.black : theme.colors.bgMain,
        },
      ]}
    >
      {Platform.OS === 'web' ? (
        desktopModeEnabled ? (
          <ScrollView
            horizontal
            style={styles.previewViewport}
            contentContainerStyle={styles.desktopScrollContent}
            showsHorizontalScrollIndicator
            bounces={false}
            directionalLockEnabled
            nestedScrollEnabled
          >
            {createElement('iframe', {
              key: `${previewUrl}-${webReloadKey}-desktop`,
              src: previewUrl,
              title: pageTitle?.trim() || siteLabel,
              style: iframeStyle,
              onLoad: () => setLoadingPreview(false),
            })}
          </ScrollView>
        ) : (
          <View style={styles.previewViewport}>
            {createElement('iframe', {
              key: `${previewUrl}-${webReloadKey}-mobile`,
              src: previewUrl,
              title: pageTitle?.trim() || siteLabel,
              style: iframeStyle,
              onLoad: () => setLoadingPreview(false),
            })}
          </View>
        )
      ) : desktopModeEnabled ? (
        <View style={styles.previewViewport} onLayout={handleNativePreviewViewportLayout}>
          {nativeShellMode ? (
            <View style={styles.previewViewport}>
              <WebView
                key={`${previewUrl}-${nativeReloadKey}-${viewportPreset}`}
                ref={webViewRef}
                source={{ uri: previewUrl }}
                originWhitelist={['*']}
                javaScriptEnabled
                domStorageEnabled
                sharedCookiesEnabled
                thirdPartyCookiesEnabled
                allowsBackForwardNavigationGestures
                startInLoadingState
                setSupportMultipleWindows={false}
                automaticallyAdjustContentInsets={false}
                automaticallyAdjustsScrollIndicatorInsets={false}
                contentInset={{ top: 0, left: 0, right: 0, bottom: webViewBottomInset }}
                contentInsetAdjustmentBehavior="never"
                contentMode={nativeContentMode}
                scalesPageToFit={false}
                setBuiltInZoomControls
                setDisplayZoomControls={false}
                userAgent={nativeUserAgent}
                onMessage={handleDesktopFrameMessage}
                onNavigationStateChange={handleNavigationStateChange}
                onShouldStartLoadWithRequest={handleShouldStartLoad}
                onLoadStart={() => setLoadingPreview(true)}
                onLoadEnd={() => setLoadingPreview(false)}
                onContentProcessDidTerminate={handleContentProcessDidTerminate}
                onError={(event) =>
                  setCapabilitiesError(event.nativeEvent.description || 'Could not load preview.')
                }
                onHttpError={(event) =>
                  setCapabilitiesError(
                    `Preview returned HTTP ${String(event.nativeEvent.statusCode)}.`,
                  )
                }
                style={styles.webView}
              />
            </View>
          ) : (
            <ScrollView
              key={`${previewUrl}-${nativeReloadKey}-${viewportPreset}-shell`}
              ref={desktopScrollViewRef}
              style={styles.previewViewport}
              contentContainerStyle={styles.desktopNativeScrollContent}
              horizontal
              showsHorizontalScrollIndicator
              showsVerticalScrollIndicator
              bounces={false}
              alwaysBounceHorizontal={false}
              alwaysBounceVertical={false}
              directionalLockEnabled={false}
              pinchGestureEnabled={Platform.OS === 'ios'}
              scrollEnabled
              minimumZoomScale={desktopMinimumZoomScale}
              maximumZoomScale={3}
              bouncesZoom={false}
            >
              <View
                style={[
                  styles.desktopNativeCanvas,
                  {
                    width: desktopViewportSize.width,
                    height: desktopCanvasHeight,
                  },
                ]}
              >
                <WebView
                  key={`${previewUrl}-${nativeReloadKey}-${viewportPreset}`}
                  ref={webViewRef}
                  source={{ uri: previewUrl }}
                  originWhitelist={['*']}
                  javaScriptEnabled
                  domStorageEnabled
                  sharedCookiesEnabled
                  thirdPartyCookiesEnabled
                  allowsBackForwardNavigationGestures
                  startInLoadingState
                  setSupportMultipleWindows={false}
                  automaticallyAdjustContentInsets={false}
                  automaticallyAdjustsScrollIndicatorInsets={false}
                  contentInset={{ top: 0, left: 0, right: 0, bottom: webViewBottomInset }}
                  contentInsetAdjustmentBehavior="never"
                  injectedJavaScript={overviewInjectedJavaScript}
                  onMessage={handleOverviewMessage}
                  scrollEnabled={false}
                  contentMode={nativeContentMode}
                  scalesPageToFit
                  setBuiltInZoomControls
                  setDisplayZoomControls={false}
                  userAgent={nativeUserAgent}
                  onNavigationStateChange={handleNavigationStateChange}
                  onShouldStartLoadWithRequest={handleShouldStartLoad}
                  onLoadStart={() => setLoadingPreview(true)}
                  onLoadEnd={() => setLoadingPreview(false)}
                  onContentProcessDidTerminate={handleContentProcessDidTerminate}
                  onError={(event) =>
                    setCapabilitiesError(event.nativeEvent.description || 'Could not load preview.')
                  }
                  onHttpError={(event) =>
                    setCapabilitiesError(
                      `Preview returned HTTP ${String(event.nativeEvent.statusCode)}.`,
                    )
                  }
                  style={[
                    styles.desktopNativeWebView,
                    {
                      width: desktopViewportSize.width,
                      height: desktopCanvasHeight,
                    },
                  ]}
                />
              </View>
            </ScrollView>
          )}
        </View>
      ) : (
        <View style={styles.previewViewport}>
          <WebView
            key={`${previewUrl}-${nativeReloadKey}-${viewportPreset}`}
            ref={webViewRef}
            source={{ uri: previewUrl }}
            originWhitelist={['*']}
            javaScriptEnabled
            domStorageEnabled
            sharedCookiesEnabled
            thirdPartyCookiesEnabled
            allowsBackForwardNavigationGestures
            startInLoadingState
            setSupportMultipleWindows={false}
            automaticallyAdjustContentInsets={false}
            automaticallyAdjustsScrollIndicatorInsets={false}
            contentInset={{ top: 0, left: 0, right: 0, bottom: webViewBottomInset }}
            contentInsetAdjustmentBehavior="never"
            contentMode={nativeContentMode}
            scalesPageToFit
            setBuiltInZoomControls
            setDisplayZoomControls={false}
            userAgent={nativeUserAgent}
            onNavigationStateChange={handleNavigationStateChange}
            onShouldStartLoadWithRequest={handleShouldStartLoad}
            onLoadStart={() => setLoadingPreview(true)}
            onLoadEnd={() => setLoadingPreview(false)}
            onContentProcessDidTerminate={handleContentProcessDidTerminate}
            onScroll={handleWebViewScroll}
            onError={(event) =>
              setCapabilitiesError(event.nativeEvent.description || 'Could not load preview.')
            }
            onHttpError={(event) =>
              setCapabilitiesError(`Preview returned HTTP ${String(event.nativeEvent.statusCode)}.`)
            }
            style={styles.webView}
          />
        </View>
      )}
      {loadingPreview ||
      (desktopOverviewEnabled && !nativeOverviewShellEnabled && !overviewReady) ? (
        <View
          style={styles.loadingOverlay}
          accessibilityRole="progressbar"
          accessibilityLabel="Loading preview"
          accessibilityLiveRegion="polite"
        >
          <ActivityIndicator color={theme.colors.textPrimary} />
          <Text style={styles.loadingText}>Loading preview</Text>
        </View>
      ) : null}
    </View>
  );
}
