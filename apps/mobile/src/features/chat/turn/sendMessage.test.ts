import { createTestStore } from '@shell/state/testing';
import { executeSendMessage } from './sendMessage';
import type { MainScreenSendMessageHandlerContext } from './sendMessageHandler';
import {
  SubmissionController,
  submissionScopeKey,
  type SubmissionDraftSnapshot,
} from './controllers/submissionController';

const SCOPE_KEY = submissionScopeKey({ profileId: 'profile-1', threadId: 'thread-1' });

function snapshot(value: string, revision = 1): SubmissionDraftSnapshot {
  return { scopeKey: SCOPE_KEY, value, revision };
}

function createHarness(options: { slashHandled: boolean }) {
  const submissionController = new SubmissionController(() => 'submission-original');
  const beginSpy = jest.spyOn(submissionController, 'begin');
  const handleSlashCommand = jest.fn(() => Promise.resolve(options.slashHandled));
  const setDraft = jest.fn();
  const context = {
    selectedChatId: 'thread-1',
    handleSlashCommand,
    setDraft,
    pendingMentionPaths: [],
    pendingLocalImagePaths: [],
    selectedChat: null,
    submissionController,
    draftController: { snapshot: () => snapshot('/compact') },
    threadRuntimeSnapshotsRef: { current: {} },
    selectedChatIdRef: { current: 'thread-1' },
    activeTurnIdRef: { current: null },
    selectedChatRef: { current: null },
    store: createTestStore(),
  } as unknown as MainScreenSendMessageHandlerContext;
  return { beginSpy, context, handleSlashCommand, setDraft, submissionController };
}

/**
 * Reproduces a slash command consuming a composer submission.
 *
 * Slash commands never reach the bridge as a turn, so they must be handled before a submission
 * exists. Beginning a submission first hands the command the retry entry that a previously failed
 * message is waiting on, so the real retry is later resent under a brand new id — a duplicate turn.
 */
describe('Slash commands never consume a composer submission', () => {
  it('handles the command without beginning a submission', async () => {
    const { beginSpy, context, handleSlashCommand, setDraft } = createHarness({
      slashHandled: true,
    });

    await expect(
      executeSendMessage(context, '/compact', { allowSlashCommands: true }),
    ).resolves.toBe(true);

    expect(handleSlashCommand).toHaveBeenCalledWith('/compact');
    expect(beginSpy).not.toHaveBeenCalled();
    expect(setDraft).toHaveBeenCalledWith('');
  });

  it('leaves the draft alone when the command asked to keep the composer', async () => {
    const { beginSpy, context, setDraft } = createHarness({ slashHandled: true });

    await expect(
      executeSendMessage(context, '/compact', { allowSlashCommands: true, clearComposer: false }),
    ).resolves.toBe(true);

    expect(beginSpy).not.toHaveBeenCalled();
    expect(setDraft).not.toHaveBeenCalled();
  });

  it('preserves a failed submission for its retry', async () => {
    const { context, submissionController } = createHarness({ slashHandled: true });
    const attachments = { mentions: [], localImages: [] };
    const failed = submissionController.begin(snapshot('/compact'), attachments);
    submissionController.markCleared(failed, 1);
    submissionController.fail(failed, snapshot('', 1));

    await executeSendMessage(context, '/compact', { allowSlashCommands: true });

    expect(submissionController.begin(snapshot('/compact'), attachments).id).toBe(failed.id);
  });

  it('still begins a submission when the command is not recognized', async () => {
    const { beginSpy, context } = createHarness({ slashHandled: false });

    await executeSendMessage(context, '/compact', { allowSlashCommands: true }).catch(
      () => undefined,
    );

    expect(beginSpy).toHaveBeenCalledTimes(1);
  });

  it('does not consult the slash handler when slash commands are disabled', async () => {
    const { beginSpy, context, handleSlashCommand } = createHarness({ slashHandled: true });

    await executeSendMessage(context, '/compact').catch(() => undefined);

    expect(handleSlashCommand).not.toHaveBeenCalled();
    expect(beginSpy).toHaveBeenCalledTimes(1);
  });
});
