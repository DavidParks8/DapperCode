import React from 'react';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '../theme';
import { SubAgentCard } from './SubAgentCard';
import * as chatMessageStyles from './chatMessageStyles';
import type { TimelineEntry } from './chatMessageTypes';

const theme = createAppTheme('dark');

type QueryableInstance = Omit<ReactTestInstance, 'props' | 'children' | 'findAll'> & {
  type: unknown;
  props: Record<string, unknown>;
  children: Array<QueryableInstance | string>;
  findAll(predicate: (node: QueryableInstance) => boolean): QueryableInstance[];
};

function wrap(node: React.ReactNode) {
  return <AppThemeProvider theme={theme}>{node}</AppThemeProvider>;
}

function render(node: React.ReactNode): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(wrap(node));
  });
  if (!tree) throw new Error('Component did not render');
  return tree;
}

function queryRoot(tree: ReactTestRenderer): QueryableInstance {
  return tree.root as QueryableInstance;
}

function findByAccessibilityLabel(root: QueryableInstance, label: string): QueryableInstance {
  const match = root.findAll((node) => node.props.accessibilityLabel === label)[0];
  if (!match) throw new Error(`Missing element with accessibilityLabel: ${label}`);
  return match;
}

const entries: TimelineEntry[] = [
  {
    title: 'Investigate flaky test',
    details: ['Status: running', 'Latest: Reading test output'],
  },
];

describe('SubAgentCard', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does not recompute the StyleSheet when re-rendered with an unchanged theme', () => {
    const createStylesSpy = jest.spyOn(chatMessageStyles, 'createStyles');

    const tree = render(
      <SubAgentCard
        idPrefix="sub-1"
        entries={entries}
        agentStatus="running"
        running
        threadId="thread-1"
      />,
    );

    const callsAfterMount = createStylesSpy.mock.calls.length;
    expect(callsAfterMount).toBeGreaterThan(0);

    // Re-render with new (but theme-equivalent) props; SubAgentCard's own styles should not be
    // recomputed since the theme object reference is unchanged. This is the regression the
    // memoization fix protects against — SubAgentCard re-renders frequently while a sub-agent
    // streams tool output.
    act(() => {
      tree.update(
        wrap(
          <SubAgentCard
            idPrefix="sub-1"
            entries={[
              { title: 'Investigate flaky test', details: ['Status: running', 'Latest: New line'] },
            ]}
            agentStatus="running"
            running
            threadId="thread-1"
          />,
        ),
      );
    });

    expect(createStylesSpy.mock.calls.length).toBe(callsAfterMount);
  });

  it('gives the open-agent-chat affordance an effective touch target without inflating its visible chrome', () => {
    const tree = render(
      <SubAgentCard
        idPrefix="sub-1"
        entries={entries}
        agentStatus="running"
        running={false}
        threadId="thread-1"
        onOpen={jest.fn()}
      />,
    );

    const openButton = findByAccessibilityLabel(queryRoot(tree), 'Open agent chat');
    const hitSlop = openButton.props.hitSlop as {
      top: number;
      bottom: number;
      left: number;
      right: number;
    };
    // The row is a fixed 18px tall footer; hitSlop should pad it up toward the 44pt minimum.
    expect(hitSlop.top).toBeGreaterThanOrEqual(13);
    expect(hitSlop.bottom).toBeGreaterThanOrEqual(13);
  });

  it('disables the open affordance and omits onPress when there is no thread to open', () => {
    const tree = render(
      <SubAgentCard
        idPrefix="sub-1"
        entries={entries}
        agentStatus="running"
        running={false}
        threadId=""
      />,
    );

    const openButton = findByAccessibilityLabel(queryRoot(tree), 'Open agent chat');
    expect(openButton.props.disabled).toBe(true);
    expect(openButton.props.onPress).toBeUndefined();
  });
});
