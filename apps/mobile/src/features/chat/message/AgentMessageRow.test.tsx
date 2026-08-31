import { ScrollView } from 'react-native';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { AgentMessageRow } from './AgentMessageRow';

jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));
jest.mock('@expo/vector-icons', () => ({ Ionicons: ({ name }: { name: string }) => name }));

const theme = createAppTheme('dark');

type Queryable = ReactTestInstance & {
  props: Record<string, unknown>;
  children: Array<Queryable | string>;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
  findAllByType(type: unknown): Queryable[];
  findByProps(props: Record<string, unknown>): Queryable;
};

function renderRow(
  direction: 'sent' | 'received' = 'sent',
  disposition: 'sent' | 'steering' | 'queued' | 'cancelled' = 'queued',
) {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <AppThemeProvider theme={theme}>
        <AgentMessageRow
          messageId="message-1"
          meta={{
            messageId: 'message-1',
            direction,
            relatedThreadId: direction === 'sent' ? 'child-1' : 'parent-1',
            relatedTitle: direction === 'sent' ? 'Review agent' : 'Lead agent',
            relation: direction === 'sent' ? 'sub_agent' : 'parent',
            disposition,
            body: 'Inspect the queue lifecycle and report any race.',
          }}
        />
      </AppThemeProvider>,
    );
  });
  if (!tree) {
    throw new Error('Expected agent-message row to render');
  }
  return tree;
}

function renderedContent(tree: ReactTestRenderer): string {
  return JSON.stringify((tree as unknown as { toJSON: () => unknown }).toJSON());
}

describe('AgentMessageRow', () => {
  it('renders a collapsed sender row and reveals the complete body in a bounded panel', () => {
    const tree = renderRow();
    const root = tree.root as Queryable;
    const accessibleRow = root.findAll(
      (node) => node.props['accessibilityLabel'] === 'Sent to sub-agent: Review agent',
    )[0];
    if (!accessibleRow) {
      throw new Error('Expected accessible sender row');
    }

    expect(accessibleRow.props['accessibilityState']).toMatchObject({ expanded: false });
    expect(renderedContent(tree)).toContain('Sent to sub-agent');
    expect(renderedContent(tree)).toContain('Review agent');
    expect(renderedContent(tree)).toContain('queued');
    expect(renderedContent(tree)).not.toContain('Inspect the queue lifecycle');

    act(() => {
      const onPress = accessibleRow.props['onPress'];
      if (typeof onPress === 'function') {
        onPress();
      }
    });

    expect(accessibleRow.props['accessibilityState']).toMatchObject({ expanded: true });
    expect(renderedContent(tree)).toContain('Inspect the queue lifecycle and report any race.');
    expect(root.findAllByType(ScrollView)[0]?.props['style']).toMatchObject({ maxHeight: 300 });
  });

  it('uses the recipient label and omits sender disposition from accessibility value', () => {
    const tree = renderRow('received');
    const accessibleRow = (tree.root as Queryable).findAll(
      (node) => node.props['accessibilityLabel'] === 'Received from parent: Lead agent',
    )[0];
    if (!accessibleRow) {
      throw new Error('Expected accessible recipient row');
    }

    expect(accessibleRow.props['accessibilityValue']).toEqual({ text: 'Lead agent' });
    expect(renderedContent(tree)).toContain('Received from parent');
  });

  it('renders a cancelled sender activity as a terminal status', () => {
    const tree = renderRow('sent', 'cancelled');
    const accessibleRow = (tree.root as Queryable).findAll(
      (node) => node.props['accessibilityLabel'] === 'Sent to sub-agent: Review agent',
    )[0];

    expect(accessibleRow?.props['accessibilityValue']).toEqual({
      text: 'Review agent, cancelled',
    });
    expect(renderedContent(tree)).toContain('cancelled');
  });
});
