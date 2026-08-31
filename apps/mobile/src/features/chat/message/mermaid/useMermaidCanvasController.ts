import { useCallback, useEffect, useRef } from 'react';

import {
  MERMAID_RENDER_TIMEOUT_MS,
  parseMermaidFrameMessage,
  type MermaidControlCommand,
  type MermaidDisplayCommand,
} from './mermaidProtocol';

let nextRequestId = 0;

interface MermaidCanvasControllerOptions {
  svg: string;
  width: number;
  height: number;
  frameReady: boolean;
  postMessage: (message: string) => boolean;
  onFrameReady: () => void;
  onRendered: () => void;
  onError: (message: string) => void;
  onZoomChange?: (zoom: number) => void;
}

export interface MermaidCanvasController {
  handleFrameMessage: (raw: unknown) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
}

export function useMermaidCanvasController({
  svg,
  width,
  height,
  frameReady,
  postMessage,
  onFrameReady,
  onRendered,
  onError,
  onZoomChange,
}: MermaidCanvasControllerOptions): MermaidCanvasController {
  const displayCommandRef = useRef<{
    svg: string;
    width: number;
    height: number;
    command: MermaidDisplayCommand;
  } | null>(null);
  if (
    !displayCommandRef.current ||
    displayCommandRef.current.svg !== svg ||
    displayCommandRef.current.width !== width ||
    displayCommandRef.current.height !== height
  ) {
    nextRequestId += 1;
    displayCommandRef.current = {
      svg,
      width,
      height,
      command: {
        type: 'display',
        id: `viewer-${String(nextRequestId)}`,
        svg,
        width,
        height,
      },
    };
  }
  const displayCommand = displayCommandRef.current.command;
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbacksRef = useRef({ onFrameReady, onRendered, onError, onZoomChange });
  callbacksRef.current = { onFrameReady, onRendered, onError, onZoomChange };

  const clearRenderTimeout = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!frameReady) {
      return;
    }
    clearRenderTimeout();
    if (!postMessage(JSON.stringify(displayCommand))) {
      callbacksRef.current.onError('The Mermaid viewer could not start.');
      return;
    }
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      callbacksRef.current.onError('The full-screen Mermaid diagram took too long to open.');
    }, MERMAID_RENDER_TIMEOUT_MS);
    return clearRenderTimeout;
  }, [clearRenderTimeout, displayCommand, frameReady, postMessage]);

  useEffect(() => clearRenderTimeout, [clearRenderTimeout]);

  const handleFrameMessage = useCallback(
    (raw: unknown) => {
      const message = parseMermaidFrameMessage(raw);
      if (!message) {
        return;
      }
      if (message.type === 'ready') {
        callbacksRef.current.onFrameReady();
        return;
      }
      if (message.id !== displayCommand.id) {
        return;
      }
      if (message.type === 'rendered') {
        clearRenderTimeout();
        callbacksRef.current.onRendered();
      } else if (message.type === 'error') {
        clearRenderTimeout();
        callbacksRef.current.onError(message.message);
      } else if (message.type === 'viewState') {
        callbacksRef.current.onZoomChange?.(message.zoom);
      }
    },
    [clearRenderTimeout, displayCommand.id],
  );

  const sendControl = useCallback(
    (type: MermaidControlCommand['type']) => {
      if (!frameReady) {
        return;
      }
      const command: MermaidControlCommand = { type, id: displayCommand.id };
      postMessage(JSON.stringify(command));
    },
    [displayCommand.id, frameReady, postMessage],
  );

  return {
    handleFrameMessage,
    zoomIn: useCallback(() => sendControl('zoomIn'), [sendControl]),
    zoomOut: useCallback(() => sendControl('zoomOut'), [sendControl]),
    reset: useCallback(() => sendControl('reset'), [sendControl]),
  };
}
