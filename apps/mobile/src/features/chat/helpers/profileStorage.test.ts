import { fileSystemMock as FileSystem } from '@shared/testing/expoFileSystemMock';
import { getProfileStorage } from './profileStorage';

describe('profileStorage', () => {
  const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  afterEach(() => {
    jest.clearAllMocks();
    if (originalLocalStorage) {
      Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
    } else {
      Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });

  it('shares native adapters and delegates reads, writes, and existence checks', async () => {
    FileSystem.read.mockResolvedValue('native value');
    FileSystem.info.mockImplementation(async (path) => ({ exists: path !== '/missing' }));
    const storage = getProfileStorage('ios');
    expect(getProfileStorage('android')).toBe(storage);
    expect(getProfileStorage('web')).not.toBe(storage);
    await expect(storage.read('/profile')).resolves.toBe('native value');
    await storage.write('/profile', 'next');
    await expect(storage.exists?.('/profile')).resolves.toBe(true);
    await expect(storage.exists?.('/missing')).resolves.toBe(false);
    expect(FileSystem.read).toHaveBeenCalledWith('/profile');
    expect(FileSystem.write).toHaveBeenCalledWith('/profile', 'next');
    jest.mocked(FileSystem.info).mockRejectedValueOnce(new Error('stat failed'));
    await expect(storage.exists?.('/profile')).rejects.toThrow('stat failed');
  });

  it('reads the current browser storage and preserves empty stored values', async () => {
    const storage = getProfileStorage('web');
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    expect(getProfileStorage('web')).toBe(storage);
    await storage.write('profile-one', '');
    await storage.write('profile-two', 'second');
    await expect(storage.read('profile-one')).resolves.toBe('');
    await expect(storage.read('profile-two')).resolves.toBe('second');
    await expect(storage.exists?.('profile-one')).resolves.toBe(true);
    await expect(storage.exists?.('missing')).resolves.toBe(false);
    await expect(storage.read('missing')).rejects.toThrow('missing');
  });

  it.each([undefined, {}, { getItem: () => null }])(
    'reports unavailable browser storage instead of accepting %p',
    async (value) => {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value });
      const storage = getProfileStorage('web');
      await expect(storage.read('profile')).rejects.toThrow('missing');
      await expect(storage.write('profile', 'value')).rejects.toThrow(
        'Browser storage is unavailable.',
      );
      await expect(storage.exists?.('profile')).resolves.toBe(false);
    },
  );

  it('preserves browser read and write errors', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error('read denied');
        },
        setItem: () => {
          throw new Error('quota exceeded');
        },
      },
    });
    const storage = getProfileStorage('web');
    expect(() => storage.read('profile')).toThrow('read denied');
    expect(() => storage.write('profile', 'value')).toThrow('quota exceeded');
  });
});
