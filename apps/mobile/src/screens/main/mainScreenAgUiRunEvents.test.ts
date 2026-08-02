import type { AgUiEventEnvelope } from '../../api/agUi';
import { EventType } from '@ag-ui/core';
import { coalesceAgUiTextContentEvents } from './mainScreenAgUiRunEvents';

function textEvent(
  delta: string,
  options: Partial<Pick<AgUiEventEnvelope, 'threadId' | 'runId'>> & {
    messageId?: string;
  } = {},
): AgUiEventEnvelope {
  return {
    threadId: options.threadId ?? 'thread',
    runId: options.runId ?? 'run',
    event: {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: options.messageId ?? 'message',
      delta,
    },
  };
}

describe('coalesceAgUiTextContentEvents', () => {
  it('materializes consecutive deltas for one message once per render frame', () => {
    const coalesced = coalesceAgUiTextContentEvents([
      textEvent('One'),
      textEvent(' two'),
      textEvent(' three'),
      textEvent('Other', { messageId: 'other' }),
      textEvent(' thread', { threadId: 'child', messageId: 'other' }),
    ]);

    expect(coalesced).toHaveLength(3);
    expect(coalesced[0]?.event).toMatchObject({
      messageId: 'message',
      delta: 'One two three',
    });
    expect(coalesced[1]?.event).toMatchObject({ messageId: 'other', delta: 'Other' });
    expect(coalesced[2]).toMatchObject({ threadId: 'child' });
  });
});
