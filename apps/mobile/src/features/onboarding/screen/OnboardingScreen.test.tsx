import { requireTestValue } from '@shared/testing/requireTestValue';
import * as Clipboard from 'expo-clipboard';
import type * as fsNode from 'fs';
import type * as pathNode from 'path';
import { KeyboardAvoidingView, Modal, Platform, Share } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { feedback } from '@shared/feedback';
import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { computeHitSlop } from '@shared/ui/touchTarget';
import { setMockReducedMotionEnabled } from '@shared/testing/reanimatedMock';
import { OnboardingScreen, type OnboardingMode } from './OnboardingScreen';

const mockRequestCameraPermission = jest.fn().mockResolvedValue({ granted: false });
const mockWsConstructor = jest.fn();
const mockWsConnect = jest.fn();
const mockWsRequest = jest.fn().mockResolvedValue({ status: 'ok' });
const mockWsDisconnect = jest.fn();
let mockCameraGranted = false;

jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));
jest.mock('@shared/feedback', () => ({
  feedback: {
    selection: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockResolvedValue(undefined),
    success: jest.fn().mockResolvedValue(undefined),
    warning: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
    destructive: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: ({ name }: { name: string }) => name }));
jest.mock('expo-blur', () => ({ BlurView: jest.requireActual('react-native').View }));
jest.mock('expo-linear-gradient', () => ({
  LinearGradient: jest.requireActual('react-native').View,
}));
jest.mock('expo-camera', () => ({
  CameraView: (props: Record<string, unknown>) =>
    jest.requireActual('react').createElement('mock-camera-view', props),
  useCameraPermissions: () => [{ granted: mockCameraGranted }, mockRequestCameraPermission],
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@bridge/ws/ws', () => ({
  HostBridgeWsClient: class {
    constructor(baseUrl: string, options: unknown) {
      mockWsConstructor(baseUrl, options);
    }
    connect = mockWsConnect;
    request = mockWsRequest;
    disconnect = mockWsDisconnect;
  },
}));

type Queryable = ReactTestInstance & {
  children: unknown[];
  parent: Queryable | null;
  type: unknown;
  props: Record<string, unknown>;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
};

type PropHandler = (...args: never[]) => unknown;

function readHandler<Handler extends PropHandler>(node: Queryable, property: string): Handler {
  const handler = node.props[property];
  if (typeof handler !== 'function') {
    throw new Error(`Missing handler: ${property}`);
  }
  return handler as Handler;
}

const theme = createAppTheme('dark');
const lightTheme = createAppTheme('light');

function hasText(root: Queryable, text: string): boolean {
  return root.findAll((node) => node.children.map(String).join('').includes(text)).length > 0;
}

function findByLabel(root: Queryable, label: string): Queryable {
  const node = root.findAll((candidate) => candidate.props['accessibilityLabel'] === label)[0];
  if (!node) {
    throw new Error(`Missing label: ${label}`);
  }
  return node;
}

function findPressableByText(root: Queryable, text: string): Queryable {
  const textNode = root.findAll((node) => node.children.map(String).join('') === text)[0];
  let current: Queryable | null = textNode ?? null;
  while (current && typeof current.props['onPress'] !== 'function') {
    current = current.parent;
  }
  if (!current) {
    throw new Error(`Missing pressable: ${text}`);
  }
  return current;
}

async function press(node: Queryable): Promise<void> {
  await act(async () => {
    readHandler<() => void>(node, 'onPress')();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderOnboarding(
  options: {
    mode?: OnboardingMode;
    initialBridgeUrl?: string | null;
    initialBridgeToken?: string | null;
    onSave?: jest.Mock;
    onCancel?: jest.Mock;
    allowInsecureRemoteBridge?: boolean;
    allowQueryTokenAuth?: boolean;
    themeMode?: 'dark' | 'light';
  } = {},
): Promise<{
  tree: ReactTestRenderer;
  onSave: jest.Mock;
  onCancel: jest.Mock;
  rerender: (next: typeof options) => Promise<void>;
}> {
  const onSave = options.onSave ?? jest.fn().mockResolvedValue(undefined);
  const onCancel = options.onCancel ?? jest.fn();
  const createElement = (props: typeof options) => (
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}
    >
      <AppThemeProvider theme={props.themeMode === 'light' ? lightTheme : theme}>
        <OnboardingScreen
          mode={props.mode}
          initialBridgeUrl={props.initialBridgeUrl}
          initialBridgeToken={props.initialBridgeToken}
          allowInsecureRemoteBridge={props.allowInsecureRemoteBridge}
          allowQueryTokenAuth={props.allowQueryTokenAuth}
          onSave={props.onSave ?? onSave}
          onCancel={props.onCancel ?? onCancel}
        />
      </AppThemeProvider>
    </SafeAreaProvider>
  );
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = renderer.create(createElement(options));
    await Promise.resolve();
  });
  if (!tree) {
    throw new Error('Expected onboarding tree');
  }
  const renderedTree = tree;
  return {
    tree: renderedTree,
    onSave,
    onCancel,
    rerender: async (next) => {
      await act(async () => {
        renderedTree.update(createElement({ ...options, ...next }));
        await Promise.resolve();
      });
    },
  };
}

describe('OnboardingScreen behavior', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockCameraGranted = false;
    global.fetch = jest.fn().mockResolvedValue({ status: 200 });
    mockWsRequest.mockResolvedValue({ status: 'ok' });
    jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
  });
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('moves between initial intro and connection setup', async () => {
    const { tree } = await renderOnboarding();
    const root = tree.root as Queryable;
    expect(hasText(root, 'DapperCode')).toBe(true);
    expect(hasText(root, 'Pair this device with your own machine.')).toBe(true);
    await press(findPressableByText(root, 'Private connection'));
    expect(findByLabel(root, 'Bridge URL')).toBeTruthy();
    expect(hasText(root, '1. Start')).toBe(true);
    await press(findPressableByText(root, 'Back'));
    expect(hasText(root, 'Private connection')).toBe(true);
    act(() => tree.unmount());
  });

  it.each([
    { mode: 'add' as const, label: 'Continue' },
    { mode: 'edit' as const, label: 'Save URL' },
    { mode: 'reconnect' as const, label: 'Reconnect' },
  ])('renders direct connection mode controls', async ({ mode, label }) => {
    const result = await renderOnboarding({
      mode,
      initialBridgeUrl: 'http://127.0.0.1:3001',
      initialBridgeToken: 'token',
    });
    const root = result.tree.root as Queryable;
    expect(findByLabel(root, label)).toBeTruthy();
    await press(findByLabel(root, 'Cancel connection setup'));
    expect(result.onCancel).toHaveBeenCalled();
    await press(findByLabel(root, 'Show bridge token'));
    expect(findByLabel(root, 'Bridge token').props['secureTextEntry']).toBe(false);
    await press(findByLabel(root, 'Hide bridge token'));
    expect(findByLabel(root, 'Bridge token').props['secureTextEntry']).toBe(true);
    act(() => result.tree.unmount());
  });

  it('validates URL and token before probing', async () => {
    const { tree, onSave } = await renderOnboarding({ mode: 'add' });
    const root = tree.root as Queryable;
    await press(findByLabel(root, 'Continue'));
    expect(hasText(root, 'Enter a valid URL.')).toBe(true);
    const url = findByLabel(root, 'Bridge URL');
    const token = findByLabel(root, 'Bridge token');
    act(() => readHandler<(value: string) => void>(url, 'onChangeText')('http://127.0.0.1:3001'));
    await press(findByLabel(root, 'Continue'));
    expect(hasText(root, 'Connection token is required.')).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    await press(findPressableByText(root, 'Test Connection'));
    expect(hasText(root, 'Enter a valid URL.')).toBe(false);
    expect(hasText(root, 'Connection token is required.')).toBe(true);
    act(() => readHandler<(value: string) => void>(token, 'onChangeText')('token'));
    act(() => tree.unmount());
  });

  it('probes and saves normalized credentials', async () => {
    const result = await renderOnboarding({
      mode: 'edit',
      initialBridgeUrl: ' ws://127.0.0.1:3001/path/ ',
      initialBridgeToken: ' token ',
    });
    const root = result.tree.root as Queryable;
    await press(findByLabel(root, 'Save URL'));
    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/path/health',
      expect.objectContaining({
        headers: { Authorization: 'Bearer token' },
      }),
    );
    expect(mockWsConnect).toHaveBeenCalledTimes(1);
    expect(mockWsConstructor).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/path',
      expect.objectContaining({
        clientType: 'mobile',
        clientName: 'DapperCode Mobile',
        getClientForeground: expect.any(Function),
      }),
    );
    expect(mockWsConnect.mock.invocationCallOrder[0]).toBeLessThan(
      mockWsRequest.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(mockWsRequest).toHaveBeenCalledWith('bridge/health/read');
    expect(mockWsDisconnect).toHaveBeenCalled();
    expect(result.onSave).toHaveBeenCalledWith({
      bridgeUrl: 'http://127.0.0.1:3001/path',
      bridgeToken: 'token',
      workspaceId: null,
    });
    expect(hasText(root, 'Connected. URL and token both verified.')).toBe(true);
    act(() => result.tree.unmount());
  });

  it('reports partial health, RPC failure, save failure, and insecure remote warnings', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ status: 503 });
    const partial = await renderOnboarding({
      mode: 'add',
      initialBridgeUrl: 'http://127.0.0.1:3001',
      initialBridgeToken: 'token',
    });
    await press(findPressableByText(partial.tree.root as Queryable, 'Test Connection'));
    expect(hasText(partial.tree.root as Queryable, 'Authenticated RPC verified')).toBe(true);
    act(() => partial.tree.unmount());

    mockWsRequest.mockRejectedValueOnce(new Error('offline'));
    const failed = await renderOnboarding({
      mode: 'add',
      initialBridgeUrl: 'http://127.0.0.1:3001',
      initialBridgeToken: 'token',
    });
    await press(findPressableByText(failed.tree.root as Queryable, 'Test Connection'));
    expect(hasText(failed.tree.root as Queryable, 'Connection error.')).toBe(true);
    act(() => failed.tree.unmount());

    const saveFailed = await renderOnboarding({
      mode: 'add',
      initialBridgeUrl: 'http://example.com',
      initialBridgeToken: 'token',
      onSave: jest.fn().mockRejectedValue(new Error('could not persist')),
    });
    expect(hasText(saveFailed.tree.root as Queryable, 'plain HTTP over a non-private host')).toBe(
      true,
    );
    await press(findByLabel(saveFailed.tree.root as Queryable, 'Continue'));
    expect(hasText(saveFailed.tree.root as Queryable, 'could not persist')).toBe(true);
    act(() => saveFailed.tree.unmount());
  });

  it('handles denied camera permission and valid QR pairing payloads', async () => {
    const denied = await renderOnboarding({ mode: 'add' });
    await press(findPressableByText(denied.tree.root as Queryable, 'Scan QR'));
    expect(mockRequestCameraPermission).toHaveBeenCalled();
    expect(hasText(denied.tree.root as Queryable, 'Camera permission is required')).toBe(true);
    act(() => denied.tree.unmount());

    mockCameraGranted = true;
    const granted = await renderOnboarding({ mode: 'add' });
    const root = granted.tree.root as Queryable;
    await press(findPressableByText(root, 'Scan QR'));
    expect(hasText(root, 'Scan Pairing QR')).toBe(true);
    const camera = root.findAll((node) => node.type === 'mock-camera-view')[0];
    if (!camera) {
      throw new Error('Missing camera');
    }
    await act(async () => {
      readHandler<(event: { data: string }) => void>(
        camera,
        'onBarcodeScanned',
      )({
        data: JSON.stringify({
          type: 'dappercode-bridge-pair',
          bridgeUrl: 'http://127.0.0.1:3001',
          bridgeToken: ' qr-token ',
        }),
      });
    });
    expect(findByLabel(root, 'Bridge URL').props['value']).toBe('http://127.0.0.1:3001');
    expect(findByLabel(root, 'Bridge token').props['value']).toBe('qr-token');
    expect(hasText(root, 'Scan Pairing QR')).toBe(false);
    act(() => granted.tree.unmount());
  });

  it('reports invalid QR payloads, unlocks scanning, and closes the scanner', async () => {
    mockCameraGranted = true;
    const result = await renderOnboarding({ mode: 'add' });
    const root = result.tree.root as Queryable;
    await press(findPressableByText(root, 'Scan QR'));
    const camera = requireTestValue(
      root.findAll((node) => node.type === 'mock-camera-view')[0],
      'indexed test value',
    );
    await act(async () => {
      readHandler<(event: { data: string }) => void>(
        camera,
        'onBarcodeScanned',
      )({ data: 'not-a-pairing-code' });
    });
    expect(hasText(root, 'QR code is not a valid DapperCode bridge pairing code.')).toBe(true);
    act(() => jest.advanceTimersByTime(1200));
    await press(findByLabel(root, 'Cancel QR scan'));
    expect(hasText(root, 'Scan Pairing QR')).toBe(false);
    act(() => result.tree.unmount());
  });

  it.each([
    [
      'bridge URL and token aliases',
      { url: 'ws://127.0.0.1:3001/', token: ' alias-token ' },
      'http://127.0.0.1:3001',
      'alias-token',
    ],
    [
      'slash pair type',
      { type: ' DAPPERCODE/BRIDGE-PAIR ', bridgeToken: 'slash-pair' },
      '',
      'slash-pair',
    ],
    [
      'dash token type',
      { type: 'dappercode-bridge-token', bridgeToken: 'dash-token' },
      '',
      'dash-token',
    ],
    [
      'slash token type',
      { type: 'dappercode/bridge-token', token: 'slash-token' },
      '',
      'slash-token',
    ],
    ['missing type', { bridgeToken: 'typeless' }, '', 'typeless'],
  ])('accepts QR JSON payload using %s', async (_name, payload, expectedUrl, expectedToken) => {
    mockCameraGranted = true;
    const result = await renderOnboarding({ mode: 'add' });
    const root = result.tree.root as Queryable;
    await press(findPressableByText(root, 'Scan QR'));
    const camera = requireTestValue(
      root.findAll((node) => node.type === 'mock-camera-view')[0],
      'indexed test value',
    );
    await act(async () =>
      readHandler<(event: { data: string }) => void>(
        camera,
        'onBarcodeScanned',
      )({ data: JSON.stringify(payload) }),
    );
    expect(findByLabel(root, 'Bridge URL').props['value']).toBe(expectedUrl);
    expect(findByLabel(root, 'Bridge token').props['value']).toBe(expectedToken);
    act(() => result.tree.unmount());
  });

  it.each([
    [
      'dappercode://pair?bridgeUrl=http%3A%2F%2F127.0.0.1%3A3001&bridgeToken=uri-token',
      'http://127.0.0.1:3001',
      'uri-token',
    ],
    [
      'dappercode://pair?url=ws%3A%2F%2F127.0.0.1%3A4001&token=alias-uri',
      'http://127.0.0.1:4001',
      'alias-uri',
    ],
    ['dappercode://pair?token=token-only', '', 'token-only'],
  ])('accepts pairing URI %s', async (data, expectedUrl, expectedToken) => {
    mockCameraGranted = true;
    const result = await renderOnboarding({ mode: 'add' });
    const root = result.tree.root as Queryable;
    await press(findPressableByText(root, 'Scan QR'));
    const camera = requireTestValue(
      root.findAll((node) => node.type === 'mock-camera-view')[0],
      'indexed test value',
    );
    await act(async () =>
      readHandler<(event: { data: string }) => void>(camera, 'onBarcodeScanned')({ data }),
    );
    expect(findByLabel(root, 'Bridge URL').props['value']).toBe(expectedUrl);
    expect(findByLabel(root, 'Bridge token').props['value']).toBe(expectedToken);
    act(() => result.tree.unmount());
  });

  it.each([
    '',
    JSON.stringify({ type: 42, bridgeUrl: 42, bridgeToken: 42 }),
    JSON.stringify({ type: 'other', bridgeToken: 'token' }),
    JSON.stringify({ type: 'dappercode-bridge-pair', bridgeToken: '   ' }),
    'https://example.com/?token=nope',
    'dappercode://pair',
  ])('rejects invalid QR form %p', async (data) => {
    mockCameraGranted = true;
    const result = await renderOnboarding({ mode: 'add' });
    const root = result.tree.root as Queryable;
    await press(findPressableByText(root, 'Scan QR'));
    const camera = requireTestValue(
      root.findAll((node) => node.type === 'mock-camera-view')[0],
      'indexed test value',
    );
    await act(async () =>
      readHandler<(event: { data: string }) => void>(camera, 'onBarcodeScanned')({ data }),
    );
    expect(hasText(root, 'QR code is not a valid DapperCode bridge pairing code.')).toBe(true);
    act(() => result.tree.unmount());
  });

  it('locks duplicate scans until the invalid scan delay expires', async () => {
    mockCameraGranted = true;
    const result = await renderOnboarding({ mode: 'add' });
    const root = result.tree.root as Queryable;
    await press(findPressableByText(root, 'Scan QR'));
    const camera = requireTestValue(
      root.findAll((node) => node.type === 'mock-camera-view')[0],
      'indexed test value',
    );
    await act(async () =>
      readHandler<(event: { data: string }) => void>(
        camera,
        'onBarcodeScanned',
      )({ data: 'invalid' }),
    );
    expect(camera.props['onBarcodeScanned']).toBeUndefined();
    act(() => jest.advanceTimersByTime(1200));
    const unlockedCamera = requireTestValue(
      root.findAll((node) => node.type === 'mock-camera-view')[0],
      'indexed test value',
    );
    await act(async () =>
      readHandler<(event: { data: string }) => void>(
        unlockedCamera,
        'onBarcodeScanned',
      )({ data: 'dappercode://pair?token=unlocked' }),
    );
    expect(findByLabel(root, 'Bridge token').props['value']).toBe('unlocked');
    act(() => result.tree.unmount());
  });

  it('times out the native probes, aborts fetch, and leaves controls busy while pending', async () => {
    const abort = jest.spyOn(AbortController.prototype, 'abort');
    (global.fetch as jest.Mock).mockImplementation(() => new Promise(() => {}));
    const result = await renderOnboarding({
      mode: 'add',
      initialBridgeUrl: 'http://127.0.0.1:3001',
      initialBridgeToken: 'token',
      allowQueryTokenAuth: true,
    });
    const root = result.tree.root as Queryable;
    let checkPromise: Promise<void> | undefined;
    act(() => {
      checkPromise = (
        findPressableByText(root, 'Test Connection').props['onPress'] as () => Promise<void>
      )();
    });
    expect(findPressableByText(root, 'Test Connection').props['accessibilityState']).toEqual(
      expect.objectContaining({ disabled: true, busy: true }),
    );
    expect(findByLabel(root, 'Continue').props['accessibilityState']).toEqual(
      expect.objectContaining({ disabled: true, busy: true }),
    );
    await act(async () => {
      jest.advanceTimersByTime(70_000);
      await checkPromise;
    });
    expect(abort).toHaveBeenCalled();
    expect(hasText(root, 'Connection error.')).toBe(true);
    act(() => result.tree.unmount());
  });

  it('cancels a cold save probe without saving when connection setup is dismissed', async () => {
    (global.fetch as jest.Mock).mockImplementation(
      (_url: string, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );
    const result = await renderOnboarding({
      mode: 'add',
      initialBridgeUrl: 'http://127.0.0.1:3001',
      initialBridgeToken: 'token',
      onCancel: jest.fn(),
    });
    const root = result.tree.root as Queryable;
    let savePromise: Promise<void> | undefined;
    act(() => {
      savePromise = (findByLabel(root, 'Continue').props['onPress'] as () => Promise<void>)();
    });

    await press(findByLabel(root, 'Cancel connection setup'));
    await act(async () => {
      await savePromise;
    });

    expect(result.onSave).not.toHaveBeenCalled();
    expect(result.onCancel).toHaveBeenCalled();
    expect(mockWsConnect).not.toHaveBeenCalled();
    expect(hasText(root, 'Connection error.')).toBe(false);
    act(() => result.tree.unmount());
  });

  it('handles fetch rejection, degraded RPC, unexpected RPC, and fallback save errors', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('network down'));
    mockWsRequest.mockResolvedValueOnce({ status: 'degraded' });
    const degraded = await renderOnboarding({
      mode: 'add',
      initialBridgeUrl: 'http://127.0.0.1:3001',
      initialBridgeToken: 'token',
    });
    await press(findPressableByText(degraded.tree.root as Queryable, 'Test Connection'));
    expect(hasText(degraded.tree.root as Queryable, 'Authenticated RPC verified')).toBe(true);
    act(() => degraded.tree.unmount());

    mockWsRequest.mockResolvedValueOnce({ status: 'wrong' });
    const unexpected = await renderOnboarding({
      mode: 'add',
      initialBridgeUrl: 'http://127.0.0.1:3001',
      initialBridgeToken: 'token',
    });
    await press(findPressableByText(unexpected.tree.root as Queryable, 'Test Connection'));
    expect(hasText(unexpected.tree.root as Queryable, 'Connection error.')).toBe(true);
    act(() => unexpected.tree.unmount());

    mockWsRequest.mockRejectedValueOnce(new Error('save probe failed'));
    const failedSaveProbe = await renderOnboarding({
      mode: 'add',
      initialBridgeUrl: 'http://127.0.0.1:3001',
      initialBridgeToken: 'token',
    });
    await press(findByLabel(failedSaveProbe.tree.root as Queryable, 'Continue'));
    expect(failedSaveProbe.onSave).not.toHaveBeenCalled();
    act(() => failedSaveProbe.tree.unmount());

    const fallback = await renderOnboarding({
      mode: 'add',
      initialBridgeUrl: 'http://127.0.0.1:3001',
      initialBridgeToken: 'token',
      onSave: jest.fn().mockRejectedValue({ message: '' }),
    });
    await press(findByLabel(fallback.tree.root as Queryable, 'Continue'));
    expect(hasText(fallback.tree.root as Queryable, 'Saving the connection failed.')).toBe(true);
    act(() => fallback.tree.unmount());
  });

  it('copies commands and shares the guide on iOS and Android, including rejected shares', async () => {
    const share = jest.spyOn(Share, 'share');
    const result = await renderOnboarding({ mode: 'add' });
    const root = result.tree.root as Queryable;
    await press(findPressableByText(root, 'Copy'));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(
      'Open the desktop companion on your Mac to set up and start the bundled bridge.',
    );
    expect(hasText(root, 'Copied')).toBe(true);
    act(() => jest.advanceTimersByTime(1400));
    expect(hasText(root, 'Copy')).toBe(true);

    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    await press(findByLabel(root, 'Share bridge setup guide'));
    expect(share).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: 'https://github.com/DavidParks8/DapperCode/blob/main/docs/setup-and-operations.md',
      }),
    );
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    share.mockRejectedValueOnce(new Error('cancelled'));
    await press(findByLabel(root, 'Share bridge setup guide'));
    expect(share).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          'https://github.com/DavidParks8/DapperCode/blob/main/docs/setup-and-operations.md',
        ),
      }),
    );
    act(() => result.tree.unmount());
  });

  it('submits from both inputs and clears prior status when values change', async () => {
    const result = await renderOnboarding({
      mode: 'add',
      initialBridgeUrl: 'http://127.0.0.1:3001',
      initialBridgeToken: 'token',
    });
    const root = result.tree.root as Queryable;
    await act(async () =>
      readHandler<() => void>(findByLabel(root, 'Bridge URL'), 'onSubmitEditing')(),
    );
    expect(result.onSave).toHaveBeenCalledTimes(1);
    act(() =>
      readHandler<(value: string) => void>(findByLabel(root, 'Bridge URL'), 'onChangeText')('bad'),
    );
    expect(hasText(root, 'Connected. URL and token both verified.')).toBe(false);
    act(() =>
      readHandler<(value: string) => void>(
        findByLabel(root, 'Bridge URL'),
        'onChangeText',
      )('http://127.0.0.1:3001'),
    );
    await act(async () =>
      readHandler<() => void>(findByLabel(root, 'Bridge token'), 'onSubmitEditing')(),
    );
    expect(result.onSave).toHaveBeenCalledTimes(2);
    act(() =>
      readHandler<(value: string) => void>(
        findByLabel(root, 'Bridge token'),
        'onChangeText',
      )('next-token'),
    );
    expect(hasText(root, 'Connected. URL and token both verified.')).toBe(false);
    act(() => result.tree.unmount());
  });

  it('reacts to mode and initial credential prop changes', async () => {
    const result = await renderOnboarding();
    expect(hasText(result.tree.root as Queryable, 'Private connection')).toBe(true);
    await result.rerender({
      mode: 'edit',
      initialBridgeUrl: 'http://127.0.0.1:4999',
      initialBridgeToken: 'rerender-token',
    });
    const root = result.tree.root as Queryable;
    expect(findByLabel(root, 'Bridge URL').props['value']).toBe('http://127.0.0.1:4999');
    expect(findByLabel(root, 'Bridge token').props['value']).toBe('rerender-token');
    expect(findByLabel(root, 'Save URL')).toBeTruthy();
    await result.rerender({ mode: 'initial', initialBridgeUrl: null, initialBridgeToken: null });
    expect(hasText(root, 'Private connection')).toBe(true);
    act(() => result.tree.unmount());
  });

  it('covers warning visibility permutations', async () => {
    const allowed = await renderOnboarding({
      mode: 'add',
      initialBridgeUrl: 'http://example.com',
      allowInsecureRemoteBridge: true,
    });
    expect(hasText(allowed.tree.root as Queryable, 'plain HTTP over a non-private host')).toBe(
      false,
    );
    act(() =>
      readHandler<(value: string) => void>(
        findByLabel(allowed.tree.root as Queryable, 'Bridge URL'),
        'onChangeText',
      )('https://example.com'),
    );
    expect(hasText(allowed.tree.root as Queryable, 'plain HTTP over a non-private host')).toBe(
      false,
    );
    act(() => allowed.tree.unmount());
  });

  it('renders the native form and status styling with the light theme', async () => {
    const result = await renderOnboarding({
      mode: 'add',
      initialBridgeUrl: 'http://example.com',
      initialBridgeToken: 'token',
      themeMode: 'light',
    });
    const root = result.tree.root as Queryable;
    expect(findByLabel(root, 'Bridge URL')).toBeTruthy();
    await press(findPressableByText(root, 'Test Connection'));
    expect(hasText(root, 'Connected. URL and token both verified.')).toBe(true);
    act(() => result.tree.unmount());
  });

  it('opens after newly granted permission and covers every modal close path', async () => {
    mockRequestCameraPermission.mockResolvedValueOnce({ granted: true });
    const result = await renderOnboarding({ mode: 'add' });
    const root = result.tree.root as Queryable;
    await press(findPressableByText(root, 'Scan QR'));
    expect(hasText(root, 'Scan Pairing QR')).toBe(true);
    expect(hasText(root, 'Camera permission is required to scan the pairing QR.')).toBe(true);
    const modal = requireTestValue(
      root.findAll((node) => node.type === Modal)[0],
      'indexed test value',
    );
    act(() => readHandler<() => void>(modal, 'onRequestClose')());
    expect(hasText(root, 'Scan Pairing QR')).toBe(false);

    mockCameraGranted = true;
    await result.rerender({ mode: 'add' });
    await press(findPressableByText(root, 'Scan QR'));
    await press(findPressableByText(root, 'Cancel'));
    expect(hasText(root, 'Scan Pairing QR')).toBe(false);

    await press(findPressableByText(root, 'Scan QR'));
    const sheet = requireTestValue(
      root.findAll((node) => node.props['accessibilityRole'] === 'none')[0],
      'indexed test value',
    );
    const stopPropagation = jest.fn();
    act(() =>
      readHandler<(event: { stopPropagation: () => void }) => void>(
        sheet,
        'onPress',
      )({ stopPropagation }),
    );
    expect(stopPropagation).toHaveBeenCalled();
    const backdrop = requireTestValue(
      root.findAll(
        (node) =>
          node.props['accessibilityLabel'] === 'Close QR scanner' &&
          typeof node.props['onPress'] === 'function',
      )[0],
      'indexed test value',
    );
    await press(backdrop);
    expect(hasText(root, 'Scan Pairing QR')).toBe(false);
    act(() => result.tree.unmount());
  });

  it('does not re-probe after a successful Test Connection when saving unchanged credentials', async () => {
    const result = await renderOnboarding({
      mode: 'add',
      initialBridgeUrl: 'http://127.0.0.1:3001',
      initialBridgeToken: 'token',
    });
    const root = result.tree.root as Queryable;
    await press(findPressableByText(root, 'Test Connection'));
    expect(hasText(root, 'Connected. URL and token both verified.')).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockWsRequest).toHaveBeenCalledTimes(1);
    (feedback.success as jest.Mock).mockClear();

    await press(findByLabel(root, 'Continue'));

    // The unchanged, already-successful credential check must be reused rather than probed again.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockWsRequest).toHaveBeenCalledTimes(1);
    expect(result.onSave).toHaveBeenCalledWith({
      bridgeUrl: 'http://127.0.0.1:3001',
      bridgeToken: 'token',
      workspaceId: null,
    });
    // No redundant success haptic for a save that skipped a fresh probe.
    expect(feedback.success as jest.Mock).not.toHaveBeenCalled();
    act(() => result.tree.unmount());
  });

  it('does re-probe when credentials change after a successful Test Connection', async () => {
    const result = await renderOnboarding({
      mode: 'add',
      initialBridgeUrl: 'http://127.0.0.1:3001',
      initialBridgeToken: 'token',
    });
    const root = result.tree.root as Queryable;
    await press(findPressableByText(root, 'Test Connection'));
    expect(global.fetch).toHaveBeenCalledTimes(1);
    act(() =>
      readHandler<(value: string) => void>(
        findByLabel(root, 'Bridge token'),
        'onChangeText',
      )('different-token'),
    );

    await press(findByLabel(root, 'Continue'));

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(mockWsRequest).toHaveBeenCalledTimes(2);
    act(() => result.tree.unmount());
  });

  it('discards a stale in-flight probe result for credentials edited while it was pending', async () => {
    let resolveWsRequest: ((value: { status: string }) => void) | undefined;
    mockWsRequest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveWsRequest = resolve;
        }),
    );
    const result = await renderOnboarding({
      mode: 'add',
      initialBridgeUrl: 'http://127.0.0.1:3001',
      initialBridgeToken: 'token-a',
    });
    const root = result.tree.root as Queryable;

    // Start a Test Connection probe for the original credentials; it stays pending on the
    // authenticated RPC health check until resolveWsRequest is invoked below.
    await act(async () => {
      readHandler<() => void>(findPressableByText(root, 'Test Connection'), 'onPress')();
      await Promise.resolve();
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // Edit both fields to a different, never-probed pair of credentials while the first
    // probe is still in flight.
    act(() =>
      readHandler<(value: string) => void>(
        findByLabel(root, 'Bridge URL'),
        'onChangeText',
      )('http://127.0.0.1:4002'),
    );
    act(() =>
      readHandler<(value: string) => void>(
        findByLabel(root, 'Bridge token'),
        'onChangeText',
      )('token-b'),
    );
    expect(hasText(root, 'Connected. URL and token both verified.')).toBe(false);

    // Let the stale probe for the original credentials resolve.
    await act(async () => {
      resolveWsRequest?.({ status: 'ok' });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The stale success must never surface for credentials the user has since replaced.
    expect(hasText(root, 'Connected. URL and token both verified.')).toBe(false);

    // Editing mid-probe bumps input generation but must NOT block the still-active probe from
    // clearing its own busy state once it settles: Test Connection/Continue must not be left
    // disabled+busy forever. Read `.props` directly rather than relying on the `press` helper,
    // which invokes onPress unconditionally and would not surface a stuck-disabled regression.
    const testConnectionButton = findPressableByText(root, 'Test Connection');
    expect(testConnectionButton.props['disabled']).toBe(false);
    expect(testConnectionButton.props['accessibilityState']).toEqual(
      expect.objectContaining({ disabled: false, busy: false }),
    );
    const continueButtonAfterStaleProbe = findByLabel(root, 'Continue');
    expect(continueButtonAfterStaleProbe.props['disabled']).toBe(false);
    expect(continueButtonAfterStaleProbe.props['accessibilityState']).toEqual(
      expect.objectContaining({ disabled: false, busy: false }),
    );

    // Saving the edited (never-probed) credentials must run its own probe rather than
    // trusting the discarded, mismatched result.
    await press(findByLabel(root, 'Continue'));
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(mockWsRequest).toHaveBeenCalledTimes(2);
    expect(result.onSave).toHaveBeenCalledWith({
      bridgeUrl: 'http://127.0.0.1:4002',
      bridgeToken: 'token-b',
      workspaceId: null,
    });
    act(() => result.tree.unmount());
  });

  it('clears a cached probe success when initial credentials reset via props', async () => {
    const result = await renderOnboarding({
      mode: 'edit',
      initialBridgeUrl: 'http://127.0.0.1:3001',
      initialBridgeToken: 'token-a',
    });
    const root = result.tree.root as Queryable;
    await press(findPressableByText(root, 'Test Connection'));
    expect(hasText(root, 'Connected. URL and token both verified.')).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    await result.rerender({
      mode: 'edit',
      initialBridgeUrl: 'http://127.0.0.1:9002',
      initialBridgeToken: 'token-b',
    });

    // The cached success from the previous profile's credentials must not leak into the
    // freshly loaded, never-probed pair.
    expect(hasText(root, 'Connected. URL and token both verified.')).toBe(false);
    expect(findByLabel(root, 'Bridge URL').props['value']).toBe('http://127.0.0.1:9002');

    await press(findByLabel(root, 'Save URL'));
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(result.onSave).toHaveBeenCalledWith({
      bridgeUrl: 'http://127.0.0.1:9002',
      bridgeToken: 'token-b',
      workspaceId: null,
    });
    act(() => result.tree.unmount());
  });

  it('fires semantic haptics for selection, connection outcomes, and QR scan results', async () => {
    mockRequestCameraPermission.mockResolvedValueOnce({ granted: true });
    mockCameraGranted = true;
    const result = await renderOnboarding();
    const root = result.tree.root as Queryable;

    await press(findPressableByText(root, 'Private connection'));
    expect(feedback.selection as jest.Mock).toHaveBeenCalled();
    (feedback.selection as jest.Mock).mockClear();

    const url = findByLabel(root, 'Bridge URL');
    const token = findByLabel(root, 'Bridge token');
    act(() => readHandler<(value: string) => void>(url, 'onChangeText')('http://127.0.0.1:3001'));
    act(() => readHandler<(value: string) => void>(token, 'onChangeText')('token'));

    await press(findPressableByText(root, 'Test Connection'));
    expect(feedback.success as jest.Mock).toHaveBeenCalledTimes(1);

    (global.fetch as jest.Mock).mockResolvedValueOnce({ status: 503 });
    mockWsRequest.mockRejectedValueOnce(new Error('offline'));
    act(() => readHandler<(value: string) => void>(token, 'onChangeText')('token-changed'));
    await press(findPressableByText(root, 'Test Connection'));
    expect(feedback.error as jest.Mock).toHaveBeenCalled();

    await press(findPressableByText(root, 'Scan QR'));
    expect(feedback.selection as jest.Mock).toHaveBeenCalled();
    act(() => result.tree.unmount());
  });

  it('meets the platform touch-target minimum and exposes accessibility roles/labels/hints', async () => {
    const initial = await renderOnboarding();
    const initialRoot = initial.tree.root as Queryable;
    await press(findPressableByText(initialRoot, 'Private connection'));

    const backButton = findByLabel(initialRoot, 'Back');
    expect(backButton.props['accessibilityRole']).toBe('button');
    expect(backButton.props['accessibilityHint']).toBeTruthy();

    const scanButton = findByLabel(initialRoot, 'Scan QR');
    expect(scanButton.props['accessibilityRole']).toBe('button');
    expect(scanButton.props['accessibilityHint']).toBeTruthy();
    act(() => initial.tree.unmount());

    const direct = await renderOnboarding({
      mode: 'add',
      initialBridgeUrl: 'http://127.0.0.1:3001',
      initialBridgeToken: 'token',
    });
    const directRoot = direct.tree.root as Queryable;

    const cancelButton = findByLabel(directRoot, 'Cancel connection setup');
    const cancelHitSlop = cancelButton.props['hitSlop'] as {
      top: number;
      bottom: number;
      left: number;
      right: number;
    };
    const minimum = Platform.select({ ios: 44, android: 48, default: 44 });
    // cancelBtn is drawn at 30px; hitSlop must pad it out to at least the platform minimum.
    expect(30 + cancelHitSlop.top + cancelHitSlop.bottom).toBeGreaterThanOrEqual(minimum);
    expect(30 + cancelHitSlop.left + cancelHitSlop.right).toBeGreaterThanOrEqual(minimum);

    act(() => direct.tree.unmount());
  });

  it('caps Share/Copy hitSlop so adjacent sides never overlap the commandCardActions gap', async () => {
    // commandCardActions gap is spacing.xs (4). Each button's horizontal slop must stay within
    // half that gap so the two adjacent hit areas meet without stealing taps from one another,
    // on both iOS's 44pt and Android's 48dp minimum effective touch target.
    for (const platformOS of ['ios', 'android'] as const) {
      Object.defineProperty(Platform, 'OS', { configurable: true, value: platformOS });
      const slop = computeHitSlop({ width: 30, height: 30 }, { maxHorizontal: 2 });
      expect(slop.left).toBeLessThanOrEqual(2);
      expect(slop.right).toBeLessThanOrEqual(2);
      expect(slop.left + slop.right).toBeLessThanOrEqual(4);
      // Vertical slop stays uncapped so the full platform minimum is preserved on that axis.
      const minimum = platformOS === 'android' ? 48 : 44;
      expect(30 + slop.top + slop.bottom).toBeGreaterThanOrEqual(minimum);
    }
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });

    const result = await renderOnboarding({ mode: 'add' });
    const root = result.tree.root as Queryable;
    const shareButton = findByLabel(root, 'Share bridge setup guide');
    const copyButton = findByLabel(root, 'Copy setup command');
    const shareHitSlop = shareButton.props['hitSlop'] as {
      top: number;
      bottom: number;
      left: number;
      right: number;
    };
    const copyHitSlop = copyButton.props['hitSlop'] as typeof shareHitSlop;

    // Share sits left of Copy in commandCardActions: Share's right slop plus Copy's left slop
    // must not exceed the 4px gap between them, or one button's hit area reaches into the
    // other's visible chrome.
    expect(shareHitSlop.right).toBeLessThanOrEqual(2);
    expect(copyHitSlop.left).toBeLessThanOrEqual(2);
    expect(shareHitSlop.right + copyHitSlop.left).toBeLessThanOrEqual(4);
    // Vertical (top/bottom) slop is unaffected by the horizontal cap and still meets the 44pt
    // iOS minimum effective touch target.
    expect(30 + shareHitSlop.top + shareHitSlop.bottom).toBeGreaterThanOrEqual(44);
    expect(30 + copyHitSlop.top + copyHitSlop.bottom).toBeGreaterThanOrEqual(44);

    act(() => result.tree.unmount());
  });

  it('renders StatusBanner without a Reanimated entrance when Reduce Motion is enabled', async () => {
    setMockReducedMotionEnabled(true);
    try {
      const result = await renderOnboarding({
        mode: 'add',
        initialBridgeUrl: 'http://127.0.0.1:3001',
        initialBridgeToken: 'token',
      });
      const root = result.tree.root as Queryable;
      await press(findPressableByText(root, 'Test Connection'));
      expect(hasText(root, 'Connected. URL and token both verified.')).toBe(true);
      act(() => result.tree.unmount());
    } finally {
      setMockReducedMotionEnabled(false);
    }
  });

  it('uses Android-appropriate keyboard avoidance so the URL/token fields stay reachable', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    try {
      const result = await renderOnboarding({ mode: 'add' });
      const root = result.tree.root as Queryable;
      const keyboardAvoiding = requireTestValue(
        root.findAll((node) => node.type === KeyboardAvoidingView)[0],
        'indexed test value',
      );
      expect(keyboardAvoiding.props['behavior']).toBe('height');
      act(() => result.tree.unmount());
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    }
  });

  describe('typography tokens', () => {
    it('has no ad hoc numeric fontSize literals in owned onboarding source files', () => {
      const fs: typeof fsNode = jest.requireActual('fs');
      const path: typeof pathNode = jest.requireActual('path');
      const dir = __dirname;
      const offenders: string[] = [];
      for (const entry of fs.readdirSync(dir)) {
        if (!/\.tsx?$/.test(entry) || entry.endsWith('.test.tsx') || entry.endsWith('.test.ts')) {
          continue;
        }
        const contents = fs.readFileSync(path.join(dir, entry), 'utf8');
        const matches = contents.match(/fontSize:\s*[0-9]/g);
        if (matches) {
          offenders.push(`${entry}: ${matches.join(', ')}`);
        }
      }
      expect(offenders).toEqual([]);
    });

    it('renders the brand name using the headline semantic role', async () => {
      const result = await renderOnboarding({ mode: 'initial' });
      const root = result.tree.root as Queryable;
      const brandNode = root.findAll(
        (node) => node.children.map(String).join('') === 'DapperCode',
      )[0];
      const style = Array.isArray(brandNode?.props['style'])
        ? Object.assign({}, ...brandNode.props['style'])
        : ((brandNode?.props['style'] as Record<string, unknown>) ?? {});
      expect(style.fontSize).toBe(theme.typography.headline.fontSize);
      act(() => result.tree.unmount());
    });

    it('renders the compact stepper pill index using the metadata semantic role', async () => {
      const result = await renderOnboarding({ mode: 'initial' });
      const root = result.tree.root as Queryable;
      await press(findPressableByText(root, 'Private connection'));
      const pillIndexNode = root.findAll((node) => node.children.map(String).join('') === '1')[0];
      const style = Array.isArray(pillIndexNode?.props['style'])
        ? Object.assign({}, ...pillIndexNode.props['style'])
        : ((pillIndexNode?.props['style'] as Record<string, unknown>) ?? {});
      expect(style.fontSize).toBe(theme.typography.metadata.fontSize);
      // 11pt readability floor is preserved via the metadata role rather than a raw literal.
      expect(style.fontSize).toBeGreaterThanOrEqual(11);
      act(() => result.tree.unmount());
    });
  });
});
