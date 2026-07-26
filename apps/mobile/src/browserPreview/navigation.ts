import {
  BROWSER_PREVIEW_INTERNAL_QUERY_KEYS,
  BROWSER_PREVIEW_PROXY_PREFIX,
  type BrowserPreviewViewportSpec,
  DEFAULT_BROWSER_PREVIEW_VIEWPORT,
  normalizeBrowserPreviewViewportSpec,
  normalizeViewportDimension,
} from './constants';

export function buildBrowserPreviewBootstrapUrl(
  bridgeUrl: string,
  previewPort: number,
  bootstrapPath: string,
  viewport: BrowserPreviewViewportSpec = DEFAULT_BROWSER_PREVIEW_VIEWPORT,
  previewBaseUrl?: string | null,
): string | null {
  if (typeof bridgeUrl !== 'string' || typeof bootstrapPath !== 'string') {
    return null;
  }

  const normalizedBridgeUrl = bridgeUrl.trim();
  const normalizedPath = bootstrapPath.trim();
  if (!normalizedBridgeUrl || !normalizedPath) {
    return null;
  }

  try {
    const normalizedViewport = normalizeBrowserPreviewViewportSpec(viewport);
    const resolvedPreviewBaseUrl = getBrowserPreviewBaseUrl(
      normalizedBridgeUrl,
      previewPort,
      previewBaseUrl,
    );
    if (!resolvedPreviewBaseUrl) {
      return null;
    }
    const base = new URL(resolvedPreviewBaseUrl);

    const previewUrl = new URL(
      normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`,
      base.toString(),
    );
    applyViewportParams(previewUrl, normalizedViewport);
    return previewUrl.toString();
  } catch {
    return null;
  }
}

export function applyBrowserPreviewShellMode(
  rawUrl: string,
  shellMode: 'desktop' | 'overview' | null,
): string | null {
  if (typeof rawUrl !== 'string') {
    return null;
  }

  try {
    const parsed = new URL(rawUrl.trim());
    parsed.searchParams.delete('frame');
    if (shellMode) {
      parsed.searchParams.set('shell', shellMode);
    } else {
      parsed.searchParams.delete('shell');
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function getNativeBrowserPreviewShellMode(
  platformOs: string,
  viewportPreset: 'mobile' | 'desktop' | 'desktop2',
): 'desktop' | 'overview' | null {
  if (platformOs !== 'ios' && platformOs !== 'android') {
    return null;
  }

  if (viewportPreset === 'desktop') {
    return 'overview';
  }

  if (viewportPreset === 'desktop2') {
    return 'desktop';
  }

  return null;
}

export function getBrowserPreviewShellRequestKey(rawUrl: string | null | undefined): string | null {
  if (typeof rawUrl !== 'string') {
    return null;
  }

  try {
    const parsed = new URL(rawUrl.trim());
    const sid = parsed.searchParams.get('sid');
    if (!sid) {
      return null;
    }
    return sid;
  } catch {
    return null;
  }
}

export function getBrowserPreviewOrigin(
  bridgeUrl: string,
  previewPort: number,
  previewBaseUrl?: string | null,
): string | null {
  const baseUrl = getBrowserPreviewBaseUrl(bridgeUrl, previewPort, previewBaseUrl);
  if (!baseUrl) {
    return null;
  }

  try {
    const parsed = new URL(baseUrl);
    return parsed.origin;
  } catch {
    return null;
  }
}

export function isSameOriginUrl(url: string, origin: string | null | undefined): boolean {
  if (!origin) {
    return false;
  }

  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

export function applyBrowserPreviewViewportPreset(
  rawUrl: string,
  viewport: BrowserPreviewViewportSpec,
): string | null {
  if (typeof rawUrl !== 'string') {
    return null;
  }

  try {
    const parsed = new URL(rawUrl.trim());
    applyViewportParams(parsed, normalizeBrowserPreviewViewportSpec(viewport));
    return parsed.toString();
  } catch {
    return null;
  }
}

export function buildBrowserPreviewViewportNavigationUrl(
  rawCurrentUrl: string,
  rawBootstrapUrl: string,
  viewport: BrowserPreviewViewportSpec,
): string | null {
  if (typeof rawCurrentUrl !== 'string' || typeof rawBootstrapUrl !== 'string') {
    return null;
  }

  try {
    const normalizedViewport = normalizeBrowserPreviewViewportSpec(viewport);
    const current = new URL(rawCurrentUrl.trim());
    const bootstrap = new URL(rawBootstrapUrl.trim());
    const sid = bootstrap.searchParams.get('sid');
    const st = bootstrap.searchParams.get('st');

    if (current.origin !== bootstrap.origin || !sid || !st) {
      return applyBrowserPreviewViewportPreset(rawBootstrapUrl, normalizedViewport);
    }

    current.searchParams.set('sid', sid);
    current.searchParams.set('st', st);
    applyViewportParams(current, normalizedViewport);
    return current.toString();
  } catch {
    return applyBrowserPreviewViewportPreset(rawBootstrapUrl, viewport);
  }
}

export function mapBrowserPreviewNavigationUrlToTargetUrl(
  rawNavigationUrl: string,
  rawPreviewOrigin: string | null | undefined,
  rawSessionTargetUrl: string | null | undefined,
): string | null {
  if (
    typeof rawNavigationUrl !== 'string' ||
    typeof rawPreviewOrigin !== 'string' ||
    typeof rawSessionTargetUrl !== 'string'
  ) {
    return null;
  }

  try {
    const navigationUrl = new URL(rawNavigationUrl.trim());
    const previewOrigin = new URL(rawPreviewOrigin.trim());
    const sessionTargetUrl = new URL(rawSessionTargetUrl.trim());
    if (navigationUrl.origin !== previewOrigin.origin) {
      return navigationUrl.toString();
    }

    const mappedUrl = resolvePreviewDisplayUrl(navigationUrl, sessionTargetUrl);
    for (const key of BROWSER_PREVIEW_INTERNAL_QUERY_KEYS) {
      mappedUrl.searchParams.delete(key);
    }
    if (!mappedUrl.pathname) {
      mappedUrl.pathname = '/';
    }
    return mappedUrl.toString();
  } catch {
    return null;
  }
}

function getBrowserPreviewBaseUrl(
  bridgeUrl: string,
  previewPort: number,
  previewBaseUrl?: string | null,
): string | null {
  if (typeof bridgeUrl !== 'string') {
    return null;
  }

  const explicitBaseUrl = normalizeBrowserPreviewBaseUrl(previewBaseUrl);
  if (explicitBaseUrl) {
    return explicitBaseUrl;
  }

  try {
    const parsed = new URL(bridgeUrl.trim());
    parsed.port = String(previewPort);
    parsed.pathname = '/';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function normalizeBrowserPreviewBaseUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    parsed.pathname = '/';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function resolvePreviewDisplayUrl(navigationUrl: URL, sessionTargetUrl: URL): URL {
  const proxyPrefixWithSlash = `${BROWSER_PREVIEW_PROXY_PREFIX}/`;
  if (!navigationUrl.pathname.startsWith(proxyPrefixWithSlash)) {
    const mappedUrl = new URL(sessionTargetUrl.toString());
    mappedUrl.pathname = navigationUrl.pathname || '/';
    mappedUrl.search = navigationUrl.search;
    mappedUrl.hash = navigationUrl.hash;
    return mappedUrl;
  }

  const proxyTail = navigationUrl.pathname.slice(proxyPrefixWithSlash.length);
  const segments = proxyTail.split('/');
  const targetToken = segments.shift()?.trim() ?? '';
  const decodedOrigin = decodeBrowserPreviewProxyOriginToken(targetToken);
  const mappedUrl = decodedOrigin ? new URL(decodedOrigin) : new URL(sessionTargetUrl.toString());
  const remainderPath = segments.join('/');
  mappedUrl.pathname = remainderPath ? `/${remainderPath}` : '/';
  mappedUrl.search = navigationUrl.search;
  mappedUrl.hash = navigationUrl.hash;
  return mappedUrl;
}

function decodeBrowserPreviewProxyOriginToken(value: string): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  const base64 = normalized + padding;

  try {
    if (typeof globalThis.atob === 'function') {
      return globalThis.atob(base64);
    }

    const bufferLike = globalThis as typeof globalThis & {
      Buffer?: {
        from(input: string, encoding: string): { toString(encoding: string): string };
      };
    };
    if (bufferLike.Buffer) {
      return bufferLike.Buffer.from(base64, 'base64').toString('utf8');
    }
  } catch {
    return null;
  }

  return null;
}

function applyViewportParams(url: URL, viewport: BrowserPreviewViewportSpec): void {
  url.searchParams.set('vp', viewport.preset);
  if (viewport.preset === 'desktop') {
    const width = normalizeViewportDimension(viewport.width);
    const height = normalizeViewportDimension(viewport.height);
    if (width) {
      url.searchParams.set('vw', String(width));
    } else {
      url.searchParams.delete('vw');
    }
    if (height) {
      url.searchParams.set('vh', String(height));
    } else {
      url.searchParams.delete('vh');
    }
    return;
  }

  url.searchParams.delete('vw');
  url.searchParams.delete('vh');
}
