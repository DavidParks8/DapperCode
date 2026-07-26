import renderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { Chat } from '../../api/types';
import { createAppTheme, AppThemeProvider } from '../../theme';
import { SubAgentDetailView } from './SubAgentDetailView';
import type { ThreadRuntimeSnapshot } from './mainScreenHelpers';

const theme = createAppTheme('dark');

function chat(messages: Chat['messages'] = []): Chat {
  return {
    id: 'child',
    title: 'Research dependency options',
    status: 'running',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    statusUpdatedAt: '2026-07-20T00:00:00.000Z',
    lastMessagePreview: '',
    messages,
  };
}

function render(
  overrides: Partial<React.ComponentProps<typeof SubAgentDetailView>> = {}
): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 47, left: 0, right: 0, bottom: 34 },
        }}
      >
        <AppThemeProvider theme={theme}>
          <SubAgentDetailView
            visible
            chat={chat()}
            parentChat={null}
            runtime={null}
            liveMessageState={null}
            display={null}
            title="Research dependency options"
            loading={false}
            error={null}
            bridgeUrl="https://bridge.test"
            bridgeToken={null}
            showToolCalls
            agentThreadStatusById={new Map()}
            onClose={jest.fn()}
            {...overrides}
          />
        </AppThemeProvider>
      </SafeAreaProvider>
    );
  });
  if (!tree) throw new Error('render failed');
  return tree;
}

type Queryable = ReactTestInstance & {
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
};

function countByLabel(tree: ReactTestRenderer, label: string): number {
  return (tree.root as Queryable).findAll((node) => node.props.accessibilityLabel === label).length;
}

function isStarting(tree: ReactTestRenderer): boolean {
  return countByLabel(tree, 'Sub-agent starting') > 0;
}

describe('SubAgentDetailView starting state', () => {
  it('reports a sub-agent that has not produced anything as starting', () => {
    // A just-spawned sub-agent has no transcript. An empty scroll view makes a
    // live agent look dead.
    const tree = render();
    expect(isStarting(tree)).toBe(true);
    act(() => tree.unmount());
  });

  it('drops the starting state the moment streamed text arrives', () => {
    // The card becomes navigable before the child has said anything, so the page
    // has to switch to the transcript as soon as the bridge streams a token.
    const runtime = { streamingText: 'Reading package.json' } as unknown as ThreadRuntimeSnapshot;
    const tree = render({ runtime });
    expect(isStarting(tree)).toBe(false);
    act(() => tree.unmount());
  });

  it('drops the starting state once a persisted message exists', () => {
    const tree = render({
      chat: chat([
        {
          id: 'message-1',
          role: 'assistant',
          content: 'Found three options',
          createdAt: '2026-07-20T00:00:01.000Z',
        },
      ]),
    });
    expect(isStarting(tree)).toBe(false);
    act(() => tree.unmount());
  });

  it('never shows a starting state for a sub-agent that has already finished', () => {
    // Regression: a finished sub-agent that left no transcript spun on "Starting…"
    // forever, because the state was derived from the message count alone.
    for (const status of ['complete', 'idle', 'error'] as const) {
      const tree = render({ chat: { ...chat(), status } });
      expect(isStarting(tree)).toBe(false);
      expect(countByLabel(tree, 'Sub-agent reported no transcript')).toBeGreaterThan(0);
      act(() => tree.unmount());
    }
  });

  it('still reports a running sub-agent with no transcript as starting', () => {
    const tree = render({ chat: { ...chat(), status: 'running' } });
    expect(isStarting(tree)).toBe(true);
    expect(countByLabel(tree, 'Sub-agent reported no transcript')).toBe(0);
    act(() => tree.unmount());
  });

  it('shows the loading shell instead of a starting state before the chat resolves', () => {
    const tree = render({ chat: null, loading: true });
    expect(isStarting(tree)).toBe(false);
    expect(countByLabel(tree, 'Loading agent transcript')).toBeGreaterThan(0);
    act(() => tree.unmount());
  });
});
