import { act, render, screen } from '@testing-library/react-native';
import { Dimensions, Keyboard, type KeyboardEvent } from 'react-native';
import { ChatInput } from '../../chat/composer/ChatInput';
import type { LocalThread } from '../runtime/types';
import { LocalChatScreen } from './ChatScreen';

jest.mock('expo-router', () => ({
  ...jest.requireActual('@shared/testing/expoRouterMock'),
  useLocalSearchParams: () => ({ threadId: '00000000-0000-4000-8000-000000000001' }),
}));
jest.mock('@shell/layout/useShellLayout', () => ({
  useSceneHorizontalInsets: () => ({ paddingLeft: 0, paddingRight: 0 }),
}));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 24, bottom: 34, left: 0, right: 0 }),
}));
jest.mock('../runtime/OnDeviceProvider', () => ({ useOnDeviceRuntime: () => mockRuntime }));
jest.mock('../../chat/composer/ChatInput', () => ({ ChatInput: jest.fn(() => null) }));
jest.mock('../../chat/transcript/ChatTranscriptView', () => ({ ChatTranscriptView: () => null }));
jest.mock('./GitTransferProgress', () => ({ GitTransferProgress: () => null }));

const thread: LocalThread = {
  version: 1,
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Local conversation',
  workspaceId: 'workspace',
  modelId: 'qwen3-1.7b-q4-k-m',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  status: 'idle',
  activeTurnId: null,
  lastSubmissionId: null,
  lastError: null,
  messages: [],
};
const mockRuntime = {
  draft: () => '',
  threads: { list: () => [thread] },
  workspaces: () => [{ id: 'workspace', name: 'Workspace' }],
  loop: { snapshot: () => ({ phase: 'idle', threadId: null }) },
  models: { snapshot: () => ({ phase: 'empty', modelId: null }) },
  workspaceActivity: () => null,
  error: () => null,
};

afterEach(() => {
  jest.restoreAllMocks();
});

test('typing moves the local composer above the measured keyboard once and restores its safe-area spacing on hide', () => {
  const original = Keyboard.addListener.bind(Keyboard);
  const handlers = new Map<string, (event: KeyboardEvent) => void>();
  jest.spyOn(Keyboard, 'addListener').mockImplementation((name, handler) => {
    handlers.set(name, handler);
    return original(name, handler);
  });
  const window = Dimensions.get('window');
  const coordinate = { screenX: 0, screenY: window.height - 300, width: window.width, height: 300 };
  const event: KeyboardEvent = {
    duration: 250,
    easing: 'keyboard',
    startCoordinates: coordinate,
    endCoordinates: coordinate,
    isEventFromThisApp: true,
  };
  const view = render(<LocalChatScreen />);
  const layout = () => screen.getByTestId('on-device-chat-body').props['style'];
  const composer = () => jest.mocked(ChatInput).mock.calls.at(-1)?.[0];
  expect(layout()).toMatchObject({ paddingBottom: 0 });
  expect(composer()).toMatchObject({ keyboardVisible: false, safeAreaBottomInset: 34 });
  act(() => {
    handlers.get('keyboardWillShow')?.(event);
  });
  expect(layout()).toMatchObject({ paddingBottom: 300 });
  expect(composer()?.keyboardVisible).toBe(true);
  act(() => {
    handlers.get('keyboardWillChangeFrame')?.({
      ...event,
      endCoordinates: { ...coordinate, screenY: window.height - 350, height: 350 },
    });
  });
  expect(layout()).toMatchObject({ paddingBottom: 350 });
  act(() => {
    handlers.get('keyboardWillHide')?.(event);
  });
  expect(layout()).toMatchObject({ paddingBottom: 0 });
  expect(composer()?.keyboardVisible).toBe(false);
  view.unmount();
});
