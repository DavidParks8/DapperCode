import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import type { Chat, ChatMessage } from '@bridge/types/types';
import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { ChatTranscriptView, type ChatTranscriptViewProps } from './ChatTranscriptView';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn().mockResolvedValue(true) }));
jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-gesture-handler', () =>
  jest.requireActual('@shared/testing/gestureHandlerMock'),
);

type Queryable = ReactTestInstance & {
  props: Record<string, unknown>;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
  findAllByProps(props: Record<string, unknown>): Queryable[];
};

const theme = createAppTheme('dark');

function toolCall(id: string, title: string, status: 'in_progress' | 'completed'): ChatMessage {
  return {
    id,
    role: 'tool',
    toolCallId: id,
    content: status === 'completed' ? `${title} finished with a long settled result line` : '',
    createdAt: '2026-09-01T00:00:00.000Z',
    toolMeta: { toolCallId: id, kind: 'other', status, title },
  };
}

function makeChat(messages: ChatMessage[]): Chat {
  return {
    id: 'thread',
    title: 'Rapid tools',
    status: 'running',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    statusUpdatedAt: '2026-09-01T00:00:00.000Z',
    lastMessagePreview: '',
    messages,
  };
}

const baseProps: ChatTranscriptViewProps = {
  chat: makeChat([]),
  parentChat: null,
  bridgeUrl: 'https://bridge',
  bridgeToken: null,
  showToolCalls: true,
  agentThreadStatusById: new Map(),
  scrollRef: { current: null },
  inlineChoicesEnabled: false,
  onInlineOptionSelect: jest.fn(),
  onPinnedAutoScroll: jest.fn(),
  onJumpToLatest: jest.fn(),
  onScrollInteractionStart: jest.fn(),
  autoScrollStateRef: {
    current: { shouldStickToBottom: true, isUserInteracting: false, isMomentumScrolling: false },
  },
  bottomInset: 0,
  scrollRailEnabled: false,
  activity: { tone: 'running', title: 'Chasing the hamster' },
};

function element(messages: ChatMessage[]) {
  return (
    <AppThemeProvider theme={theme}>
      <ChatTranscriptView {...baseProps} chat={makeChat(messages)} />
    </AppThemeProvider>
  );
}

describe('tool rows adjacent to the transcript activity row', () => {
  /**
   * Transcript rows live inside an inverted FlatList, whose cells carry `scaleY: -1`. Reanimated
   * snapshots raw Yoga frames without ancestor transforms, so a row driving its own layout
   * transition holds a stale frame anchored to the opposite visual edge while its siblings and the
   * activity header already sit at their committed positions. During a rapid tool burst that made
   * each new row paint on top of the "Chasing the hamster" row before snapping into place.
   */
  it('never lets a tool row drive its own layout transition while the activity row is on screen', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(element([toolCall('tool-1', 'Reading a file', 'in_progress')]));
    });
    if (!tree) {
      throw new Error('Expected a transcript tree');
    }
    const root = tree.root as Queryable;
    const activityRows = () => root.findAllByProps({ testID: 'transcript-activity-event' });
    const toolRows = () => root.findAllByProps({ testID: 'tool-row-layout' });
    const animatedRowLayouts = () => toolRows().map((row) => row.props['layout']);

    expect(activityRows().length).toBeGreaterThan(0);
    expect(toolRows().length).toBeGreaterThan(0);
    expect(animatedRowLayouts().every((layout) => layout === undefined)).toBe(true);

    // A rapid burst: the first row settles (resizing itself) in the same commit that appends the
    // next two rows directly beneath the activity header.
    act(() => {
      tree?.update(
        element([
          toolCall('tool-1', 'Reading a file', 'completed'),
          toolCall('tool-2', 'Searching the workspace', 'completed'),
          toolCall('tool-3', 'Running the test suite', 'in_progress'),
        ]),
      );
    });

    expect(activityRows().length).toBeGreaterThan(0);
    expect(toolRows().length).toBeGreaterThan(0);
    expect(animatedRowLayouts().every((layout) => layout === undefined)).toBe(true);

    act(() => tree?.unmount());
  });
});
