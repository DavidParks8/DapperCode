import type { LocalModelReply } from '../models/engine';
import { randomUUID } from 'expo-crypto';
import type { LocalAgentRun, LocalToolCall } from './types';
import type { LocalMessage, LocalToolApprovalPolicy } from './types';
import { emptyLocalAnswer } from './modelHistory';
import { parallelLocalReads, LOCAL_FANOUT, type LocalThreadPort } from './delegation';

export async function runLocalRounds(
  threads: LocalThreadPort,
  run: LocalAgentRun,
  limit: number,
  bindings: {
    check(): void;
    generate(assistantId: string): Promise<LocalModelReply>;
    tool(call: LocalToolCall, repeated: boolean): Promise<void>;
    approval: LocalToolApprovalPolicy;
  },
): Promise<void> {
  let steps = 0;
  let lastCall = '';
  let repeats = 0;
  for (let round = 0; round < limit; round += 1) {
    bindings.check();
    const assistant: LocalMessage = {
      id: randomUUID(),
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
    };
    threads.change(run.threadId, (thread) => ({
      ...thread,
      messages: [...thread.messages, assistant],
    }));
    let reply: LocalModelReply;
    try {
      reply = await bindings.generate(assistant.id);
    } catch (error) {
      threads.change(run.threadId, (thread) => ({
        ...thread,
        messages: thread.messages.filter(
          (message) => message.id !== assistant.id || !emptyLocalAnswer(message),
        ),
      }));
      throw error;
    }
    bindings.check();
    const calls = localReplyToolCalls(reply);
    threads.change(run.threadId, (thread) => ({
      ...thread,
      updatedAt: new Date().toISOString(),
      messages: thread.messages.map((message) =>
        message.id === assistant.id
          ? {
              ...message,
              content: reply.content ?? '',
              reasoning: reply.reasoning_content ?? '',
              toolCalls: calls,
            }
          : message,
      ),
    }));
    await threads.save(run.threadId);
    if (!calls.length) {
      requireLocalAnswer(reply);
      return;
    }
    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index];
      if (!call) {
        throw new Error('The local tool call is unavailable.');
      }
      bindings.check();
      if (steps === limit) {
        throw new LocalStepLimit(
          'The local tool limit was reached. Review the workspace before continuing.',
        );
      }
      const reads = parallelLocalReads(
        calls.slice(index, index + Math.min(LOCAL_FANOUT, limit - steps)),
        bindings.approval,
      );
      if (reads.length > 1) {
        steps += reads.length;
        const results = await Promise.allSettled(reads.map((entry) => bindings.tool(entry, false)));
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') {
          throw failure.reason;
        }
        index += reads.length - 1;
        lastCall = '';
        repeats = 0;
        continue;
      }
      steps += 1;
      const key = `${call.function.name} ${call.function.arguments}`;
      repeats = key === lastCall ? repeats + 1 : 1;
      lastCall = key;
      if (repeats > REPEATED_TOOL_CALL_LIMIT) {
        throw new LocalStepLimit(
          `The local model kept repeating the same ${call.function.name} call. Review the conversation, then continue or rephrase the request.`,
        );
      }
      await bindings.tool(call, repeats === REPEATED_TOOL_CALL_LIMIT);
    }
  }
  throw new LocalStepLimit(
    'The local tool limit was reached. Review the workspace before continuing.',
  );
}

export class LocalStepLimit extends Error {}

export function interruptLocalRun<T>(run: LocalAgentRun, work: Promise<T>): Promise<T> {
  work.catch(() => undefined);
  return Promise.race([work, run.interrupt]);
}

export function localReplyToolCalls(reply: LocalModelReply): LocalToolCall[] {
  return (reply.tool_calls ?? []).map((call) => ({
    id: randomUUID(),
    type: 'function',
    function: { name: call.function.name, arguments: call.function.arguments },
  }));
}

export function requireLocalAnswer(reply: LocalModelReply): void {
  if (reply.truncated || reply.stopped_limit) {
    throw new LocalStepLimit(
      'The local model reached its output limit. Review the partial response and continue explicitly.',
    );
  }
  if (!reply.content?.trim()) {
    throw new Error('The model returned neither an answer nor a tool call.');
  }
}

/** The third identical consecutive call is not run; a further repeat ends the turn. */
export const REPEATED_TOOL_CALL_LIMIT = 3;

export function repeatedToolCallError(name: string): string {
  return `Not run: this is the same ${name} call with the same arguments ${String(REPEATED_TOOL_CALL_LIMIT)} times in a row, so its result would not change. Use the earlier result, try a different tool or arguments, or answer.`;
}

const TITLE_LIMIT = 60;

/** The first message's first line, cut at a word boundary when longer than the drawer can show. */
export function localConversationTitle(input: string): string {
  const line = input.trim().split(/\r?\n/u)[0]?.replace(/\s+/gu, ' ').trim() ?? '';
  if (line.length <= TITLE_LIMIT) {
    return line || 'New local conversation';
  }
  const cut = line.slice(0, TITLE_LIMIT - 1);
  const boundary = cut.lastIndexOf(' ');
  const words = boundary >= TITLE_LIMIT / 2 ? cut.slice(0, boundary) : cut;
  return `${words.replace(/[\s.,;:!?-]+$/u, '')}…`;
}
