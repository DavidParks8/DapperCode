import { appendText, appendToolResult, textMessage } from '@bridge/agui/agUiMessageMutations';
import { createAgUiThreadMessageState } from '@bridge/agui/agUiMessagesState';

describe('agUiMessageMutations', () => {
  it('defaults unknown runtime roles from bridge events to assistant messages', () => {
    const runtimeRole = 'future-bridge-role' as Parameters<typeof textMessage>[1];

    expect(textMessage('message', runtimeRole, 'Hello')).toMatchObject({
      id: 'message',
      role: 'assistant',
      content: 'Hello',
    });
  });

  it('updates an indexed streaming message without scanning or mapping the message array', () => {
    let state = appendText(
      createAgUiThreadMessageState(),
      'message',
      'Hello',
      'run',
      1,
      'assistant',
    );
    const messages = new Proxy(state.messages, {
      get(target, property, receiver) {
        if (property === 'find' || property === 'findIndex' || property === 'map') {
          throw new Error(`unexpected ${String(property)} scan`);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    state = appendText({ ...state, messages }, 'message', ' world', 'run', 2, 'assistant');

    expect(state.messages[0]).toMatchObject({
      id: 'message',
      content: 'Hello world',
      parts: [{ type: 'text', text: 'Hello world' }],
    });
    expect(state.messageIndexById).toEqual({ message: 0 });
  });

  it('reindexes retained messages after replacing a tool result', () => {
    let state = createAgUiThreadMessageState();
    state = appendText(state, 'before', 'A', 'run', 1, 'assistant');
    state = appendText(state, 'old-tool', 'old', 'run', 2, 'assistant');
    state = appendText(state, 'after', 'B', 'run', 3, 'assistant');
    state = {
      ...state,
      toolResultMessageIdByCallId: { call: 'old-tool' },
    };

    state = appendToolResult(state, 'run', 'new-tool', 'call', 'new', 4);

    expect(state.messages.map((message) => message.id)).toEqual(['before', 'after', 'new-tool']);
    expect(state.messageIndexById).toEqual({ before: 0, after: 1, 'new-tool': 2 });
  });

  it('keeps mixed ordered parts and flattened content equivalent while streaming', () => {
    let state = appendText(
      createAgUiThreadMessageState(),
      'message',
      'Hello',
      'run',
      1,
      'assistant',
    );
    const message = state.messages[0];
    if (!message || message.role !== 'assistant') {
      throw new Error('expected assistant message');
    }
    state = {
      ...state,
      messages: [
        {
          ...message,
          content: 'Hello\n[file: file:///tmp/a.txt] a.txt',
          parts: [
            { type: 'text', text: 'Hello' },
            { type: 'resourceLink', uri: 'file:///tmp/a.txt', name: 'a.txt' },
          ],
        },
      ],
    };

    state = appendText(state, 'message', ' tail', 'run', 2, 'assistant');

    expect(state.messages[0]).toMatchObject({
      content: 'Hello\n[file: file:///tmp/a.txt] a.txt\n tail',
      parts: [
        { type: 'text', text: 'Hello' },
        { type: 'resourceLink', uri: 'file:///tmp/a.txt', name: 'a.txt' },
        { type: 'text', text: ' tail' },
      ],
    });
  });
});
