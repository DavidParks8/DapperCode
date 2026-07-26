import { normalizeBridgeUrlInput } from '../../bridgeUrl';

export type PairingPayload = { bridgeToken: string; bridgeUrl?: string };

export function parsePairingPayload(rawValue: string): PairingPayload | null {
  const raw = rawValue.trim();
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as {
      type?: unknown;
      bridgeUrl?: unknown;
      url?: unknown;
      bridgeToken?: unknown;
      token?: unknown;
    };
    const type = typeof parsed.type === 'string' ? parsed.type.trim().toLowerCase() : '';
    const bridgeUrlRaw =
      typeof parsed.bridgeUrl === 'string'
        ? parsed.bridgeUrl
        : typeof parsed.url === 'string'
          ? parsed.url
          : '';
    const bridgeTokenRaw =
      typeof parsed.bridgeToken === 'string'
        ? parsed.bridgeToken
        : typeof parsed.token === 'string'
          ? parsed.token
          : '';
    const bridgeUrl = normalizeBridgeUrlInput(bridgeUrlRaw) ?? undefined;
    const bridgeToken = bridgeTokenRaw.trim();
    if (
      bridgeToken &&
      (type === 'tethercode-bridge-pair' ||
        type === 'tethercode/bridge-pair' ||
        type === 'tethercode-bridge-token' ||
        type === 'tethercode/bridge-token' ||
        !type)
    ) {
      return bridgeUrl ? { bridgeToken, bridgeUrl } : { bridgeToken };
    }
  } catch {
    // Try URI form fallback below.
  }

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'dappercode:') {
      return null;
    }
    const bridgeUrl =
      normalizeBridgeUrlInput(
        parsed.searchParams.get('bridgeUrl') ?? parsed.searchParams.get('url') ?? ''
      ) ?? undefined;
    const bridgeToken =
      (parsed.searchParams.get('bridgeToken') ?? parsed.searchParams.get('token') ?? '').trim();
    if (!bridgeToken) {
      return null;
    }
    return bridgeUrl ? { bridgeToken, bridgeUrl } : { bridgeToken };
  } catch {
    return null;
  }
}