import type { BridgeUiSurface } from '@bridge/types/types';
import {
  formatCallElapsed,
  isPhoneCallSurface,
  phoneCallModel,
  phoneCallStatusLine,
  selectDockedPhoneCalls,
} from './phoneCallModel';

function callSurface(
  overrides: Partial<BridgeUiSurface> = {},
  status = 'In call',
): BridgeUiSurface {
  return {
    id: 'phone-call-live:call-1',
    threadId: 'thread-1',
    kind: 'phone-call',
    presentation: 'workflowCard',
    tone: 'success',
    title: 'Phone call · +15551234567',
    subtitle: status,
    blocks: [
      {
        type: 'keyValue',
        items: [
          { label: 'Status', value: status },
          { label: 'To', value: 'Pharmacy (+15551234567)' },
          { label: 'From', value: '+15550000001' },
          { label: 'Duration', value: '2:41' },
          { label: 'Objective', value: 'Request a prescription refill.' },
        ],
      },
      {
        type: 'markdown',
        markdown: '**Live transcript**\n\n**Recipient:** Please hold.',
      },
    ],
    actions: [{ id: 'hangup', label: 'Hang Up', style: 'destructive', dismissesSurface: false }],
    dismissible: false,
    ...overrides,
  };
}

function settledCall(
  items: Array<{ label: string; value: string }>,
  tone: BridgeUiSurface['tone'] = 'neutral',
) {
  return callSurface({
    title: 'Phone call ended',
    tone,
    actions: [],
    dismissible: true,
    blocks: [{ type: 'keyValue', items }],
  });
}

describe('phoneCallModel', () => {
  it('reads who, state, elapsed time and transcript from a live call card', () => {
    const model = phoneCallModel(callSurface());

    expect(model).toMatchObject({
      callee: 'Pharmacy (+15551234567)',
      phase: 'live',
      durationSeconds: 161,
      objective: 'Request a prescription refill.',
      outcome: null,
      transcriptMarkdown: '**Recipient:** Please hold.',
    });
    expect(phoneCallStatusLine(model, 161, 'idle')).toBe('In call · 2:41');
    expect(phoneCallStatusLine(model, 161, 'pending')).toBe('Hanging up…');
    expect(phoneCallStatusLine(model, 161, 'failed')).toBe('Couldn’t hang up. Try again.');
  });

  it('distinguishes connecting, held, ended and failed calls', () => {
    const ringing = phoneCallModel(callSurface({}, 'Ringing'));
    expect(ringing.phase).toBe('connecting');
    expect(phoneCallStatusLine(ringing, null, 'idle')).toBe('Ringing…');

    const held = phoneCallModel(callSurface({}, 'On hold'));
    expect(held.phase).toBe('held');
    expect(phoneCallStatusLine(held, 3_725, 'idle')).toBe('On hold · 1:02:05');

    const ended = phoneCallModel(
      settledCall([
        { label: 'Status', value: 'Ended' },
        { label: 'To', value: '+15551234567' },
        { label: 'Duration', value: '1:05' },
        { label: 'Summary', value: 'Refill ready Friday.' },
      ]),
    );
    expect(ended).toMatchObject({
      callee: '+15551234567',
      phase: 'ended',
      outcome: { label: 'Summary', value: 'Refill ready Friday.' },
      transcriptMarkdown: null,
      hangupAction: null,
    });
    // A settled call leads with what happened, not how long it took, and ignores a stale hang-up.
    expect(phoneCallStatusLine(ended, ended.durationSeconds, 'pending')).toBe(
      'Ended · Refill ready Friday.',
    );

    const hungUp = phoneCallModel(
      settledCall([
        { label: 'Status', value: 'Ended' },
        { label: 'Duration', value: '0:13' },
        { label: 'Reason', value: 'You hung up' },
      ]),
    );
    expect(phoneCallStatusLine(hungUp, hungUp.durationSeconds, 'idle')).toBe('Ended · You hung up');

    const failed = phoneCallModel(
      settledCall(
        [
          { label: 'Status', value: 'Failed' },
          { label: 'Reason', value: 'Line busy' },
          { label: 'Details', value: 'SIP call rejected (486 Busy Here)' },
        ],
        'error',
      ),
    );
    expect(failed).toMatchObject({
      phase: 'failed',
      durationSeconds: null,
      details: 'SIP call rejected (486 Busy Here)',
    });
    expect(phoneCallStatusLine(failed, null, 'idle')).toBe('Failed · Line busy');
  });

  it('docks the active call, or only the newest result, never a pile of old calls', () => {
    const old = settledCall([{ label: 'Status', value: 'Ended' }]);
    const older = { ...old, id: 'phone-call-live:older', createdAt: '2026-11-14T08:00:00Z' };
    const newer = { ...old, id: 'phone-call-live:newer', createdAt: '2026-11-14T09:00:00Z' };
    const active = callSurface({ id: 'phone-call-live:active', createdAt: '2026-11-14T07:00:00Z' });

    expect(selectDockedPhoneCalls([newer, older])).toEqual({
      docked: [newer],
      superseded: [older],
    });
    expect(selectDockedPhoneCalls([older, active, newer])).toEqual({
      docked: [active],
      superseded: [older, newer],
    });
    expect(selectDockedPhoneCalls([])).toEqual({ docked: [], superseded: [] });
  });

  it('only docks phone-call workflow cards', () => {
    expect(isPhoneCallSurface(callSurface())).toBe(true);
    expect(isPhoneCallSurface(callSurface({ kind: null }))).toBe(true);
    expect(isPhoneCallSurface(callSurface({ presentation: 'modal' }))).toBe(false);
    expect(isPhoneCallSurface(callSurface({ kind: 'goal' }))).toBe(false);
    expect(isPhoneCallSurface(callSurface({ id: 'goal-1', kind: null }))).toBe(false);
    expect(formatCallElapsed(-4)).toBe('0:00');
  });
});
