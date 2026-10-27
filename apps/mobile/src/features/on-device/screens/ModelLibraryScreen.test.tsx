import { fireEvent, render, screen } from '@testing-library/react-native';
import { ModelLibraryScreen } from './ModelLibraryScreen';

jest.mock('expo-router', () => jest.requireActual('@shared/testing/expoRouterMock'));
jest.mock('@shell/layout/useShellLayout', () => ({
  useSceneHorizontalInsets: () => ({ paddingLeft: 0, paddingRight: 0 }),
}));
jest.mock('../runtime/OnDeviceProvider', () => ({
  useOnDeviceRuntime: () => mockRuntime,
}));

let mockPhysicalBytes = 16 * 1024 ** 3;
const mockRuntime = {
  native: {
    getMemoryInfo: () => ({
      physicalBytes: mockPhysicalBytes,
      availableBytes: mockPhysicalBytes,
      isSimulator: true,
    }),
  },
  downloads: {
    snapshot: (id: string) => ({
      phase: id === 'qwen3-1.7b-q4-k-m' ? 'ready' : 'not_downloaded',
      bytesWritten: 0,
      canResume: false,
      verificationPending: false,
      error: null,
    }),
  },
  models: { snapshot: () => ({ modelId: null, phase: 'empty' }) },
  error: () => null,
};

beforeEach(() => {
  mockPhysicalBytes = 16 * 1024 ** 3;
});

test('catalog supports downloaded-only and search without losing the downloaded recommendation', () => {
  render(<ModelLibraryScreen />);
  expect(screen.getByText('Qwen3 0.6B')).toBeTruthy();
  expect(screen.getByText(/Qwen3 1.7B/)).toBeTruthy();
  fireEvent(screen.getByLabelText('Downloaded models only'), 'valueChange', true);
  expect(screen.queryByText('Qwen3 0.6B')).toBeNull();
  expect(screen.getByText(/Qwen3 1.7B/)).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('Search models'), '4B');
  expect(screen.queryByText(/Qwen3/)).toBeNull();
  fireEvent(screen.getByLabelText('Downloaded models only'), 'valueChange', false);
  expect(screen.getByText('Qwen3 4B')).toBeTruthy();
});

test('unsupported models are excluded by default and cannot be loaded or downloaded when revealed', () => {
  mockPhysicalBytes = 1024 ** 3;
  render(<ModelLibraryScreen />);
  expect(screen.queryByText(/Qwen3/)).toBeNull();
  fireEvent(
    screen.getByLabelText("Show models beyond this device's RAM budget"),
    'valueChange',
    true,
  );
  expect(screen.getByText('Qwen3 0.6B')).toBeTruthy();
  for (const button of screen.getAllByRole('button', { name: 'Download' })) {
    expect(button.props['accessibilityState']).toMatchObject({ disabled: true });
  }
  expect(
    screen.getByRole('button', { name: 'Load and use' }).props['accessibilityState'],
  ).toMatchObject({ disabled: true });
});
