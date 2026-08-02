import { normalizeBridgeUrlInput } from '../../bridgeUrl';

export type PairingPayload = { bridgeToken: string; bridgeUrl?: string };

const PAIRING_TYPES = new Set([
  '',
  'dappercode-bridge-pair',
  'dappercode/bridge-pair',
  'dappercode-bridge-token',
  'dappercode/bridge-token',
]);

export function parsePairingPayload(rawValue: string): PairingPayload | null {
  const raw = rawValue.trim();
  if (!raw) {
    return null;
  }
  return parseJsonPairingPayload(raw) ?? parseUriPairingPayload(raw);
}

function parseJsonPairingPayload(raw: string): PairingPayload | null {
  try {
    const parsed = JSON.parse(raw) as {
      type?: unknown;
      bridgeUrl?: unknown;
      url?: unknown;
      bridgeToken?: unknown;
      token?: unknown;
    };
    const type = typeof parsed.type === 'string' ? parsed.type.trim().toLowerCase() : '';
    const bridgeUrl =
      normalizeBridgeUrlInput(firstString(parsed.bridgeUrl, parsed.url)) ?? undefined;
    const bridgeToken = firstString(parsed.bridgeToken, parsed.token).trim();
    return bridgeToken && PAIRING_TYPES.has(type) ? toPairingPayload(bridgeToken, bridgeUrl) : null;
  } catch {
    return null;
  }
}

function parseUriPairingPayload(raw: string): PairingPayload | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'dappercode:') {
      return null;
    }
    const bridgeUrl =
      normalizeBridgeUrlInput(
        firstString(parsed.searchParams.get('bridgeUrl'), parsed.searchParams.get('url')),
      ) ?? undefined;
    const bridgeToken = firstString(
      parsed.searchParams.get('bridgeToken'),
      parsed.searchParams.get('token'),
    ).trim();
    return bridgeToken ? toPairingPayload(bridgeToken, bridgeUrl) : null;
  } catch {
    return null;
  }
}

function firstString(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === 'string') ?? '';
}

function toPairingPayload(bridgeToken: string, bridgeUrl: string | undefined): PairingPayload {
  return bridgeUrl ? { bridgeToken, bridgeUrl } : { bridgeToken };
}
