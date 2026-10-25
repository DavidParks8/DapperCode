import { Provider, createStore } from 'jotai';
import { Dimensions } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { queryRoot } from '@shared/testing/foldableLayout';
import { CircularToolbarButton } from '@shared/ui/CircularToolbarButton';
import { drawerCommandsAtom } from '@shell/state/drawer/atoms';
import { windowTraitsAtom } from '@shell/state/layout/atoms';
import { ChatSceneToolbar, resolveInlineHeaderButtons } from './chatToolbar';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

const theme = createAppTheme('dark');

function renderToolbar(context: Record<string, unknown>): ReactTestRenderer {
  act(() => {
    Dimensions.set({
      window: { width: 466, height: 678, scale: 3, fontScale: 1 },
      screen: { width: 466, height: 678, scale: 3, fontScale: 1 },
    });
  });
  const store = createStore();
  // The closed iPhone Duo lays bars out on the trailing edge, below its status column.
  store.set(windowTraitsAtom, {
    horizontalSizeClass: 'compact',
    verticalSizeClass: 'regular',
    verticalBarEdge: 'trailing',
    divisions: [],
    occlusions: [{ x: 382, y: 0, width: 84, height: 174 }],
    statusBar: null,
  });
  store.set(drawerCommandsAtom, {
    closeDrawer: jest.fn(),
    toggleNavigation: jest.fn(),
    navigationLabel: 'Open navigation drawer',
  });
  let tree!: ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 466, height: 678 },
          insets: { top: 0, left: 0, right: 84, bottom: 20 },
        }}
      >
        <Provider store={store}>
          <AppThemeProvider theme={theme}>
            <ChatSceneToolbar context={context as never} />
          </AppThemeProvider>
        </Provider>
      </SafeAreaProvider>,
    );
  });
  return tree;
}

function labels(tree: ReactTestRenderer): string[] {
  return queryRoot(tree)
    .findAll((node) => node.type === CircularToolbarButton)
    .map((button) => button.props['accessibilityLabel'] as string);
}

describe('chat toolbar', () => {
  afterEach(() => {
    act(() => {
      Dimensions.set({
        window: { width: 750, height: 1334, scale: 2, fontScale: 1 },
        screen: { width: 750, height: 1334, scale: 2, fontScale: 1 },
      });
    });
  });

  it('puts navigation first, then the chat actions, in the vertical bar', () => {
    const openTitleEditor = jest.fn();
    const handleOpenGit = jest.fn();
    const tree = renderToolbar({
      onOpenDrawer: jest.fn(),
      selectedChat: { id: 'chat' },
      openTitleEditor,
      handleOpenGit,
    });

    expect(labels(tree)).toEqual(['Open navigation drawer', 'Edit session title', 'Open Git']);
    const [, rename, git] = queryRoot(tree).findAll((node) => node.type === CircularToolbarButton);
    act(() => (rename?.props['onPress'] as () => void)());
    act(() => (git?.props['onPress'] as () => void)());
    expect(openTitleEditor).toHaveBeenCalledTimes(1);
    expect(handleOpenGit).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });

  it('offers only navigation before a chat exists', () => {
    const tree = renderToolbar({
      onOpenDrawer: jest.fn(),
      selectedChat: null,
      openTitleEditor: jest.fn(),
      handleOpenGit: jest.fn(),
    });

    expect(labels(tree)).toEqual(['Open navigation drawer']);
    act(() => tree.unmount());
  });

  it('leaves the header buttons inline only while bars are horizontal', () => {
    const actions = {
      onOpenDrawer: jest.fn(),
      hasChat: true,
      openTitleEditor: jest.fn(),
      handleOpenGit: jest.fn(),
    };

    expect(resolveInlineHeaderButtons(false, actions)).toEqual({});
    expect(resolveInlineHeaderButtons(true, actions)).toEqual({
      onOpenDrawer: actions.onOpenDrawer,
      onRenameTitle: actions.openTitleEditor,
      rightIconName: 'git-branch-outline',
      onRightActionPress: actions.handleOpenGit,
    });
    expect(resolveInlineHeaderButtons(true, { ...actions, hasChat: false })).toEqual({
      onOpenDrawer: actions.onOpenDrawer,
    });
  });
});
