import type { ChatMessage, ChatToolMeta } from './types';
import {
  attachToolMeta,
  mergeToolMeta,
  messageReferencesToolCall,
  parseToolMeta,
  toToolKind,
  toToolStatus,
  withToolStructured,
} from './toolMeta';

const baseMeta: ChatToolMeta = {
  toolCallId: 'call-1',
  kind: 'read',
  status: 'completed',
  title: 'Read a.ts',
};

describe('tool metadata readers', () => {
  it('normalizes wire spellings and falls back for unknown values', () => {
    expect(toToolKind('switch-mode')).toBe('switch_mode');
    expect(toToolKind('EXECUTE')).toBe('execute');
    expect(toToolKind(42)).toBe('other');
    expect(toToolStatus('in-progress')).toBe('in_progress');
    expect(toToolStatus(null)).toBe('pending');
  });

  it('parses a payload and defaults the title to its kind', () => {
    expect(
      parseToolMeta({
        toolCallId: 'call-1',
        kind: 'edit',
        status: 'in_progress',
        content: [{ type: 'text', text: 'hi' }],
        locations: [{ path: 'a.ts' }],
        truncated: true,
      }),
    ).toEqual({
      toolCallId: 'call-1',
      kind: 'edit',
      status: 'in_progress',
      title: 'edit',
      content: [{ type: 'text', text: 'hi' }],
      locations: [{ path: 'a.ts' }],
      truncated: true,
    });
  });

  it('accepts a fallback tool call id and rejects unusable payloads', () => {
    expect(parseToolMeta({ kind: 'read' }, 'call-9')?.toolCallId).toBe('call-9');
    expect(parseToolMeta({ kind: 'read' })).toBeNull();
    expect(parseToolMeta('nope', 'call-9')).toBeNull();
  });

  it('keeps previous payloads when an update omits them', () => {
    const previous: ChatToolMeta = { ...baseMeta, content: [1], locations: [2], truncated: true };
    expect(mergeToolMeta(previous, { ...baseMeta, status: 'failed' })).toEqual({
      ...previous,
      status: 'failed',
    });
    expect(mergeToolMeta(undefined, baseMeta)).toBe(baseMeta);
  });

  it('updates structured payloads without disturbing the described facts', () => {
    expect(withToolStructured(baseMeta, 'call-1', [1], undefined)).toEqual({
      ...baseMeta,
      content: [1],
    });
    expect(withToolStructured(undefined, 'call-2', undefined, [{ path: 'a.ts' }])).toEqual({
      toolCallId: 'call-2',
      kind: 'other',
      status: 'pending',
      title: 'other',
      locations: [{ path: 'a.ts' }],
    });
  });
});

describe('attachToolMeta', () => {
  const toolResult: ChatMessage = {
    id: 'tool-result:call-1',
    role: 'tool',
    toolCallId: 'call-1',
    content: 'done',
    createdAt: '',
  };
  const toolCall: ChatMessage = {
    id: 'tool-call:call-1',
    role: 'assistant',
    content: '',
    createdAt: '',
    toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } }],
  };
  const unrelated: ChatMessage = { id: 'a1', role: 'assistant', content: 'hi', createdAt: '' };

  it('stamps every message that speaks for the same call', () => {
    const next = attachToolMeta([toolCall, toolResult, unrelated], baseMeta);
    expect(next[0].toolMeta).toEqual(baseMeta);
    expect(next[1].toolMeta).toEqual(baseMeta);
    expect(next[2].toolMeta).toBeUndefined();
  });

  it('returns the same list when nothing changed', () => {
    const stamped = attachToolMeta([toolResult], baseMeta);
    expect(attachToolMeta(stamped, baseMeta)).toBe(stamped);
    expect(attachToolMeta([unrelated], baseMeta)).toEqual([unrelated]);
  });

  it('matches only messages that reference the call', () => {
    expect(messageReferencesToolCall(toolResult, 'call-1')).toBe(true);
    expect(messageReferencesToolCall(toolResult, 'call-2')).toBe(false);
    expect(messageReferencesToolCall(toolCall, 'call-1')).toBe(true);
    expect(messageReferencesToolCall(unrelated, 'call-1')).toBe(false);
    expect(
      messageReferencesToolCall(
        { id: 'u1', role: 'user', content: 'hi', createdAt: '' },
        'call-1',
      ),
    ).toBe(false);
  });
});
