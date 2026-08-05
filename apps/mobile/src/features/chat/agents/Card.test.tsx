import React from 'react';
import { StyleSheet } from 'react-native';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { render as renderWithTestingLibrary, userEvent } from '@testing-library/react-native';

import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { SubAgentCard } from './Card';
import * as chatMessageStyles from '../message/styles';
import type { TimelineEntry } from '../message/types';

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

  it('opens the agent chat when the user presses the full card target', async () => {
    const onOpen = jest.fn();
    const user = userEvent.setup();
    const { getByRole, getByText } = renderWithTestingLibrary(
      wrap(
        <SubAgentCard
          idPrefix="sub-1"
          entries={entries}
          agentStatus="running"
          running={false}
          threadId="thread-1"
          onOpen={onOpen}
        />,
      ),
    );

    const openButton = getByRole('button', { name: 'Open agent chat' });
    // The card repaints while its sub-agent works, so a footer-sized target is easy to miss. The
    // press area has to wrap the card body — title, summary and the open hint alike — rather than
    // padding a dense 18pt row with hitSlop.
    expect(openButton.props['testID']).toBe('sub-1-subagent-open-0');
    expect(openButton.props['hitSlop']).toBeUndefined();
    const style = StyleSheet.flatten(openButton.props['style'] as never) as { flex?: number };
    expect(style.flex).toBe(1);

    expect(getByText('Investigate flaky test')).toBeTruthy();
    expect(getByText('Open agent chat', { includeHiddenElements: true })).toBeTruthy();

    await user.press(openButton);
    expect(onOpen).toHaveBeenCalledWith('thread-1');
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
