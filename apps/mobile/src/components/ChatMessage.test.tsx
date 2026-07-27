import type { ReactElement, ReactNode } from 'react';
import * as Clipboard from 'expo-clipboard';
import {
  ActivityIndicator,
  Image,
  Linking,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import type { ChatMessage as ApiChatMessage } from '../api/types';
import {
  COMPACTION_ACTIVITY_TYPE,
  createActivityMessage,
  SUBAGENT_ACTIVITY_TYPE,
} from '../api/messages';
import { createAppTheme, AppThemeProvider } from '../theme';
import { ChatMessage, ToolInvocationRow } from './ChatMessage';
import { resetHuggedTextWidthCache } from './chatMessageUserBubble';
import { buildToolInvocations, type ToolInvocation } from './toolInvocationModel';

type QueryableTestInstance = ReactTestInstance & {
  type: unknown;
  props: Record<string, unknown> & {
    onContentSizeChange: jest.Mock;
    onLayout: jest.Mock;
    onLoad: jest.Mock;
    onRequestClose: jest.Mock;
    onScroll: jest.Mock;
    source?: { headers?: Record<string, string>; uri?: string };
  };
  children: unknown[];
  findAll(predicate: (node: QueryableTestInstance) => boolean): QueryableTestInstance[];
  findAllByProps(props: Record<string, unknown>): QueryableTestInstance[];
  findAllByType(type: unknown): QueryableTestInstance[];
};

type QueryableRenderer = ReactTestRenderer & { root: QueryableTestInstance; toJSON(): unknown };
type LegacyTestMessage = Omit<ApiChatMessage, 'role' | 'content'> & {
  id: string;
  role: ApiChatMessage['role'] | 'system';
  content: string;
  createdAt: string;
  systemKind?: 'tool' | 'reasoning' | 'subAgent' | 'compaction';
  subAgentMeta?: Parameters<typeof createActivityMessage>[2]['subAgent'];
};

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn().mockResolvedValue(true) }));

jest.mock('react-native-reanimated', () => {
  const reactNative = jest.requireActual('react-native');

  return {
    __esModule: true,
    default: {
      Image: reactNative.Image,
    },
    clamp: (value: number, min: number, max: number) => Math.min(Math.max(value, min), max),
    useAnimatedStyle: (updater: () => unknown) => updater(),
    useSharedValue: <T,>(value: T) => ({ value }),
    withTiming: <T,>(value: T) => value,
  };
});

jest.mock('react-native-gesture-handler', () => {
  const React = jest.requireActual('react');
  const reactNative = jest.requireActual('react-native');

  const createGesture = () => {
    const chain = {
      enabled: () => chain,
      onStart: () => chain,
      onUpdate: () => chain,
      onEnd: () => chain,
      minDistance: () => chain,
      numberOfTaps: () => chain,
      maxDuration: () => chain,
    };
    return chain;
  };

  return {
    GestureDetector: ({ children }: { children: ReactNode }) => (
      <reactNative.View>{children}</reactNative.View>
    ),
    Gesture: {
      Pinch: () => createGesture(),
      Pan: () => createGesture(),
      Tap: () => createGesture(),
      Simultaneous: (...gestures: unknown[]) => gestures[0],
      Exclusive: (...gestures: unknown[]) => gestures[0],
    },
  };
});

describe('ChatMessage image viewer', () => {
  const theme = createAppTheme('dark');

  it('opens transcript images in a full-screen modal when tapped', () => {
    const message: ApiChatMessage = {
      id: 'msg_image',
      role: 'assistant',
      content: '[image: data:image/png;base64,abc123]',
      createdAt: '2026-04-17T00:00:00.000Z',
    };

    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 59, right: 0, bottom: 34, left: 0 },
          }}
        >
          <AppThemeProvider theme={theme}>
            <ChatMessage message={message} />
          </AppThemeProvider>
        </SafeAreaProvider>,
      );
    });
    const tree = expectValue(rendered) as QueryableRenderer;

    const modal = tree.root.findByType(Modal);
    expect(modal.props.visible).toBe(false);

    const previewImage = tree.root.findAllByType(Image)[0];
    act(() => {
      previewImage.props.onLoad({ nativeEvent: { source: { width: 800, height: 400 } } });
      previewImage.props.onLoad({ nativeEvent: { source: { width: 800, height: 400 } } });
      previewImage.props.onLoad({ nativeEvent: { source: { width: 0, height: 400 } } });
      previewImage.props.onLoad({ nativeEvent: { source: {} } });
    });

    const trigger = tree.root.findByProps({
      testID: 'chat-image-fullscreen-trigger',
    });
    act(() => {
      readOnPress(trigger.props)();
    });

    expect(tree.root.findByType(Modal).props.visible).toBe(true);

    act(() => {
      (tree.root.findByType(Modal).props.onRequestClose as () => void)();
    });
    expect(tree.root.findByType(Modal).props.visible).toBe(false);

    act(() => {
      readOnPress(trigger.props)();
    });
    act(() => {
      readOnPress(tree.root.findByProps({ testID: 'chat-image-fullscreen-close' }).props)();
    });
    expect(tree.root.findByType(Modal).props.visible).toBe(false);

    act(() => {
      readOnPress(trigger.props)();
    });

    const backdrop = tree.root.findByProps({
      testID: 'chat-image-fullscreen-backdrop',
    });
    act(() => {
      readOnPress(backdrop.props)();
    });

    expect(tree.root.findByType(Modal).props.visible).toBe(false);
  });
});

describe('ChatMessage markdown formatting', () => {
  const theme = createAppTheme('dark');

  it('keeps assistant headings compact in chat', () => {
    const message: ApiChatMessage = {
      id: 'msg_heading',
      role: 'assistant',
      content: '# Role\n\nThe bridge connects the app to local runtimes.',
      createdAt: '2026-04-17T00:00:00.000Z',
    };

    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(
        <AppThemeProvider theme={theme}>
          <ChatMessage message={message} />
        </AppThemeProvider>,
      );
    });
    const tree = expectValue(rendered);
    const root = tree.root as QueryableTestInstance;

    const heading = root
      .findAll((node) => node.type === Text)
      .find((node) => flattenRenderedText(node.props.children).includes('Role'));

    if (!heading) {
      throw new Error('Expected heading text to render');
    }
    const headingStyle = StyleSheet.flatten(heading.props.style as never) as { fontSize?: number };
    expect(headingStyle.fontSize).toBeLessThanOrEqual(18);
  });

  it('repaints when only the ordered parts change', () => {
    const base: ApiChatMessage = {
      id: 'msg_parts',
      role: 'assistant',
      content: 'This needs a wider search.',
      parts: [{ type: 'text', text: 'This needs a' }],
      createdAt: '2026-04-17T00:00:00.000Z',
    };

    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(
        <AppThemeProvider theme={theme}>
          <ChatMessage message={base} />
        </AppThemeProvider>,
      );
    });
    const tree = expectValue(rendered);
    const readText = () =>
      (tree.root as QueryableTestInstance)
        .findAll((node) => node.type === Text)
        .map((node) => flattenRenderedText(node.props.children))
        .join(' ');

    expect(readText()).toContain('This needs a');

    act(() => {
      tree.update(
        <AppThemeProvider theme={theme}>
          <ChatMessage
            message={{ ...base, parts: [{ type: 'text', text: 'This needs a wider search.' }] }}
          />
        </AppThemeProvider>,
      );
    });

    expect(readText()).toContain('This needs a wider search.');
  });

  it('renders markdown tables in a horizontal scroll area', () => {
    const message: ApiChatMessage = {
      id: 'msg_table',
      role: 'assistant',
      content:
        '| Listener | Routes | Purpose |\n| --- | --- | --- |\n| Main | `GET /rpc`, `GET /health` | Primary API for the app |',
      createdAt: '2026-04-17T00:00:00.000Z',
    };

    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(
        <AppThemeProvider theme={theme}>
          <ChatMessage message={message} />
        </AppThemeProvider>,
      );
    });
    const tree = expectValue(rendered);
    const root = tree.root as QueryableTestInstance;

    expect(
      root
        .findAll((node) => node.type === ScrollView)
        .some((node) => node.props.horizontal === true),
    ).toBe(true);
  });

  it('routes web and local-preview links while rendering file links as labels', () => {
    const openUrl = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    const onOpenLocalPreview = jest.fn();
    const tree = renderMessage(
      {
        id: 'markdown-links',
        role: 'assistant',
        content:
          '[Docs](https://example.test/docs) [Preview](http://localhost:4173) [Source](file:///tmp/source.ts:12)',
        createdAt: '2026-04-17T00:00:00.000Z',
      },
      { onOpenLocalPreview },
    );
    const root = tree.root as QueryableTestInstance;

    act(() => {
      readOnPress(findTextPressable(root, 'Docs').props)();
      readOnPress(findTextPressable(root, 'Preview').props)();
    });

    expect(openUrl).toHaveBeenCalledWith('https://example.test/docs');
    expect(onOpenLocalPreview).toHaveBeenCalledWith('http://localhost:4173');
    expect(hasRenderedText(root, 'source.ts:12')).toBe(true);
    expect(
      findTextNodes(root, 'source.ts:12').every((node) => node.props.onPress === undefined),
    ).toBe(true);
    act(() => tree.unmount());
    openUrl.mockRestore();
  });

  it('renders markdown images only when their source is usable', () => {
    const tree = renderMessage({
      id: 'markdown-images',
      role: 'assistant',
      content: '![Remote](https://example.test/remote.png) ![Missing]()',
      createdAt: '2026-04-17T00:00:00.000Z',
    });
    const images = tree.root.findAllByType(Image);
    expect(
      images.some((node) => node.props.source?.uri === 'https://example.test/remote.png'),
    ).toBe(true);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Remote' }).length).toBeGreaterThan(0);
    act(() => tree.unmount());
  });
});

describe('ChatMessage copy action', () => {
  beforeEach(() => {
    jest.mocked(Clipboard.setStringAsync).mockClear();
    jest.mocked(Clipboard.setStringAsync).mockResolvedValue(true);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('copies the assistant response and shows a transient copied state', () => {
    jest.useFakeTimers();
    const tree = renderMessage({
      id: 'assistant-copy',
      role: 'assistant',
      content: 'The bridge is running on port 4319.',
      createdAt: '2026-04-17T00:00:00.000Z',
    });
    const root = tree.root as QueryableTestInstance;
    const button = findCopyButton(root, 'assistant-copy');

    expect(button.props.accessibilityLabel).toBe('Copy message');

    act(() => readOnPress(button.props)());

    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('The bridge is running on port 4319.');
    expect(findCopyButton(root, 'assistant-copy').props.accessibilityLabel).toBe('Copied message');

    act(() => {
      jest.advanceTimersByTime(2000);
    });

    expect(findCopyButton(root, 'assistant-copy').props.accessibilityLabel).toBe('Copy message');

    act(() => tree.unmount());
  });

  it('joins ordered text parts and omits attachments from the copied text', () => {
    const tree = renderMessage({
      id: 'assistant-parts',
      role: 'assistant',
      content: 'ignored',
      parts: [
        { type: 'text', text: 'First paragraph.' },
        { type: 'image', uri: 'https://example.test/shot.png' },
        { type: 'text', text: 'Second paragraph.' },
      ],
      createdAt: '2026-04-17T00:00:00.000Z',
    });
    const root = tree.root as QueryableTestInstance;

    act(() => readOnPress(findCopyButton(root, 'assistant-parts').props)());

    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('First paragraph.\n\nSecond paragraph.');
    act(() => tree.unmount());
  });

  it('hides the copy action while an assistant response is still empty', () => {
    const tree = renderMessage({
      id: 'assistant-streaming',
      role: 'assistant',
      content: '',
      createdAt: '2026-04-17T00:00:00.000Z',
    });

    expect(findCopyButtons(tree.root as QueryableTestInstance, 'assistant-streaming').length).toBe(
      0,
    );
    act(() => tree.unmount());
  });

  it('does not offer a copy action on user messages', () => {
    const tree = renderMessage({
      id: 'user-message',
      role: 'user',
      content: 'Restart the bridge',
      createdAt: '2026-04-17T00:00:00.000Z',
    });

    expect(findCopyButtons(tree.root as QueryableTestInstance, 'user-message').length).toBe(0);
    act(() => tree.unmount());
  });
});

describe('ChatMessage text selection', () => {
  const response = '# Heading\n\nThe bridge is running on port 4319.\n\n```sh\nnpm run bridge\n```';

  it('leaves the markdown block text unselectable so the long press is not swallowed', () => {
    // React Native's `Text selectable` only attaches a long press that opens a copy-the-whole-
    // block edit menu; leaving it on means the user can never reach real selection. Only a Text
    // with no Text ancestor becomes a real paragraph view, so those are the ones that matter.
    const tree = renderMessage({
      id: 'assistant-blocks',
      role: 'assistant',
      content: response,
      createdAt: '2026-04-17T00:00:00.000Z',
    });
    const root = tree.root as QueryableTestInstance;

    const blockTexts = root
      .findAll((node) => node.type === Text)
      .filter((node) => !hasTextAncestor(node));

    expect(blockTexts.length).toBeGreaterThan(0);
    expect(blockTexts.filter((node) => node.props.selectable === true)).toHaveLength(0);
    act(() => tree.unmount());
  });

  it('opens a selectable text sheet on long press and closes it again', () => {
    const tree = renderMessage({
      id: 'assistant-longpress',
      role: 'assistant',
      content: response,
      createdAt: '2026-04-17T00:00:00.000Z',
    });
    const root = tree.root as QueryableTestInstance;

    expect(
      root.findAllByProps({ testID: 'chat-message-select-text-assistant-longpress' }),
    ).toHaveLength(0);

    const target = root.findByProps({ testID: 'chat-message-select-target-assistant-longpress' });
    act(() => readOnLongPress(target.props)());

    // A read-only multiline TextInput is the only React Native surface that supports partial
    // selection, so the sheet has to hand the response to one.
    const input = root.findByType(TextInput);
    expect(input.props.value).toBe(response);
    expect(input.props.editable).toBe(false);
    expect(input.props.multiline).toBe(true);

    act(() =>
      readOnPress(
        root.findByProps({ testID: 'chat-message-select-text-assistant-longpress-close' }).props,
      )(),
    );

    expect(root.findAllByType(TextInput)).toHaveLength(0);
    act(() => tree.unmount());
  });

  it('opens the same sheet from the select-text action button', () => {
    const tree = renderMessage({
      id: 'assistant-action',
      role: 'assistant',
      content: response,
      createdAt: '2026-04-17T00:00:00.000Z',
    });
    const root = tree.root as QueryableTestInstance;

    const button = root.findByProps({ testID: 'chat-message-copy-assistant-action-select' });
    expect(button.props.accessibilityLabel).toBe('Select message text');

    act(() => readOnPress(button.props)());

    expect(root.findByType(TextInput).props.value).toBe(response);
    act(() => tree.unmount());
  });

  it('does not arm the long press while a response is still empty', () => {
    const tree = renderMessage({
      id: 'assistant-empty',
      role: 'assistant',
      content: '',
      createdAt: '2026-04-17T00:00:00.000Z',
    });
    const root = tree.root as QueryableTestInstance;

    expect(
      root.findByProps({ testID: 'chat-message-select-target-assistant-empty' }).props.onLongPress,
    ).toBeUndefined();
    act(() => tree.unmount());
  });

  it('keeps user bubbles and tool output selectable', () => {
    const userTree = renderMessage({
      id: 'user-selectable',
      role: 'user',
      content: 'Restart the bridge',
      createdAt: '2026-04-17T00:00:00.000Z',
    });
    const userRoot = userTree.root as QueryableTestInstance;

    expect(
      userRoot
        .findAll((node) => node.type === Text)
        .filter((node) => !hasTextAncestor(node))
        .some((node) => node.props.selectable === true),
    ).toBe(true);
    act(() => userTree.unmount());
  });
});

describe('ChatMessage command rows', () => {
  const theme = createAppTheme('dark');

  it('renders long command titles in horizontal scroll viewports without ellipsis', () => {
    const messages: LegacyTestMessage[] = [
      {
        id: 'tool_command',
        role: 'system',
        systemKind: 'tool',
        content: '• Ran npm test -- --runInBand src/components/ChatMessage.test.tsx',
        createdAt: '2026-04-17T00:00:00.000Z',
      },
    ];

    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(
        <AppThemeProvider theme={theme}>
          <ToolInvocationRow invocation={onlyInvocation(messages)} />
        </AppThemeProvider>,
      );
    });
    const tree = expectValue(rendered);
    const viewport = tree.root.findByProps({ testID: 'tool-command-scroll' });
    const horizontalScroll = viewport.findByType(ScrollView);
    const commandText = horizontalScroll.findByType(Text);

    expect(horizontalScroll.props.horizontal).toBe(true);
    expect(commandText.props.numberOfLines).toBeUndefined();
    expect(flattenRenderedText(commandText.props.children)).toContain('ChatMessage.test.tsx');
  });
});

describe('ChatMessage transcript width', () => {
  const theme = createAppTheme('dark');

  const flattenRootStyle = (element: ReactElement) => {
    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(<AppThemeProvider theme={theme}>{element}</AppThemeProvider>);
    });
    const tree = expectValue(rendered) as QueryableRenderer;
    const root = tree.toJSON() as { props: { style?: unknown } };
    return (StyleSheet.flatten(root.props.style) ?? {}) as {
      maxWidth?: number | string;
      width?: number | string;
    };
  };

  it.each([
    {
      name: 'assistant message',
      element: (
        <ChatMessage
          message={{
            id: 'assistant-width',
            role: 'assistant',
            content: 'A fairly long assistant answer that should reach the transcript edge.',
            createdAt: '2026-04-17T00:00:00.000Z',
          }}
        />
      ),
    },
    {
      name: 'reasoning card',
      element: (
        <ChatMessage
          message={{
            id: 'reasoning-width',
            role: 'reasoning',
            content: 'Thinking through the change',
            createdAt: '2026-04-17T00:00:00.000Z',
          }}
        />
      ),
    },
    {
      name: 'sub-agent card',
      element: (
        <ChatMessage
          message={createActivityMessage(
            'subagent-width',
            SUBAGENT_ACTIVITY_TYPE,
            { text: 'Delegated to explore agent' },
            '2026-04-17T00:00:00.000Z',
          )}
        />
      ),
    },
    {
      name: 'tool card',
      element: (
        <ToolInvocationRow
          invocation={onlyInvocation([
            {
              id: 'tool-width',
              role: 'system',
              systemKind: 'tool',
              content: '• Ran npm test\n  output line',
              createdAt: '2026-04-17T00:00:00.000Z',
            },
          ])}
        />
      ),
    },
  ])('stretches the $name to the full transcript width', ({ element }) => {
    expect(flattenRootStyle(element).maxWidth).toBe('100%');
  });

  it('keeps user bubbles inset from the opposite edge', () => {
    const style = flattenRootStyle(
      <ChatMessage
        message={{
          id: 'user-width',
          role: 'user',
          content: 'A user message that stays visually distinct from the assistant column.',
          createdAt: '2026-04-17T00:00:00.000Z',
        }}
      />,
    );

    expect(style.maxWidth).toBe('92%');
  });

  it('renders expanded tool output without a right inset', () => {
    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(
        <AppThemeProvider theme={theme}>
          <ToolInvocationRow
            invocation={onlyInvocation([
              {
                id: 'tool-body-width',
                role: 'system',
                systemKind: 'tool',
                content: '• Ran npm test\n  output line',
                createdAt: '2026-04-17T00:00:00.000Z',
              },
            ])}
          />
        </AppThemeProvider>,
      );
    });
    const tree = expectValue(rendered) as QueryableRenderer;

    act(() => {
      readOnPress(tree.root.findByProps({ accessibilityRole: 'button' }).props)();
    });

    const body = tree.root.findByProps({ testID: 'tool-output-body' });
    const bodyStyle = (StyleSheet.flatten(body.props.style as never) ?? {}) as {
      marginRight?: number;
    };

    expect(bodyStyle.marginRight).toBeUndefined();
  });
});

describe('ChatMessage user bubble', () => {
  beforeEach(() => {
    resetHuggedTextWidthCache();
  });

  const findUserText = (root: QueryableTestInstance) => {
    const node = root
      .findAll((candidate) => candidate.type === Text)
      .find((candidate) => flattenRenderedText(candidate.props.children).includes('wrapped'));
    if (!node) throw new Error('Expected the user message text to render');
    return node;
  };

  const readContentStyle = (root: QueryableTestInstance) =>
    (StyleSheet.flatten(root.findByProps({ testID: 'user-bubble-content' }).props.style as never) ??
      {}) as { maxWidth?: number | string };

  const fireTextLayout = (node: QueryableTestInstance, widths: number[]) => {
    const onTextLayout = node.props.onTextLayout as
      ((event: { nativeEvent: { lines: { width: number }[] } }) => void) | undefined;
    if (!onTextLayout) throw new Error('Expected the user text to report its layout');
    act(() => {
      onTextLayout({ nativeEvent: { lines: widths.map((width) => ({ width })) } });
    });
  };

  it('hugs the widest rendered line instead of filling the allowed width', () => {
    const tree = renderMessage({
      id: 'user-hug',
      role: 'user',
      content: 'A message long enough that it gets wrapped across more than one line.',
      createdAt: '2026-04-17T00:00:00.000Z',
    });
    const root = tree.root as QueryableTestInstance;

    expect(readContentStyle(root).maxWidth).toBeUndefined();

    fireTextLayout(findUserText(root), [212.4, 98]);
    expect(readContentStyle(root).maxWidth).toBe(213);

    fireTextLayout(findUserText(root), [212.4, 98]);
    expect(readContentStyle(root).maxWidth).toBe(213);

    act(() => tree.unmount());
  });

  it('ignores empty and shrinking layout reports so the bubble stays stable', () => {
    const tree = renderMessage({
      id: 'user-stable',
      role: 'user',
      content: 'Another wrapped user message for measurement.',
      createdAt: '2026-04-17T00:00:00.000Z',
    });
    const root = tree.root as QueryableTestInstance;

    fireTextLayout(findUserText(root), [180, 60]);
    fireTextLayout(findUserText(root), []);
    fireTextLayout(findUserText(root), [90]);

    expect(readContentStyle(root).maxWidth).toBe(180);
    act(() => tree.unmount());
  });

  it('reuses the measured width when the row remounts while scrolling', () => {
    const message = {
      id: 'user-remount',
      role: 'user' as const,
      content: 'A wrapped user message that gets recycled by the list.',
      createdAt: '2026-04-17T00:00:00.000Z',
    };

    const first = renderMessage(message);
    fireTextLayout(findUserText(first.root as QueryableTestInstance), [164, 70]);
    expect(readContentStyle(first.root as QueryableTestInstance).maxWidth).toBe(164);
    act(() => first.unmount());

    const second = renderMessage(message);
    expect(readContentStyle(second.root as QueryableTestInstance).maxWidth).toBe(164);
    act(() => second.unmount());
  });

  it('leaves bubbles with attachments unconstrained', () => {
    const tree = renderMessage({
      id: 'user-attachment',
      role: 'user',
      content: 'A wrapped caption\n[file: /tmp/a-very-long-attachment-path-report.txt]',
      createdAt: '2026-04-17T00:00:00.000Z',
    });
    const root = tree.root as QueryableTestInstance;

    expect(findUserText(root).props.onTextLayout).toBeUndefined();
    expect(readContentStyle(root).maxWidth).toBeUndefined();
    act(() => tree.unmount());
  });

  it('renders user text in the shared UI font rather than a monospace face', () => {
    const theme = createAppTheme('dark');
    const tree = renderMessage({
      id: 'user-font',
      role: 'user',
      content: 'A wrapped user message.',
      createdAt: '2026-04-17T00:00:00.000Z',
    });
    const root = tree.root as QueryableTestInstance;
    const style = (StyleSheet.flatten(findUserText(root).props.style as never) ?? {}) as {
      fontFamily?: string;
      fontSize?: number;
    };

    expect(style.fontFamily).toBeUndefined();
    expect(style.fontFamily).not.toBe(theme.fonts.monoRegular);
    expect(style.fontSize).toBe(theme.typography.body.fontSize);
    act(() => tree.unmount());
  });
});

describe('ChatMessage role and part matrices', () => {
  it.each([
    {
      name: 'user mentions and file markers',
      message: {
        id: 'user-file',
        role: 'user' as const,
        content: 'Review @report.txt\n[file: /tmp/report.txt]',
        createdAt: '2026-04-17T00:00:00.000Z',
      },
      expected: ['Review', '@report.txt', 'report.txt'],
    },
    {
      name: 'assistant empty cursor',
      message: {
        id: 'assistant-empty',
        role: 'assistant' as const,
        content: '',
        createdAt: '2026-04-17T00:00:00.000Z',
      },
      expected: ['▍'],
    },
    {
      name: 'compaction default',
      message: {
        id: 'compact',
        role: 'system' as const,
        systemKind: 'compaction' as const,
        content: 'Compacted conversation context',
        createdAt: '2026-04-17T00:00:00.000Z',
      },
      expected: ['Conversation compacted'],
    },
    {
      name: 'compaction custom',
      message: {
        id: 'compact-custom',
        role: 'system' as const,
        systemKind: 'compaction' as const,
        content: '- Reduced old turns',
        createdAt: '2026-04-17T00:00:00.000Z',
      },
      expected: ['Reduced old turns'],
    },
  ])('renders $name', ({ message, expected }) => {
    const tree = renderMessage(message);
    for (const text of expected)
      expect(hasRenderedText(tree.root as QueryableTestInstance, text)).toBe(true);
    act(() => tree.unmount());
  });

  it('renders all structured content part families and local image auth', () => {
    const message: ApiChatMessage = {
      id: 'parts',
      role: 'assistant',
      content: '',
      createdAt: '2026-04-17T00:00:00.000Z',
      parts: [
        { type: 'text', text: 'Structured text' },
        { type: 'image', url: 'https://example.test/image.png' },
        { type: 'image', uri: '/tmp/local.png' },
        { type: 'image' },
        { type: 'audio', mimeType: 'audio/wav' },
        { type: 'audio' },
        { type: 'resourceLink', uri: 'file:///tmp/report.json', name: 'Report' },
        { type: 'resourceLink', uri: 'https://example.test/resource' },
        { type: 'resource', resource: { uri: 'file:///tmp/data.txt', text: 'Embedded text' } },
        { type: 'resource', resource: { text: 'Inline resource' } },
      ],
    };
    const tree = renderMessage(message, { bridgeUrl: 'http://bridge', bridgeToken: 'secret' });
    const root = tree.root as QueryableTestInstance;
    for (const text of [
      'Structured text',
      '[image]',
      '[audio: audio/wav]',
      '[audio]',
      'Report',
      'Embedded text',
      'Inline resource',
    ]) {
      expect(hasRenderedText(root, text)).toBe(true);
    }
    const images = root.findAll((node) => node.type === Image);
    expect(images.some((node) => node.props.source?.uri === 'https://example.test/image.png')).toBe(
      true,
    );
    expect(
      images.some((node) => String(node.props.source?.uri).includes('/local-image?path=')),
    ).toBe(true);
    expect(
      images.some((node) => node.props.source?.headers?.Authorization === 'Bearer secret'),
    ).toBe(true);
    act(() => tree.unmount());
  });

  it.each([
    ['remote marker', '[image: https://example.test/marker.png]', 'marker.png'],
    ['local marker', '[local image: /tmp/local-marker.png]', 'local-marker.png'],
    ['windows file', '[file: C:\\work\\report.txt:9]', 'report.txt:9'],
    ['encoded file', '[file: file:///tmp/my%20report.txt#L7]', 'my report.txt:7'],
    ['root file fallback', '[file: /]', '/'],
  ])('renders the %s content marker', (_name, content, expected) => {
    const tree = renderMessage(
      { id: content, role: 'assistant', content, createdAt: '2026-04-17T00:00:00.000Z' },
      { bridgeUrl: 'https://bridge' },
    );
    expect(
      hasRenderedText(tree.root as QueryableTestInstance, expected) ||
        tree.root.findAllByProps({ accessibilityLabel: expected }).length > 0,
    ).toBe(true);
    act(() => tree.unmount());
  });

  it('renders structured data images and omits empty text and resource bodies', () => {
    const tree = renderMessage({
      id: 'part-fallbacks',
      role: 'assistant',
      content: 'ignored',
      createdAt: '2026-04-17T00:00:00.000Z',
      parts: [
        { type: 'text', text: '' },
        { type: 'image', data: 'abc123', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 42 as never, text: '' } },
      ],
    });
    expect(
      tree.root
        .findAllByType(Image)
        .some((node) => node.props.source?.uri === 'data:image/png;base64,abc123'),
    ).toBe(true);
    expect(hasRenderedText(tree.root as QueryableTestInstance, '[embedded resource]')).toBe(true);
    act(() => tree.unmount());
  });
});

describe('ChatMessage system timeline matrices', () => {
  it.each([
    {
      kind: 'reasoning' as const,
      content: '• Plan\n  └ First thought\n  └ Second thought',
      label: 'Plan',
      hint: 'Tap to show thinking',
    },
    {
      kind: 'tool' as const,
      content: '• Called tool `search`\n  └ query=coverage\n  └ 3 results',
      label: 'Called tool `search`',
      hint: 'Tap to show 2 lines',
    },
  ])('expands $kind timeline details', ({ kind, content, label, hint }) => {
    const tree = renderMessage({
      id: `timeline-${kind}`,
      role: 'system',
      systemKind: kind,
      content,
      createdAt: '2026-04-17T00:00:00.000Z',
    });
    const root = tree.root as QueryableTestInstance;
    if (kind === 'reasoning') simulateTextLayout(root, 5);
    expect(root.findAll((node) => node.props.accessibilityLabel === label).length).toBeGreaterThan(
      0,
    );
    expect(hasRenderedText(root, hint)).toBe(true);
    const control = root.findAll(
      (node) => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function',
    )[0];
    act(() => readOnPress(control.props)());
    expect(hasRenderedText(root, kind === 'reasoning' ? 'First thought' : 'query=coverage')).toBe(
      true,
    );
    act(() => tree.unmount());
  });

  it('hides the reasoning toggle when the preview already shows every line', () => {
    const tree = renderMessage({
      id: 'reasoning-short',
      role: 'system',
      systemKind: 'reasoning',
      content: '• Plan\n  └ Short thought',
      createdAt: '2026-04-17T00:00:00.000Z',
    });
    const root = tree.root as QueryableTestInstance;
    simulateTextLayout(root, 2);
    expect(hasRenderedText(root, 'Short thought')).toBe(true);
    expect(hasRenderedText(root, 'Tap to show thinking')).toBe(false);
    expect(
      root.findAll((node) => node.props.accessibilityLabel === 'Plan')[0].props.accessibilityState,
    ).toEqual({ disabled: true });
    act(() => tree.unmount());
  });

  it('renders subagent details and opens the receiver transcript', () => {
    const onOpenSubAgentThread = jest.fn();
    const latest =
      `Latest: ${'Inspecting a deliberately long repository path '.repeat(4)}`.trimEnd();
    const tree = renderMessage(
      {
        id: 'subagent',
        role: 'system',
        systemKind: 'subAgent',
        content: `• Spawned agent\n  └ Analyze tests\n  ${latest}`,
        subAgentMeta: { receiverThreadIds: [' child-thread '], agentStatus: 'running' },
        createdAt: '2026-04-17T00:00:00.000Z',
      },
      { onOpenSubAgentThread },
    );
    const root = tree.root as QueryableTestInstance;
    expect(hasRenderedText(root, 'Analyze tests')).toBe(true);
    expect(hasRenderedText(root, 'Open agent chat')).toBe(true);
    const latestViewport = root.findAllByProps({ testID: 'subagent-latest-scroll' })[0];
    const latestScroll = latestViewport?.findAllByType(ScrollView)[0];
    const latestText = latestScroll
      ?.findAllByType(Text)
      .find((node) => flattenRenderedText(node.props.children).trimStart() === latest);
    expect(latestScroll?.props).toMatchObject({
      horizontal: true,
      nestedScrollEnabled: true,
      showsHorizontalScrollIndicator: false,
      contentContainerStyle: expect.objectContaining({ flexDirection: 'row' }),
    });
    expect(latestText?.props).toMatchObject({
      numberOfLines: 1,
    });
    const control = root.findAll(
      (node) =>
        node.props.accessibilityLabel === 'Open agent chat' &&
        typeof node.props.onPress === 'function',
    )[0];
    expect(control.findAllByProps({ testID: 'subagent-latest-scroll' })).toHaveLength(0);
    act(() => {
      latestScroll?.props.onLayout({ nativeEvent: { layout: { width: 120 } } });
      latestScroll?.props.onContentSizeChange(480);
      latestScroll?.props.onScroll({ nativeEvent: { contentOffset: { x: 40 } } });
    });
    expect(
      latestViewport?.findAll((node) => node.props.pointerEvents === 'none').length,
    ).toBeGreaterThanOrEqual(2);
    act(() => readOnPress(control.props)());
    expect(onOpenSubAgentThread).toHaveBeenCalledWith('child-thread');
    act(() => tree.unmount());
  });

  it('keeps the agent chat affordance visible when the transcript is unavailable', () => {
    const onOpenSubAgentThread = jest.fn();
    const tree = renderMessage(
      {
        id: 'subagent-internal',
        role: 'system',
        systemKind: 'subAgent',
        content: '• Spawned sub-agent\n  Result: Workspace title',
        createdAt: '',
        subAgentMeta: {
          receiverThreadIds: ['child-internal'],
          agentStatus: 'completed',
          navigable: false,
        },
      },
      { onOpenSubAgentThread },
    );
    const root = tree.root as QueryableTestInstance;
    const button = root.findAll((node) => node.props.accessibilityLabel === 'Open agent chat')[0];
    expect(button?.props.accessibilityState).toMatchObject({ disabled: true });
    expect(hasRenderedText(root, 'Workspace title')).toBe(true);
    expect(hasRenderedText(root, 'Open agent chat')).toBe(true);
    act(() => tree.unmount());
  });

  it('opens a known running agent even when stale metadata says it is not navigable', () => {
    const onOpenSubAgentThread = jest.fn();
    const tree = renderMessage(
      {
        id: 'subagent-running',
        role: 'system',
        systemKind: 'subAgent',
        content: '• Sub-agent working\n  Latest: Inspecting files',
        createdAt: '2026-04-17T00:00:00.000Z',
        subAgentMeta: {
          receiverThreadIds: ['child-running'],
          agentStatus: 'running',
          navigable: false,
        },
      },
      { onOpenSubAgentThread },
    );
    const root = tree.root as QueryableTestInstance;
    const control = root.findAll(
      (node) =>
        node.props.accessibilityLabel === 'Open agent chat' &&
        typeof node.props.onPress === 'function',
    )[0];
    expect(control?.props.accessibilityState).toMatchObject({ disabled: false });
    act(() => readOnPress(control.props)());
    expect(onOpenSubAgentThread).toHaveBeenCalledWith('child-running');
    act(() => tree.unmount());
  });

  it('animates a running subagent card and stops after completion', () => {
    const running = createActivityMessage(
      'subagent-live',
      SUBAGENT_ACTIVITY_TYPE,
      {
        text: '• Sub-agent working\n  Latest: Responding: The full streamed response',
        subAgent: { toolCallId: 'task-live', agentStatus: 'running', receiverThreadIds: [] },
      },
      '2026-04-17T00:00:00.000Z',
    );
    const tree = renderMessage(running);
    expect(tree.root.findAllByType(ActivityIndicator)).toHaveLength(1);
    const root = tree.root as QueryableTestInstance;
    expect(hasRenderedText(root, 'Open agent chat')).toBe(true);
    expect(hasRenderedText(root, 'Latest: Responding...')).toBe(true);
    expect(hasRenderedText(root, 'The full streamed response')).toBe(false);

    const completed = createActivityMessage(
      'subagent-live',
      SUBAGENT_ACTIVITY_TYPE,
      {
        text: '• Sub-agent completed\n  Latest: Returned result',
        subAgent: { toolCallId: 'task-live', agentStatus: 'completed', receiverThreadIds: [] },
      },
      '2026-04-17T00:00:01.000Z',
    );
    const completedTree = renderMessage(completed);
    expect(completedTree.root.findAllByType(ActivityIndicator)).toHaveLength(0);
    act(() => tree.unmount());
    act(() => completedTree.unmount());
  });

  it('expands a failed invocation row and shows its output', () => {
    const invocation: ToolInvocation = {
      id: 'build',
      kind: 'execute',
      status: 'failed',
      title: 'npm run build',
      monospaceTitle: true,
      isError: true,
      locations: [{ path: 'src/app.ts', line: 12 }],
      diffs: [],
      terminals: [{ terminalId: 'term-1', output: 'compile error\nexit 1' }],
      textLines: [],
      images: [],
      truncated: true,
      empty: false,
    };
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <AppThemeProvider theme={createAppTheme('dark')}>
          <ToolInvocationRow invocation={invocation} />
        </AppThemeProvider>,
      );
    });
    const rendered = expectValue(tree);
    const root = rendered.root as QueryableTestInstance;
    expect(hasRenderedText(root, 'compile error')).toBe(false);
    const control = root.findAll(
      (node) =>
        typeof node.props.onPress === 'function' &&
        node.props.accessibilityLabel === 'npm run build',
    )[0];
    if (!control) throw new Error('Missing invocation row');
    act(() => readOnPress(control.props)());
    expect(hasRenderedText(root, 'compile error')).toBe(true);
    expect(hasRenderedText(root, 'src/app.ts:12')).toBe(true);
    expect(hasRenderedText(root, 'Output truncated by the bridge.')).toBe(true);
    act(() => readOnPress(control.props)());
    expect(hasRenderedText(root, 'compile error')).toBe(false);
    act(() => rendered.unmount());
  });

  it('renders an edit invocation as a coloured diff', () => {
    const invocation: ToolInvocation = {
      id: 'edit',
      kind: 'edit',
      status: 'completed',
      title: 'Edit src/app.ts',
      monospaceTitle: false,
      isError: false,
      locations: [],
      diffs: [{ path: 'src/app.ts', oldText: 'const a = 1;', newText: 'const a = 2;' }],
      terminals: [],
      textLines: [],
      images: [],
      truncated: false,
      empty: false,
    };
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <AppThemeProvider theme={createAppTheme('dark')}>
          <ToolInvocationRow invocation={invocation} />
        </AppThemeProvider>,
      );
    });
    const rendered = expectValue(tree);
    const root = rendered.root as QueryableTestInstance;
    const control = root.findAll(
      (node) =>
        typeof node.props.onPress === 'function' &&
        node.props.accessibilityLabel === 'Edit src/app.ts',
    )[0];
    act(() => readOnPress(control.props)());
    expect(hasRenderedText(root, '- const a = 1;')).toBe(true);
    expect(hasRenderedText(root, '+ const a = 2;')).toBe(true);
    expect(hasRenderedText(root, 'src/app.ts')).toBe(true);
    act(() => rendered.unmount());
  });

  it('shows a spinner while a tool is still running', () => {
    const invocation: ToolInvocation = {
      id: 'running',
      kind: 'read',
      status: 'in_progress',
      title: 'Read package.json',
      monospaceTitle: false,
      isError: false,
      locations: [],
      diffs: [],
      terminals: [],
      textLines: [],
      images: [],
      truncated: false,
      empty: true,
    };
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <AppThemeProvider theme={createAppTheme('dark')}>
          <ToolInvocationRow invocation={invocation} />
        </AppThemeProvider>,
      );
    });
    const rendered = expectValue(tree);
    const root = rendered.root as QueryableTestInstance;
    expect(root.findAllByType(ActivityIndicator).length).toBeGreaterThan(0);
    const control = root.findAll(
      (node) =>
        typeof node.props.onPress === 'function' &&
        node.props.accessibilityLabel === 'Read package.json',
    )[0];
    expect(control.props.accessibilityState).toEqual({ disabled: true });
    act(() => rendered.unmount());
  });

  it('renders the computer-use action family with metadata and image output', () => {
    const actions = [
      ['getAppState', 'Captured screen'],
      ['click', 'Clicked'],
      ['scroll', 'Scrolled'],
      ['typeText', 'Typed text'],
      ['pressKey', 'Pressed key'],
      ['drag', 'Dragged'],
      ['setValue', 'Set value'],
      ['listApps', 'Listed apps'],
      ['customAction', 'Custom Action'],
    ];
    const content = actions
      .map(
        ([action], index) =>
          `• Called tool \`computerUse/${action}\`\n  └ ${index === 0 ? '[image: https://example.test/screen.png]' : index === 1 ? 'Window: "Editor", App: com.microsoft.VSCode.' : 'App=com.apple.Safari (active)'}`,
      )
      .join('\n');
    const tree = renderMessage({
      id: 'computer-use',
      role: 'system',
      systemKind: 'tool',
      content,
      createdAt: '2026-04-17T00:00:00.000Z',
    });
    const root = tree.root as QueryableTestInstance;
    expect(hasRenderedText(root, '9 actions')).toBe(true);
    for (const [, label] of actions) expect(hasRenderedText(root, label)).toBe(true);
    expect(hasRenderedText(root, 'VSCode')).toBe(true);
    expect(
      root
        .findAllByType(Image)
        .some((node) => node.props.source?.uri === 'https://example.test/screen.png'),
    ).toBe(true);
    act(() => tree.unmount());
  });

  it('scrolls long tool output and updates command fades', () => {
    const details = Array.from({ length: 26 }, (_, index) => `line ${String(index + 1)}`);
    const messages: LegacyTestMessage[] = [
      {
        id: 'long',
        role: 'system',
        systemKind: 'tool',
        content: `• Ran exhaustive command\n${details.map((line) => `  └ ${line}`).join('\n')}`,
        createdAt: '2026-04-17T00:00:00.000Z',
      },
    ];
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <AppThemeProvider theme={createAppTheme('dark')}>
          <ToolInvocationRow
            invocation={onlyInvocation(messages)}
            bridgeUrl="https://bridge"
            bridgeToken="token"
          />
        </AppThemeProvider>,
      );
    });
    const rendered = expectValue(tree);
    const root = rendered.root as QueryableTestInstance;
    const commandScroll = root
      .findByProps({ testID: 'tool-command-scroll' })
      .findByType(ScrollView) as QueryableTestInstance;
    act(() => {
      commandScroll.props.onLayout({ nativeEvent: { layout: { width: 100 } } });
      commandScroll.props.onContentSizeChange(300);
      commandScroll.props.onScroll({ nativeEvent: { contentOffset: { x: 50 } } });
    });
    expect(root.findAll((node) => Array.isArray(node.props.colors)).length).toBeGreaterThanOrEqual(
      1,
    );
    act(() => {
      commandScroll.props.onScroll({ nativeEvent: { contentOffset: { x: 200 } } });
    });
    const control = root.findAll(
      (node) =>
        typeof node.props.onPress === 'function' &&
        node.props.accessibilityLabel === 'Ran exhaustive command',
    )[0];
    act(() => readOnPress(control.props)());
    expect(hasRenderedText(root, 'line 26')).toBe(true);
    expect(
      root
        .findAllByType(ScrollView)
        .some((node) => node.props.showsVerticalScrollIndicator === true),
    ).toBe(true);
    act(() => rendered.unmount());
  });

  it('renders disabled reasoning, subagent, and empty tool edge cases', () => {
    const reasoning = renderMessage({
      id: 'reasoning-empty',
      role: 'system',
      systemKind: 'reasoning',
      content: '• Waiting',
      createdAt: '2026-04-17T00:00:00.000Z',
    });
    expect(
      (reasoning.root as QueryableTestInstance).findAll(
        (node) => node.props.accessibilityLabel === 'Waiting',
      )[0].props.accessibilityState,
    ).toEqual({ disabled: true });
    act(() => reasoning.unmount());

    const subagent = renderMessage({
      id: 'subagent-error',
      role: 'system',
      systemKind: 'subAgent',
      content: '• Agent failed',
      subAgentMeta: { receiverThreadIds: [''] },
      createdAt: '2026-04-17T00:00:00.000Z',
    });
    expect(
      (subagent.root as QueryableTestInstance).findAll(
        (node) => node.props.accessibilityLabel === 'Open agent chat',
      )[0].props.accessibilityState,
    ).toEqual({ disabled: true });
    act(() => subagent.unmount());

    expect(buildToolInvocations([])).toEqual([]);
  });

  it.each([
    ['Agent waiting', 'pause-circle-outline'],
    ['Agent closed', 'checkmark-circle-outline'],
    ['Spawned helper', 'sparkles-outline'],
    ['Agent active', 'git-branch-outline'],
  ])('renders the %s subagent visual', (title, icon) => {
    const tree = renderMessage({
      id: title,
      role: 'system',
      systemKind: 'subAgent',
      content: `• ${title}`,
      createdAt: '2026-04-17T00:00:00.000Z',
    });
    expect(
      (tree.root as QueryableTestInstance).findAll((node) => node.props.name === icon).length,
    ).toBeGreaterThan(0);
    act(() => tree.unmount());
  });

  it.each([
    ['', 'Conversation compacted'],
    ['• Compacted conversation context', 'Conversation compacted'],
    ['- Custom compaction', 'Custom compaction'],
  ])('formats compaction content %p', (content, expected) => {
    const tree = renderMessage({
      id: `compact-${content}`,
      role: 'system',
      systemKind: 'compaction',
      content,
      createdAt: '2026-04-17T00:00:00.000Z',
    });
    expect(hasRenderedText(tree.root as QueryableTestInstance, expected)).toBe(true);
    act(() => tree.unmount());
  });

  it('falls back to plain system markdown for malformed timeline content', () => {
    const tree = renderMessage({
      id: 'malformed',
      role: 'system',
      systemKind: 'tool',
      content: 'before bullet\n• Tool call',
      createdAt: '2026-04-17T00:00:00.000Z',
    });
    expect(hasRenderedText(tree.root as QueryableTestInstance, 'before bullet')).toBe(true);
    act(() => tree.unmount());
  });
});

function renderMessage(
  message: ApiChatMessage | LegacyTestMessage,
  props: {
    bridgeUrl?: string;
    bridgeToken?: string;
    onOpenLocalPreview?: (url: string) => void;
    onOpenSubAgentThread?: (id: string) => void;
  } = {},
): QueryableRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 59, right: 0, bottom: 34, left: 0 },
        }}
      >
        <AppThemeProvider theme={createAppTheme('dark')}>
          <ChatMessage message={toOfficialMessage(message)} {...props} />
        </AppThemeProvider>
      </SafeAreaProvider>,
    );
  });
  return expectValue(tree) as QueryableRenderer;
}

function onlyInvocation(messages: LegacyTestMessage[]): ToolInvocation {
  const invocations = buildToolInvocations(messages.map(toOfficialMessage));
  const invocation = invocations[0];
  if (!invocation) throw new Error('Expected a tool invocation');
  return invocation;
}

function toOfficialMessage(message: ApiChatMessage | LegacyTestMessage): ApiChatMessage {
  const legacy = message as LegacyTestMessage;
  if (legacy.systemKind === 'reasoning') {
    return {
      id: legacy.id,
      role: 'reasoning',
      content: legacy.content,
      createdAt: legacy.createdAt,
    };
  }
  if (legacy.systemKind === 'tool') {
    return {
      id: legacy.id,
      role: 'tool',
      toolCallId: legacy.id,
      content: legacy.content,
      createdAt: legacy.createdAt,
    };
  }
  if (legacy.systemKind === 'subAgent') {
    return createActivityMessage(
      legacy.id,
      SUBAGENT_ACTIVITY_TYPE,
      {
        text: legacy.content,
        ...(legacy.subAgentMeta ? { subAgent: legacy.subAgentMeta } : {}),
      },
      legacy.createdAt,
    );
  }
  if (legacy.systemKind === 'compaction') {
    return createActivityMessage(
      legacy.id,
      COMPACTION_ACTIVITY_TYPE,
      { text: legacy.content },
      legacy.createdAt,
    );
  }
  return message as ApiChatMessage;
}

function hasRenderedText(root: QueryableTestInstance, text: string): boolean {
  return root.findAll((node) => flattenRenderedText(node.children).includes(text)).length > 0;
}

function expectValue<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('Expected value to be set');
  }
  return value;
}

function readOnPress(props: Record<string, unknown>): () => void {
  if (typeof props.onPress !== 'function') {
    throw new Error('Expected press handler');
  }
  return props.onPress as () => void;
}

function readOnLongPress(props: Record<string, unknown>): () => void {
  if (typeof props.onLongPress !== 'function') {
    throw new Error('Expected long press handler');
  }
  return props.onLongPress as () => void;
}

/**
 * React Native only turns the outermost `Text` of a tree into a real paragraph view, so a nested
 * `Text` never carries the selection gesture no matter what its `selectable` prop says.
 */
function hasTextAncestor(node: QueryableTestInstance): boolean {
  let parent = (node as unknown as { parent: QueryableTestInstance | null }).parent;
  while (parent) {
    if (parent.type === Text) return true;
    parent = (parent as unknown as { parent: QueryableTestInstance | null }).parent;
  }
  return false;
}

function findCopyButtons(root: QueryableTestInstance, messageId: string): QueryableTestInstance[] {
  return root.findAll(
    (node) =>
      node.props.testID === `chat-message-copy-${messageId}` &&
      typeof node.props.onPress === 'function',
  );
}

function findCopyButton(root: QueryableTestInstance, messageId: string): QueryableTestInstance {
  const button = findCopyButtons(root, messageId)[0];
  if (!button) {
    throw new Error(`Expected a copy button for ${messageId}`);
  }
  return button;
}

function findTextNodes(root: QueryableTestInstance, text: string): QueryableTestInstance[] {
  return root.findAll((node) => node.type === Text && flattenTestTreeText(node) === text);
}

function simulateTextLayout(root: QueryableTestInstance, lineCount: number): void {
  const measured = root.findAll(
    (node) => node.type === Text && typeof node.props.onTextLayout === 'function',
  );
  act(() => {
    for (const node of measured) {
      (node.props.onTextLayout as (event: { nativeEvent: { lines: unknown[] } }) => void)({
        nativeEvent: { lines: Array.from({ length: lineCount }, () => ({})) },
      });
    }
  });
}

function findTextPressable(root: QueryableTestInstance, text: string): QueryableTestInstance {
  const node = findTextNodes(root, text).find(
    (candidate) => typeof candidate.props.onPress === 'function',
  );
  if (!node) throw new Error(`Expected pressable text "${text}"`);
  return node;
}

function flattenTestTreeText(node: QueryableTestInstance): string {
  return node.children
    .map((child) =>
      typeof child === 'string' || typeof child === 'number'
        ? String(child)
        : flattenTestTreeText(child as QueryableTestInstance),
    )
    .join('');
}

function flattenRenderedText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(flattenRenderedText).join('');
  }
  return '';
}
