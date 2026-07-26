import type { NativeSyntheticEvent } from 'react-native';

export interface BrowserScreenHandle {
  handleHardwareBackPress: () => boolean;
}

export type ViewportPreset = 'mobile' | 'desktop' | 'desktop2';

export type WebViewScrollEvent = NativeSyntheticEvent<
  Readonly<{
    contentOffset: {
      x: number;
      y: number;
    };
  }>
>;

export type DesktopFrameMessage = {
  type: 'dappercodeDesktopFrameState';
  shellRequestKey?: string | null;
  rawUrl?: string;
  title?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
};

export const DEFAULT_DESKTOP_VIEWPORT = { width: 1920, height: 1080 };

export const DESKTOP_VIEWPORT_PRESETS = [
  { label: '1920×1080', width: 1920, height: 1080 },
  { label: '1366×768', width: 1366, height: 768 },
  { label: '1440×900', width: 1440, height: 900 },
  { label: '1512×982', width: 1512, height: 982 },
  { label: '1728×1117', width: 1728, height: 1117 },
];

export const VIEWPORT_MODES = [
  { key: 'mobile', label: 'Mobile' },
  { key: 'desktop', label: 'Desktop' },
  { key: 'desktop2', label: 'Desktop Full' },
] as const;

export const DESKTOP_PREVIEW_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

export const OVERVIEW_INJECTED_JAVASCRIPT = `
  (function() {
    if (window.__dappercodeOverviewMetricsInstalled) {
      true;
      return;
    }
    window.__dappercodeOverviewMetricsInstalled = true;
    var lastHeight = 0;
    function readHeight() {
      var doc = document.documentElement;
      var body = document.body;
      return Math.max(
        Math.ceil(doc ? doc.scrollHeight : 0),
        Math.ceil(body ? body.scrollHeight : 0),
        Math.ceil(window.innerHeight || 0)
      );
    }
    function postHeight() {
      var nextHeight = readHeight();
      if (!nextHeight || nextHeight === lastHeight) {
        return;
      }
      lastHeight = nextHeight;
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'dappercodeOverviewMetrics',
          height: nextHeight
        }));
      }
    }
    if (typeof ResizeObserver === 'function') {
      var resizeObserver = new ResizeObserver(function() {
        postHeight();
      });
      if (document.documentElement) {
        resizeObserver.observe(document.documentElement);
      }
      if (document.body) {
        resizeObserver.observe(document.body);
      }
    }
    if (typeof MutationObserver === 'function' && document.documentElement) {
      var mutationObserver = new MutationObserver(function() {
        postHeight();
      });
      mutationObserver.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
      });
    }
    window.addEventListener('load', postHeight);
    window.addEventListener('resize', postHeight);
    setTimeout(postHeight, 0);
    setTimeout(postHeight, 300);
    setTimeout(postHeight, 1000);
    true;
  })();
`;

export function getCompactBrowserLabel(rawUrl: string | null | undefined): string {
  if (!rawUrl) {
    return 'Local preview';
  }
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
  } catch {
    return rawUrl.replace(/^https?:\/\//, '');
  }
}

export function parseDesktopViewportValue(raw: string): number | null {
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(value) || value < 320 || value > 4096) {
    return null;
  }
  return value;
}
