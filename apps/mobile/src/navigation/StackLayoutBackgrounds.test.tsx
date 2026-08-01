let mockStackProps: Record<string, unknown> | null = null;

jest.mock('expo-router', () => {
  const Stack = Object.assign(
    (props: Record<string, unknown>) => {
      mockStackProps = props;
      return null;
    },
    { Screen: () => null },
  );
  return { Stack };
});

import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type { ReactElement } from 'react';

import ChatLayout from '../app/profiles/[profileId]/(drawer)/chats/[chatId]/_layout';
import SettingsLayout from '../app/profiles/[profileId]/(drawer)/settings/_layout';
import { AppThemeProvider, createAppTheme } from '../theme';

interface StackScreenOptions {
  contentStyle: { backgroundColor: string };
  headerShown: boolean;
}

function renderLayout(layout: ReactElement, mode: 'light' | 'dark'): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <AppThemeProvider theme={createAppTheme(mode)}>{layout}</AppThemeProvider>,
    );
  });
  if (!tree) throw new Error('Expected stack layout');
  return tree;
}

function readScreenOptions(): StackScreenOptions {
  if (!mockStackProps) throw new Error('Expected Stack props');
  return mockStackProps.screenOptions as StackScreenOptions;
}

describe('full-screen transition backgrounds', () => {
  beforeEach(() => {
    mockStackProps = null;
  });

  it.each([
    ['chat', <ChatLayout />],
    ['settings', <SettingsLayout />],
  ])('keeps the %s stack scene dark behind rounded transition corners', (_name, layout) => {
    const tree = renderLayout(layout, 'dark');

    expect(readScreenOptions()).toMatchObject({
      headerShown: false,
      contentStyle: { backgroundColor: '#000000' },
    });

    act(() => tree.unmount());
  });

  it('uses the light app surface instead of unthemed white', () => {
    const tree = renderLayout(<ChatLayout />, 'light');

    expect(readScreenOptions().contentStyle.backgroundColor).toBe('#DDE7F0');

    act(() => tree.unmount());
  });
});
