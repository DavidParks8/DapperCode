import { Provider, createStore } from 'jotai';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { ActivityIndicator, ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { BridgeUiSurface, ChatMessage } from '@bridge/types/types';
import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { CLOSED_DUO_TRAITS } from '@shared/testing/foldableLayout';
import { resolveShellLayout } from '@shell/layout/windowLayout';
import { selectDockedPhoneCalls } from '../approvals/phoneCallModel';
import { classifyChatMessageKind } from '../message/itemRenderers';
import { useMainScreenUiActionHandlers } from '../screen/uiActionHandlers';
import { activeBridgeUiSurfacesAtom } from '../state/turn';
import { collectUserMessageAnchors } from '../transcript/scrollRail/geometry';
import { formatPhoneNumber, parseCalleeDisplay } from './formatPhoneNumber';
import { parseCallTranscript } from './phoneCallTimeline';
import {
  collectReportedPhoneCallIds,
  isPhoneCallReportText,
  parsePhoneCallReportMessage,
} from './phoneCallReport';
import { PhoneCallRecordCard } from './PhoneCallRecordCard';
import { PhoneCallStageContent } from './PhoneCallStageContent';
import { PhoneCallApprovalSheet } from './PhoneCallApprovalSheet';
import { resolvePhoneCallStageLayout } from './stageLayout';

jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('@shared/feedback', () => ({
  feedback: {
    selection: jest.fn().mockResolvedValue(undefined),
    destructive: jest.fn().mockResolvedValue(undefined),
  },
}));

const theme = createAppTheme('dark');
const safeAreaMetrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

type QueryNode = {
  type: unknown;
  props: Record<string, unknown>;
  findAll(predicate: (node: QueryNode) => boolean): QueryNode[];
};

const mounted: ReactTestRenderer[] = [];

function mount(element: React.ReactElement): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <SafeAreaProvider initialMetrics={safeAreaMetrics}>
        <AppThemeProvider theme={theme}>{element}</AppThemeProvider>
      </SafeAreaProvider>,
    );
  });
  if (!tree) {
    throw new Error('Failed to render test tree');
  }
  mounted.push(tree);
  return tree;
}

function rootOf(tree: ReactTestRenderer): QueryNode {
  return tree.root as unknown as QueryNode;
}

function byTestId(tree: ReactTestRenderer, testID: string): QueryNode[] {
  return rootOf(tree).findAll(
    (node) => node.props['testID'] === testID && typeof node.type !== 'string',
  );
}

function allTexts(tree: ReactTestRenderer): string[] {
  return rootOf(tree)
    .findAll((node) => node.type === Text)
    .map((node) => String(node.props['children']));
}

const sampleReport = [
  '[Outbound phone call ended]',
  'Call ID: call-42',
  'To: CVS Pharmacy (+15551234567)',
  'Status: completed',
  'Duration: 3:15 (195s)',
  'End reason: remote_bye',
  'Outcome summary: Prescription refill ready Friday at 2 PM.',
  'Objective: Confirm refill pickup time.',
  '',
  'Transcript:',
  'Agent: Hello, checking on a prescription refill.',
  'Event: Pressed 2',
  'Tool: Calendar lookup · completed: Free after 2 PM',
  'CVS Pharmacy: It will be ready Friday at 2 PM.',
  'Instruction (not spoken): Confirm the copay too.',
].join('\n');

const sampleLiveSurface: BridgeUiSurface = {
  id: 'phone-call-live:call-42',
  threadId: 'thread-1',
  kind: 'phone-call',
  presentation: 'workflowCard',
  tone: 'success',
  title: 'Phone call · CVS Pharmacy',
  subtitle: 'In call',
  blocks: [
    {
      type: 'keyValue',
      items: [
        { label: 'Status', value: 'In call' },
        { label: 'To', value: 'CVS Pharmacy (+15551234567)' },
        { label: 'From', value: '+15550000001' },
        { label: 'Activity', value: 'Checking calendar…' },
        { label: 'Duration', value: '1:12' },
        { label: 'Objective', value: 'Confirm refill pickup time.' },
      ],
    },
    {
      type: 'markdown',
      markdown: [
        '**Live transcript**',
        '',
        '**Agent:** Hi, calling about a prescription refill.',
        '',
        '**CVS Pharmacy:** Sure, what day works best?',
        '',
        '**Event:** Pressed 2',
        '',
        '**Tool:** Checking calendar… · running',
        '',
        '**Instruction (not spoken):** Ask about Friday afternoon.',
      ].join('\n'),
    },
  ],
  actions: [{ id: 'hangup', label: 'Hang Up', style: 'destructive', dismissesSurface: false }],
  dismissible: false,
};

const sampleApprovalSurface: BridgeUiSurface = {
  id: 'phone-call-approval:call-99',
  threadId: 'thread-1',
  kind: 'phone-call',
  presentation: 'modal',
  tone: 'warning',
  title: 'Approve outbound phone call',
  subtitle: 'CVS Pharmacy (+15551234567)',
  blocks: [
    {
      type: 'keyValue',
      items: [
        { label: 'To', value: 'CVS Pharmacy (+15551234567)' },
        { label: 'From', value: '+15550000001' },
        { label: 'On behalf of', value: 'David' },
        { label: 'Objective', value: 'Confirm prescription pickup window.' },
      ],
    },
    {
      type: 'markdown',
      markdown: '**Opening message**\n\nHi, calling to check on a prescription refill.',
    },
    {
      type: 'markdown',
      markdown: '**Background for the calling agent**\n\nDOB is May 4.',
    },
  ],
  actions: [
    { id: 'approve', label: 'Approve & Call', style: 'primary', dismissesSurface: true },
    { id: 'cancel', label: 'Cancel', style: 'destructive', dismissesSurface: true },
  ],
  dismissible: false,
};

describe('phone-call UX redesign models and components', () => {
  afterEach(() => {
    act(() => {
      mounted.splice(0).forEach((tree) => tree.unmount());
    });
  });

  it('formats NANP phone numbers, preserves international E.164 numbers verbatim, and splits named callees', () => {
    expect(formatPhoneNumber('+15551234567')).toBe('(555) 123-4567');
    expect(formatPhoneNumber('5551234567')).toBe('(555) 123-4567');
    expect(formatPhoneNumber('+442079460958')).toBe('+442079460958');
    expect(formatPhoneNumber('+8613800138000')).toBe('+8613800138000');
    expect(formatPhoneNumber('+5511987654321')).toBe('+5511987654321');
    expect(parseCalleeDisplay('CVS Pharmacy (+15551234567)')).toEqual({
      displayName: 'CVS Pharmacy',
      name: 'CVS Pharmacy',
      formattedNumber: '(555) 123-4567',
      rawNumber: '+15551234567',
    });
  });

  it('parses structured markdown and plain transcripts including events and async tool chips', () => {
    const items = parseCallTranscript(
      '**Agent:** Checking now. [interrupted]\n\n**Event:** Pressed 2\n\n**Tool:** Checking calendar… · running\n\n**Tool:** Calendar lookup · completed: Free at 2 PM\n\n**Instruction (not spoken):** Ask for Friday.',
      'markdown',
    );
    expect(items).toEqual([
      { kind: 'agent', text: 'Checking now.', interrupted: true },
      { kind: 'event', text: 'Pressed 2' },
      { kind: 'tool', label: 'Checking calendar…', status: 'running', detail: null },
      { kind: 'tool', label: 'Calendar lookup', status: 'completed', detail: 'Free at 2 PM' },
      { kind: 'whisper', text: 'Ask for Friday.' },
    ]);

    // Plain-text post-call reports preserve Unicode callee labels and keep multiline colon text
    // (such as hours "Monday: 9–5") inside the current speaker bubble instead of faking a speaker.
    const unicodeReport = [
      '[Outbound phone call ended]',
      'Call ID: call-jp',
      'To: 薬局 Café (+81312345678)',
      'Status: completed',
      'Duration: 1:10 (70s)',
      'End reason: remote_bye',
      'Objective: Confirm hours.',
      '',
      'Transcript:',
      'Agent: What are your hours?',
      '薬局 Café: Our hours are:',
      'Monday: 9–5',
      'Tuesday: 9–6',
    ].join('\n');
    const parsedUnicode = parsePhoneCallReportMessage(unicodeReport);
    expect(parsedUnicode?.timeline).toEqual([
      { kind: 'agent', text: 'What are your hours?', interrupted: false },
      {
        kind: 'recipient',
        speakerLabel: '薬局 Café',
        text: 'Our hours are:\nMonday: 9–5\nTuesday: 9–6',
        interrupted: false,
      },
    ]);
  });

  it('parses post-call reports, renders collapsible inline Call Records, and retires settled dock pills', () => {
    expect(isPhoneCallReportText(sampleReport)).toBe(true);
    const record = parsePhoneCallReportMessage(sampleReport);
    expect(record).toMatchObject({
      callId: 'call-42',
      status: 'completed',
      durationLabel: '3:15',
      endReason: 'Recipient hung up',
      outcomeSummary: 'Prescription refill ready Friday at 2 PM.',
      objective: 'Confirm refill pickup time.',
    });

    const userMsg: ChatMessage = {
      id: 'm-1',
      role: 'user',
      content: 'Call the pharmacy please',
      createdAt: '2026-11-26T18:00:00Z',
    };
    const reportMsg: ChatMessage = {
      id: 'm-2',
      role: 'user',
      content: sampleReport,
      createdAt: '2026-11-26T18:04:00Z',
    };
    expect(classifyChatMessageKind(reportMsg, false)).toBe('phoneCallRecord');
    expect(collectUserMessageAnchors([userMsg, reportMsg])).toEqual([
      { messageId: 'm-1', transcriptIndex: 0 },
    ]);

    const reportedIds = collectReportedPhoneCallIds([userMsg, reportMsg]);
    const settledSurface: BridgeUiSurface = {
      ...sampleLiveSurface,
      actions: [],
      dismissible: true,
    };
    expect(selectDockedPhoneCalls([settledSurface], reportedIds)).toEqual({
      docked: [],
      superseded: [settledSurface],
    });
    // Pre-connect failure without a report stays docked until dismissed.
    const preConnectFail: BridgeUiSurface = {
      ...settledSurface,
      id: 'phone-call-live:call-unreported',
      tone: 'error',
    };
    expect(selectDockedPhoneCalls([preConnectFail], reportedIds).docked).toEqual([preConnectFail]);

    const tree = mount(<PhoneCallRecordCard record={record!} />);
    expect(allTexts(tree)).toContain('Phone call · CVS Pharmacy · 3:15');
    expect(allTexts(tree)).toContain('Prescription refill ready Friday at 2 PM.');
    expect(byTestId(tree, 'phone-call-record-body')).toHaveLength(0);

    act(() => {
      (byTestId(tree, 'phone-call-record-toggle')[0]!.props['onPress'] as () => void)();
    });
    expect(byTestId(tree, 'phone-call-record-timeline').length).toBeGreaterThan(0);
    expect(byTestId(tree, 'call-timeline-tool')).toHaveLength(1);
    expect(byTestId(tree, 'call-timeline-event')).toHaveLength(1);
    expect(byTestId(tree, 'phone-call-record-details')).toHaveLength(0);

    act(() => {
      (byTestId(tree, 'phone-call-record-details-toggle')[0]!.props['onPress'] as () => void)();
    });
    expect(allTexts(tree)).toContain('Confirm refill pickup time.');
  });

  it('renders Live Call Stage with two-sided bubbles, tool spinner, whisper controls, and approval handoff', async () => {
    const onAction = jest.fn().mockResolvedValue(true);
    const onChangeWhisperDraft = jest.fn();
    const onJumpToChatAttention = jest.fn();
    const tree = mount(
      <PhoneCallStageContent
        surface={sampleLiveSurface}
        host="sheet"
        whisperDraft="Tell them I prefer Friday afternoon"
        onChangeWhisperDraft={onChangeWhisperDraft}
        onClose={jest.fn()}
        onAction={onAction}
        onDismiss={jest.fn()}
        hasPendingChatAttention
        onJumpToChatAttention={onJumpToChatAttention}
      />,
    );

    const renderedText = allTexts(tree).join(' ');
    expect(renderedText).toContain('CVS Pharmacy');
    expect(renderedText).toContain('(555) 123-4567');
    expect(renderedText).toContain('Checking calendar… · 1:12');
    // Explicitly no tap-to-listen-in feature.
    expect(renderedText.toLowerCase()).not.toContain('listen in');
    expect(byTestId(tree, 'call-timeline-agent')).toHaveLength(1);
    expect(byTestId(tree, 'call-timeline-recipient')).toHaveLength(1);
    expect(byTestId(tree, 'call-timeline-tool')).toHaveLength(1);
    expect(byTestId(tree, 'call-timeline-event')).toHaveLength(1);
    expect(byTestId(tree, 'call-timeline-whisper')).toHaveLength(1);
    expect(rootOf(tree).findAll((node) => node.type === ActivityIndicator).length).toBeGreaterThan(
      0,
    );

    // Async tool chat approval handoff banner minimizes straight back to chat and meets touch target.
    const attentionBanner = byTestId(tree, 'phone-call-stage-attention-banner')[0]!;
    expect(
      (StyleSheet.flatten(attentionBanner.props['style'] as never) as { minHeight?: number })
        .minHeight,
    ).toBeGreaterThanOrEqual(theme.touchTarget.minimum);
    const attentionBtn = byTestId(tree, 'phone-call-stage-attention-action')[0]!;
    const attentionSlop = attentionBtn.props['hitSlop'] as { top: number; bottom: number };
    expect(32 + attentionSlop.top + attentionSlop.bottom).toBeGreaterThanOrEqual(
      theme.touchTarget.minimum,
    );
    act(() => {
      (attentionBtn.props['onPress'] as () => void)();
    });
    expect(onJumpToChatAttention).toHaveBeenCalledTimes(1);

    const wrapUpChip = byTestId(tree, 'phone-call-whisper-chip-wrap-up')[0]!;
    const chipSlop = wrapUpChip.props['hitSlop'] as { top: number; bottom: number };
    expect(34 + chipSlop.top + chipSlop.bottom).toBeGreaterThanOrEqual(theme.touchTarget.minimum);
    const chipsScroll = rootOf(tree).findAll(
      (node) => node.type === ScrollView && node.props['horizontal'] === true,
    )[0]!;
    expect(
      (
        StyleSheet.flatten(chipsScroll.props['contentContainerStyle'] as never) as {
          minHeight?: number;
        }
      ).minHeight,
    ).toBeGreaterThanOrEqual(theme.touchTarget.minimum);

    // Send whisper from the dedicated bar.
    await act(async () => {
      (byTestId(tree, 'phone-call-whisper-send')[0]!.props['onPress'] as () => void)();
      await Promise.resolve();
    });
    expect(onAction).toHaveBeenCalledWith(
      sampleLiveSurface,
      expect.objectContaining({ id: 'steer', dismissesSurface: false }),
      { instruction: 'Tell them I prefer Friday afternoon' },
    );
    expect(onChangeWhisperDraft).toHaveBeenCalledWith('');

    // Quick-steer chip sends directly without wiping draft.
    await act(async () => {
      (byTestId(tree, 'phone-call-whisper-chip-wrap-up')[0]!.props['onPress'] as () => void)();
      await Promise.resolve();
    });
    expect(onAction).toHaveBeenLastCalledWith(
      sampleLiveSurface,
      expect.objectContaining({ id: 'steer' }),
      { instruction: 'Wrap up the conversation politely and hang up.' },
    );
  });

  it('supports inline editing in PhoneCallApprovalSheet before approving and validates non-empty goal', async () => {
    const onAction = jest.fn().mockResolvedValue(true);
    const tree = mount(
      <PhoneCallApprovalSheet
        surface={sampleApprovalSurface}
        onAction={onAction}
        onDismiss={jest.fn()}
      />,
    );

    expect(allTexts(tree)).toContain('CVS Pharmacy');
    expect(allTexts(tree)).toContain('(555) 123-4567');
    expect(allTexts(tree)).toContain('Calling from (555) 000-0001 · On behalf of David');

    const editBtn = byTestId(tree, 'phone-call-approval-edit-toggle')[0]!;
    const editSlop = editBtn.props['hitSlop'] as { top: number; bottom: number };
    expect(32 + editSlop.top + editSlop.bottom).toBeGreaterThanOrEqual(theme.touchTarget.minimum);
    const editParent = (editBtn as unknown as { parent: QueryNode | null }).parent!;
    expect(
      (StyleSheet.flatten(editParent.props['style'] as never) as { minHeight?: number }).minHeight,
    ).toBeGreaterThanOrEqual(theme.touchTarget.minimum);
    act(() => {
      (editBtn.props['onPress'] as () => void)();
    });
    act(() => {
      (
        byTestId(tree, 'phone-call-approval-objective-input')[0]!.props['onChangeText'] as (
          v: string,
        ) => void
      )('   ');
    });
    act(() => {
      (byTestId(tree, 'phone-call-approval-approve')[0]!.props['onPress'] as () => void)();
    });
    expect(byTestId(tree, 'phone-call-approval-validation-error')).toHaveLength(1);
    expect(onAction).not.toHaveBeenCalled();

    act(() => {
      (
        byTestId(tree, 'phone-call-approval-objective-input')[0]!.props['onChangeText'] as (
          v: string,
        ) => void
      )('Ask if pickup is ready Friday at 3 PM.');
    });
    expect(allTexts(tree)).toContain('Save & Call');
    await act(async () => {
      (byTestId(tree, 'phone-call-approval-approve')[0]!.props['onPress'] as () => void)();
      await Promise.resolve();
    });
    expect(onAction).toHaveBeenCalledWith(
      sampleApprovalSurface,
      expect.objectContaining({ id: 'approve' }),
      {
        objective: 'Ask if pickup is ready Friday at 3 PM.',
        firstMessage: 'Hi, calling to check on a prescription refill.',
        context: 'DOB is May 4.',
      },
    );
  });

  it('selects sheet vs trailing split-pane across every iPhone Duo pose', () => {
    // Closed Duo: compact outer display with trailing rail -> sheet
    const closed = resolvePhoneCallStageLayout({
      windowWidth: 466,
      layout: resolveShellLayout({ width: 466, height: 678 }, CLOSED_DUO_TRAITS, false),
      sceneInsets: { paddingLeft: 0, paddingRight: 84 },
    });
    expect(closed).toEqual({ mode: 'sheet' });

    // Laptop Duo: horizontal tabletop fold -> sheet (never cramps short upper display)
    const laptop = resolvePhoneCallStageLayout({
      windowWidth: 669,
      layout: resolveShellLayout(
        { width: 669, height: 951 },
        {
          horizontalSizeClass: 'regular',
          verticalSizeClass: 'regular',
          divisions: [{ x: 0, y: 455.5, width: 669, height: 40 }],
        },
        false,
      ),
      sceneInsets: { paddingLeft: 0, paddingRight: 64 },
    });
    expect(laptop).toEqual({ mode: 'sheet' });

    // Book Duo: vertical pane-splitting fold -> trailing page across hinge, clear of side rail
    const book = resolvePhoneCallStageLayout({
      windowWidth: 951,
      layout: resolveShellLayout(
        { width: 951, height: 669 },
        {
          horizontalSizeClass: 'regular',
          verticalSizeClass: 'compact',
          divisions: [{ x: 455, y: 0, width: 41, height: 669 }],
        },
        false,
      ),
      sceneInsets: { paddingLeft: 0, paddingRight: 84 },
    });
    expect(book).toEqual({
      mode: 'split-pane',
      paneWidth: 951 - (455 + 41) - 84,
      dividerWidth: 41,
      acrossFold: true,
    });

    // Open wide Duo (hidden sidebar) -> trailing split pane beside chat
    const openWide = resolvePhoneCallStageLayout({
      windowWidth: 951,
      layout: resolveShellLayout({ width: 951, height: 669 }, null, true),
      sceneInsets: { paddingLeft: 0, paddingRight: 84 },
    });
    expect(openWide).toMatchObject({
      mode: 'split-pane',
      acrossFold: false,
      dividerWidth: 1,
    });
    if (openWide.mode === 'split-pane') {
      expect(openWide.paneWidth).toBeGreaterThanOrEqual(330);
      expect(openWide.paneWidth).toBeLessThanOrEqual(400);
    }
  });

  it('forwards approval edit and whisper steer payloads through useMainScreenUiActionHandlers', async () => {
    const store = createStore();
    store.set(activeBridgeUiSurfacesAtom, [sampleApprovalSurface, sampleLiveSurface]);
    const resolveBridgeUiSurface = jest.fn().mockResolvedValue({ ok: true });
    const removeThreadBridgeUiSurface = jest.fn();
    let captured: ReturnType<typeof useMainScreenUiActionHandlers> | null = null;

    function HandlerHarness() {
      captured = useMainScreenUiActionHandlers({
        api: { resolveBridgeUiSurface, dismissBridgeUiSurface: jest.fn() },
        approvalController: { dismissUserInput: jest.fn() },
        cacheThreadPendingUserInputRequest: jest.fn(),
        clearHeldActivity: jest.fn(),
        createChat: jest.fn(),
        draftController: { restoring: false },
        heldActivityTimeoutRef: { current: null },
        onOpenGit: jest.fn(),
        openingChatId: null,
        removeThreadBridgeUiSurface,
        runWatchdogNow: 0,
        runWatchdogUntilRef: { current: 0 },
        scrollToBottomReliable: jest.fn(),
        selectedChat: null,
        sendMessage: jest.fn(),
        uploadingAttachment: false,
        ws: { isConnected: true },
        store,
      } as never);
      return null;
    }

    let tree!: ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <Provider store={store}>
          <HandlerHarness />
        </Provider>,
      );
    });
    mounted.push(tree);

    const steerOk = await act(async () =>
      captured!.handleBridgeUiAction(
        sampleLiveSurface,
        { id: 'steer', label: 'Whisper', dismissesSurface: false },
        { instruction: 'Ask about Friday afternoon.' },
      ),
    );
    expect(steerOk).toBe(true);
    expect(resolveBridgeUiSurface).toHaveBeenCalledWith(sampleLiveSurface.id, {
      threadId: sampleLiveSurface.threadId,
      turnId: null,
      actionId: 'steer',
      payload: { instruction: 'Ask about Friday afternoon.' },
    });
    // Non-dismissing whisper keeps the live call surface active.
    expect(store.get(activeBridgeUiSurfacesAtom).map((item) => item.id)).toContain(
      sampleLiveSurface.id,
    );

    const approveOk = await act(async () =>
      captured!.handleBridgeUiAction(sampleApprovalSurface, sampleApprovalSurface.actions[0]!, {
        objective: 'Updated pickup time',
        firstMessage: 'Hi there',
        context: 'Order 42',
      }),
    );
    expect(approveOk).toBe(true);
    expect(resolveBridgeUiSurface).toHaveBeenLastCalledWith(sampleApprovalSurface.id, {
      threadId: sampleApprovalSurface.threadId,
      turnId: null,
      actionId: 'approve',
      payload: { objective: 'Updated pickup time', firstMessage: 'Hi there', context: 'Order 42' },
    });
    expect(removeThreadBridgeUiSurface).toHaveBeenCalledWith(
      sampleApprovalSurface.id,
      sampleApprovalSurface.threadId,
    );
    expect(store.get(activeBridgeUiSurfacesAtom).map((item) => item.id)).not.toContain(
      sampleApprovalSurface.id,
    );
  });
});
