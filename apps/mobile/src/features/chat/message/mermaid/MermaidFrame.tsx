import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';
import { Image, Platform, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import MERMAID_RUNTIME_ASSET from '../../../../../assets/generated/mermaid-renderer.html';

export interface MermaidFrameHandle {
  postMessage: (message: string) => boolean;
}

export interface MermaidFrameProps {
  testID: string;
  style?: StyleProp<ViewStyle>;
  onMessage: (raw: unknown) => void;
  onError: (message: string) => void;
  onProcessTerminated?: () => void;
}

export function resolveMermaidRuntimeUri(uri: string, platform = Platform.OS): string {
  if (platform !== 'android' || /^[a-z][a-z\d+.-]*:/iu.test(uri)) {
    return uri;
  }
  if (!/^[a-z0-9_]+$/u.test(uri)) {
    throw new Error('The packaged Mermaid runtime has an invalid Android resource identifier.');
  }
  return `file:///android_res/raw/${uri}.html`;
}

export const MermaidFrame = forwardRef<MermaidFrameHandle, MermaidFrameProps>(function MermaidFrame(
  { testID, style, onMessage, onError, onProcessTerminated },
  ref,
) {
  const webViewRef = useRef<WebView>(null);
  const source = useMemo(
    () => ({ uri: resolveMermaidRuntimeUri(Image.resolveAssetSource(MERMAID_RUNTIME_ASSET).uri) }),
    [],
  );

  useImperativeHandle(
    ref,
    () => ({
      postMessage: (message: string) => {
        if (!webViewRef.current) {
          return false;
        }
        webViewRef.current.postMessage(message);
        return true;
      },
    }),
    [],
  );

  return (
    <WebView
      ref={webViewRef}
      testID={testID}
      source={source}
      originWhitelist={['*']}
      javaScriptEnabled
      domStorageEnabled={false}
      scrollEnabled={false}
      bounces={false}
      overScrollMode="never"
      setSupportMultipleWindows={false}
      javaScriptCanOpenWindowsAutomatically={false}
      allowFileAccess
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      mixedContentMode="never"
      cacheEnabled={false}
      automaticallyAdjustContentInsets={false}
      contentInsetAdjustmentBehavior="never"
      onMessage={(event: WebViewMessageEvent) => onMessage(event.nativeEvent.data)}
      onShouldStartLoadWithRequest={(request) =>
        request.url === source.uri || request.url === 'about:blank'
      }
      onError={(event) =>
        onError(event.nativeEvent.description || 'The Mermaid renderer could not load.')
      }
      onContentProcessDidTerminate={onProcessTerminated}
      onRenderProcessGone={onProcessTerminated}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      containerStyle={[styles.transparent, style]}
      style={styles.transparent}
    />
  );
});

const styles = StyleSheet.create({
  transparent: {
    flex: 1,
    backgroundColor: 'transparent',
  },
});
