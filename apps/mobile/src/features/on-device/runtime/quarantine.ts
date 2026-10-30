import type { LocalDocumentPort } from './threads';

export const QUARANTINE_PREFIX = 'quarantine-';

export function quarantineName(name: string, now = Date.now()): string {
  const safe = name.toLowerCase().replace(/[^a-z0-9._-]/gu, '-');
  return `${QUARANTINE_PREFIX}${now}-${safe}`.slice(0, 160);
}

/**
 * Moves a damaged runtime document aside without changing its bytes, so startup can continue
 * without overwriting it. Returns false when it could not be moved and was left in place.
 */
export async function quarantineDocument(
  storage: LocalDocumentPort,
  name: string,
  contents?: string | null,
): Promise<boolean> {
  try {
    const raw = contents ?? (await storage.readRuntimeDocument(name));
    if (raw === null) {
      return true;
    }
    await storage.writeRuntimeDocument(quarantineName(name), raw);
    await storage.removeRuntimeDocument(name);
    return true;
  } catch {
    return false;
  }
}
