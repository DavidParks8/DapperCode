import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import { StyleSheet } from 'react-native';

import { MermaidFrame, type MermaidFrameHandle } from './MermaidFrame';
import {
  MERMAID_MAX_SOURCE_BYTES,
  MERMAID_MAX_SVG_BYTES,
  MERMAID_FRAME_STARTUP_TIMEOUT_MS,
  MERMAID_RENDER_TIMEOUT_MS,
  parseMermaidFrameMessage,
  utf8ByteLength,
  type MermaidRenderCommand,
  type MermaidThemePayload,
} from './mermaidProtocol';

const CACHE_MAX_BYTES = 8 * 1024 * 1024;
export const MERMAID_CACHE_MAX_ENTRIES = 32;
export const MERMAID_MAX_QUEUED_RENDERS = 16;
export const MERMAID_MAX_QUEUED_SOURCE_BYTES = 512 * 1024;

export interface MermaidRenderResult {
  svg: string;
  width: number;
  height: number;
}

interface MermaidRenderer {
  render: (
    source: string,
    theme: MermaidThemePayload,
    signal?: AbortSignal,
  ) => Promise<MermaidRenderResult>;
}

interface PendingSubscriber {
  resolve: (result: MermaidRenderResult) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort: (() => void) | null;
}

interface PendingRender {
  id: string;
  key: string;
  source: string;
  sourceBytes: number;
  theme: MermaidThemePayload;
  subscribers: Set<PendingSubscriber>;
  timeout: ReturnType<typeof setTimeout> | null;
}

interface CacheEntry {
  result: MermaidRenderResult;
  bytes: number;
}

const sharedCache = new Map<string, CacheEntry>();
let sharedCacheBytes = 0;

export type MermaidRenderState =
  | { status: 'loading'; result: null; error: null }
  | { status: 'ready'; result: MermaidRenderResult; error: null }
  | { status: 'error'; result: null; error: string };

const MermaidRendererContext = createContext<MermaidRenderer | null>(null);

export function MermaidRenderProvider({ children }: PropsWithChildren) {
  const frameRef = useRef<MermaidFrameHandle>(null);
  const frameReadyRef = useRef(false);
  const mountedRef = useRef(true);
  const queueRef = useRef<PendingRender[]>([]);
  const queuedSourceBytesRef = useRef(0);
  const activeRef = useRef<PendingRender | null>(null);
  const inFlightRef = useRef(new Map<string, PendingRender>());
  const nextRequestRef = useRef(0);
  const restartCountRef = useRef(0);
  const fatalErrorRef = useRef<string | null>(null);
  const pumpRef = useRef<() => void>(() => undefined);
  const hostStartupTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hostRequested, setHostRequested] = useState(false);
  const [hostKey, setHostKey] = useState(0);

  const schedulePump = useCallback(() => {
    queueMicrotask(() => {
      if (mountedRef.current) {
        pumpRef.current();
      }
    });
  }, []);

  const rejectPending = useCallback((request: PendingRender, message: string) => {
    if (request.timeout) {
      clearTimeout(request.timeout);
      request.timeout = null;
    }
    inFlightRef.current.delete(request.key);
    for (const subscriber of request.subscribers) {
      if (subscriber.signal && subscriber.onAbort) {
        subscriber.signal.removeEventListener('abort', subscriber.onAbort);
      }
      subscriber.reject(new Error(message));
    }
    request.subscribers.clear();
  }, []);

  const resolvePending = useCallback((request: PendingRender, result: MermaidRenderResult) => {
    if (request.timeout) {
      clearTimeout(request.timeout);
      request.timeout = null;
    }
    inFlightRef.current.delete(request.key);
    for (const subscriber of request.subscribers) {
      if (subscriber.signal && subscriber.onAbort) {
        subscriber.signal.removeEventListener('abort', subscriber.onAbort);
      }
      subscriber.resolve(result);
    }
    request.subscribers.clear();
  }, []);

  const rejectAll = useCallback(
    (message: string) => {
      const active = activeRef.current;
      activeRef.current = null;
      if (active) {
        rejectPending(active, message);
      }
      const queuedRequests = queueRef.current.splice(0);
      queuedSourceBytesRef.current = 0;
      for (const queued of queuedRequests) {
        rejectPending(queued, message);
      }
    },
    [rejectPending],
  );

  const clearHostStartupTimeout = useCallback(() => {
    if (hostStartupTimeoutRef.current) {
      clearTimeout(hostStartupTimeoutRef.current);
      hostStartupTimeoutRef.current = null;
    }
  }, []);

  const restartHost = useCallback(
    (message: string) => {
      clearHostStartupTimeout();
      frameReadyRef.current = false;
      const active = activeRef.current;
      activeRef.current = null;
      if (active) {
        rejectPending(active, message);
      }
      restartCountRef.current += 1;
      if (restartCountRef.current > 2) {
        fatalErrorRef.current = message;
        rejectAll(message);
        setHostRequested(false);
        return;
      }
      setHostKey((current) => current + 1);
    },
    [clearHostStartupTimeout, rejectAll, rejectPending],
  );

  const rejectAndRestartHost = useCallback(
    (message: string) => {
      rejectAll(message);
      restartHost(message);
    },
    [rejectAll, restartHost],
  );

  pumpRef.current = () => {
    if (
      !frameReadyRef.current ||
      activeRef.current ||
      queueRef.current.length === 0 ||
      fatalErrorRef.current
    ) {
      return;
    }
    const request = queueRef.current.shift() as PendingRender;
    queuedSourceBytesRef.current = Math.max(0, queuedSourceBytesRef.current - request.sourceBytes);
    activeRef.current = request;
    const command: MermaidRenderCommand = {
      type: 'render',
      id: request.id,
      source: request.source,
      theme: request.theme,
    };
    if (!frameRef.current?.postMessage(JSON.stringify(command))) {
      restartHost('The Mermaid renderer could not accept this diagram.');
      return;
    }
    request.timeout = setTimeout(() => {
      if (activeRef.current?.id !== request.id) {
        return;
      }
      restartHost('This Mermaid diagram took too long to render.');
    }, MERMAID_RENDER_TIMEOUT_MS);
  };

  const cancelSubscription = useCallback(
    (request: PendingRender, subscriber: PendingSubscriber) => {
      if (!request.subscribers.delete(subscriber)) {
        return;
      }
      if (subscriber.signal && subscriber.onAbort) {
        subscriber.signal.removeEventListener('abort', subscriber.onAbort);
      }
      subscriber.reject(createRenderCancelledError());
      if (request.subscribers.size > 0 || activeRef.current === request) {
        return;
      }
      const queuedIndex = queueRef.current.indexOf(request);
      if (queuedIndex >= 0) {
        queueRef.current.splice(queuedIndex, 1);
        queuedSourceBytesRef.current = Math.max(
          0,
          queuedSourceBytesRef.current - request.sourceBytes,
        );
      }
      inFlightRef.current.delete(request.key);
    },
    [],
  );

  const subscribeToRender = useCallback(
    (request: PendingRender, signal?: AbortSignal): Promise<MermaidRenderResult> => {
      if (signal?.aborted) {
        return Promise.reject(createRenderCancelledError());
      }
      return new Promise<MermaidRenderResult>((resolve, reject) => {
        const subscriber: PendingSubscriber = {
          resolve,
          reject,
          signal,
          onAbort: null,
        };
        if (signal) {
          subscriber.onAbort = () => cancelSubscription(request, subscriber);
          signal.addEventListener('abort', subscriber.onAbort, { once: true });
        }
        request.subscribers.add(subscriber);
      });
    },
    [cancelSubscription],
  );

  const render = useCallback(
    (
      source: string,
      theme: MermaidThemePayload,
      signal?: AbortSignal,
    ): Promise<MermaidRenderResult> => {
      const sourceBytes = utf8ByteLength(source);
      if (sourceBytes > MERMAID_MAX_SOURCE_BYTES) {
        return Promise.reject(new Error('This Mermaid source is too large to render safely.'));
      }
      const key = `${JSON.stringify(theme)}\u0000${source}`;
      const cached = sharedCache.get(key);
      if (cached) {
        sharedCache.delete(key);
        sharedCache.set(key, cached);
        return Promise.resolve(cached.result);
      }
      if (signal?.aborted) {
        return Promise.reject(createRenderCancelledError());
      }
      if (fatalErrorRef.current) {
        fatalErrorRef.current = null;
        restartCountRef.current = 0;
        frameReadyRef.current = false;
        setHostKey((current) => current + 1);
      }
      const inFlight = inFlightRef.current.get(key);
      if (inFlight) {
        return subscribeToRender(inFlight, signal);
      }
      if (queueRef.current.length >= MERMAID_MAX_QUEUED_RENDERS) {
        return Promise.reject(
          new Error('Too many Mermaid diagrams are waiting to render. Try this diagram again.'),
        );
      }
      if (queuedSourceBytesRef.current + sourceBytes > MERMAID_MAX_QUEUED_SOURCE_BYTES) {
        return Promise.reject(
          new Error('The queued Mermaid source is too large to render safely.'),
        );
      }

      nextRequestRef.current += 1;
      const request: PendingRender = {
        id: `render-${String(nextRequestRef.current)}`,
        key,
        source,
        sourceBytes,
        theme,
        subscribers: new Set(),
        timeout: null,
      };
      inFlightRef.current.set(key, request);
      queueRef.current.push(request);
      queuedSourceBytesRef.current += sourceBytes;
      setHostRequested(true);
      schedulePump();
      return subscribeToRender(request, signal);
    },
    [schedulePump, subscribeToRender],
  );

  const handleFrameMessage = useCallback(
    (raw: unknown) => {
      const message = parseMermaidFrameMessage(raw);
      if (!message) {
        return;
      }
      if (message.type === 'ready') {
        clearHostStartupTimeout();
        frameReadyRef.current = true;
        schedulePump();
        return;
      }
      const active = activeRef.current;
      if (!active || message.id !== active.id) {
        return;
      }
      activeRef.current = null;
      restartCountRef.current = 0;

      if (message.type === 'rendered') {
        if (!message.svg) {
          rejectPending(active, 'The Mermaid renderer returned no displayable SVG.');
        } else if (utf8ByteLength(message.svg) > MERMAID_MAX_SVG_BYTES) {
          rejectPending(active, 'This Mermaid diagram is too complex to display safely.');
        } else {
          const result = { svg: message.svg, width: message.width, height: message.height };
          restartCountRef.current = 0;
          cacheResult(active.key, result);
          resolvePending(active, result);
        }
      } else if (message.type === 'error') {
        rejectPending(active, message.message);
      } else {
        rejectPending(active, 'The Mermaid renderer returned an unexpected response.');
      }
      schedulePump();
    },
    [clearHostStartupTimeout, rejectPending, resolvePending, schedulePump],
  );

  useEffect(() => {
    if (!hostRequested || frameReadyRef.current || fatalErrorRef.current) {
      return;
    }
    clearHostStartupTimeout();
    hostStartupTimeoutRef.current = setTimeout(() => {
      hostStartupTimeoutRef.current = null;
      rejectAndRestartHost('The Mermaid renderer took too long to start.');
    }, MERMAID_FRAME_STARTUP_TIMEOUT_MS);
    return clearHostStartupTimeout;
  }, [clearHostStartupTimeout, hostKey, hostRequested, rejectAndRestartHost]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearHostStartupTimeout();
      rejectAll('The Mermaid renderer was closed.');
    };
  }, [clearHostStartupTimeout, rejectAll]);

  const renderer = useMemo<MermaidRenderer>(() => ({ render }), [render]);

  return (
    <MermaidRendererContext.Provider value={renderer}>
      {children}
      {hostRequested ? (
        <MermaidFrame
          key={hostKey}
          ref={frameRef}
          testID="mermaid-render-host"
          style={styles.hiddenHost}
          onMessage={handleFrameMessage}
          onError={(message) => {
            if (frameReadyRef.current || activeRef.current) {
              restartHost(message);
            } else {
              rejectAndRestartHost(message);
            }
          }}
          onProcessTerminated={() => {
            const message = 'The Mermaid renderer stopped unexpectedly. Try the diagram again.';
            if (frameReadyRef.current || activeRef.current) {
              restartHost(message);
            } else {
              rejectAndRestartHost(message);
            }
          }}
        />
      ) : null}
    </MermaidRendererContext.Provider>
  );
}

export function useMermaidRender(source: string, theme: MermaidThemePayload): MermaidRenderState {
  const renderer = useContext(MermaidRendererContext);
  const [state, setState] = useState<MermaidRenderState>({
    status: 'loading',
    result: null,
    error: null,
  });

  useEffect(() => {
    let current = true;
    setState({ status: 'loading', result: null, error: null });
    if (!renderer) {
      setState({
        status: 'error',
        result: null,
        error: 'The Mermaid renderer is unavailable.',
      });
      return () => {
        current = false;
      };
    }
    const controller = new AbortController();
    void renderer.render(source, theme, controller.signal).then(
      (result) => {
        if (current) {
          setState({ status: 'ready', result, error: null });
        }
      },
      (error: unknown) => {
        if (current) {
          setState({
            status: 'error',
            result: null,
            error:
              error instanceof Error && error.message.trim()
                ? error.message
                : 'Mermaid could not render this diagram.',
          });
        }
      },
    );
    return () => {
      current = false;
      controller.abort();
    };
  }, [renderer, source, theme]);

  return state;
}

const styles = StyleSheet.create({
  hiddenHost: {
    position: 'absolute',
    left: -4,
    top: -4,
    width: 2,
    height: 2,
    opacity: 0.01,
  },
});

function createRenderCancelledError(): Error {
  const error = new Error('The Mermaid render was cancelled.');
  error.name = 'AbortError';
  return error;
}

function cacheResult(key: string, result: MermaidRenderResult): void {
  const existing = sharedCache.get(key);
  if (existing) {
    sharedCache.delete(key);
    sharedCacheBytes -= existing.bytes;
  }
  const bytes = utf8ByteLength(result.svg);
  sharedCache.set(key, { result, bytes });
  sharedCacheBytes += bytes;
  while (sharedCache.size > MERMAID_CACHE_MAX_ENTRIES || sharedCacheBytes > CACHE_MAX_BYTES) {
    const oldestKey = sharedCache.keys().next().value as string;
    const oldest = sharedCache.get(oldestKey) as CacheEntry;
    sharedCache.delete(oldestKey);
    sharedCacheBytes -= oldest.bytes;
  }
}

export function clearMermaidRenderCacheForTests(): void {
  sharedCache.clear();
  sharedCacheBytes = 0;
}
