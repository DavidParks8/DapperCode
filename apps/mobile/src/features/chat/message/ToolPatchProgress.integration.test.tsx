import { EventType, type AGUIEvent } from '@ag-ui/core';
import { act, fireEvent, render } from '@testing-library/react-native';
import { Provider } from 'jotai';

import { createAgUiThreadMessageState } from '@bridge/agui/agUiMessagesState';
import { reduceThreadState } from '@bridge/agui/agUiThreadEventReducer';
import { TOOL_META_EVENT_NAME } from '@bridge/toolMeta';
import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { requireTestValue } from '@shared/testing/requireTestValue';
import { ToolInvocationRow } from './ToolInvocation';
import { buildToolInvocations } from './toolInvocationModel';

jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

const theme = createAppTheme('dark');
const firstDiff = { type: 'diff', path: 'src/first.ts', oldText: 'old\n', newText: 'new\n' };
const secondDiff = { type: 'diff', path: 'src/second.ts', oldText: null, newText: 'added\n' };

it.each(['completed', 'failed'] as const)(
  'keeps live per-file patch counts visible through a %s status-only update and snapshot',
  (status) => {
    let state = createAgUiThreadMessageState();
    const dispatch = (event: AGUIEvent) => {
      state = reduceThreadState(state, { threadId: 'thread', runId: 'run', event });
    };
    const meta = (value: Record<string, unknown>) =>
      dispatch({
        type: EventType.CUSTOM,
        name: TOOL_META_EVENT_NAME,
        value: { toolCallId: 'patch', kind: 'other', title: 'functions.apply_patch', ...value },
      });
    const element = () => (
      <Provider>
        <AppThemeProvider theme={theme}>
          <ToolInvocationRow
            invocation={requireTestValue(buildToolInvocations(state.messages)[0], 'patch row')}
          />
        </AppThemeProvider>
      </Provider>
    );

    meta({ status: 'pending' });
    const screen = render(element());
    expect(screen.getByTestId('tool-row').props['accessibilityLabel']).toBe(
      'Waiting to edit functions.apply_patch',
    );
    expect(screen.queryByTestId('tool-patch-file')).toBeNull();

    meta({ status: 'in_progress', content: [firstDiff] });
    screen.rerender(element());
    expect(screen.getByTestId('tool-row').props['accessibilityLabel']).toBe(
      'Editing first.ts +1 -1',
    );
    expect(screen.getByLabelText('src/first.ts, 1 line added, 1 line removed')).toBeTruthy();
    expect(screen.queryByTestId('tool-output-container')).toBeNull();
    expect(screen.getByTestId('tool-header-shimmer', { includeHiddenElements: true })).toBeTruthy();

    meta({ status: 'in_progress', content: [firstDiff, secondDiff] });
    screen.rerender(element());
    expect(screen.getAllByTestId('tool-patch-file')).toHaveLength(2);
    expect(screen.getByLabelText('src/second.ts, 1 line added, 0 lines removed')).toBeTruthy();

    const revisedDiff = { ...firstDiff, newText: 'new\nanother\n' };
    meta({ status: 'in_progress', content: [firstDiff, secondDiff, revisedDiff] });
    screen.rerender(element());
    expect(screen.getAllByTestId('tool-patch-path').map((node) => node.props['children'])).toEqual([
      'src/first.ts',
      'src/second.ts',
    ]);
    expect(screen.getByLabelText('src/first.ts, 2 lines added, 1 line removed')).toBeTruthy();
    expect(screen.getByTestId('tool-row').props['accessibilityLabel']).toBe(
      'Editing 2 files +3 -1',
    );
    expect(screen.queryByTestId('tool-output-container')).toBeNull();

    meta({ status });
    screen.rerender(element());
    const label = status === 'completed' ? 'Edited 2 files +3 -1' : 'Failed to edit 2 files +3 -1';
    expect(screen.getByTestId('tool-row').props['accessibilityLabel']).toBe(label);
    expect(screen.queryByTestId('tool-header-shimmer', { includeHiddenElements: true })).toBeNull();
    expect(screen.getByLabelText('src/first.ts, 2 lines added, 1 line removed')).toBeTruthy();
    expect(screen.getByTestId('tool-row').props['accessibilityValue']).toEqual({ text: status });

    dispatch({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        {
          id: 'snapshot-call',
          role: 'assistant',
          toolCalls: [
            { id: 'patch', type: 'function', function: { name: 'apply_patch', arguments: '{}' } },
          ],
        },
        {
          id: 'snapshot-meta',
          role: 'activity',
          activityType: 'dappercode.tool',
          content: {
            toolCallId: 'patch',
            kind: 'other',
            title: 'apply_patch',
            status,
            content: [firstDiff, secondDiff, revisedDiff],
          },
        },
      ],
    });
    screen.rerender(element());
    expect(screen.getAllByTestId('tool-row')).toHaveLength(1);
    expect(screen.getAllByTestId('tool-patch-file')).toHaveLength(2);
    expect(screen.getByTestId('tool-row').props['accessibilityLabel']).toBe(label);
    act(() => fireEvent.press(screen.getByTestId('tool-title-toggle')));
    expect(screen.getByTestId('tool-output-container')).toBeTruthy();
    expect(screen.getByLabelText('src/first.ts, 2 lines added, 1 line removed')).toBeTruthy();
  },
);

it('shows unavailable counts and truncation without hiding filenames or reporting false zeroes', () => {
  const [invocation] = buildToolInvocations([
    {
      id: 'large-patch',
      role: 'tool',
      toolCallId: 'large-patch',
      content: '',
      createdAt: '2026-09-01T00:00:00.000Z',
      toolMeta: {
        toolCallId: 'large-patch',
        kind: 'edit',
        status: 'completed',
        title: 'apply_patch',
        truncated: true,
        locations: [{ path: 'missing.ts' }],
        content: [{ ...firstDiff, path: 'large.ts', newText: 'x'.repeat(16 * 1024) }],
      },
    },
  ]);
  const screen = render(
    <AppThemeProvider theme={theme}>
      <ToolInvocationRow invocation={requireTestValue(invocation, 'large patch')} />
    </AppThemeProvider>,
  );
  expect(screen.getByLabelText('large.ts, Counts unavailable')).toBeTruthy();
  expect(screen.getByLabelText('missing.ts, Counts unavailable')).toBeTruthy();
  expect(screen.queryByText('+0')).toBeNull();
  expect(screen.queryByText('-0')).toBeNull();
  expect(screen.getByText('Some changes were truncated by the bridge.')).toBeTruthy();
  expect(screen.queryByTestId('tool-output-container')).toBeNull();
});
