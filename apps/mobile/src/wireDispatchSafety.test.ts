import { toToolLikeMessage } from './api/chatMappingToolMessageProjection';
import { buildToolInvocations } from './components/toolInvocationModel';
import { lookupDispatchEntry } from './runtimeValidation';
import { processThreadStateEvents } from './screens/main/mainScreenThreadStateEvents';
import { processTurnLifecycleEvents } from './screens/main/mainScreenTurnLifecycleEvents';
import { toBridgeUiSurface } from './screens/main/mainScreenHelperBridgeUi';
import type { ChatMessage, ChatToolMeta } from './api/types';
import type { RpcNotification } from './api/typesBridge';

/**
 * Reproduces wire data reaching `Object.prototype` through a dispatch table.
 *
 * Every one of these tables is keyed by a string the bridge sent us. A plain object literal
 * inherits `constructor`, `toString`, and friends, so a payload naming one of them resolves to an
 * inherited function and the table invokes it — running arbitrary built-ins with our arguments and
 * short-circuiting the fallback the payload should have taken.
 */
describe('Wire-keyed dispatch tables never reach Object.prototype', () => {
  it('only reads own properties', () => {
    const table = { known: 'value' };
    expect(lookupDispatchEntry(table, 'known')).toBe('value');
    expect(lookupDispatchEntry(table, 'constructor')).toBeUndefined();
    expect(lookupDispatchEntry(table, 'toString')).toBeUndefined();
    expect(lookupDispatchEntry(table, 'hasOwnProperty')).toBeUndefined();
  });

  it('reports no tool-like message for an inherited item type', () => {
    expect(toToolLikeMessage({ type: 'constructor' })).toBeNull();
    expect(toToolLikeMessage({ type: 'plan', plan: [] })).not.toBeUndefined();
  });

  it('drops a bridge UI block whose type names an inherited member', () => {
    const surface = toBridgeUiSurface({
      id: 'surface-1',
      threadId: 'thread-1',
      presentation: 'workflowCard',
      title: 'Surface',
      blocks: [{ type: 'toString' }, { type: 'constructor' }, { type: 'text', text: 'kept' }],
    });

    expect(surface?.blocks).toEqual([{ type: 'text', text: 'kept' }]);
  });

  it('still walks nested content under an inherited structured-content type', () => {
    const toolMeta: ChatToolMeta = {
      toolCallId: 'call-1',
      kind: 'edit',
      status: 'completed',
      title: 'Edit app.ts',
      content: [
        {
          type: 'constructor',
          content: [{ type: 'diff', path: 'app.ts', newText: 'next', oldText: 'prev' }],
        },
      ],
    } as unknown as ChatToolMeta;
    const messages: ChatMessage[] = [
      {
        id: 'tool-result:call-1',
        role: 'tool',
        toolCallId: 'call-1',
        content: 'done',
        createdAt: '2026-05-01T00:00:00.000Z',
        toolMeta,
      },
    ];

    expect(buildToolInvocations(messages)[0]?.diffs).toEqual([
      { path: 'app.ts', oldText: 'prev', newText: 'next' },
    ]);
  });

  it.each(['constructor', 'toString', 'hasOwnProperty'])(
    'ignores the "%s" notification method without touching the router context',
    (method) => {
      const event = { method, params: {} } as RpcNotification;
      // A missing handler must return before the context is ever built, so a context that cannot
      // be destructured proves nothing was dispatched.
      const context = null as unknown as Parameters<typeof processTurnLifecycleEvents>[0];

      expect(() =>
        processTurnLifecycleEvents(context, event, null, undefined, undefined),
      ).not.toThrow();
      expect(() => processThreadStateEvents(context, event, null)).not.toThrow();
    },
  );
});
