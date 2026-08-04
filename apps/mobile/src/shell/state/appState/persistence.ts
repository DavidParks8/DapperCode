import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import type { AppStatePersistenceAdapter } from '@shell/state/appState';

const APP_STATE_STORE_KEY = 'dappercode.app-state.v1';

interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function createAppStatePersistence(): AppStatePersistenceAdapter {
  return {
    readCurrent: () => readSecureValue(APP_STATE_STORE_KEY),
    writeCurrent: (raw) => writeSecureValue(APP_STATE_STORE_KEY, raw),
  };
}

async function readSecureValue(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    return getWebStorage()?.getItem(key) ?? null;
  }
  return SecureStore.getItemAsync(key);
}

async function writeSecureValue(key: string, raw: string): Promise<void> {
  if (Platform.OS === 'web') {
    const storage = getWebStorage();
    if (!storage) {
      throw new Error('Browser storage is unavailable.');
    }
    storage.setItem(key, raw);
    return;
  }
  await SecureStore.setItemAsync(key, raw, {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
}

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
