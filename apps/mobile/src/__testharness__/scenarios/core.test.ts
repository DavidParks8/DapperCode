import { requireTestValue } from '../../testing/requireTestValue';
import { EventType } from '@ag-ui/core';
import { TestableThreadState } from '../TestableThreadState';
import { sequence } from '../EventSequenceBuilder';
import {
  simpleReply,
  streamingReply,
  toolCallThenReply,
  subAgentSpawn,
  snapshotMidStream,
} from '../fixtures/scenarios';

describe('Status transitions', () => {
  it('is idle before any events, running after STEP_STARTED, and complete after RUN_FINISHED', () => {
    const state = new TestableThreadState();

    const initial = state.getActivityStatus('t1');
    expect(initial.hasRunning).toBe(false);

    state.apply('t1', 'r1', {
      type: EventType.RUN_STARTED,
      threadId: 't1',
      runId: 'r1',
    });
    state.apply('t1', 'r1', {
      type: EventType.STEP_STARTED,
      stepName: 'agent-turn',
    });
    expect(state.getActivityStatus('t1').hasRunning).toBe(true);

    state.apply('t1', 'r1', {
      type: EventType.TEXT_MESSAGE_START,
      messageId: 'm1',
      role: 'assistant',
    });
    expect(state.getActivityStatus('t1').hasRunning).toBe(true);

    state.apply('t1', 'r1', {
      type: EventType.STEP_FINISHED,
      stepName: 'agent-turn',
    });
    expect(state.getActivityStatus('t1').hasRunning).toBe(false);

    state.apply('t1', 'r1', {
      type: EventType.RUN_FINISHED,
      threadId: 't1',
      runId: 'r1',
    });
    const afterFinish = state.getActivityStatus('t1');
    expect(afterFinish.hasTerminal).toBe(true);
    expect(afterFinish.hasRunning).toBe(false);
  });

  it('does not corrupt state when a stale RUN_FINISHED arrives after a new run', () => {
    const state = new TestableThreadState();

    // First run completes
    state.applySequence(simpleReply('t1', 'run-1'));
    expect(state.getActivityStatus('t1').hasRunning).toBe(false);

    // Second run starts — RUN_STARTED resets the state
    state.apply('t1', 'run-2', {
      type: EventType.RUN_STARTED,
      threadId: 't1',
      runId: 'run-2',
    });

    // Stale RUN_FINISHED from run-1 arrives — should be a no-op
    const before = state.getThreadState('t1');
    state.apply('t1', 'run-1', {
      type: EventType.RUN_FINISHED,
      threadId: 't1',
      runId: 'run-1',
    });
    expect(state.getThreadState('t1')).toBe(before);
  });

  it('marks error state on RUN_ERROR after a message exists', () => {
    const state = new TestableThreadState();
    state.apply('t1', 'r1', {
      type: EventType.RUN_STARTED,
      threadId: 't1',
      runId: 'r1',
    });
    state.apply('t1', 'r1', {
      type: EventType.TEXT_MESSAGE_START,
      messageId: 'm1',
      role: 'assistant',
    });
    state.apply('t1', 'r1', {
      type: EventType.RUN_ERROR,
      message: 'something broke',
    });
    const status = state.getActivityStatus('t1');
    expect(status.hasTerminal).toBe(true);
    expect(status.hasRunning).toBe(false);
  });
});

describe('Message ordering', () => {
  it('preserves the order of messages as they are applied', () => {
    const state = new TestableThreadState();
    state.applySequence(simpleReply('t1', 'r1', 'Hello'));

    const ids = state.getMessageIds('t1');
    expect(ids).toHaveLength(1);
    expect(ids[0]).toBe('t1::msg-1');
  });

  it('preserves order across multiple turns via persisted chat', () => {
    const state = new TestableThreadState();

    // First turn completes
    state.applySequence(simpleReply('t1', 'run-1', 'First'));

    // Persist the first turn's messages in the chat (simulates production storage)
    state.setPersistedChat({
      id: 't1',
      title: 'Test thread',
      status: 'idle',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      statusUpdatedAt: new Date(0).toISOString(),
      lastMessagePreview: '',
      messages: state.getThreadState('t1')!.messages,
    });

    // Second turn — RUN_STARTED resets live state
    state.applySequence(
      sequence('t1', 'run-2')
        .runStarted()
        .textMessage('Second', { messageId: 't1::msg-2' })
        .runFinished()
        .build(),
    );

    const contents = state.getMessageContents('t1');
    expect(contents).toHaveLength(2);
    expect(requireTestValue(contents[0], 'indexed test value').content).toBe('First');
    expect(requireTestValue(contents[1], 'indexed test value').content).toBe('Second');
  });
});

describe('Duplicate prevention', () => {
  it('does not produce duplicate messages from a simple reply', () => {
    const state = new TestableThreadState();
    state.applySequence(simpleReply('t1'));
    expect(state.findDuplicateIds('t1')).toHaveLength(0);
    expect(state.findDuplicateContent('t1')).toHaveLength(0);
  });

  it('does not produce duplicates after streaming', () => {
    const state = new TestableThreadState();
    state.applySequence(streamingReply('t1'));
    expect(state.findDuplicateIds('t1')).toHaveLength(0);
    expect(state.findDuplicateContent('t1')).toHaveLength(0);
  });

  it('does not duplicate messages after a MESSAGES_SNAPSHOT', () => {
    const state = new TestableThreadState();
    state.applySequence(snapshotMidStream('t1'));
    expect(state.findDuplicateIds('t1')).toHaveLength(0);
    expect(state.getMessageContents('t1')).toHaveLength(2);
  });

  it('does not duplicate across multiple runs via persisted chat', () => {
    const state = new TestableThreadState();
    // Use different message IDs so run-2 doesn't merge with run-1
    state.applySequence(
      sequence('t1', 'run-1')
        .runStarted()
        .textMessage('Hello', { messageId: 't1::run1-msg' })
        .runFinished()
        .build(),
    );

    // Persist first turn's messages
    state.setPersistedChat({
      id: 't1',
      title: 'Test thread',
      status: 'idle',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      statusUpdatedAt: new Date(0).toISOString(),
      lastMessagePreview: '',
      messages: state.getThreadState('t1')!.messages,
    });

    state.applySequence(
      sequence('t1', 'run-2')
        .runStarted()
        .textMessage('Goodbye', { messageId: 't1::run2-msg' })
        .runFinished()
        .build(),
    );
    expect(state.findDuplicateIds('t1')).toHaveLength(0);
    expect(state.getMessageContents('t1')).toHaveLength(2);
  });
});

describe('Message retention', () => {
  it('retains all messages from a complete interaction', () => {
    const state = new TestableThreadState();
    state.applySequence(toolCallThenReply('t1'));

    const contents = state.getMessageContents('t1');
    // tool call + tool result + assistant text
    expect(contents.length).toBeGreaterThanOrEqual(1);
    const assistantMsg = contents.find(
      (m) => m.role === 'assistant' && m.content.includes('file content'),
    );
    expect(assistantMsg).toBeDefined();
  });

  it('retains messages after snapshot with live overlay', () => {
    const state = new TestableThreadState();
    state.applySequence(snapshotMidStream('t1'));

    const contents = state.getMessageContents('t1');
    expect(contents).toHaveLength(2);
    expect(requireTestValue(contents[0], 'indexed test value').content).toBe('First message');
    expect(requireTestValue(contents[1], 'indexed test value').content).toBe('Second message');
  });
});

describe('Sub-agent behavior', () => {
  it('creates a sub-agent activity card when ACTIVITY_SNAPSHOT arrives', () => {
    const state = new TestableThreadState();
    state.applySequence(subAgentSpawn('parent', 'child'));

    const activities = state.getSubAgentActivities('parent');
    expect(activities).toHaveLength(1);
  });

  it('tracks sub-agent status as it progresses', () => {
    const state = new TestableThreadState();
    const events = subAgentSpawn('parent', 'child');

    // Apply up to the running activity card
    const runningIndex = events.findIndex(
      (e) =>
        e.event.type === ('ACTIVITY_SNAPSHOT' as never) &&
        (e.event as { content?: { subAgent?: { agentStatus?: string } } }).content?.subAgent
          ?.agentStatus === 'running',
    );
    state.applySequence(events.slice(0, runningIndex + 1));
    expect(state.getRunningSubAgentCount('parent')).toBe(1);

    // Apply up to the completed activity card
    const completedIndex = events.findIndex(
      (e) =>
        e.event.type === ('ACTIVITY_SNAPSHOT' as never) &&
        (e.event as { content?: { subAgent?: { agentStatus?: string } } }).content?.subAgent
          ?.agentStatus === 'completed',
    );
    state.applySequence(events.slice(runningIndex + 1, completedIndex + 1));
    expect(state.getRunningSubAgentCount('parent')).toBe(0);
  });

  it('streams child thread messages independently', () => {
    const state = new TestableThreadState();
    state.applySequence(subAgentSpawn('parent', 'child'));

    const childContents = state.getMessageContents('child');
    expect(childContents).toHaveLength(1);
    expect(requireTestValue(childContents[0], 'indexed test value').content).toBe('Working on it');
  });

  it('does not leak child messages into parent transcript', () => {
    const state = new TestableThreadState();
    state.applySequence(subAgentSpawn('parent', 'child'));

    const parentContents = state.getMessageContents('parent');
    // Parent should not contain the child's "Working on it" message
    const childMsg = parentContents.find((m) => m.content === 'Working on it');
    expect(childMsg).toBeUndefined();
  });
});

describe('Tool call then reply', () => {
  it('includes tool call and text message in transcript', () => {
    const state = new TestableThreadState();
    state.applySequence(toolCallThenReply('t1'));

    const contents = state.getMessageContents('t1');
    expect(contents.length).toBeGreaterThanOrEqual(1);
    expect(contents.some((m) => m.content.includes('file content'))).toBe(true);
  });
});

describe('Fresh state after RUN_STARTED', () => {
  it('resets thread state on a new RUN_STARTED', () => {
    const state = new TestableThreadState();

    // First run
    state.applySequence(simpleReply('t1', 'run-1', 'Old message'));
    expect(state.getMessageContents('t1')).toHaveLength(1);

    // Second run starts — should reset
    state.apply('t1', 'run-2', {
      type: EventType.RUN_STARTED,
      threadId: 't1',
      runId: 'run-2',
    });

    const threadState = state.getThreadState('t1');
    expect(threadState?.messages).toHaveLength(0);
  });
});
