import {
  ActivityIndicator,
  Platform,
  StyleSheet,
  TextInput,
  type TextInputProps,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '../theme';
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
  const node = root.findAll((candidate) => candidate.props.accessibilityLabel === label)[0];
  if (!node) throw new Error(`Missing ${label}`);
  return node;
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
    expect(byLabel(root, 'Stopping agent').props.disabled).toBe(true);
    expect(byLabel(root, 'Add attachment').props.disabled).toBe(true);
    act(() =>
      rendered.update(
        wrap(<ChatInput {...base} value="" isLoading onAttachPress={base.onAttachPress} />),
      ),
    );
    expect(byLabel(root, 'Agent is responding').props.disabled).toBe(true);
    act(() => rendered.unmount());
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

    expect(input.props.placeholder).toBe('Message debugging...');
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
    const input = root
      .findAllByType(TextInput)
      .find((node) => node.props.accessibilityLabel === 'Message');
    if (!input) throw new Error('Missing message input');
    act(() => input.props.onLayout({ nativeEvent: { layout: { width: 240 } } }));
    const measure = root.findAll((node) => typeof node.props.onTextLayout === 'function')[0];
    act(() => measure.props.onTextLayout({ nativeEvent: { lines: [{}, {}, {}, {}, {}, {}] } }));
    expect(
      root.findAllByType(TextInput).find((node) => node.props.accessibilityLabel === 'Message')
        ?.props.scrollEnabled,
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

    const onKeyPress = input.props.onKeyPress as (event: {
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
    expect(stopButton.findAll((node) => node.props.name === 'square')).toHaveLength(1);
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
    expect(stoppingButton.findAll((node) => node.props.name === 'square')).toHaveLength(0);
    expect(stoppingButton.findAllByType(ActivityIndicator)).toHaveLength(1);
    act(() => rendered.unmount());
  });

  it('sizes plus, send/stop, and attachment-remove hitSlop to the platform minimum touch target', () => {
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

    const addAttachment = byLabel(root, 'Add attachment');
    const sendMessage = byLabel(root, 'Send message');
    const removeAttachment = byLabel(root, 'error.log, remove attachment');

    for (const control of [addAttachment, sendMessage, removeAttachment]) {
      const hitSlop = control.props.hitSlop as {
        top: number;
        bottom: number;
        left: number;
        right: number;
      };
      expect(hitSlop.top).toBeGreaterThan(0);
      expect(hitSlop.bottom).toBeGreaterThan(0);
    }
    act(() => rendered.unmount());
  });
});
