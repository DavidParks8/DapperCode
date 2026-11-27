import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { ActivityIndicator, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { BridgeUiSurface } from '@bridge/types/types';
import { feedback } from '@shared/feedback';
import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { toBridgeUiSurface, upsertBridgeUiSurfaceList } from '../helpers/bridgeUi';
import { PhoneCallDock } from './PhoneCallDock';

jest.mock('@shared/feedback', () => ({
  feedback: {
    selection: jest.fn().mockResolvedValue(undefined),
    destructive: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

const theme = createAppTheme('dark');
const safeAreaMetrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function liveCall(
  status = 'In call',
  updatedAt = new Date().toISOString(),
  duration = '0:13',
  activity?: string,
): BridgeUiSurface {
  const items = [
    { label: 'Status', value: status },
    { label: 'To', value: '+15551234567' },
    { label: 'From', value: '+15550000001' },
    ...(activity ? [{ label: 'Activity', value: activity }] : []),
    { label: 'Duration', value: duration },
    { label: 'Objective', value: 'Request a prescription refill for pickup.' },
  ];
  const surface = toBridgeUiSurface({
    id: 'phone-call-live:call-1',
    threadId: 'thread-1',
    kind: 'phone-call',
    presentation: 'workflowCard',
    tone: 'success',
    title: 'Phone call · +15551234567',
    subtitle: status,
    blocks: [
      { type: 'keyValue', items },
      { type: 'markdown', markdown: '**Live transcript**\n\n**Recipient:** One moment please.' },
    ],
    actions: [{ id: 'hangup', label: 'Hang Up', style: 'destructive', dismissesSurface: false }],
    dismissible: false,
    updatedAt,
  });
  if (!surface) {
    throw new Error('Invalid phone call fixture');
  }
  return surface;
}

const endedCall: BridgeUiSurface = {
  ...liveCall(),
  title: 'Phone call ended',
  subtitle: 'Duration 1:05',
  tone: 'neutral',
  blocks: [
    {
      type: 'keyValue',
      items: [
        { label: 'Status', value: 'Ended' },
        { label: 'To', value: '+15551234567' },
        { label: 'Duration', value: '1:05' },
        { label: 'Summary', value: 'Refill ready Friday.' },
      ],
    },
  ],
  actions: [],
  dismissible: true,
};

const mounted: ReactTestRenderer[] = [];

function render(
  surface: BridgeUiSurface,
  handlers = { onOpenStage: jest.fn(), onAction: jest.fn(), onDismiss: jest.fn() },
  stageOpen = false,
) {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <SafeAreaProvider initialMetrics={safeAreaMetrics}>
        <AppThemeProvider theme={theme}>
          <PhoneCallDock surface={surface} stageOpen={stageOpen} {...handlers} />
        </AppThemeProvider>
      </SafeAreaProvider>,
    );
  });
  if (!tree) {
    throw new Error('PhoneCallDock did not render');
  }
  mounted.push(tree);
  return { tree, ...handlers };
}

type QueryableNode = {
  type: unknown;
  props: Record<string, unknown>;
  findAll(predicate: (node: QueryableNode) => boolean): QueryableNode[];
};

function rootOf(tree: ReactTestRenderer): QueryableNode {
  return tree.root as unknown as QueryableNode;
}

function byTestId(tree: ReactTestRenderer, testID: string): QueryableNode[] {
  return rootOf(tree).findAll(
    (node) => node.props['testID'] === testID && typeof node.type !== 'string',
  );
}

function shows(tree: ReactTestRenderer, testID: string): boolean {
  return byTestId(tree, testID).length > 0;
}

function press(tree: ReactTestRenderer, testID: string): void {
  const onPress = byTestId(tree, testID)[0]?.props['onPress'];
  if (typeof onPress !== 'function') {
    throw new Error(`${testID} is not pressable`);
  }
  act(() => {
    onPress();
  });
}

async function pressAndSettle(tree: ReactTestRenderer, testID: string): Promise<void> {
  const onPress = byTestId(tree, testID)[0]?.props['onPress'];
  if (typeof onPress !== 'function') {
    throw new Error(`${testID} is not pressable`);
  }
  await act(async () => {
    onPress();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function texts(tree: ReactTestRenderer): string[] {
  return rootOf(tree)
    .findAll((node) => node.type === Text)
    .map((node) => String(node.props['children']));
}

describe('PhoneCallDock', () => {
  afterEach(() => {
    act(() => {
      mounted.splice(0).forEach((tree) => tree.unmount());
    });
    jest.useRealTimers();
  });

  it('rests as a strictly 1-row ambient pill with formatted number and opens the Live Call Stage on tap', () => {
    const surface = liveCall('In call', new Date().toISOString(), '0:13', 'Agent speaking');
    const { tree, onOpenStage } = render(surface);

    expect(texts(tree)).toEqual(['(555) 123-4567', 'Agent speaking · 0:13']);
    expect(shows(tree, 'phone-call-dock-details')).toBe(false);

    press(tree, 'phone-call-dock-toggle');
    expect(feedback.selection).toHaveBeenCalled();
    expect(onOpenStage).toHaveBeenCalledWith(surface);
    expect(shows(tree, 'phone-call-dock-details')).toBe(false);
  });

  it('shows a live spinner badge when an async voice tool is running mid-call', () => {
    const surface = liveCall('In call', new Date().toISOString(), '0:42', 'Checking calendar…');
    const { tree } = render(surface);

    expect(texts(tree)).toEqual(['(555) 123-4567', 'Checking calendar… · 0:42']);
    expect(rootOf(tree).findAll((node) => node.type === ActivityIndicator)).toHaveLength(1);
  });

  it('keeps the call timer moving between bridge updates', () => {
    jest.useFakeTimers({ now: new Date('2026-11-14T08:00:00.000Z') });
    const { tree } = render(liveCall('On hold', '2026-11-14T08:00:00.000Z'));
    expect(texts(tree)).toContain('On hold · 0:13');

    act(() => {
      jest.advanceTimersByTime(2_000);
    });
    expect(texts(tree)).toContain('On hold · 0:15');
  });

  it.each([-60_000, 60_000])(
    'ticks from local receipt, not bridge time, with %d ms of phone clock skew',
    (skew) => {
      const bridgeTime = Date.parse('2026-11-14T08:00:00.000Z');
      jest.useFakeTimers({ now: bridgeTime + skew });
      const surface = liveCall('In call', new Date(bridgeTime).toISOString());

      act(() => {
        jest.advanceTimersByTime(4_000);
      });
      const { tree } = render(surface);
      expect(texts(tree)).toContain('In call · 0:17');

      act(() => {
        jest.advanceTimersByTime(2_000);
      });
      expect(texts(tree)).toContain('In call · 0:19');
    },
  );

  it('reanchors fresh duration updates and preserves receipt time through cached dock remounts', () => {
    jest.useFakeTimers({ now: new Date('2026-11-14T08:01:00.000Z') });
    let snapshots = upsertBridgeUiSurfaceList([], liveCall('In call', '2026-11-14T08:00:00.000Z'));
    const { tree, onOpenStage, onAction, onDismiss } = render(snapshots[0]!);
    expect(texts(tree)).toContain('In call · 0:13');
    act(() => {
      jest.advanceTimersByTime(2_500);
    });
    expect(texts(tree)).toContain('In call · 0:15');

    const update = liveCall('On hold', '2026-11-14T08:00:02.500Z', '1:00');
    snapshots = upsertBridgeUiSurfaceList(snapshots, update);
    act(() => {
      tree.update(
        <SafeAreaProvider initialMetrics={safeAreaMetrics}>
          <AppThemeProvider theme={theme}>
            <PhoneCallDock
              surface={snapshots[0]!}
              onOpenStage={onOpenStage}
              onAction={onAction}
              onDismiss={onDismiss}
            />
          </AppThemeProvider>
        </SafeAreaProvider>,
      );
    });
    expect(texts(tree)).toContain('On hold · 1:00');
    act(() => {
      jest.advanceTimersByTime(2_000);
    });
    expect(texts(tree)).toContain('On hold · 1:02');

    act(() => {
      tree.unmount();
      jest.advanceTimersByTime(3_000);
    });
    const { tree: remounted } = render(snapshots[0]!);
    expect(texts(remounted)).toContain('On hold · 1:05');
    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    expect(texts(remounted)).toContain('On hold · 1:06');
  });

  it('hangs up once and acknowledges the request until the call settles', () => {
    const { tree, onAction, onOpenStage } = render(liveCall());
    press(tree, 'phone-call-dock-hangup');
    expect(feedback.destructive).toHaveBeenCalled();
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0]?.[1]).toMatchObject({ id: 'hangup' });
    expect(byTestId(tree, 'phone-call-dock-hangup')[0]?.props['disabled']).toBe(true);
    expect(texts(tree)).toContain('Hanging up…');

    act(() => {
      tree.update(
        <SafeAreaProvider initialMetrics={safeAreaMetrics}>
          <AppThemeProvider theme={theme}>
            <PhoneCallDock
              surface={endedCall}
              onOpenStage={onOpenStage}
              onAction={onAction}
              onDismiss={jest.fn()}
            />
          </AppThemeProvider>
        </SafeAreaProvider>,
      );
    });
    expect(shows(tree, 'phone-call-dock-hangup')).toBe(false);
    expect(texts(tree)).toEqual(['(555) 123-4567', 'Ended · Refill ready Friday.']);
  });

  it('reports a failed hang-up in place and lets the user retry', async () => {
    const onAction = jest.fn().mockResolvedValue(false);
    const { tree } = render(liveCall(), {
      onOpenStage: jest.fn(),
      onAction,
      onDismiss: jest.fn(),
    });

    await pressAndSettle(tree, 'phone-call-dock-hangup');

    expect(texts(tree)).toContain('Couldn’t hang up. Try again.');
    expect(byTestId(tree, 'phone-call-dock-hangup')[0]?.props['disabled']).toBe(false);
    await pressAndSettle(tree, 'phone-call-dock-hangup');
    expect(onAction).toHaveBeenCalledTimes(2);
  });

  it('lets an unreported settled call be dismissed cleanly', () => {
    const { tree, onDismiss } = render(endedCall);
    expect(shows(tree, 'phone-call-dock-dismiss')).toBe(true);
    press(tree, 'phone-call-dock-dismiss');
    expect(onDismiss).toHaveBeenCalledWith(endedCall);
  });
});
