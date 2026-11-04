import type { LocalDocumentPort } from './threads';

export const QUARANTINE_PREFIX = 'quarantine-';

export function quarantineName(name: string, now = Date.now(), attempt = 0): string {
  const safe = name.toLowerCase().replace(/[^a-z0-9._-]/gu, '-');
  const stamp = attempt === 0 ? `${now}` : `${now}-${attempt}`;
  return `${QUARANTINE_PREFIX}${stamp}-${safe}`.slice(0, 160);
}

/**
 * A quarantine name nothing is stored under yet. Two documents set aside within the same
 * millisecond (or a document and a copy of the same draft) would otherwise share a name, and the
 * second write would destroy the bytes the first one preserved.
 */
async function freeQuarantineName(storage: LocalDocumentPort, name: string): Promise<string> {
  const now = Date.now();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = quarantineName(name, now, attempt);
    if ((await storage.readRuntimeDocument(candidate)) === null) {
      return candidate;
    }
  }
  throw new Error('No free name to set a local document aside.');
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
    await storage.writeRuntimeDocument(await freeQuarantineName(storage, name), raw);
    await storage.removeRuntimeDocument(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sets aside text that is not the contents of any document (such as a synthesized copy of an
 * inline legacy draft). Unlike `quarantineDocument`, it never removes `name`, because whatever is
 * stored there was not the source of `contents`.
 */
export async function quarantineContents(
  storage: LocalDocumentPort,
  name: string,
  contents: string,
): Promise<boolean> {
  try {
    await storage.writeRuntimeDocument(await freeQuarantineName(storage, name), contents);
    return true;
  } catch {
    return false;
  }
}
