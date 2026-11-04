import { resolveRunAnnouncement, type RunAnnouncementMemory } from './runAnnouncement';
import type { ActivityState } from '../state/runtime';
import { keepReportedRunActivity } from '../state/composer';

function step(
  memory: RunAnnouncementMemory | null,
  chatId: string | null,
  activeTurnId: string | null,
  activity: ActivityState,
  resolvedActivity: ActivityState = activity,
) {
  return resolveRunAnnouncement(memory, { chatId, activeTurnId, activity, resolvedActivity });
}

const completed: ActivityState = { tone: 'complete', title: 'Turn completed' };

describe('resolveRunAnnouncement', () => {
  it('stays silent while a settled chat opens', () => {
    const opening = step(
      null,
      'chat-a',
      null,
      { tone: 'idle', title: 'Ready' },
      {
        tone: 'running',
        title: 'Opening chat',
      },
    );
    expect(opening.announcement).toBeNull();
    const opened = step(opening.memory, 'chat-a', null, completed);
    expect(opened.announcement).toBeNull();
    expect(step(opened.memory, 'chat-a', null, completed).announcement).toBeNull();
  });

  it('never announces shell transitions such as sending a message', () => {
    const sending = step(null, 'chat-a', null, { tone: 'running', title: 'Sending message' });
    expect(sending.announcement).toBeNull();
    expect(
      step(sending.memory, 'chat-a', 'turn-1', { tone: 'running', title: 'Working' }).announcement,
    ).toBeNull();
  });

  it('announces reported phases and the completion of a watched turn, every turn', () => {
    let state = step(null, 'chat-a', null, { tone: 'idle', title: 'Ready' });
    state = step(state.memory, 'chat-a', 'turn-1', {
      tone: 'running',
      title: 'Loading Qwen3 1.7B',
      detail: '40%',
      announce: true,
    });
    expect(state.announcement).toBe('Loading Qwen3 1.7B');
    state = step(state.memory, 'chat-a', null, completed);
    expect(state.announcement).toBe('Turn completed');
    // Later renders of the settled turn keep the same message (deduplicated by the hook).
    state = step(state.memory, 'chat-a', null, completed);
    expect(state.announcement).toBe('Turn completed');
    state = step(state.memory, 'chat-a', 'turn-2', { tone: 'running', title: 'Working' });
    expect(state.announcement).toBeNull();
    state = step(state.memory, 'chat-a', null, completed);
    expect(state.announcement).toBe('Turn completed');
  });

  it('does not carry a finished turn into another chat', () => {
    let state = step(null, 'chat-a', 'turn-1', { tone: 'running', title: 'Working' });
    state = step(state.memory, 'chat-b', null, completed);
    expect(state.announcement).toBeNull();
  });
});

describe('keepReportedRunActivity', () => {
  it('keeps an agent-reported phase when the shell writes its generic Working', () => {
    const generating: ActivityState = { tone: 'running', title: 'Generating', announce: true };
    expect(keepReportedRunActivity(generating, { tone: 'running', title: 'Working' })).toBe(
      generating,
    );
    expect(
      keepReportedRunActivity(generating, { tone: 'running', title: 'Stopping turn' }),
    ).toEqual({ tone: 'running', title: 'Stopping turn' });
    expect(keepReportedRunActivity(generating, completed)).toBe(completed);
    const working: ActivityState = { tone: 'running', title: 'Working' };
    expect(keepReportedRunActivity({ tone: 'running', title: 'Sending message' }, working)).toBe(
      working,
    );
  });
});
