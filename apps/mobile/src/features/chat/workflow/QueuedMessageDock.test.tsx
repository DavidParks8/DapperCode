import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { QueuedMessageDock } from './QueuedMessageDock';

jest.mock('@expo/vector-icons', () => ({ Ionicons: ({ name }: { name: string }) => name }));

const theme = createAppTheme('dark');

type Queryable = ReactTestInstance & {
  props: Record<string, unknown>;
  children: Array<Queryable | string>;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
  findAllByType(type: unknown): Queryable[];
};

describe('QueuedMessageDock', () => {
  it('renders agent messages as received, read-only, and cancel-only', () => {
    const onEdit = jest.fn();
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <AppThemeProvider theme={theme}>
          <QueuedMessageDock
            queuedMessage={{
              id: 'queued-agent-message',
              createdAt: '2026-04-17T00:00:00.000Z',
              content: 'Please inspect the queue lifecycle.',
              agentMessage: {
                messageId: 'agent-message-1',
                direction: 'received',
                relatedThreadId: 'parent-1',
                relatedTitle: 'Lead agent',
                relation: 'parent',
                disposition: 'queued',
                body: 'Please inspect the queue lifecycle.',
              },
            }}
            remainingQueuedMessagesCount={0}
            pendingSubmission={false}
            steerEnabled
            cancelEnabled
            editEnabled
            steeringActive={false}
            steerPending={false}
            editing
            waitingForToolCalls={false}
            steeringInFlight={false}
            steerDisabledReason={null}
            onCancelQueuedMessage={jest.fn()}
            onCancelEdit={jest.fn()}
            onEditQueuedMessage={onEdit}
            onSteerQueuedMessage={jest.fn()}
          />
        </AppThemeProvider>,
      );
    });
    if (!tree) {
      throw new Error('Expected queued message dock to render');
    }

    const root = tree.root as Queryable;
    const text = JSON.stringify((tree as unknown as { toJSON: () => unknown }).toJSON());
    expect(text).toContain('Received from parent · Lead agent');
    expect(text).toContain('Please inspect the queue lifecycle.');
    expect(text).toContain('Cancel');
    expect(text).not.toContain('Steer');
    expect(text).not.toContain('Discard');

    const body = root.findAll(
      (node) =>
        node.props['accessibilityLabel'] === 'Queued message received from parent Lead agent',
    )[0];
    if (!body) {
      throw new Error('Expected read-only agent queue body');
    }
    expect(body.props['disabled']).toBe(true);
    expect(body.props['accessibilityState']).toMatchObject({ disabled: true });
    expect(onEdit).not.toHaveBeenCalled();
  });
});
