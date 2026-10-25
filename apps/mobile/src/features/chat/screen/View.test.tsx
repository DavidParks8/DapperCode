import { Provider, createStore } from 'jotai';
import { StyleSheet } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { windowTraitsAtom } from '@shell/state/layout/atoms';

import { MainScreenView } from './View';

const mockSurfaceRenderCounts = {
  header: 0,
  transcript: 0,
  modelAndEffort: 0,
  rename: 0,
  attachments: 0,
  prompts: 0,
};

jest.mock('./HeaderAndWorkflow', () => {
  const mockReact = jest.requireActual('react');
  const { View: NativeView } = jest.requireActual('react-native');

  return {
    MainScreenHeaderAndWorkflow: () => {
      mockSurfaceRenderCounts.header += 1;
      return mockReact.createElement(NativeView, { testID: 'top-chrome-content' });
    },
  };
});
jest.mock('../transcript/TranscriptAndSheets', () => {
  const { useAtomValue: readAtom } = jest.requireActual('jotai');
  const { Text: NativeText } = jest.requireActual('react-native');
  const { topChromeHeightAtom: measuredTopChromeHeightAtom } =
    jest.requireActual('../state/composer');

  return {
    MainScreenTranscriptAndSheets: () => {
      mockSurfaceRenderCounts.transcript += 1;
      const topInset = readAtom(measuredTopChromeHeightAtom);
      return <NativeText testID="transcript-top-inset">{String(topInset)}</NativeText>;
    },
  };
});
jest.mock('./RenameSheet', () => ({
  MainScreenRenameSheet: () => {
    mockSurfaceRenderCounts.rename += 1;
    return null;
  },
}));
jest.mock('../composer/AttachmentModals', () => ({
  MainScreenAttachmentModals: () => {
    mockSurfaceRenderCounts.attachments += 1;
    return null;
  },
}));
jest.mock('../approvals/BridgePrompts', () => ({
  MainScreenApprovalAndBridgePrompts: () => {
    mockSurfaceRenderCounts.prompts += 1;
    return null;
  },
}));
jest.mock('../models/ModelAndEffortSheets', () => ({
  MainScreenModelAndEffortSheets: () => {
    mockSurfaceRenderCounts.modelAndEffort += 1;
    return null;
  },
}));
jest.mock('../styles/useStyles', () => {
  const { createMainScreenShellStyles } = jest.requireActual('../styles/shellStyles');
  const { createAppTheme } = jest.requireActual('@shared/theme');
  const styles = createMainScreenShellStyles(createAppTheme('dark'));
  return { useMainScreenStyles: () => ({ styles }) };
});

function renderScreen(
  initialContext: Record<string, unknown> = {},
  store = createStore(),
): {
  tree: ReactTestRenderer;
  updateContext: (context: Record<string, unknown>) => void;
} {
  let tree: ReactTestRenderer | undefined;
  const render = (context: Record<string, unknown>) => (
    <Provider store={store}>
      <MainScreenView context={context as never} />
    </Provider>
  );
  act(() => {
    tree = renderer.create(render(initialContext));
  });
  if (!tree) {
    throw new Error('Main screen did not render');
  }
  return {
    tree,
    updateContext: (context) => {
      act(() => tree?.update(render(context)));
    },
  };
}

function transcriptTopInset(tree: ReactTestRenderer): string {
  return String(tree.root.findByProps({ testID: 'transcript-top-inset' }).props['children']);
}

function reportTopChromeHeight(topChrome: ReactTestRenderer['root'], height: number): void {
  const onLayout = topChrome.props['onLayout'];
  if (typeof onLayout !== 'function') {
    throw new Error('Top chrome does not report layout');
  }
  onLayout({ nativeEvent: { layout: { height } } });
}

describe('MainScreenView', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockSurfaceRenderCounts) as Array<
      keyof typeof mockSurfaceRenderCounts
    >) {
      mockSurfaceRenderCounts[key] = 0;
    }
  });

  it('docks the chrome just above the composer, and only there, on a device folded like a laptop', () => {
    const store = createStore();
    const { tree, updateContext } = renderScreen({ composerReservedInset: 102 }, store);
    const chromeStyle = () =>
      StyleSheet.flatten(
        tree.root.findByProps({ testID: 'main-screen-top-chrome' }).props['style'] as never,
      ) as Record<string, unknown>;

    expect(chromeStyle()).toMatchObject({ position: 'absolute', top: 0 });
    expect(chromeStyle()['bottom']).toBeUndefined();

    act(() => {
      store.set(windowTraitsAtom, {
        horizontalSizeClass: 'regular',
        verticalSizeClass: 'regular',
        divisions: [{ x: 0, y: 455.5, width: 669, height: 40 }],
      });
    });
    // Pinning both edges stretched the chrome over the whole transcript.
    expect(chromeStyle()).toMatchObject({ position: 'absolute', bottom: 102 });
    // Native ignores `top: undefined`, so the key itself must be absent.
    expect('top' in chromeStyle()).toBe(false);

    updateContext({ composerReservedInset: 140 });
    expect(chromeStyle()).toMatchObject({ bottom: 140 });
    act(() => tree.unmount());
  });

  it('publishes top-chrome layout changes to the transcript sibling', () => {
    const { tree } = renderScreen();
    const topChrome = tree.root.findByProps({ testID: 'main-screen-top-chrome' });

    expect(transcriptTopInset(tree)).toBe('0');

    act(() => {
      reportTopChromeHeight(topChrome, 72);
    });
    expect(transcriptTopInset(tree)).toBe('72');

    act(() => {
      reportTopChromeHeight(topChrome, 124);
    });
    expect(transcriptTopInset(tree)).toBe('124');

    act(() => tree.unmount());
  });

  it('rerenders only the surface whose consumed context changed', () => {
    const tokenTotals = { totalTokens: 12 };
    const initialContext = {
      displayedActivity: null,
      headerTitle: 'Original title',
      selectedChat: { id: 'thread-1', messages: [], tokenTotals },
      selectedThreadRuntimeSnapshot: { tokenTotals },
    };
    const { tree, updateContext } = renderScreen(initialContext);
    const initialRenderCounts = { ...mockSurfaceRenderCounts };

    const streamingActivity = { title: 'Streaming response' };
    const streamingChat = {
      ...initialContext.selectedChat,
      messages: [{ id: 'message-1', text: 'Streaming response' }],
    };
    const streamingSnapshot = { tokenTotals };
    updateContext({
      ...initialContext,
      displayedActivity: streamingActivity,
      selectedChat: streamingChat,
      selectedThreadRuntimeSnapshot: streamingSnapshot,
    });
    expect(mockSurfaceRenderCounts).toEqual({
      ...initialRenderCounts,
      transcript: initialRenderCounts.transcript + 1,
    });

    updateContext({
      ...initialContext,
      displayedActivity: streamingActivity,
      headerTitle: 'Renamed title',
      selectedChat: streamingChat,
      selectedThreadRuntimeSnapshot: streamingSnapshot,
    });
    expect(mockSurfaceRenderCounts).toEqual({
      ...initialRenderCounts,
      header: initialRenderCounts.header + 1,
      transcript: initialRenderCounts.transcript + 1,
    });

    const changedTokenTotals = { totalTokens: 24 };
    updateContext({
      ...initialContext,
      displayedActivity: streamingActivity,
      headerTitle: 'Renamed title',
      selectedChat: {
        ...streamingChat,
        tokenTotals: changedTokenTotals,
      },
      selectedThreadRuntimeSnapshot: { tokenTotals: changedTokenTotals },
    });
    expect(mockSurfaceRenderCounts).toEqual({
      ...initialRenderCounts,
      header: initialRenderCounts.header + 2,
      transcript: initialRenderCounts.transcript + 2,
    });

    act(() => tree.unmount());
  });
});
