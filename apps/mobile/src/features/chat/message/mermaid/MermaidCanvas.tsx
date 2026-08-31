import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

import { MermaidFrame, type MermaidFrameHandle } from './MermaidFrame';
import { MERMAID_FRAME_STARTUP_TIMEOUT_MS } from './mermaidProtocol';
import { useMermaidCanvasController } from './useMermaidCanvasController';

export interface MermaidCanvasHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
}

export interface MermaidCanvasProps {
  svg: string;
  width: number;
  height: number;
  style?: StyleProp<ViewStyle>;
  onLoading: () => void;
  onRendered: () => void;
  onError: (message: string) => void;
  onZoomChange?: (zoom: number) => void;
}

export const MermaidCanvas = forwardRef<MermaidCanvasHandle, MermaidCanvasProps>(
  function MermaidCanvas(
    { svg, width, height, style, onLoading, onRendered, onError, onZoomChange },
    ref,
  ) {
    const frameRef = useRef<MermaidFrameHandle>(null);
    const [frameReady, setFrameReady] = useState(false);
    const [processKey, setProcessKey] = useState(0);
    const processRestartsRef = useRef(0);
    const startupTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const onErrorRef = useRef(onError);
    onErrorRef.current = onError;
    const clearStartupTimeout = useCallback(() => {
      if (startupTimeoutRef.current) {
        clearTimeout(startupTimeoutRef.current);
        startupTimeoutRef.current = null;
      }
    }, []);
    useEffect(() => {
      if (frameReady) {
        return;
      }
      clearStartupTimeout();
      startupTimeoutRef.current = setTimeout(() => {
        startupTimeoutRef.current = null;
        onErrorRef.current('The Mermaid viewer took too long to start.');
      }, MERMAID_FRAME_STARTUP_TIMEOUT_MS);
      return clearStartupTimeout;
    }, [clearStartupTimeout, frameReady, processKey]);
    const postMessage = useCallback(
      (message: string) => frameRef.current?.postMessage(message) ?? false,
      [],
    );
    const handleRendered = useCallback(() => {
      processRestartsRef.current = 0;
      onRendered();
    }, [onRendered]);
    const handleFrameReady = useCallback(() => {
      clearStartupTimeout();
      setFrameReady(true);
    }, [clearStartupTimeout]);
    const handleError = useCallback(
      (message: string) => {
        clearStartupTimeout();
        onErrorRef.current(message);
      },
      [clearStartupTimeout],
    );
    const controller = useMermaidCanvasController({
      svg,
      width,
      height,
      frameReady,
      postMessage,
      onFrameReady: handleFrameReady,
      onRendered: handleRendered,
      onError: handleError,
      onZoomChange,
    });
    useImperativeHandle(ref, () => controller, [controller]);

    return (
      <MermaidFrame
        key={processKey}
        ref={frameRef}
        testID="mermaid-canvas-viewer"
        style={style}
        onMessage={controller.handleFrameMessage}
        onError={handleError}
        onProcessTerminated={() => {
          setFrameReady(false);
          onLoading();
          if (processRestartsRef.current >= 1) {
            onErrorRef.current('The Mermaid renderer stopped unexpectedly.');
            return;
          }
          processRestartsRef.current += 1;
          setProcessKey((current) => current + 1);
        }}
      />
    );
  },
);
