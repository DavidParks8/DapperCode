import type { TestableThreadState } from './TestableThreadState';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    interface Matchers<R> {
      /** Assert the projected transcript has exactly N messages. */
      toHaveMessageCount(expected: number): R;
      /** Assert a message at the given index has matching id/role/content. */
      toHaveMessageAt(
        index: number,
        expected: { id?: string; role?: string; content?: string | RegExp },
      ): R;
      /** Assert no duplicate message IDs exist in the transcript. */
      toHaveNoDuplicateIds(): R;
      /** Assert no duplicate message content exists in the transcript. */
      toHaveNoDuplicateContent(): R;
      /** Assert message IDs appear in the given order. */
      toHaveMessagesInOrder(...ids: string[]): R;
      /** Assert a sub-agent activity card exists for the given child thread. */
      toHaveSubAgentCard(
        childThreadId: string,
        expected?: { status?: string; preview?: string | RegExp },
      ): R;
      /** Assert the number of sub-agent activities. */
      toHaveSubAgentCount(expected: number): R;
      /** Assert the number of running sub-agents. */
      toHaveRunningSubAgents(expected: number): R;
    }
  }
}

function getMessages(state: TestableThreadState, threadId: string) {
  return state.projectTranscript(threadId);
}

export function createMatchers(state: TestableThreadState) {
  return {
    toHaveMessageCount(threadId: string, expected: number) {
      const { messages } = getMessages(state, threadId);
      const pass = messages.length === expected;
      return {
        pass,
        message: () =>
          pass
            ? `expected transcript NOT to have ${expected} messages`
            : `expected ${expected} messages but got ${messages.length}`,
      };
    },

    toHaveMessageAt(
      threadId: string,
      index: number,
      expected: { id?: string; role?: string; content?: string | RegExp },
    ) {
      const { messages } = getMessages(state, threadId);
      if (index >= messages.length) {
        return {
          pass: false,
          message: () => `index ${index} is out of range (have ${messages.length} messages)`,
        };
      }
      const msg = messages[index];
      const failures: string[] = [];
      if (expected.id !== undefined && msg.id !== expected.id) {
        failures.push(`id: expected "${expected.id}" but got "${msg.id}"`);
      }
      if (expected.role !== undefined && msg.role !== expected.role) {
        failures.push(`role: expected "${expected.role}" but got "${msg.role}"`);
      }
      if (expected.content !== undefined) {
        const text = msg.role === 'activity'
          ? (msg.content as { text?: string })?.text ?? ''
          : (typeof msg.content === 'string' ? msg.content : '');
        if (expected.content instanceof RegExp) {
          if (!expected.content.test(text)) {
            failures.push(`content: expected to match ${expected.content} but got "${text}"`);
          }
        } else if (text !== expected.content) {
          failures.push(`content: expected "${expected.content}" but got "${text}"`);
        }
      }
      return {
        pass: failures.length === 0,
        message: () =>
          `message at index ${index}: ${failures.join('; ')}`,
      };
    },

    toHaveNoDuplicateIds(threadId: string) {
      const dupes = state.findDuplicateIds(threadId);
      return {
        pass: dupes.length === 0,
        message: () =>
          `found duplicate message IDs: ${dupes.join(', ')}`,
      };
    },

    toHaveNoDuplicateContent(threadId: string) {
      const dupes = state.findDuplicateContent(threadId);
      return {
        pass: dupes.length === 0,
        message: () =>
          `found duplicate content: ${dupes.map((d) => `"${d.content}" (x${d.count})`).join(', ')}`,
      };
    },

    toHaveMessagesInOrder(threadId: string, ...ids: string[]) {
      const actualIds = state.getMessageIds(threadId);
      const actualIndex = new Map(actualIds.map((id, i) => [id, i]));
      const failures: string[] = [];
      for (let i = 1; i < ids.length; i++) {
        const prev = actualIndex.get(ids[i - 1]);
        const curr = actualIndex.get(ids[i]);
        if (prev === undefined) {
          failures.push(`"${ids[i - 1]}" not found in transcript`);
        } else if (curr === undefined) {
          failures.push(`"${ids[i]}" not found in transcript`);
        } else if (curr <= prev) {
          failures.push(`"${ids[i]}" (index ${curr}) should come after "${ids[i - 1]}" (index ${prev})`);
        }
      }
      return {
        pass: failures.length === 0,
        message: () => `message order: ${failures.join('; ')}`,
      };
    },

    toHaveSubAgentCard(
      threadId: string,
      childThreadId: string,
      expected?: { status?: string; preview?: string | RegExp },
    ) {
      const activities = state.getSubAgentActivities(threadId);
      const card = activities.find((m) => {
        const meta = (m.content as { subAgent?: { receiverThreadIds?: string[] } })?.subAgent;
        return meta?.receiverThreadIds?.includes(childThreadId);
      });
      if (!card) {
        return {
          pass: false,
          message: () => `no sub-agent card found for child "${childThreadId}"`,
        };
      }
      const failures: string[] = [];
      if (expected?.status !== undefined) {
        const meta = (card.content as { subAgent?: { agentStatus?: string } })?.subAgent;
        if (meta?.agentStatus !== expected.status) {
          failures.push(`status: expected "${expected.status}" but got "${meta?.agentStatus}"`);
        }
      }
      if (expected?.preview !== undefined) {
        const text = (card.content as { text?: string })?.text ?? '';
        if (expected.preview instanceof RegExp) {
          if (!expected.preview.test(text)) {
            failures.push(`preview: expected to match ${expected.preview} but got "${text}"`);
          }
        } else if (!text.includes(expected.preview)) {
          failures.push(`preview: expected to contain "${expected.preview}" but got "${text}"`);
        }
      }
      return {
        pass: failures.length === 0,
        message: () => `sub-agent card for "${childThreadId}": ${failures.join('; ')}`,
      };
    },

    toHaveSubAgentCount(threadId: string, expected: number) {
      const activities = state.getSubAgentActivities(threadId);
      const pass = activities.length === expected;
      return {
        pass,
        message: () =>
          pass
            ? `expected NOT ${expected} sub-agents`
            : `expected ${expected} sub-agents but got ${activities.length}`,
      };
    },

    toHaveRunningSubAgents(threadId: string, expected: number) {
      const count = state.getRunningSubAgentCount(threadId);
      const pass = count === expected;
      return {
        pass,
        message: () =>
          pass
            ? `expected NOT ${expected} running sub-agents`
            : `expected ${expected} running sub-agents but got ${count}`,
      };
    },
  };
}
