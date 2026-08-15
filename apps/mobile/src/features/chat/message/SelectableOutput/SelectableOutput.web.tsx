import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { StyleSheet, View } from 'react-native';

import { useAppTheme } from '@shared/theme';
import {
  createSelectableOutputHtml,
  estimateSelectableOutputHeight,
  parseSelectableOutputFrameMessage,
  selectableOutputHtmlStyle,
  stripTrailingLineBreak,
} from './selectableOutputProtocol';
import type { SelectableOutputProps } from './SelectableOutput';

export function SelectableOutput({
  text,
  style,
  testID,
  accessibilityLabel,
}: SelectableOutputProps): ReactElement | null {
  const theme = useAppTheme();
  const htmlStyle = useMemo(() => selectableOutputHtmlStyle(theme), [theme]);
  const normalizedText = useMemo(() => stripTrailingLineBreak(text), [text]);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(() =>
    estimateSelectableOutputHeight(normalizedText, htmlStyle.lineHeight),
  );
  const srcDoc = useMemo(
    () => createSelectableOutputHtml(normalizedText, htmlStyle),
    [normalizedText, htmlStyle],
  );

  const handleMessage = useCallback((event: MessageEvent<unknown>) => {
    if (event.source !== frameRef.current?.contentWindow) {
      return;
    }
    const message = parseSelectableOutputFrameMessage(event.data);
    if (!message) {
      return;
    }
    if (message.type === 'height') {
      setHeight(message.height);
    }
  }, []);

  useEffect(() => {
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [handleMessage]);

  if (normalizedText.length === 0) {
    return null;
  }

  const label = accessibilityLabel ?? normalizedText;

  return (
    <View style={[styles.container, style]} testID={testID} accessible accessibilityLabel={label}>
      {createElement('iframe', {
        ref: frameRef,
        srcDoc,
        title: 'Selectable tool output',
        sandbox: 'allow-scripts',
        referrerPolicy: 'no-referrer',
        style: { ...iframeStyle, height },
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
});

const iframeStyle: CSSProperties = {
  width: '100%',
  border: 0,
  display: 'block',
  background: 'transparent',
};
