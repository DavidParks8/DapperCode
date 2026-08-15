import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { useAppTheme } from '@shared/theme';
import {
  createSelectableOutputHtml,
  createSelectableOutputSetTextCommand,
  estimateSelectableOutputHeight,
  parseSelectableOutputFrameMessage,
  selectableOutputHtmlStyle,
  stripTrailingLineBreak,
} from './selectableOutputProtocol';

export interface SelectableOutputProps {
  text: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityLabel?: string;
}

export function SelectableOutput({
  text,
  style,
  testID,
  accessibilityLabel,
}: SelectableOutputProps): ReactElement | null {
  const theme = useAppTheme();
  const htmlStyle = useMemo(() => selectableOutputHtmlStyle(theme), [theme]);
  const normalizedText = useMemo(() => stripTrailingLineBreak(text), [text]);
  const initialTextRef = useRef(normalizedText);
  const latestTextRef = useRef(normalizedText);
  latestTextRef.current = normalizedText;
  const webViewRef = useRef<WebView>(null);
  const readyRef = useRef(false);
  const [failed, setFailed] = useState(false);
  const [height, setHeight] = useState(() =>
    estimateSelectableOutputHeight(initialTextRef.current, htmlStyle.lineHeight),
  );
  const source = useMemo(
    () => ({ html: createSelectableOutputHtml(initialTextRef.current, htmlStyle) }),
    [htmlStyle],
  );

  const pushText = useCallback(() => {
    if (!readyRef.current || !webViewRef.current) {
      return;
    }
    webViewRef.current.postMessage(createSelectableOutputSetTextCommand(latestTextRef.current));
  }, []);

  useEffect(() => {
    pushText();
  }, [pushText, text]);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const message = parseSelectableOutputFrameMessage(event.nativeEvent.data);
      if (!message) {
        return;
      }
      if (message.type === 'ready') {
        readyRef.current = true;
        pushText();
      } else if (message.type === 'height') {
        setHeight(message.height);
      }
    },
    [pushText],
  );

  if (normalizedText.length === 0) {
    return null;
  }

  const label = accessibilityLabel ?? normalizedText;

  return (
    <View style={[styles.container, style]} accessible accessibilityLabel={label}>
      {failed ? (
        <Text style={fallbackTextStyle(htmlStyle)} selectable>
          {normalizedText}
        </Text>
      ) : (
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
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          mixedContentMode="never"
          cacheEnabled={false}
          automaticallyAdjustContentInsets={false}
          contentInsetAdjustmentBehavior="never"
          onMessage={handleMessage}
          onShouldStartLoadWithRequest={(request) =>
            request.url === 'about:blank' || request.url === ''
          }
          onError={() => setFailed(true)}
          onContentProcessDidTerminate={() => setFailed(true)}
          onRenderProcessGone={() => setFailed(true)}
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          containerStyle={[styles.transparent, { height }]}
          style={styles.transparent}
        />
      )}
    </View>
  );
}

function fallbackTextStyle(htmlStyle: ReturnType<typeof selectableOutputHtmlStyle>): {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  color: string;
} {
  return {
    fontFamily: htmlStyle.fontFamily,
    fontSize: htmlStyle.fontSize,
    lineHeight: htmlStyle.lineHeight,
    color: htmlStyle.color,
  };
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
  transparent: {
    flex: 1,
    backgroundColor: 'transparent',
  },
});
