import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import type { AppStatePersistenceAdapter } from '@shell/state/appState';

const APP_STATE_STORE_KEY = 'dappercode.app-state.v1';
const E2E_APP_STATE_FILE = 'dappercode-e2e-app-state.json';

interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function createAppStatePersistence(): AppStatePersistenceAdapter {
  if (
    __DEV__ &&
    Platform.OS !== 'web' &&
    process.env['EXPO_PUBLIC_E2E_FILE_PERSISTENCE']?.trim().toLowerCase() === 'true'
  ) {
    return {
      readCurrent: readE2EFile,
      writeCurrent: writeE2EFile,
    };
  }
  return {
    readCurrent: () => readSecureValue(APP_STATE_STORE_KEY),
    writeCurrent: (raw) => writeSecureValue(APP_STATE_STORE_KEY, raw),
  };
}

async function readE2EFile(): Promise<string | null> {
  const path = e2eFilePath();
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) {
    return null;
  }
  if (info.isDirectory) {
    throw new Error('E2E app-state path points to a directory.');
  }
  return await FileSystem.readAsStringAsync(path);
}

async function writeE2EFile(raw: string): Promise<void> {
  await FileSystem.writeAsStringAsync(e2eFilePath(), raw);
}

function e2eFilePath(): string {
  if (!FileSystem.cacheDirectory) {
    throw new Error('E2E app-state cache storage is unavailable.');
  }
  return `${FileSystem.cacheDirectory}${E2E_APP_STATE_FILE}`;
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
