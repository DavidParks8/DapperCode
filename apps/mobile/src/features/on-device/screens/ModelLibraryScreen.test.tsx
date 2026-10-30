import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router, usePathname } from 'expo-router';
import { Text } from 'react-native';
import { resetRouterMock } from '@shared/testing/expoRouterMock';
import { ModelLibraryScreen } from './ModelLibraryScreen';
import { ModelFamilyScreen } from './ModelFamilyScreen';

jest.mock('expo-router', () => jest.requireActual('@shared/testing/expoRouterMock'));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('@shell/layout/useShellLayout', () => ({
  useSceneHorizontalInsets: () => ({ paddingLeft: 0, paddingRight: 0 }),
}));
jest.mock('../runtime/OnDeviceProvider', () => ({ useOnDeviceRuntime: () => mockRuntime }));

let mockPhysicalBytes = 16 * 1024 ** 3;
let mockDownloadingId: string | null = null;
const mockRuntime = {
  native: {
    getMemoryInfo: () => ({
      physicalBytes: mockPhysicalBytes,
      availableBytes: mockPhysicalBytes,
      isSimulator: true,
    }),
  },
  downloads: {
    snapshot: (id: string) =>
      id === mockDownloadingId
        ? {
            phase: 'downloading',
            bytesWritten: 40 * 1024 ** 2,
            totalBytes: 100 * 1024 ** 2,
            bytesPerSecond: 2 * 1024 ** 2,
            etaSeconds: 90,
            verifiedBytes: 0,
            canResume: false,
            verificationPending: false,
            error: null,
          }
        : {
            phase: id === 'qwen3-1.7b-q4-k-m' ? 'ready' : 'not_downloaded',
            bytesWritten: 0,
            totalBytes: 0,
            bytesPerSecond: null,
            etaSeconds: null,
            verifiedBytes: 0,
            canResume: false,
            verificationPending: false,
            error: null,
          },
    pause: jest.fn(async () => undefined),
    cancel: jest.fn(async () => undefined),
  },
  models: { snapshot: () => ({ modelId: null, phase: 'empty' }) },
  selectModel: jest.fn(async () => undefined),
  error: () => null,
};

function NavigationProbe() {
  const pathname = usePathname();
  if (pathname.startsWith('/on-device/chat/')) {
    return <Text>Returned to chat</Text>;
  }
  return pathname.startsWith('/on-device/models/') ? <ModelFamilyScreen /> : <ModelLibraryScreen />;
}

beforeEach(() => {
  resetRouterMock();
  router.replace('/on-device/models');
  mockPhysicalBytes = 16 * 1024 ** 3;
  mockDownloadingId = null;
  mockRuntime.selectModel.mockClear();
  mockRuntime.downloads.pause.mockClear();
  mockRuntime.downloads.cancel.mockClear();
});

test('family discovery shows modern families without quant actions and pushes the chosen family onto the stack', () => {
  render(<NavigationProbe />);
  expect(screen.getByText('Bonsai 2')).toBeTruthy();
  expect(screen.getByText('Qwen3.5')).toBeTruthy();
  expect(screen.getByText('Gemma 4')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Qwen3.5 model family' }));
  expect(router.push).toHaveBeenLastCalledWith({
    pathname: '/on-device/models/[familyId]',
    params: { familyId: 'qwen3.5' },
  });
  expect(screen.getByText('0.8B')).toBeTruthy();
  expect(screen.getByText('2B')).toBeTruthy();
  expect(screen.getAllByText('Q8_0')).toHaveLength(2);
  expect(screen.getAllByRole('button', { name: 'Download' }).length).toBeGreaterThan(1);
  fireEvent.press(screen.getByRole('button', { name: 'Back' }));
  expect(screen.getByRole('button', { name: 'Bonsai 2 model family' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
});

test('downloaded-only and family search remain effective across the family-to-quant navigation', () => {
  render(<NavigationProbe />);
  fireEvent.changeText(screen.getByLabelText('Search model families'), 'Gemma');
  expect(screen.queryByText('Bonsai 2')).toBeNull();
  expect(screen.getByText('Gemma 4')).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('Search model families'), '');
  fireEvent(screen.getByLabelText('Downloaded models only'), 'valueChange', true);
  expect(screen.queryByText('Bonsai 2')).toBeNull();
  expect(screen.getByText('Qwen3')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Qwen3 model family' }));
  expect(screen.getByText('1.7B')).toBeTruthy();
  expect(screen.queryByText('0.6B')).toBeNull();
  expect(screen.getByRole('button', { name: 'Load and use' })).toBeTruthy();
});

test('unsupported models stay filtered and cannot be loaded or downloaded when revealed', () => {
  mockPhysicalBytes = 1024 ** 3;
  render(<NavigationProbe />);
  expect(screen.queryByText('Qwen3')).toBeNull();
  fireEvent(
    screen.getByLabelText("Show models beyond this device's RAM budget"),
    'valueChange',
    true,
  );
  fireEvent.press(screen.getByRole('button', { name: 'Qwen3 model family' }));
  for (const button of screen.getAllByRole('button', { name: 'Download' })) {
    expect(button.props['accessibilityState']).toMatchObject({ disabled: true });
  }
  expect(
    screen.getByRole('button', { name: 'Load and use' }).props['accessibilityState'],
  ).toMatchObject({ disabled: true });
});

test('choosing a quant for a chat dismisses both picker pages back to that chat', async () => {
  router.replace({ pathname: '/on-device/chat/[threadId]', params: { threadId: 'thread-one' } });
  router.push({ pathname: '/on-device/models', params: { threadId: 'thread-one' } });
  render(<NavigationProbe />);
  fireEvent.press(screen.getByRole('button', { name: 'Qwen3 model family' }));
  fireEvent.press(screen.getByRole('button', { name: 'Load and use' }));
  await waitFor(() =>
    expect(mockRuntime.selectModel).toHaveBeenCalledWith('qwen3-1.7b-q4-k-m', 'thread-one'),
  );
  await waitFor(() => expect(screen.getByText('Returned to chat')).toBeTruthy());
  expect(router.dismissTo).toHaveBeenCalledWith({
    pathname: '/on-device/chat/[threadId]',
    params: { threadId: 'thread-one' },
  });
});

test('Prism-specific Bonsai packings are visible but cannot masquerade as usable quants', () => {
  render(<NavigationProbe />);
  fireEvent.press(screen.getByRole('button', { name: 'Bonsai 2 model family' }));
  expect(screen.getAllByText('Q2_0')).toHaveLength(2);
  expect(screen.getAllByRole('button', { name: 'Unavailable in this build' })).toHaveLength(4);
  expect(screen.getAllByRole('button', { name: 'Download' })).toHaveLength(2);
});

test('a running download shows byte progress and leaves other models usable', () => {
  mockDownloadingId = 'qwen3-0.6b-q4-0';
  render(<NavigationProbe />);
  fireEvent.press(screen.getByRole('button', { name: 'Qwen3 model family' }));
  expect(
    screen.getByText('Downloading 40% · 0.04 GiB of 0.10 GiB · 2.0 MiB/s · 2 min left'),
  ).toBeTruthy();
  for (const name of ['Load and use', 'Delete download']) {
    expect(screen.getByRole('button', { name }).props['accessibilityState']).toMatchObject({
      disabled: false,
    });
  }
  fireEvent.press(screen.getByRole('button', { name: 'Pause download' }));
  expect(mockRuntime.downloads.pause).toHaveBeenCalledWith('qwen3-0.6b-q4-0');
  fireEvent.press(screen.getByRole('button', { name: 'Cancel download' }));
  expect(mockRuntime.downloads.cancel).toHaveBeenCalledWith('qwen3-0.6b-q4-0');
});
