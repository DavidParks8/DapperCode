import { File } from 'expo-file-system';
import { readFileInfo, writeFile } from '@shared/filesystem';
import type { ProfilePersistenceStorage } from './persistence';

const fileStorage: ProfilePersistenceStorage = {
  read: async (path) => new File(path).text(),
  write: async (path, value) => writeFile(new File(path), value),
  exists: async (path) => (await readFileInfo(new File(path))).exists,
};

interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const webStorage: ProfilePersistenceStorage = {
  read: (key) => {
    const value = getWebStorage()?.getItem(key);
    return value == null ? Promise.reject(new Error('missing')) : Promise.resolve(value);
  },
  write: (key, value) => {
    const storage = getWebStorage();
    if (!storage) {
      return Promise.reject(new Error('Browser storage is unavailable.'));
    }
    storage.setItem(key, value);
    return Promise.resolve();
  },
  exists: (key) => Promise.resolve(getWebStorage()?.getItem(key) != null),
};

function getWebStorage(): WebStorageLike | null {
  if (typeof globalThis !== 'object' || globalThis === null) {
    return null;
  }
  const storage = (globalThis as typeof globalThis & { localStorage?: Partial<WebStorageLike> })
    .localStorage;
  return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function'
    ? storage
    : null;
}

export function getProfileStorage(platform: string): ProfilePersistenceStorage {
  return platform === 'web' ? webStorage : fileStorage;
}
