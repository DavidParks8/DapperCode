import React from 'react';
import { StyleSheet } from 'react-native';
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
  if (!tree) {
    throw new Error('Component did not render');
  }
  return tree;
}

function queryRoot(tree: ReactTestRenderer): QueryableInstance {
  return tree.root as QueryableInstance;
}

function findByAccessibilityLabel(root: QueryableInstance, label: string): QueryableInstance {
  const match = root.findAll((node) => node.props['accessibilityLabel'] === label)[0];
  if (!match) {
    throw new Error(`Missing element with accessibilityLabel: ${label}`);
  }
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

  it('uses the dedicated indigo sub-agent surface instead of warning colors', () => {
    const tree = render(
      <SubAgentCard
        idPrefix="sub-1"
        entries={entries}
        agentStatus="completed"
        running={false}
        threadId="thread-1"
        onOpen={jest.fn()}
      />,
    );
    const card = queryRoot(tree).findAll(
      (node) => node.props['testID'] === 'sub-1-subagent-card-0',
    )[0];
    if (!card) {
      throw new Error('Expected sub-agent card');
    }
    const style = StyleSheet.flatten(card.props['style'] as never) as {
      backgroundColor?: string;
      borderColor?: string;
    };

    expect(style.backgroundColor).toBe(theme.colors.subAgentBg);
    expect(style.borderColor).toBe(theme.colors.subAgentBorder);
    expect(style.backgroundColor).not.toBe(theme.colors.warningBg);

    act(() => tree.unmount());
  });

  it('caps the open-agent-chat hitSlop so it cannot overlap the scrollable Latest row above it', () => {
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
    const hitSlop = openButton.props['hitSlop'] as {
      top: number;
      bottom: number;
      left: number;
      right: number;
    };
    // The footer row sits `marginTop: 4` below the "Latest" detail row (see subAgentOpenHint /
    // subAgentDetailRow in chatMessageStyles.ts). The row is only 18pt tall, so an uncapped
    // hitSlop would pad ~13-15pt toward the 44pt/48dp minimum and eat well into (56-69% of) that
    // scrollable row's own touch/scroll area. Capping at 4 keeps the expanded hit area's top edge
    // flush with — never past — the boundary between the two rows.
    expect(hitSlop.top).toBe(4);
    expect(hitSlop.bottom).toBe(4);
    expect(hitSlop.top).toBeLessThanOrEqual(4);
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
    expect(openButton.props['disabled']).toBe(true);
    expect(openButton.props['onPress']).toBeUndefined();
  });
});
