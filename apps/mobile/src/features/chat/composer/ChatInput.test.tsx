import { requireTestValue } from '@shared/testing/requireTestValue';
import {
  ActivityIndicator,
  Platform,
  StyleSheet,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '@shared/theme';
import {
  getRenderedGlassViewProps,
  setMockGlassEffectAPIAvailable,
  setMockLiquidGlassAvailable,
} from '@shared/testing/glassEffectMock';
import { ChatInput } from './ChatInput';

jest.mock('@expo/vector-icons', () => ({ Ionicons: ({ name }: { name: string }) => name }));

jest.mock('expo-haptics', () => ({
  __esModule: true,
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  selectionAsync: jest.fn().mockResolvedValue(undefined),
  impactAsync: jest.fn().mockResolvedValue(undefined),
  notificationAsync: jest.fn().mockResolvedValue(undefined),
}));

import * as Haptics from 'expo-haptics';

const mockHaptics = Haptics as unknown as { impactAsync: jest.Mock };

type Queryable = ReactTestInstance & {
  children: unknown[];
  parent: Queryable | null;
  props: Record<string, unknown> & {
    onChangeText: jest.Mock;
    onFocus: jest.Mock;
    onLayout: jest.Mock;
    onPress: jest.Mock;
    onTextLayout: jest.Mock;
    style: TextInputProps['style'];
  };
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
  findAllByType(type: unknown): Queryable[];
};

const theme = createAppTheme('dark');

function byLabel(root: Queryable, label: string) {
  const node = root.findAll((candidate) => candidate.props['accessibilityLabel'] === label)[0];
  if (!node) {
    throw new Error(`Missing ${label}`);
  }
  return node;
}

function composerBarRadius(root: Queryable): number {
  const composerBar = root.findAllByType(View).find((candidate) => {
    const style = StyleSheet.flatten(candidate.props.style) as {
      backgroundColor?: string;
      borderColor?: string;
    };
    return (
      style.backgroundColor === theme.colors.bgInput &&
      style.borderColor === theme.colors.borderHighlight
    );
  });
  if (!composerBar) {
    throw new Error('Missing composer bar');
  }
  const style = StyleSheet.flatten(composerBar.props.style) as { borderRadius?: number };
  return Number(style.borderRadius);
}

function wrap(child: React.ReactElement): React.ReactElement {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}
    >
      <AppThemeProvider theme={theme}>{child}</AppThemeProvider>
    </SafeAreaProvider>
  );
}

describe('ChatInput behavior', () => {
  const base = {
    onChangeText: jest.fn(),
    onFocus: jest.fn(),
    onSubmit: jest.fn(),
    onStop: jest.fn(),
    onAttachPress: jest.fn(),
    onRemoveAttachment: jest.fn(),
  };

  afterEach(() => jest.clearAllMocks());

  it('renders attachment, send, stop, loading, and disabled action states', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        wrap(
          <ChatInput
            {...base}
            value="Send this"
            isLoading={false}
            onAttachPress={base.onAttachPress}
            attachments={[{ id: 'a1', label: 'error.log' }]}
          />,
        ),
      );
    });

    const rendered = tree as ReactTestRenderer;
    const root = rendered.root as Queryable;
    act(() => byLabel(root, 'Message').props.onChangeText('changed'));
    act(() => byLabel(root, 'Message').props.onFocus());
    act(() => byLabel(root, 'Add attachment').props.onPress());
    act(() => byLabel(root, 'error.log, remove attachment').props.onPress());
    act(() => byLabel(root, 'Send message').props.onPress());
    expect(base.onChangeText).toHaveBeenCalledWith('changed');
    expect(base.onSubmit).toHaveBeenCalled();
    expect(base.onRemoveAttachment).toHaveBeenCalledWith('a1');
    expect(mockHaptics.impactAsync).toHaveBeenCalledWith('light');

    act(() =>
      rendered.update(
        wrap(
          <ChatInput
            {...base}
            value=""
            isLoading
            showStopButton
            onAttachPress={base.onAttachPress}
          />,
        ),
      ),
    );
    act(() => byLabel(root, 'Stop agent').props.onPress());
    expect(base.onStop).toHaveBeenCalled();
    expect(mockHaptics.impactAsync).toHaveBeenCalledWith('heavy');
    expect(byLabel(root, 'Agent is responding').props['disabled']).toBe(true);
    act(() =>
      rendered.update(
        wrap(
          <ChatInput
            {...base}
            value=""
            isLoading
            isStopping
            showStopButton
            onAttachPress={base.onAttachPress}
            attachDisabled
          />,
        ),
      ),
    );
    expect(byLabel(root, 'Stopping agent').props['disabled']).toBe(true);
    expect(byLabel(root, 'Add attachment').props['disabled']).toBe(true);
    act(() =>
      rendered.update(
        wrap(<ChatInput {...base} value="" isLoading onAttachPress={base.onAttachPress} />),
      ),
    );
    expect(byLabel(root, 'Agent is responding').props['disabled']).toBe(true);
    act(() => rendered.unmount());
  });

  it('embeds Add in the input glass while keeping Send as a separate action', () => {
    const originalPlatformOs = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    setMockLiquidGlassAvailable(true);
    setMockGlassEffectAPIAvailable(true);
    let tree: ReactTestRenderer | undefined;

    act(() => {
      tree = renderer.create(
        wrap(
          <ChatInput
            {...base}
            value="Send this"
            isLoading={false}
            onAttachPress={base.onAttachPress}
          />,
        ),
      );
    });

    const glassProps = getRenderedGlassViewProps();
    const inputSurface = glassProps.find(
      (entry) => entry.testID === 'composer-input-glass-surface',
    );
    const submitSurface = glassProps.find(
      (entry) => entry.testID === 'composer-submit-glass-surface',
    );
    expect(inputSurface?.glassEffectStyle).toBe(theme.glass.capsule.glassEffectStyle);
    expect(inputSurface?.tintColor).toBe(theme.glass.capsule.tintColor);
    expect(submitSurface?.glassEffectStyle).toBe(theme.glass.prominent.glassEffectStyle);
    expect(submitSurface?.tintColor).toBe(theme.glass.prominent.tintColor);
    const root = (tree as ReactTestRenderer).root as Queryable;
    const addButton = byLabel(root, 'Add attachment');
    const sendButton = byLabel(root, 'Send message');
    const inputGlass = root.findAll(
      (node) => node.props['testID'] === 'composer-input-glass-surface',
    )[0];
    expect(
      requireTestValue(inputGlass, 'composer input glass').findAll(
        (node) => node.props['accessibilityLabel'] === 'Add attachment',
      ),
    ).not.toHaveLength(0);
    expect(
      sendButton.findAll((node) => node.props['testID'] === 'composer-submit-glass-surface'),
    ).not.toHaveLength(0);
    expect(
      requireTestValue(inputGlass, 'composer input glass').findAll(
        (node) => node.props['accessibilityLabel'] === 'Send message',
      ),
    ).toHaveLength(0);
    expect(addButton.props['hitSlop']).toEqual({ top: 6, right: 6, bottom: 6, left: 6 });
    expect(byLabel(root, 'Message')).toBeTruthy();

    act(() => (tree as ReactTestRenderer).unmount());
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOs });
  });

  it('keeps the disabled Send action visible beside an empty composer', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        wrap(<ChatInput {...base} value="" isLoading={false} onAttachPress={base.onAttachPress} />),
      );
    });

    const sendButton = byLabel((tree as ReactTestRenderer).root as Queryable, 'Send message');
    expect(sendButton.props['disabled']).toBe(true);
    expect(
      sendButton.findAll((node) => node.props['testID'] === 'composer-submit-glass-surface'),
    ).not.toHaveLength(0);
    act(() => (tree as ReactTestRenderer).unmount());
  });

  it('reserves enough height for placeholder descenders', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        wrap(
          <ChatInput
            {...base}
            value=""
            isLoading={false}
            placeholder="Message debugging..."
            onAttachPress={base.onAttachPress}
          />,
        ),
      );
    });
    const rendered = tree as ReactTestRenderer;
    const input = byLabel(rendered.root as Queryable, 'Message');
    const inputStyle = StyleSheet.flatten(input.props.style);
    const verticalPadding = Number(inputStyle.paddingVertical ?? 0);

    expect(input.props['placeholder']).toBe('Message debugging...');
    expect(inputStyle.height).toBe(Number(inputStyle.lineHeight) + verticalPadding * 2);
    act(() => rendered.unmount());
  });

  it('measures single and multiline composer height and renders footer reserves', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        wrap(
          <ChatInput
            {...base}
            value="line"
            isLoading={false}
            onAttachPress={base.onAttachPress}
            footer={<></>}
            reserveFooterSpace
          />,
        ),
      );
    });
    const rendered = tree as ReactTestRenderer;
    const root = rendered.root as Queryable;
    expect(composerBarRadius(root)).toBe(theme.radius.full);
    const input = root
      .findAllByType(TextInput)
      .find((node) => node.props['accessibilityLabel'] === 'Message');
    if (!input) {
      throw new Error('Missing message input');
    }
    act(() => input.props.onLayout({ nativeEvent: { layout: { width: 240 } } }));
    const measure = requireTestValue(
      root.findAll((node) => typeof node.props.onTextLayout === 'function')[0],
      'indexed test value',
    );
    act(() => measure.props.onTextLayout({ nativeEvent: { lines: [{}, {}, {}, {}, {}, {}] } }));
    expect(composerBarRadius(root)).toBe(theme.radius.lg);
    expect(
      root.findAllByType(TextInput).find((node) => node.props['accessibilityLabel'] === 'Message')
        ?.props['scrollEnabled'],
    ).toBe(true);
    act(() =>
      rendered.update(
        wrap(
          <ChatInput
            {...base}
            value=""
            isLoading={false}
            onAttachPress={base.onAttachPress}
            reserveFooterSpace
          />,
        ),
      ),
    );
    expect(composerBarRadius(root)).toBe(theme.radius.full);
    act(() => rendered.unmount());
  });

  it('submits once for web Enter and preserves Shift+Enter', () => {
    const originalOs = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        wrap(
          <ChatInput {...base} value="hi" isLoading={false} onAttachPress={base.onAttachPress} />,
        ),
      );
    });
    const rendered = tree as ReactTestRenderer;
    const input = byLabel(rendered.root as Queryable, 'Message');
    const preventDefault = jest.fn();

    const onKeyPress = input.props['onKeyPress'] as (event: {
      nativeEvent: { key: string; shiftKey?: boolean };
      preventDefault: () => void;
    }) => void;
    act(() => onKeyPress({ nativeEvent: { key: 'Enter' }, preventDefault }));
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(base.onSubmit).toHaveBeenCalledTimes(1);

    act(() =>
      onKeyPress({
        nativeEvent: { key: 'Enter', shiftKey: true },
        preventDefault,
      }),
    );
    expect(base.onSubmit).toHaveBeenCalledTimes(1);
    act(() => rendered.unmount());
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOs });
  });

  it('shows only the stop glyph or the spinner, never both, based on isStopping', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        wrap(
          <ChatInput
            {...base}
            value=""
            isLoading
            showStopButton
            onAttachPress={base.onAttachPress}
          />,
        ),
      );
    });
    const rendered = tree as ReactTestRenderer;
    const root = rendered.root as Queryable;

    // Not stopping yet: only the square glyph renders, no spinner underneath it.
    const stopButton = byLabel(root, 'Stop agent');
    expect(stopButton.findAll((node) => node.props['name'] === 'square')).toHaveLength(1);
    expect(stopButton.findAllByType(ActivityIndicator)).toHaveLength(0);

    act(() =>
      rendered.update(
        wrap(
          <ChatInput
            {...base}
            value=""
            isLoading
            isStopping
            showStopButton
            onAttachPress={base.onAttachPress}
          />,
        ),
      ),
    );

    // Stopping: only the spinner renders, the square glyph is gone (regression guard for the
    // overlap bug where both were shown simultaneously).
    const stoppingButton = byLabel(root, 'Stopping agent');
    expect(stoppingButton.findAll((node) => node.props['name'] === 'square')).toHaveLength(0);
    expect(stoppingButton.findAllByType(ActivityIndicator)).toHaveLength(1);
    act(() => rendered.unmount());
  });

  it('renders trailing composer actions at 48 points and keeps Add embedded', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        wrap(
          <ChatInput
            {...base}
            value="hi"
            isLoading={false}
            showStopButton
            onAttachPress={base.onAttachPress}
            attachments={[{ id: 'a1', label: 'error.log' }]}
          />,
        ),
      );
    });
    const rendered = tree as ReactTestRenderer;
    const root = rendered.root as Queryable;

    const removeAttachment = byLabel(root, 'error.log, remove attachment');

    const glassProps = getRenderedGlassViewProps();
    const sendStyle = StyleSheet.flatten(
      glassProps.find((entry) => entry.testID === 'composer-submit-glass-surface')?.style,
    ) as Record<string, unknown>;
    expect(sendStyle['width']).toBe(48);
    expect(sendStyle['height']).toBe(48);
    const stopStyle = StyleSheet.flatten(
      glassProps.find((entry) => entry.testID === 'composer-stop-glass-surface')?.style,
    ) as Record<string, unknown>;
    const submitStyle = StyleSheet.flatten(
      glassProps.find((entry) => entry.testID === 'composer-submit-glass-surface')?.style,
    ) as Record<string, unknown>;
    expect(stopStyle['backgroundColor']).toBe(theme.glass.capsule.fallbackBackgroundColor);
    expect(submitStyle['backgroundColor']).toBe(theme.glass.prominent.fallbackBackgroundColor);
    expect(byLabel(root, 'Add attachment').props['hitSlop']).toEqual({
      top: 6,
      right: 6,
      bottom: 6,
      left: 6,
    });
    expect(removeAttachment.props['hitSlop']).toBeDefined();
    act(() => rendered.unmount());
  });
});
