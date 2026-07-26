import { sequence } from '../EventSequenceBuilder';
import type { EventSequenceEntry } from '../EventSequenceBuilder';

/** A minimal assistant reply: RUN_STARTED, text message, RUN_FINISHED. */
export function simpleReply(
  threadId = 'thread',
  runId = 'run-1',
  content = 'Hello world',
): EventSequenceEntry[] {
  return sequence(threadId, runId)
    .runStarted()
    .textMessage(content, { messageId: `${threadId}::msg-1` })
    .runFinished()
    .build();
}

/** A multi-chunk streaming reply. */
export function streamingReply(threadId = 'thread', runId = 'run-1'): EventSequenceEntry[] {
  const mid = `${threadId}::msg-1`;
  return sequence(threadId, runId)
    .runStarted()
    .textStart(mid, 'assistant')
    .textContent('Hello', mid)
    .textContent(' world', mid)
    .textContent('!', mid)
    .textEnd(mid)
    .runFinished()
    .build();
}

/** A tool call followed by a text response. */
export function toolCallThenReply(threadId = 'thread', runId = 'run-1'): EventSequenceEntry[] {
  const mid = `${threadId}::msg-1`;
  const tcid = `${threadId}::tc-1`;
  return sequence(threadId, runId)
    .runStarted()
    .toolCall('readFile', '{"path":"foo.ts"}', { toolCallId: tcid })
    .toolResult(tcid, 'file contents here')
    .textMessage('Here is the file content.', { messageId: mid })
    .runFinished()
    .build();
}

/** Parent spawns a sub-agent, child streams, child completes, parent resumes. */
export function subAgentSpawn(
  parentThreadId = 'parent',
  childThreadId = 'child',
): EventSequenceEntry[] {
  const parentRunId = `${parentThreadId}::run-1`;
  const childRunId = `${childThreadId}::run-1`;
  const parentMsgId = `${parentThreadId}::msg-1`;
  const childMsgId = `${childThreadId}::msg-1`;
  const tcid = `${parentThreadId}::tc-1`;

  const events: EventSequenceEntry[] = [];

  // Parent starts and spawns sub-agent
  events.push(
    ...sequence(parentThreadId, parentRunId)
      .runStarted()
      .textStart(parentMsgId, 'assistant')
      .textContent('Let me ask my sub-agent.', parentMsgId)
      .textEnd(parentMsgId)
      .build(),
  );

  // Sub-agent activity card
  events.push({
    threadId: parentThreadId,
    runId: parentRunId,
    event: {
      type: 'ACTIVITY_SNAPSHOT' as never,
      messageId: `subagent:${tcid}`,
      activityType: 'dappercode.subagent',
      content: {
        text: 'Sub-agent running',
        subAgent: {
          toolCallId: tcid,
          tool: 'spawnAgent',
          senderThreadId: parentThreadId,
          receiverThreadIds: [childThreadId],
          agentStatus: 'running',
          navigable: true,
        },
      },
    },
  });

  // Child runs
  events.push(
    ...sequence(childThreadId, childRunId)
      .runStarted()
      .textStart(childMsgId, 'assistant')
      .textContent('Working on it', childMsgId)
      .textEnd(childMsgId)
      .runFinished()
      .build(),
  );

  // Update sub-agent card to completed
  events.push({
    threadId: parentThreadId,
    runId: parentRunId,
    event: {
      type: 'ACTIVITY_SNAPSHOT' as never,
      messageId: `subagent:${tcid}`,
      activityType: 'dappercode.subagent',
      content: {
        text: 'Sub-agent completed',
        subAgent: {
          toolCallId: tcid,
          tool: 'spawnAgent',
          senderThreadId: parentThreadId,
          receiverThreadIds: [childThreadId],
          agentStatus: 'completed',
          navigable: true,
        },
      },
    },
  });

  // Parent resumes
  events.push(
    ...sequence(parentThreadId, parentRunId)
      .textMessage('Done!', { messageId: `${parentThreadId}::msg-2` })
      .build(),
  );

  return events;
}

/** Two messages with a snapshot in between. */
export function snapshotMidStream(threadId = 'thread', runId = 'run-1'): EventSequenceEntry[] {
  const mid1 = `${threadId}::msg-1`;
  const mid2 = `${threadId}::msg-2`;
  return [
    ...sequence(threadId, runId)
      .runStarted()
      .textStart(mid1, 'assistant')
      .textContent('First message', mid1)
      .textEnd(mid1)
      .build(),
    // Snapshot that includes the first message
    {
      threadId,
      runId,
      event: {
        type: 'MESSAGES_SNAPSHOT' as never,
        messages: [{ role: 'assistant', content: 'First message', id: mid1 }],
      },
    },
    ...sequence(threadId, runId)
      .textStart(mid2, 'assistant')
      .textContent('Second message', mid2)
      .textEnd(mid2)
      .runFinished()
      .build(),
  ];
}
