import { fireEvent, render } from '@testing-library/react-native';
import { Provider } from 'jotai';

import type { ChatMessage } from '@bridge/types/types';
import { requireTestValue } from '@shared/testing/requireTestValue';
import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { ToolInvocationRow } from './ToolInvocation';
import { buildToolInvocations } from './toolInvocationModel';

jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

const theme = createAppTheme('dark');
const output = JSON.stringify([
  { content: 'Inspect the response', status: 'completed', priority: 'high' },
  { content: 'Render the todo list', status: 'in_progress' },
  { content: 'Check the mobile layout', status: 'pending' },
]);

function element(
  content = output,
  status: 'completed' | 'failed' = 'completed',
  structuredContent?: unknown[],
) {
  const messages: ChatMessage[] = [
    {
      id: 'result',
      role: 'tool',
      toolCallId: 'todos',
      createdAt: '2026-09-05T00:00:00Z',
      content,
      toolMeta: {
        toolCallId: 'todos',
        kind: 'other',
        title: 'todowrite',
        status,
        content: structuredContent,
      },
    },
  ];
  return (
    <Provider>
      <AppThemeProvider theme={theme}>
        <ToolInvocationRow
          invocation={requireTestValue(buildToolInvocations(messages)[0], 'todo invocation')}
        />
      </AppThemeProvider>
    </Provider>
  );
}

it('expands JSON tool output into ordered, read-only todos and collapses it again', () => {
  const screen = render(element());
  expect(screen.queryByTestId('tool-todo-list')).toBeNull();
  fireEvent.press(screen.getByTestId('tool-title-toggle'));
  expect(
    screen.getAllByTestId('tool-todo-item').map((row) => row.props['accessibilityLabel']),
  ).toEqual([
    'Inspect the response. Completed. high priority',
    'Render the todo list. In progress',
    'Check the mobile layout. Pending',
  ]);
  expect(screen.getAllByTestId('tool-todo-item').every((row) => !row.props['onPress'])).toBe(true);
  expect(screen.queryByTestId('selectable-output-text')).toBeNull();
  expect(screen.getByTestId('tool-timing')).toBeTruthy();
  expect(screen.getByTestId('tool-row').props['accessibilityState']).toMatchObject({
    expanded: true,
  });

  fireEvent.press(screen.getByTestId('tool-title-toggle'));
  expect(screen.queryByTestId('tool-todo-list')).toBeNull();
  expect(screen.getByTestId('tool-row').props['accessibilityState']).toMatchObject({
    expanded: false,
  });
});

it('renders an empty list explicitly and updates it while expanded', () => {
  const screen = render(element());
  fireEvent.press(screen.getByTestId('tool-title-toggle'));
  screen.rerender(element('[]'));
  expect(screen.getByText('No todos.')).toBeTruthy();
  expect(screen.queryByTestId('tool-todo-item')).toBeNull();
  expect(screen.queryByTestId('selectable-output-text')).toBeNull();
});

it('renders one list when reconciled history repeats the title and JSON response', () => {
  const screen = render(
    element(`${output}\ntodowrite\n${output}`, 'completed', [
      { type: 'content', content: { type: 'text', text: output } },
    ]),
  );
  fireEvent.press(screen.getByTestId('tool-title-toggle'));
  expect(screen.getAllByTestId('tool-todo-item')).toHaveLength(3);
  expect(screen.getByLabelText('Render the todo list. In progress')).toBeTruthy();
  expect(screen.queryByTestId('selectable-output-text')).toBeNull();
});

it.each([
  ['Unable to update todos', 'completed'],
  [output, 'failed'],
] as const)('preserves raw output for errors or unrecognized content', (content, status) => {
  const screen = render(element(content, status));
  fireEvent.press(screen.getByTestId('tool-title-toggle'));
  expect(screen.queryByTestId('tool-todo-list')).toBeNull();
  expect(screen.getByLabelText(`Tool output: ${content}`)).toBeTruthy();
});
