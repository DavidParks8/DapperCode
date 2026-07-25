import { TestableThreadState } from './TestableThreadState';
import { getSubAgentMeta } from '../api/messages';

interface MatcherResult {
  pass: boolean;
  message: () => string;
}

interface SubAgentExpectation {
  status?: string;
  preview?: string | RegExp;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    interface Matchers<R> {
      /** Assert the projected transcript for a thread has exactly N messages. */
      toHaveMessageCount(threadId: string, expected: number): R;
      /** Assert the message at an index matches the given id/role/content. */
      toHaveMessageAt(
        threadId: string,
        index: number,
        expected: { id?: string; role?: string; content?: string | RegExp },
      ): R;
      /** Assert no message id is rendered twice. */
      toHaveNoDuplicateIds(threadId: string): R;
      /** Assert no message body is rendered twice. */
      toHaveNoDuplicateContent(threadId: string): R;
      /** Assert message ids appear in the given relative order. */
      toHaveMessagesInOrder(threadId: string, ...ids: string[]): R;
      /** Assert a sub-agent card exists for a child thread, optionally matching status/preview. */
      toHaveSubAgentCard(
        threadId: string,
        childThreadId: string,
        expected?: SubAgentExpectation,
      ): R;
      /** Assert some sub-agent card's text matches the given preview. */
      toHaveSubAgentPreview(threadId: string, preview: string | RegExp): R;
      /** Assert how many sub-agent cards a thread renders. */
      toHaveSubAgentCount(threadId: string, expected: number): R;
      /** Assert how many sub-agents are reported as running. */
      toHaveRunningSubAgents(threadId: string, expected: number): R;
    }
  }
}

function requireState(received: unknown): TestableThreadState {
  if (!(received instanceof TestableThreadState)) {
    throw new TypeError(
      'test harness matchers expect a TestableThreadState, e.g. expect(state).toHaveMessageCount(threadId, 2)',
    );
  }
  return received;
}

function cardText(message: { content?: unknown }): string {
  const content = message.content as { text?: unknown } | undefined;
  return typeof content?.text === 'string' ? content.text : '';
}

function matchesText(actual: string, expected: string | RegExp): boolean {
  return expected instanceof RegExp ? expected.test(actual) : actual.includes(expected);
}

export const testHarnessMatchers = {
  toHaveMessageCount(received: unknown, threadId: string, expected: number): MatcherResult {
    const { messages } = requireState(received).projectTranscript(threadId);
    const pass = messages.length === expected;
    return {
      pass,
      message: () =>
        pass
          ? `expected "${threadId}" not to render ${String(expected)} messages`
          : `expected "${threadId}" to render ${String(expected)} messages but got ${String(messages.length)}:\n${messages
              .map((message) => `  - ${message.id} (${message.role})`)
              .join('\n')}`,
    };
  },

  toHaveMessageAt(
    received: unknown,
    threadId: string,
    index: number,
    expected: { id?: string; role?: string; content?: string | RegExp },
  ): MatcherResult {
    const state = requireState(received);
    const { messages } = state.projectTranscript(threadId);
    if (index >= messages.length) {
      return {
        pass: false,
        message: () =>
          `expected a message at index ${String(index)} but "${threadId}" renders ${String(messages.length)}`,
      };
    }
    const message = messages[index];
    const failures: string[] = [];
    if (expected.id !== undefined && message.id !== expected.id) {
      failures.push(`id: expected "${expected.id}" but got "${message.id}"`);
    }
    if (expected.role !== undefined && message.role !== expected.role) {
      failures.push(`role: expected "${expected.role}" but got "${message.role}"`);
    }
    if (expected.content !== undefined) {
      const text = state.getMessageContents(threadId)[index]?.content ?? '';
      if (!matchesText(text, expected.content)) {
        failures.push(`content: expected ${String(expected.content)} but got "${text}"`);
      }
    }
    return {
      pass: failures.length === 0,
      message: () =>
        failures.length === 0
          ? `expected message at index ${String(index)} not to match`
          : `message at index ${String(index)}: ${failures.join('; ')}`,
    };
  },

  toHaveNoDuplicateIds(received: unknown, threadId: string): MatcherResult {
    const duplicates = requireState(received).findDuplicateIds(threadId);
    return {
      pass: duplicates.length === 0,
      message: () =>
        duplicates.length === 0
          ? `expected "${threadId}" to render duplicate ids`
          : `"${threadId}" rendered duplicate message ids: ${duplicates.join(', ')}`,
    };
  },

  toHaveNoDuplicateContent(received: unknown, threadId: string): MatcherResult {
    const duplicates = requireState(received).findDuplicateContent(threadId);
    return {
      pass: duplicates.length === 0,
      message: () =>
        duplicates.length === 0
          ? `expected "${threadId}" to render duplicate content`
          : `"${threadId}" rendered duplicate content: ${duplicates
              .map((entry) => `"${entry.content}" (x${String(entry.count)})`)
              .join(', ')}`,
    };
  },

  toHaveMessagesInOrder(received: unknown, threadId: string, ...ids: string[]): MatcherResult {
    const actualIds = requireState(received).getMessageIds(threadId);
    const positionById = new Map(actualIds.map((id, index) => [id, index] as const));
    const failures: string[] = [];
    for (let index = 1; index < ids.length; index += 1) {
      const previous = positionById.get(ids[index - 1]);
      const current = positionById.get(ids[index]);
      if (previous === undefined) {
        failures.push(`"${ids[index - 1]}" is not rendered`);
      } else if (current === undefined) {
        failures.push(`"${ids[index]}" is not rendered`);
      } else if (current <= previous) {
        failures.push(`"${ids[index]}" should come after "${ids[index - 1]}"`);
      }
    }
    return {
      pass: failures.length === 0,
      message: () =>
        failures.length === 0
          ? `expected "${threadId}" not to render those ids in order`
          : `"${threadId}" message order: ${failures.join('; ')}`,
    };
  },

  toHaveSubAgentCard(
    received: unknown,
    threadId: string,
    childThreadId: string,
    expected?: SubAgentExpectation,
  ): MatcherResult {
    const activities = requireState(received).getSubAgentActivities(threadId);
    const card = activities.find((message) =>
      getSubAgentMeta(message)?.receiverThreadIds?.includes(childThreadId),
    );
    if (!card) {
      return {
        pass: false,
        message: () =>
          `no sub-agent card links "${childThreadId}"; "${threadId}" renders ${String(activities.length)} card(s)`,
      };
    }
    const failures: string[] = [];
    if (expected?.status !== undefined) {
      const status = getSubAgentMeta(card)?.agentStatus;
      if (status !== expected.status) {
        failures.push(`status: expected "${expected.status}" but got "${String(status)}"`);
      }
    }
    if (expected?.preview !== undefined) {
      const text = cardText(card);
      if (!matchesText(text, expected.preview)) {
        failures.push(`preview: expected ${String(expected.preview)} but got "${text}"`);
      }
    }
    return {
      pass: failures.length === 0,
      message: () =>
        failures.length === 0
          ? `expected no sub-agent card for "${childThreadId}"`
          : `sub-agent card for "${childThreadId}": ${failures.join('; ')}`,
    };
  },

  toHaveSubAgentPreview(
    received: unknown,
    threadId: string,
    preview: string | RegExp,
  ): MatcherResult {
    const activities = requireState(received).getSubAgentActivities(threadId);
    const texts = activities.map(cardText);
    const pass = texts.some((text) => matchesText(text, preview));
    return {
      pass,
      message: () =>
        pass
          ? `expected no sub-agent card matching ${String(preview)}`
          : `no sub-agent card matched ${String(preview)}; rendered:\n${texts
              .map((text) => `  - ${text.replace(/\n/g, ' / ')}`)
              .join('\n')}`,
    };
  },

  toHaveSubAgentCount(received: unknown, threadId: string, expected: number): MatcherResult {
    const activities = requireState(received).getSubAgentActivities(threadId);
    const pass = activities.length === expected;
    return {
      pass,
      message: () =>
        pass
          ? `expected "${threadId}" not to render ${String(expected)} sub-agent card(s)`
          : `expected ${String(expected)} sub-agent card(s) but got ${String(activities.length)}`,
    };
  },

  toHaveRunningSubAgents(received: unknown, threadId: string, expected: number): MatcherResult {
    const count = requireState(received).getRunningSubAgentCount(threadId);
    const pass = count === expected;
    return {
      pass,
      message: () =>
        pass
          ? `expected "${threadId}" not to report ${String(expected)} running sub-agent(s)`
          : `expected ${String(expected)} running sub-agent(s) but got ${String(count)}`,
    };
  },
};

/** Registers the harness matchers with Jest. Imported by harness scenario tests. */
export function registerTestHarnessMatchers(): void {
  expect.extend(testHarnessMatchers);
}
