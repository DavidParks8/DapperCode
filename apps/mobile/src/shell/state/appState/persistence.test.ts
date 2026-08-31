import type * as AppStatePersistenceModule from '@shell/state/appState/persistence';

describe('appStatePersistence', () => {
  const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const originalE2EFilePersistence = process.env['EXPO_PUBLIC_E2E_FILE_PERSISTENCE'];

  afterEach(() => {
    jest.dontMock('react-native');
    jest.dontMock('expo-secure-store');
    jest.dontMock('expo-file-system/legacy');
    jest.resetModules();
    jest.clearAllMocks();
    if (originalLocalStorage) {
      Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
    } else {
      Reflect.deleteProperty(globalThis, 'localStorage');
    }
    if (originalE2EFilePersistence === undefined) {
      delete process.env['EXPO_PUBLIC_E2E_FILE_PERSISTENCE'];
    } else {
      process.env['EXPO_PUBLIC_E2E_FILE_PERSISTENCE'] = originalE2EFilePersistence;
    }
  });

  it('stores the canonical document on web', async () => {
    const getItem = jest.fn().mockReturnValue(null);
    const setItem = jest.fn();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem, setItem },
    });
    jest.doMock('react-native', () => ({ Platform: { OS: 'web' } }));
    jest.doMock('expo-secure-store', () => ({}));
    jest.doMock('expo-file-system/legacy', () => ({
      cacheDirectory: 'file:///cache/',
      readAsStringAsync: jest.fn().mockResolvedValue('{"version":11}'),
    }));

    let module!: typeof AppStatePersistenceModule;
    jest.isolateModules(() => {
      module = jest.requireActual('@shell/state/appState/persistence');
    });
    const persistence = module.createAppStatePersistence();

    expect(await persistence.readCurrent()).toBeNull();
    await persistence.writeCurrent('{"version":1}');

    expect(setItem).toHaveBeenCalledWith('dappercode.app-state.v1', '{"version":1}');
  });

  it('uses secure storage for the canonical document on native platforms', async () => {
    const secureStore = {
      AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'after-first-unlock',
      getItemAsync: jest.fn().mockResolvedValue('{"version":1}'),
      setItemAsync: jest.fn().mockResolvedValue(undefined),
    };
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios' } }));
    jest.doMock('expo-secure-store', () => secureStore);
    jest.doMock('expo-file-system/legacy', () => ({
      cacheDirectory: null,
      readAsStringAsync: jest.fn(),
    }));

    let module!: typeof AppStatePersistenceModule;
    jest.isolateModules(() => {
      module = jest.requireActual('@shell/state/appState/persistence');
    });
    const persistence = module.createAppStatePersistence();

    expect(await persistence.readCurrent()).toBe('{"version":1}');
    await persistence.writeCurrent('{"version":1}');
    expect(secureStore.setItemAsync).toHaveBeenCalledWith(
      'dappercode.app-state.v1',
      '{"version":1}',
      { keychainAccessible: 'after-first-unlock' },
    );
  });

  it('uses a relaunch-safe cache file only when native development E2E explicitly enables it', async () => {
    process.env['EXPO_PUBLIC_E2E_FILE_PERSISTENCE'] = 'true';
    const secureStore = {
      AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'after-first-unlock',
      getItemAsync: jest.fn(),
      setItemAsync: jest.fn(),
    };
    const getInfoAsync = jest
      .fn()
      .mockResolvedValueOnce({ exists: false, isDirectory: false })
      .mockResolvedValueOnce({ exists: true, isDirectory: false });
    const readAsStringAsync = jest.fn().mockResolvedValue('{"version":1}');
    const writeAsStringAsync = jest.fn().mockResolvedValue(undefined);
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios' } }));
    jest.doMock('expo-secure-store', () => secureStore);
    jest.doMock('expo-file-system/legacy', () => ({
      cacheDirectory: 'file:///cache/',
      getInfoAsync,
      readAsStringAsync,
      writeAsStringAsync,
    }));

    let module!: typeof AppStatePersistenceModule;
    jest.isolateModules(() => {
      module = jest.requireActual('@shell/state/appState/persistence');
    });
    const persistence = module.createAppStatePersistence();

    await expect(persistence.readCurrent()).resolves.toBeNull();
    await expect(persistence.readCurrent()).resolves.toBe('{"version":1}');
    await persistence.writeCurrent('{"version":2}');

    expect(readAsStringAsync).toHaveBeenCalledWith('file:///cache/dappercode-e2e-app-state.json');
    expect(writeAsStringAsync).toHaveBeenCalledWith(
      'file:///cache/dappercode-e2e-app-state.json',
      '{"version":2}',
    );
    expect(secureStore.getItemAsync).not.toHaveBeenCalled();
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('reports unavailable browser storage', async () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: jest.fn() },
    });
    const readAsStringAsync = jest.fn().mockRejectedValue(new Error('missing'));
    jest.doMock('react-native', () => ({ Platform: { OS: 'web' } }));
    jest.doMock('expo-secure-store', () => ({}));
    jest.doMock('expo-file-system/legacy', () => ({
      cacheDirectory: 'file:///cache/',
      readAsStringAsync,
    }));

    let module!: typeof AppStatePersistenceModule;
    jest.isolateModules(() => {
      module = jest.requireActual('@shell/state/appState/persistence');
    });
    const persistence = module.createAppStatePersistence();
    await expect(persistence.readCurrent()).resolves.toBeNull();
    await expect(persistence.writeCurrent('{}')).rejects.toThrow('unavailable');
  });
});
