import { LOCAL_RUN_EXPIRED_EVENT, type NativeLocalRunActivity } from '../native/services.types';
import { IDLE_LOCAL_RUN, type LocalThread } from './types';
import {
  LOCAL_RUN_ACTIVITY_TITLE,
  LocalRunActivities,
  localRunActivitySubtitle,
} from './runActivity';

function native(kind: NativeLocalRunActivity['kind'] = 'continued') {
  const listeners = new Set<(event: { id: string }) => void>();
  let sequence = 0;
  const fake = {
    listeners,
    addListener: jest.fn((eventName: string, listener: (event: { id: string }) => void) => {
      expect(eventName).toBe(LOCAL_RUN_EXPIRED_EVENT);
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    }),
    beginLocalRunActivity: jest.fn(async (): Promise<NativeLocalRunActivity> => ({
      id: `run-${String(++sequence)}`,
      kind,
    })),
    updateLocalRunActivity: jest.fn(),
    endLocalRunActivity: jest.fn(),
    expire(id: string): void {
      for (const listener of [...listeners]) {
        listener({ id });
      }
    },
  };
  return fake;
}

function activities(fake: ReturnType<typeof native>, subtitle = () => 'Preparing') {
  const expired = jest.fn();
  const settled = jest.fn((): Promise<void> | null => null);
  const value = new LocalRunActivities(
    fake as unknown as ConstructorParameters<typeof LocalRunActivities>[0],
    { subtitle, expired, settled },
    1_000,
  );
  return { value, expired, settled };
}

const thread = (status: LocalThread['status']) => ({ status }) as LocalThread;

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

test('a granted activity reports progress until the run ends, then stops reporting', async () => {
  const fake = native();
  let subtitle = 'Preparing';
  const { value } = activities(fake, () => subtitle);
  const id = await value.begin();
  expect(id).toBe('run-1');
  expect(fake.beginLocalRunActivity).toHaveBeenCalledWith(LOCAL_RUN_ACTIVITY_TITLE, 'Preparing');
  expect(value.held()).toBe(true);
  jest.advanceTimersByTime(2_000);
  expect(fake.updateLocalRunActivity.mock.calls).toEqual([
    ['run-1', 'Preparing'],
    ['run-1', 'Preparing'],
  ]);
  value.changed();
  expect(fake.updateLocalRunActivity).toHaveBeenCalledTimes(2);
  subtitle = 'Generating on this iPhone';
  value.changed();
  expect(fake.updateLocalRunActivity).toHaveBeenLastCalledWith('run-1', subtitle);
  value.end(id, true);
  expect(fake.endLocalRunActivity).toHaveBeenCalledWith('run-1', true);
  expect(value.held()).toBe(false);
  jest.advanceTimersByTime(5_000);
  value.changed();
  expect(fake.updateLocalRunActivity).toHaveBeenCalledTimes(3);
  value.end(id, false);
  expect(fake.endLocalRunActivity).toHaveBeenCalledTimes(1);
  value.dispose();
});

test.each([
  ['none', async () => ({ id: 'ignored', kind: 'none' as const })],
  [
    'a native failure',
    async (): Promise<NativeLocalRunActivity> => {
      throw new Error('Unavailable');
    },
  ],
])('%s grants no background time, so nothing is held, reported, or ended', async (_name, begin) => {
  const fake = native();
  fake.beginLocalRunActivity.mockImplementationOnce(begin);
  const { value } = activities(fake);
  const id = await value.begin();
  expect(id).toBeNull();
  expect(value.held()).toBe(false);
  jest.advanceTimersByTime(10_000);
  value.end(id, true);
  expect(fake.updateLocalRunActivity).not.toHaveBeenCalled();
  expect(fake.endLocalRunActivity).not.toHaveBeenCalled();
  value.dispose();
});

test('expiration stops the run once, ends reporting, and ignores other activities', async () => {
  const fake = native('background');
  const { value, expired } = activities(fake);
  const id = await value.begin();
  fake.expire('unknown');
  expect(expired).not.toHaveBeenCalled();
  fake.expire(id!);
  fake.expire(id!);
  expect(expired).toHaveBeenCalledTimes(1);
  expect(value.held()).toBe(false);
  jest.advanceTimersByTime(5_000);
  expect(fake.updateLocalRunActivity).not.toHaveBeenCalled();
  // The run settles afterwards and still releases its activity.
  value.end(id, false);
  expect(fake.endLocalRunActivity).toHaveBeenCalledWith(id, false);
});

test('a run holds its activity from before admission until the turn and its settling finish', async () => {
  const fake = native();
  const { value, settled } = activities(fake);
  let finishSettling = (): void => undefined;
  settled.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finishSettling = resolve;
    }),
  );
  const admit = jest.fn(async () => {
    expect(fake.beginLocalRunActivity).toHaveBeenCalledTimes(1);
  });
  await expect(value.run(admit, async () => thread('complete'))).resolves.toEqual(
    thread('complete'),
  );
  expect(admit).toHaveBeenCalledTimes(1);
  expect(settled).toHaveBeenCalledTimes(1);
  expect(fake.endLocalRunActivity).not.toHaveBeenCalled();
  expect(value.held()).toBe(true);
  finishSettling();
  await Promise.resolve();
  await Promise.resolve();
  expect(fake.endLocalRunActivity).toHaveBeenCalledWith('run-1', true);
  expect(value.held()).toBe(false);
  value.dispose();
});

test.each([
  ['an interrupted turn', async () => thread('interrupted')],
  [
    'a failed turn',
    async (): Promise<LocalThread> => {
      throw new Error('Failed');
    },
  ],
])('%s ends its activity as unsuccessful at once when nothing needs settling', async (_, start) => {
  const fake = native();
  const { value, settled } = activities(fake);
  await value.run(async () => undefined, start).catch(() => undefined);
  expect(settled).toHaveBeenCalledTimes(1);
  expect(fake.endLocalRunActivity).toHaveBeenCalledWith('run-1', false);
  expect(value.held()).toBe(false);
  value.dispose();
});

test('a turn refused at admission never starts and gives its activity back once nothing needs settling', async () => {
  const fake = native();
  const { value, settled } = activities(fake);
  const start = jest.fn(async () => thread('complete'));
  const refuse = async () => {
    throw new Error('Wait for on-device operations to settle before sending.');
  };
  await expect(value.run(refuse, start)).rejects.toThrow('Wait for on-device operations');
  expect(start).not.toHaveBeenCalled();
  expect(settled).toHaveBeenCalledTimes(1);
  expect(fake.endLocalRunActivity).toHaveBeenCalledWith('run-1', false);
  expect(value.held()).toBe(false);

  // Locked while admission waited: the refused turn still releases the model first.
  let finishSettling = (): void => undefined;
  settled.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finishSettling = resolve;
    }),
  );
  await expect(value.run(refuse, start)).rejects.toThrow('Wait for on-device operations');
  expect(fake.endLocalRunActivity).toHaveBeenCalledTimes(1);
  expect(value.held()).toBe(true);
  finishSettling();
  await Promise.resolve();
  await Promise.resolve();
  expect(fake.endLocalRunActivity).toHaveBeenLastCalledWith('run-2', false);
  expect(start).not.toHaveBeenCalled();
  value.dispose();
});

test('disposal ends held activities and stops listening for expiration', async () => {
  const fake = native();
  const { value, expired } = activities(fake);
  const id = await value.begin();
  value.dispose();
  expect(fake.endLocalRunActivity).toHaveBeenCalledWith(id, false);
  expect(fake.listeners.size).toBe(0);
  jest.advanceTimersByTime(5_000);
  expect(fake.updateLocalRunActivity).not.toHaveBeenCalled();
  expect(expired).not.toHaveBeenCalled();
});

test('Lock Screen subtitles name the phase and tool but never approval or question content', () => {
  const run = { ...IDLE_LOCAL_RUN, threadId: 'thread', turnId: 'turn' };
  expect(localRunActivitySubtitle(IDLE_LOCAL_RUN)).toBe('Preparing');
  expect(localRunActivitySubtitle({ ...run, phase: 'generating' })).toBe(
    'Generating on this iPhone',
  );
  expect(localRunActivitySubtitle({ ...run, phase: 'tool', toolName: 'read_file' })).toBe(
    'Running read_file',
  );
  expect(
    localRunActivitySubtitle({
      ...run,
      phase: 'approval',
      toolName: 'git_push',
      approval: {
        threadId: 'thread',
        turnId: 'turn',
        callId: 'call',
        toolName: 'git_push',
        kind: 'other',
        summary: 'Push secret-branch to private remote',
      },
    }),
  ).toBe('Waiting for your approval');
  expect(localRunActivitySubtitle({ ...run, phase: 'input', toolName: 'ask_user' })).toBe(
    'Waiting for your answers',
  );
});
