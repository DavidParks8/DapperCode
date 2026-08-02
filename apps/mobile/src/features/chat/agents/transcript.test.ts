import type { ChatMessage } from '@bridge/types/types';
import { createActivityMessage, SUBAGENT_ACTIVITY_TYPE } from '@bridge/messages';
import { trimInheritedParentMessages } from './transcript';

function message(
  id: string,
  role: ChatMessage['role'],
  content: string,
  options?: {
    systemKind?: 'subAgent';
    subAgentMeta?: Parameters<typeof createActivityMessage>[2]['subAgent'];
  },
): ChatMessage {
  if (options?.systemKind === 'subAgent') {
    return createActivityMessage(
      id,
      SUBAGENT_ACTIVITY_TYPE,
      {
        text: content,
        ...(options.subAgentMeta ? { subAgent: options.subAgentMeta } : {}),
      },
      '2026-03-20T00:00:00.000Z',
    );
  }
  return {
    id,
    role: role === 'activity' || role === 'reasoning' || role === 'tool' ? 'system' : role,
    content,
    createdAt: '2026-03-20T00:00:00.000Z',
  };
}

describe('trimInheritedParentMessages', () => {
  it('anchors a spawned sub-agent transcript at the child prompt', () => {
    const parentMessages = [
      message('m1', 'user', 'Parent question'),
      message('m2', 'assistant', 'Parent answer'),
      message('m3', 'system', '• Spawned sub-agent', {
        systemKind: 'subAgent',
        subAgentMeta: {
          tool: 'spawn_agent',
          prompt: 'Inspect the settings architecture',
          receiverThreadIds: ['child-thread'],
        },
      }),
    ];
    const childMessages = [
      message('c1', 'user', 'Parent question'),
      message('c2', 'assistant', 'Parent answer'),
      message('c3', 'user', 'Inspect the settings architecture'),
      message('c4', 'assistant', 'The setting should live in App.tsx.'),
    ];

    expect(trimInheritedParentMessages(parentMessages, childMessages, 'child-thread')).toEqual({
      messages: childMessages.slice(2),
      hiddenInheritedMessageCount: 2,
    });
  });

  it('matches spawned prompts even when the child message includes attachment markers', () => {
    const parentMessages = [
      message('m1', 'system', '• Spawned sub-agent', {
        systemKind: 'subAgent',
        subAgentMeta: {
          tool: 'spawn_agent',
          prompt: 'Review the websocket implementation',
          receiverThreadIds: ['child-thread'],
        },
      }),
    ];
    const childMessages = [
      message('c1', 'assistant', 'Older inherited answer'),
      message(
        'c2',
        'user',
        'Review the websocket implementation\n[file: apps/mobile/src/api/ws.ts]',
      ),
      message('c3', 'assistant', 'Here is the websocket review.'),
    ];

    expect(trimInheritedParentMessages(parentMessages, childMessages, 'child-thread')).toEqual({
      messages: childMessages.slice(1),
      hiddenInheritedMessageCount: 1,
    });
  });

  it('falls back to shared-prefix trimming when no spawn prompt metadata is available', () => {
    const parentMessages = [message('m1', 'user', 'Parent question')];
    const childMessages = [
      message('m1-copy', 'user', 'Parent question'),
      message('m2', 'user', 'Child-only question'),
    ];

    expect(trimInheritedParentMessages(parentMessages, childMessages)).toEqual({
      messages: childMessages.slice(1),
      hiddenInheritedMessageCount: 1,
    });
  });

  it('does not hide the entire child transcript when every message matches', () => {
    const parentMessages = [
      message('m1', 'user', 'Shared prompt'),
      message('m2', 'assistant', 'Shared answer'),
    ];
    const childMessages = [...parentMessages];

    expect(trimInheritedParentMessages(parentMessages, childMessages)).toEqual({
      messages: childMessages,
      hiddenInheritedMessageCount: 0,
    });
  });

  it('keeps transcripts unchanged when no messages are shared', () => {
    const childMessages = [message('child', 'assistant', 'Child answer')];
    expect(
      trimInheritedParentMessages([message('parent', 'user', 'Parent')], childMessages, ' '),
    ).toEqual({
      messages: childMessages,
      hiddenInheritedMessageCount: 0,
    });
  });

  it('uses fallback spawn metadata and partial prompt matches', () => {
    const parentMessages = [
      message('skip-kind', 'system', 'skip'),
      message('skip-meta', 'system', 'skip', { systemKind: 'subAgent' }),
      message('skip-thread', 'system', 'skip', {
        systemKind: 'subAgent',
        subAgentMeta: { prompt: 'Wrong', receiverThreadIds: ['other'] },
      }),
      message('fallback', 'system', 'spawn', {
        systemKind: 'subAgent',
        subAgentMeta: {
          tool: 'other_tool',
          prompt: 'Inspect settings',
          receiverThreadIds: ['child'],
        },
      }),
    ];
    const childMessages = [
      message('inherited', 'assistant', 'Old'),
      message('not-user', 'assistant', 'Inspect settings'),
      message('empty-user', 'user', '[file: /tmp/a]'),
      message('prompt', 'user', 'Please Inspect settings carefully'),
      message('answer', 'assistant', 'Done'),
    ];
    expect(trimInheritedParentMessages(parentMessages, childMessages, 'child')).toEqual({
      messages: childMessages.slice(3),
      hiddenInheritedMessageCount: 3,
    });
  });

  it('falls back to shared-prefix trimming when spawn prompts are blank or absent from child', () => {
    const shared = message('shared', 'user', 'Shared');
    const parentMessages = [
      shared,
      message('blank', 'system', 'spawn', {
        systemKind: 'subAgent',
        subAgentMeta: { tool: 'spawnagent', prompt: ' ', receiverThreadIds: ['child'] },
      }),
      message('spawn', 'system', 'spawn', {
        systemKind: 'subAgent',
        subAgentMeta: {
          tool: 'spawnagent',
          prompt: 'Missing prompt',
          receiverThreadIds: ['child'],
        },
      }),
    ];
    const childMessages = [shared, message('child', 'user', 'Different prompt')];
    expect(trimInheritedParentMessages(parentMessages, childMessages, 'child')).toEqual({
      messages: childMessages.slice(1),
      hiddenInheritedMessageCount: 1,
    });
  });
});
