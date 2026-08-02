import { AccessibilityInfo, Alert, TextInput } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import type { HostBridgeApiClient } from '../../api/client';
import type { RpcNotification, TerminalExecResponse } from '../../api/types';
import type { HostBridgeWsClient } from '../../api/ws';
import { feedback } from '../../feedback';
import { AppThemeProvider, createAppTheme } from '../../theme';
import { TerminalScreen } from './TerminalScreen';

jest.mock('react-native-reanimated', () => jest.requireActual('../../testing/reanimatedMock'));

jest.mock('@expo/vector-icons', () => ({ Ionicons: ({ name }: { name: string }) => name }));

jest.mock('../../feedback', () => ({
  feedback: {
    selection: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockResolvedValue(undefined),
    success: jest.fn().mockResolvedValue(undefined),
    warning: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
    destructive: jest.fn().mockResolvedValue(undefined),
  },
}));

type Queryable = Omit<ReactTestInstance, 'children' | 'findAll' | 'parent' | 'props'> & {
  children: unknown[];
  props: Record<string, unknown>;
  parent: Queryable | null;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
  findAllByType(type: unknown): Queryable[];
};

type PressCallback = () => void;
type TextChangeCallback = (value: string) => void;

const theme = createAppTheme('dark');
const lightTheme = createAppTheme('light');

function hasText(root: Queryable, text: string): boolean {
  return root.findAll((node) => node.children.map(String).join('').includes(text)).length > 0;
}

function findRunButton(root: Queryable): Queryable {
  const icon = root.findAll(
    (node) => node.children.includes('play') || node.children.includes('pause'),
  )[0];
  let current: Queryable | null = icon ?? null;
  while (current && typeof current.props.onPress !== 'function')
    current = current.parent as Queryable | null;
  if (!current) throw new Error('Missing run button');
  return current;
}

function findPressableAncestor(node: Queryable): Queryable {
  let current: Queryable | null = node;
  while (current && typeof current.props.onPress !== 'function')
    current = current.parent as Queryable | null;
  if (!current) throw new Error('Missing pressable ancestor');
  return current;
}

function getCallback<T extends (...args: never[]) => unknown>(node: Queryable, prop: string): T {
  const callback = node.props[prop];
  if (typeof callback !== 'function') throw new Error(`Expected ${prop} callback`);
  return callback as T;
}

async function renderTerminal(apiOverrides: Record<string, jest.Mock> = {}, appearance = theme) {
  const defaultResponse: TerminalExecResponse = {
    command: 'pwd',
    cwd: '/workspace',
    code: 0,
    stdout: '/workspace',
    stderr: '',
    timedOut: false,
    durationMs: 12,
  };
  const api = {
    execTerminal: jest.fn().mockResolvedValue(defaultResponse),
    ...apiOverrides,
  };
  const unsubscribe = jest.fn();
  let listener: Parameters<HostBridgeWsClient['onEvent']>[0] = () => {};
  const ws = {
    onEvent: jest.fn((next) => {
      listener = next;
      return unsubscribe;
    }),
  };
  const onOpenDrawer = jest.fn();
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = renderer.create(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 47, left: 0, right: 0, bottom: 34 },
        }}
      >
        <AppThemeProvider theme={appearance}>
          <TerminalScreen
            api={api as unknown as HostBridgeApiClient}
            ws={ws as unknown as HostBridgeWsClient}
            onOpenDrawer={onOpenDrawer}
          />
        </AppThemeProvider>
      </SafeAreaProvider>,
    );
  });
  if (!tree) throw new Error('Expected TerminalScreen tree');
  return { tree, api, ws, unsubscribe, getListener: () => listener, onOpenDrawer };
}

async function triggerRun(root: Queryable, choose: 'Cancel' | 'Run' = 'Run'): Promise<void> {
  await act(async () => {
    getCallback<PressCallback>(findRunButton(root), 'onPress')();
  });
  const buttons = (Alert.alert as jest.Mock).mock.calls.at(-1)?.[2] as Array<{
    text: string;
    onPress?: () => void;
  }>;
  const action = buttons.find((button) => button.text === choose);
  await act(async () => {
    action?.onPress?.();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('TerminalScreen behavior', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    (feedback.selection as jest.Mock).mockClear();
    (feedback.warning as jest.Mock).mockClear();
    (feedback.success as jest.Mock).mockClear();
    (feedback.error as jest.Mock).mockClear();
  });

  it('blocks blank commands, confirms execution, supports cancel, and opens the drawer', async () => {
    const result = await renderTerminal();
    const root = result.tree.root as Queryable;
    const input = root.findAllByType(TextInput)[0] as Queryable;
    act(() => getCallback<TextChangeCallback>(input, 'onChangeText')('   '));
    expect(findRunButton(root).props.disabled).toBe(true);
    act(() => getCallback<PressCallback>(input, 'onSubmitEditing')());
    expect(Alert.alert).not.toHaveBeenCalled();

    act(() => getCallback<TextChangeCallback>(input, 'onChangeText')('echo hello'));
    await triggerRun(root, 'Cancel');
    expect(result.api.execTerminal).not.toHaveBeenCalled();
    await triggerRun(root);
    expect(Alert.alert).toHaveBeenCalledWith('Run command?', 'echo hello', expect.any(Array));
    expect(result.api.execTerminal).toHaveBeenCalledWith({ command: 'echo hello' });

    const menuIcon = root.findAll((node) => node.children.includes('menu'))[0];
    act(() => getCallback<PressCallback>(findPressableAncestor(menuIcon), 'onPress')());
    expect(result.onOpenDrawer).toHaveBeenCalled();
    act(() => result.tree.unmount());
  });

  it('renders stdout success, empty stdout, stderr, nullable exit codes, and execution errors', async () => {
    const success = await renderTerminal();
    await triggerRun(success.tree.root as Queryable);
    expect(hasText(success.tree.root as Queryable, '$ pwd')).toBe(true);
    expect(hasText(success.tree.root as Queryable, '/workspace')).toBe(true);
    expect(hasText(success.tree.root as Queryable, 'exit 0 · 12ms')).toBe(true);
    act(() => success.tree.unmount());

    const stderrResponse: TerminalExecResponse = {
      command: 'pwd',
      cwd: '/workspace',
      code: null,
      stdout: '',
      stderr: 'permission denied',
      timedOut: false,
      durationMs: 4,
    };
    const stderr = await renderTerminal({
      execTerminal: jest.fn().mockResolvedValue(stderrResponse),
    });
    await triggerRun(stderr.tree.root as Queryable);
    expect(hasText(stderr.tree.root as Queryable, '(no stdout)')).toBe(true);
    expect(hasText(stderr.tree.root as Queryable, 'stderr:\npermission denied')).toBe(true);
    expect(hasText(stderr.tree.root as Queryable, 'exit null · 4ms')).toBe(true);
    act(() => stderr.tree.unmount());

    const failed = await renderTerminal({
      execTerminal: jest.fn().mockRejectedValue(new Error('terminal offline')),
    });
    await triggerRun(failed.tree.root as Queryable);
    expect(hasText(failed.tree.root as Queryable, 'terminal offline')).toBe(true);
    act(() => failed.tree.unmount());
  });

  it('appends valid and fallback websocket completion events, ignores others, and unsubscribes', async () => {
    const result = await renderTerminal();
    const root = result.tree.root as Queryable;
    act(() =>
      result.getListener()({
        method: 'bridge/chat/updated',
        params: null,
      } satisfies RpcNotification),
    );
    expect(hasText(root, '[ws]')).toBe(false);
    act(() =>
      result.getListener()({
        method: 'bridge/terminal/completed',
        params: { command: 'ls', code: 2 },
      } satisfies RpcNotification),
    );
    expect(hasText(root, '[ws] ls → 2')).toBe(true);
    act(() =>
      result.getListener()({
        method: 'bridge/terminal/completed',
        params: { command: 42, code: 'bad' },
      } satisfies RpcNotification),
    );
    expect(hasText(root, '[ws] unknown → null')).toBe(true);
    act(() =>
      result.getListener()({
        method: 'bridge/terminal/completed',
        params: { command: 'cancelled', code: null },
      } satisfies RpcNotification),
    );
    expect(hasText(root, '[ws] cancelled → null')).toBe(true);
    act(() => result.tree.unmount());
    expect(result.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('renders and executes in the light appearance', async () => {
    const result = await renderTerminal({}, lightTheme);
    expect(hasText(result.tree.root as Queryable, 'Run a command to see output.')).toBe(true);
    await triggerRun(result.tree.root as Queryable);
    expect(result.api.execTerminal).toHaveBeenCalledWith({ command: 'pwd' });
    act(() => result.tree.unmount());
  });

  it('run button meets minimum touch target via hitSlop', async () => {
    const result = await renderTerminal();
    const root = result.tree.root as Queryable;
    const runBtn = findRunButton(root);
    const hitSlop = runBtn.props.hitSlop as { top: number; bottom: number; left: number; right: number };
    // Button is 30pt, needs 7pt per side to reach 44pt minimum.
    expect(hitSlop.top).toBeGreaterThanOrEqual(7);
    expect(hitSlop.bottom).toBeGreaterThanOrEqual(7);
    expect(hitSlop.left).toBeGreaterThanOrEqual(7);
    expect(hitSlop.right).toBeGreaterThanOrEqual(7);
    act(() => result.tree.unmount());
  });

  it('fires selection haptic on Run and warning haptic on Stop', async () => {
    let resolveExec!: (value: TerminalExecResponse) => void;
    const pendingResponse = new Promise<TerminalExecResponse>((resolve) => {
      resolveExec = resolve;
    });
    const result = await renderTerminal({
      execTerminal: jest.fn().mockReturnValue(pendingResponse),
    });
    const root = result.tree.root as Queryable;
    const input = root.findAllByType(TextInput)[0] as Queryable;
    act(() => getCallback<TextChangeCallback>(input, 'onChangeText')('echo hi'));

    // Tap Run → confirm → selection haptic fires
    await triggerRun(root);
    expect(feedback.selection as jest.Mock).toHaveBeenCalledTimes(1);

    // While running, tap Stop → warning haptic fires
    const stopBtn = findRunButton(root);
    await act(async () => {
      getCallback<PressCallback>(stopBtn, 'onPress')();
    });
    expect(feedback.warning as jest.Mock).toHaveBeenCalledTimes(1);

    resolveExec({ command: 'echo hi', cwd: '/', code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 });
    act(() => result.tree.unmount());
  });

  it('announces running state for accessibility', async () => {
    const announceSpy = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(jest.fn());

    let resolveExec!: (value: TerminalExecResponse) => void;
    const pendingResponse = new Promise<TerminalExecResponse>((resolve) => {
      resolveExec = resolve;
    });
    const result = await renderTerminal({
      execTerminal: jest.fn().mockReturnValue(pendingResponse),
    });
    const root = result.tree.root as Queryable;
    const input = root.findAllByType(TextInput)[0] as Queryable;
    act(() => getCallback<TextChangeCallback>(input, 'onChangeText')('echo hi'));

    await triggerRun(root);
    expect(announceSpy).toHaveBeenCalledWith('Running command');

    resolveExec({ command: 'echo hi', cwd: '/', code: 0, stdout: 'hi', stderr: '', timedOut: false, durationMs: 1 });
    await act(async () => { await Promise.resolve(); });
    act(() => result.tree.unmount());
  });
});
