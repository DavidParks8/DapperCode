import { quarantineContents, quarantineDocument } from './quarantine';
import type { LocalDocumentPort } from './threads';

function memoryStorage(initial: Record<string, string>) {
  const documents = new Map(Object.entries(initial));
  const storage: LocalDocumentPort = {
    readRuntimeDocument: (name) => Promise.resolve(documents.get(name) ?? null),
    writeRuntimeDocument: (name, value) => {
      documents.set(name, value);
      return Promise.resolve();
    },
    listRuntimeDocuments: (prefix) =>
      Promise.resolve([...documents.keys()].filter((name) => name.startsWith(prefix))),
    removeRuntimeDocument: (name) => {
      documents.delete(name);
      return Promise.resolve();
    },
  };
  return { documents, storage };
}

describe('quarantine', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('never overwrites bytes already set aside under the same name in the same millisecond', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1234);
    const { documents, storage } = memoryStorage({ 'draft-a.json': 'damaged' });

    await expect(quarantineDocument(storage, 'draft-a.json')).resolves.toBe(true);
    await expect(quarantineContents(storage, 'draft-a.json', 'inline copy')).resolves.toBe(true);
    await expect(quarantineContents(storage, 'draft-a.json', 'another copy')).resolves.toBe(true);

    expect(Object.fromEntries(documents)).toEqual({
      'quarantine-1234-draft-a.json': 'damaged',
      'quarantine-1234-1-draft-a.json': 'inline copy',
      'quarantine-1234-2-draft-a.json': 'another copy',
    });
  });

  it('only removes the source when moving a document, not when setting aside other text', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1234);
    const { documents, storage } = memoryStorage({ 'draft-a.json': 'kept' });

    await quarantineContents(storage, 'draft-a.json', 'inline copy');
    expect(documents.get('draft-a.json')).toBe('kept');

    await quarantineDocument(storage, 'draft-a.json');
    expect(documents.has('draft-a.json')).toBe(false);
    expect([...documents.values()].sort()).toEqual(['inline copy', 'kept']);
  });
});
