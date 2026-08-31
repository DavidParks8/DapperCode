import {
  createElement,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
} from 'react';
import { Image, StyleSheet, View } from 'react-native';

import MERMAID_RUNTIME_ASSET from '../../../../../assets/generated/mermaid-renderer.html';
import type { MermaidFrameHandle, MermaidFrameProps } from './MermaidFrame';

export function resolveMermaidWebRuntimeUri(
  asset: unknown,
  resolveNativeAsset = (source: number) => Image.resolveAssetSource(source).uri,
): string {
  if (typeof asset === 'string' && asset.length > 0) {
    return asset;
  }
  if (typeof asset === 'number') {
    return resolveNativeAsset(asset);
  }
  throw new Error('The web Mermaid runtime did not resolve to an asset URL.');
}

const runtimeUri = resolveMermaidWebRuntimeUri(MERMAID_RUNTIME_ASSET);

export const MermaidFrame = forwardRef<MermaidFrameHandle, MermaidFrameProps>(function MermaidFrame(
  { testID, style, onMessage, onError },
  ref,
) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      postMessage: (message: string) => {
        if (!frameRef.current?.contentWindow) {
          return false;
        }
        frameRef.current.contentWindow.postMessage(message, '*');
        return true;
      },
    }),
    [],
  );

  useEffect(() => {
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (event.source === frameRef.current?.contentWindow) {
        onMessage(event.data);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onMessage]);

  return (
    <View testID={testID} style={[styles.container, style]}>
      {createElement('iframe', {
        ref: frameRef,
        src: runtimeUri,
        title: testID.includes('host') ? 'Mermaid renderer' : 'Full-screen Mermaid diagram',
        sandbox: 'allow-scripts',
        referrerPolicy: 'no-referrer',
        onError: () => onError('The Mermaid renderer could not load.'),
        style: iframeStyle,
      })}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    overflow: 'hidden',
    backgroundColor: 'transparent',
  },
});

const iframeStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  border: 0,
  display: 'block',
  background: 'transparent',
};
