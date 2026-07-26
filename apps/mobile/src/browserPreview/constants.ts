const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const LOCAL_PREVIEW_WITHOUT_SCHEME_PATTERN =
  /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:[/?#].*)?$/i;
const PORT_ONLY_PATTERN = /^\d{2,5}$/;
const MAX_RECENT_TARGETS = 8;

export type BrowserPreviewViewportPreset = 'mobile' | 'desktop';

export interface BrowserPreviewViewportSpec {
  preset: BrowserPreviewViewportPreset;
  width?: number | null;
  height?: number | null;
}

export const LOCAL_PREVIEW_URL_PATTERN =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:[^\s<>"'`)\]]*)?/gi;

export const BROWSER_PREVIEW_PROXY_PREFIX = '/__dappercode_proxy__';

export const BROWSER_PREVIEW_INTERNAL_QUERY_KEYS = [
  'sid',
  'st',
  'vp',
  'vw',
  'vh',
  'shell',
  'frame',
] as const;

export const DEFAULT_BROWSER_PREVIEW_VIEWPORT: BrowserPreviewViewportSpec = {
  preset: 'mobile',
};

const MIN_BROWSER_PREVIEW_VIEWPORT_SIZE = 320;
const MAX_BROWSER_PREVIEW_VIEWPORT_SIZE = 4096;

export function normalizeViewportDimension(
  value: number | null | undefined
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  const normalized = Math.round(value);
  if (
    normalized < MIN_BROWSER_PREVIEW_VIEWPORT_SIZE ||
    normalized > MAX_BROWSER_PREVIEW_VIEWPORT_SIZE
  ) {
    return undefined;
  }

  return normalized;
}

export function normalizeBrowserPreviewViewportSpec(
  viewport: BrowserPreviewViewportSpec | null | undefined
): BrowserPreviewViewportSpec {
  if (!viewport || viewport.preset !== 'desktop') {
    return DEFAULT_BROWSER_PREVIEW_VIEWPORT;
  }

  return {
    preset: 'desktop',
    width: normalizeViewportDimension(viewport.width),
    height: normalizeViewportDimension(viewport.height),
  };
}

export function normalizePreviewTargetInput(value: string): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const candidate = PORT_ONLY_PATTERN.test(trimmed)
    ? `http://127.0.0.1:${trimmed}`
    : LOCAL_PREVIEW_WITHOUT_SCHEME_PATTERN.test(trimmed)
      ? `http://${trimmed}`
      : trimmed;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  const host = parsed.host.trim().toLowerCase();
  const hostname = parsed.hostname.trim().toLowerCase();
  if (!LOOPBACK_HOSTS.has(host) && !LOOPBACK_HOSTS.has(hostname)) {
    return null;
  }

  if (parsed.username || parsed.password) {
    return null;
  }

  parsed.hash = '';
  if (!parsed.pathname) {
    parsed.pathname = '/';
  }

  return parsed.toString();
}

export function dedupeRecentPreviewTargets(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const value of values) {
    const normalized = normalizePreviewTargetInput(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(normalized);
    if (deduped.length >= MAX_RECENT_TARGETS) {
      break;
    }
  }

  return deduped;
}
