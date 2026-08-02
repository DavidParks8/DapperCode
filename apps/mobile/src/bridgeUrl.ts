const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);

export function normalizeBridgeUrlInput(value: string): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (!SUPPORTED_PROTOCOLS.has(parsed.protocol)) {
    return null;
  }

  if (!parsed.hostname || parsed.username || parsed.password) {
    return null;
  }

  const normalizedProtocol =
    parsed.protocol === 'ws:' ? 'http:' : parsed.protocol === 'wss:' ? 'https:' : parsed.protocol;
  const normalizedPath = parsed.pathname.replace(/\/+$/, '');

  parsed.protocol = normalizedProtocol;
  parsed.pathname = normalizedPath || '';
  parsed.search = '';
  parsed.hash = '';
  parsed.username = '';
  parsed.password = '';

  return parsed.toString().replace(/\/$/, '');
}

export function isInsecureRemoteUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:') {
      return false;
    }

    return !isLikelyPrivateHost(parsed.hostname);
  } catch {
    return false;
  }
}

export function toBridgeHealthUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/health`;
}

function isLikelyPrivateHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  const host = stripIpv6Brackets(normalized);
  if (!host) {
    return false;
  }
  if (isLocalHost(host)) {
    return true;
  }
  return host.includes(':') ? isPrivateIpv6(host) : isPrivateIpv4(host);
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local');
}

function isPrivateIpv6(host: string): boolean {
  return host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:');
}

function isPrivateIpv4(host: string): boolean {
  const octets = host.split('.');
  if (octets.length !== 4 || !octets.every(isValidIpv4Octet)) {
    return false;
  }
  return isPrivateIpv4Prefix(octets.map(Number));
}

function isValidIpv4Octet(octet: string): boolean {
  return /^\d{1,3}$/.test(octet) && Number(octet) <= 255;
}

function isPrivateIpv4Prefix([first, second]: number[]): boolean {
  if (first === undefined || second === undefined) {
    return false;
  }
  if (first === 10 || (first === 192 && second === 168) || (first === 169 && second === 254)) {
    return true;
  }
  return (
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 100 && second >= 64 && second <= 127)
  );
}
