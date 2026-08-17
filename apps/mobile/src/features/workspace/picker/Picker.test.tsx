import { requireTestValue } from '@shared/testing/requireTestValue';
import type * as fsNode from 'fs';
import type * as pathNode from 'path';
import { Text, TextInput } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import type { FileSystemEntry } from '@bridge/types/types';
import { feedback } from '@shared/feedback';
import { createAppTheme, AppThemeProvider } from '@shared/theme';
import { WorkspacePicker } from './Picker';

type QueryableTestInstance = ReactTestInstance & {
  type: unknown;
  props: Record<string, unknown> & {
    onChangeText: jest.Mock;
    onLongPress: jest.Mock;
    onPress: jest.Mock;
  };
  children: unknown[];
  findAll(predicate: (node: QueryableTestInstance) => boolean): QueryableTestInstance[];
  findAllByType(type: unknown): QueryableTestInstance[];
};

jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));
jest.mock('@shared/feedback', () => ({
  feedback: {
    selection: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockResolvedValue(undefined),
    success: jest.fn().mockResolvedValue(undefined),
    warning: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
    destructive: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('@expo/vector-icons', () => {
  const React = jest.requireActual('react');
  const { Text } = jest.requireActual('react-native');

  return {
    Ionicons: ({ name }: { name: string }) => React.createElement(Text, null, name),
  };
});

describe('WorkspacePicker', () => {
  const theme = createAppTheme('dark');
  const oldSelectionPath = '/Users/davidparks/Documents/github/serious-projects/dappercode';
  const githubPath = '/Users/davidparks/Documents/github';
  const seriousProjectsPath = '/Users/davidparks/Documents/github/serious-projects';

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('keeps a browsed checkout destination when currentPath refreshes', () => {
    const onBrowsePath = jest.fn();
    const onSelectPath = jest.fn();

    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(
        renderPicker({
          onBrowsePath,
          onSelectPath,
          currentPath: githubPath,
          parentPath: '/Users/davidparks/Documents',
          entries: [directoryEntry('serious-projects', seriousProjectsPath)],
        }),
      );
    });

    const tree = expectValue(rendered);
    act(() => {
      readOnPress(findPressableContainingText(tree.root, 'serious-projects').props)();
    });

    expect(onBrowsePath).toHaveBeenCalledWith(seriousProjectsPath);

    act(() => {
      tree.update(
        renderPicker({
          onBrowsePath,
          onSelectPath,
          currentPath: seriousProjectsPath,
          parentPath: githubPath,
          entries: [directoryEntry('dappercode', oldSelectionPath)],
        }),
      );
    });

    act(() => {
      readOnPress(findPressableWithExactText(tree.root, 'Use serious-projects').props)();
    });

    expect(onSelectPath).toHaveBeenCalledWith(seriousProjectsPath);
    expect(onSelectPath).not.toHaveBeenCalledWith(oldSelectionPath);

    act(() => {
      tree.unmount();
    });
  });

  it('exposes modal, selected, and disabled workspace controls', () => {
    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(
        renderPicker({
          onBrowsePath: jest.fn(),
          onSelectPath: jest.fn(),
          currentPath: githubPath,
          parentPath: githubPath,
          entries: [directoryEntry('serious-projects', seriousProjectsPath)],
        }),
      );
    });

    const root = expectValue(rendered).root as QueryableTestInstance;
    expect(
      root.findAll((node) => node.props['accessibilityLabel'] === 'Cancel').length,
    ).toBeGreaterThan(0);
    expect(
      root.findAll(
        (node) =>
          node.props['accessibilityLabel'] === 'Use default workspace' &&
          typeof node.props['accessibilityState'] === 'object',
      )[0]?.props['accessibilityState'],
    ).toEqual({ disabled: false, selected: false });
    act(() => {
      expectValue(rendered).unmount();
    });
  });

  it('browses, searches, selects, pins, uses default, and closes populated workspaces', () => {
    const onBrowsePath = jest.fn();
    const onSelectPath = jest.fn();
    const onToggleFavorite = jest.fn();
    const onClose = jest.fn();
    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(
        renderPickerMatrix({ onBrowsePath, onSelectPath, onToggleFavorite, onClose }),
      );
    });
    const tree = expectValue(rendered);
    const root = tree.root as QueryableTestInstance;
    act(() => readOnPress(findPressableContainingText(root, 'notes').props)());
    expect(onBrowsePath).toHaveBeenCalledWith('/Users/davidparks/Code/notes');
    pressLabel(root, 'Code, current folder');
    pressLabel(root, 'Go to davidparks');
    expect(onBrowsePath).toHaveBeenCalledWith('/Users/davidparks');
    const search = root
      .findAllByType(TextInput)
      .find((node) => node.props['accessibilityLabel'] === 'Search folders');
    if (!search) {
      throw new Error('Missing search');
    }
    act(() => search.props.onChangeText('missing'));
    expect(flattenTreeText(root)).toContain('No folders match this search.');
    act(() => search.props.onChangeText(''));
    act(() => readOnPress(findPressableWithExactText(root, 'Use davidparks').props)());
    expect(onSelectPath).toHaveBeenCalledWith('/Users/davidparks');
    pressLabel(root, 'More actions');
    pressLabel(root, 'Pin davidparks');
    expect(onToggleFavorite).toHaveBeenCalledWith('/Users/davidparks');
    pressLabel(root, 'Use default workspace');
    expect(onSelectPath).toHaveBeenCalledWith(null);
    pressLabel(root, 'Cancel');
    expect(onClose).toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('renders loading, errors, truncation, empty folders, and custom action states', () => {
    const onActionPress = jest.fn();
    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(
        renderPickerMatrix({
          entries: [],
          loadingEntries: true,
          error: 'Bridge unavailable',
          refreshError: "Recent workspaces couldn't be refreshed. You can keep browsing folders.",
          truncationMessage: 'Showing the first 100 folders.',
          actionLabel: 'Clone here',
          onActionPress,
        }),
      );
    });
    const tree = expectValue(rendered);
    const root = tree.root as QueryableTestInstance;
    expect(flattenTreeText(root)).toContain('Bridge unavailable');
    expect(flattenTreeText(root)).toContain(
      "Recent workspaces couldn't be refreshed. You can keep browsing folders.",
    );
    expect(flattenTreeText(root)).toContain('Showing the first 100 folders.');
    expect(
      root.findAll((node) => node.props['accessibilityLabel'] === 'Loading folders...').length,
    ).toBeGreaterThan(0);
    pressLabel(root, 'More actions');
    pressLabel(root, 'Clone here');
    expect(onActionPress).toHaveBeenCalled();
    act(() => tree.update(renderPickerMatrix({ entries: [], loadingEntries: false })));
    expect(flattenTreeText(root)).toContain('No folders found here.');
    act(() => tree.unmount());
  });

  it('resets search and pending selection across visibility and selected-path changes', () => {
    const onSelectPath = jest.fn();
    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(renderPickerMatrix({ onSelectPath }));
    });
    const tree = expectValue(rendered);
    const root = tree.root as QueryableTestInstance;
    const search = requireTestValue(root.findAllByType(TextInput)[0], 'indexed test value');
    act(() => search.props.onChangeText('notes'));
    expect(
      requireTestValue(root.findAllByType(TextInput)[0], 'indexed test value').props['value'],
    ).toBe('notes');

    act(() =>
      tree.update(
        renderPickerMatrix({
          selectedPath: null,
          currentPath: null,
          bridgeRoot: null,
          parentPath: null,
          entries: [],
          onSelectPath,
        }),
      ),
    );
    expect(
      requireTestValue(root.findAllByType(TextInput)[0], 'indexed test value').props['value'],
    ).toBe('notes');
    expect(flattenTreeText(root)).toContain('Default workspace');
    const use = findByLabel(root, 'Use Default workspace');
    expect(use.props['accessibilityState']).toEqual({ disabled: true });
    // Nothing is pending and no custom action was supplied, so the overflow menu is withheld
    // instead of rendering a button whose menu would be empty.
    expect(root.findAll((node) => node.props['accessibilityLabel'] === 'More actions')).toEqual([]);

    act(() =>
      tree.update(
        renderPickerMatrix({ selectedPath: '/Users/davidparks/Code/next', onSelectPath }),
      ),
    );
    expect(flattenTreeText(root)).toContain('next');
    act(() => tree.unmount());
  });

  it('preserves a browsed pending path when the external selection changes', () => {
    const onBrowsePath = jest.fn();
    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(renderPickerMatrix({ onBrowsePath }));
    });
    const tree = expectValue(rendered);
    act(() => readOnPress(findPressableContainingText(tree.root, 'notes').props)());
    act(() =>
      tree.update(
        renderPickerMatrix({ onBrowsePath, selectedPath: '/Users/davidparks/Code/other' }),
      ),
    );
    expect(flattenTreeText(tree.root as QueryableTestInstance)).toContain(
      '/Users/davidparks/Code/notes',
    );
    act(() => tree.unmount());
  });

  it('exposes disabled loading and action controls without invoking callbacks', () => {
    const onBrowsePath = jest.fn();
    const onActionPress = jest.fn();
    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(
        renderPickerMatrix({
          entries: [],
          loadingEntries: true,
          parentPath: '/Users/davidparks',
          actionLabel: 'Clone here',
          actionDisabled: true,
          onActionPress,
          onBrowsePath,
        }),
      );
    });
    const root = expectValue(rendered).root as QueryableTestInstance;
    pressLabel(root, 'More actions');
    const action = findByLabel(root, 'Clone here');
    expect(action.props['accessibilityState']).toEqual({ disabled: true });
    expect(action.props['accessibilityHint']).toBe('Clones a repository into this folder');
    act(() => readOnPress(findByLabel(root, 'Close menu').props)());

    // The current folder is listed in the path menu for orientation, but selecting it is inert.
    pressLabel(root, 'Code, current folder');
    pressLabel(root, 'Code');
    expect(onBrowsePath).not.toHaveBeenCalled();
    expect(onActionPress).not.toHaveBeenCalled();
    act(() => expectValue(rendered).unmount());
  });

  it('offers row context-menu actions and swipe-to-unpin for pinned workspaces', () => {
    const onToggleFavorite = jest.fn();
    const onSelectPath = jest.fn();
    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(renderPickerMatrix({ onToggleFavorite, onSelectPath }));
    });
    const root = expectValue(rendered).root as QueryableTestInstance;

    const notesRow = findByLabel(root, 'Open folder notes');
    expect(notesRow.props['accessibilityHint']).toBe('Touch and hold for more actions');
    act(() => notesRow.props.onLongPress());
    pressLabel(root, 'Pin notes');
    expect(onToggleFavorite).toHaveBeenCalledWith('/Users/davidparks/Code/notes');

    act(() => findByLabel(root, 'Open folder notes').props.onLongPress());
    pressLabel(root, 'Use notes');
    expect(onSelectPath).toHaveBeenCalledWith('/Users/davidparks/Code/notes');

    // Pinned rows are unpinned by swiping instead of a long-press confirmation dialog.
    const pinnedRow = findByLabel(root, 'Open folder Code');
    expect(pinnedRow.props['accessibilityHint']).toBe('Swipe left to unpin this workspace');
    act(() => readOnPress(findByLabel(root, 'Unpin Code').props)());
    expect(onToggleFavorite).toHaveBeenCalledWith('/Users/davidparks/Code');
    act(() => expectValue(rendered).unmount());
  });

  it('filters pinned workspaces and renders recent metadata variants', () => {
    jest.setSystemTime(new Date('2026-04-17T12:00:00.000Z'));
    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(
        renderPickerMatrix({
          favoriteWorkspacePaths: ['/work/one', '/work/missing'],
          recentWorkspaces: [
            { path: '/work/one', chatCount: 1, updatedAt: '2026-04-17T11:59:55.000Z' },
            { path: '/work/two', chatCount: 2, updatedAt: 'invalid' },
          ],
        }),
      );
    });
    const root = expectValue(rendered).root as QueryableTestInstance;
    expect(flattenTreeText(root)).toContain('now');
    expect(flattenTreeText(root)).toContain('0 chats');
    const search = requireTestValue(root.findAllByType(TextInput)[0], 'indexed test value');
    act(() => search.props.onChangeText('does-not-match'));
    expect(flattenTreeText(root)).not.toContain('Pinned');
    act(() => expectValue(rendered).unmount());
  });

  it.each([
    ['2026-04-17T11:59:30.000Z', '30 sec ago'],
    ['2026-04-17T11:30:00.000Z', '30 min ago'],
    ['2026-04-17T07:00:00.000Z', '5 hr ago'],
    ['2026-04-16T12:00:00.000Z', '1 day ago'],
    ['2026-04-14T12:00:00.000Z', '3 days ago'],
    ['2026-04-03T12:00:00.000Z', '2 wk ago'],
    ['2026-02-17T12:00:00.000Z', '1 mo ago'],
  ])('renders recent workspace time %s as %s', (updatedAt, expected) => {
    jest.setSystemTime(new Date('2026-04-17T12:00:00.000Z'));
    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(
        renderPickerMatrix({
          favoriteWorkspacePaths: ['/work/time'],
          recentWorkspaces: [{ path: '/work/time', chatCount: 4, updatedAt }],
        }),
      );
    });
    expect(flattenTreeText(expectValue(rendered).root as QueryableTestInstance)).toContain(
      expected,
    );
    act(() => expectValue(rendered).unmount());
  });

  it('renders singular chat metadata, custom action copy, and modal request close', () => {
    const onClose = jest.fn();
    const onActionPress = jest.fn();
    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(
        renderPickerMatrix({
          favoriteWorkspacePaths: ['/work/one'],
          recentWorkspaces: [{ path: '/work/one', chatCount: 1 }],
          actionLabel: 'Clone here',
          actionDescription: 'Create a checkout here',
          onActionPress,
          onClose,
        }),
      );
    });
    const root = expectValue(rendered).root as QueryableTestInstance;
    expect(flattenTreeText(root)).toContain('1 chat');
    pressLabel(root, 'More actions');
    const action = findByLabel(root, 'Clone here');
    expect(action.props['accessibilityHint']).toBe('Create a checkout here');
    act(() => readOnPress(action.props)());
    expect(onActionPress).toHaveBeenCalledWith('/Users/davidparks/Code/dappercode');
    pressLabel(root, 'Cancel');
    expect(onClose).toHaveBeenCalled();
    act(() => expectValue(rendered).unmount());
  });

  it('uses omitted optional defaults and exposes disabled favorite state', () => {
    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 0, left: 0, right: 0, bottom: 0 },
          }}
        >
          <AppThemeProvider theme={theme}>
            <WorkspacePicker
              recentWorkspaces={[]}
              entries={[]}
              onBrowsePath={jest.fn()}
              onSelectPath={jest.fn()}
              onClose={jest.fn()}
            />
          </AppThemeProvider>
        </SafeAreaProvider>,
      );
    });
    const root = expectValue(rendered).root as QueryableTestInstance;
    act(() => {
      expectValue(rendered).update(
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 0, left: 0, right: 0, bottom: 0 },
          }}
        >
          <AppThemeProvider theme={theme}>
            <WorkspacePicker
              recentWorkspaces={[]}
              entries={[]}
              onBrowsePath={jest.fn()}
              onSelectPath={jest.fn()}
              onClose={jest.fn()}
            />
          </AppThemeProvider>
        </SafeAreaProvider>,
      );
    });
    expect(findByLabel(root, 'Use Default workspace').props['accessibilityState']).toEqual({
      disabled: true,
    });
    expect(root.findAll((node) => node.props['accessibilityLabel'] === 'More actions')).toEqual([]);
    expect(root.findAll((node) => node.props['accessibilityLabel'] === 'Unpin Code')).toEqual([]);
    act(() => expectValue(rendered).unmount());
  });

  it('fires a single selection haptic per gesture for close, browse, select, and favorite toggle', () => {
    const onBrowsePath = jest.fn();
    const onSelectPath = jest.fn();
    const onToggleFavorite = jest.fn();
    const onClose = jest.fn();
    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(
        renderPickerMatrix({ onBrowsePath, onSelectPath, onToggleFavorite, onClose }),
      );
    });
    const tree = expectValue(rendered);
    const root = tree.root as QueryableTestInstance;
    const selection = feedback.selection as jest.Mock;
    selection.mockClear();

    act(() => readOnPress(findPressableContainingText(root, 'notes').props)());
    expect(selection).toHaveBeenCalledTimes(1);

    pressLabel(root, 'Use default workspace');
    expect(selection).toHaveBeenCalledTimes(2);

    // Opening a menu is one gesture and choosing from it is another, so each gets its own tick.
    pressLabel(root, 'More actions');
    expect(selection).toHaveBeenCalledTimes(3);
    pressLabel(root, 'Pin notes');
    expect(onToggleFavorite).toHaveBeenCalledWith('/Users/davidparks/Code/notes');
    expect(selection).toHaveBeenCalledTimes(4);

    pressLabel(root, 'Cancel');
    expect(onClose).toHaveBeenCalled();
    expect(selection).toHaveBeenCalledTimes(5);

    act(() => tree.unmount());
  });

  it('reveals the inline nav-bar title only once the large title scrolls away', () => {
    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(renderPickerMatrix({}));
    });
    const tree = expectValue(rendered);
    const root = tree.root as QueryableTestInstance;
    const countTitles = () =>
      root.findAll(
        (node) =>
          typeof node.type === 'string' &&
          node.props['accessibilityLabel'] === 'Code, current folder',
      ).length;

    expect(countTitles()).toBe(1);
    act(() => scrollList(root, 120));
    expect(countTitles()).toBe(2);
    act(() => scrollList(root, 0));
    expect(countTitles()).toBe(1);
    act(() => tree.unmount());
  });

  it('pads the compact nav bar buttons out to the platform touch-target minimum', () => {
    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(
        renderPickerMatrix({ actionLabel: 'Clone here', onActionPress: jest.fn() }),
      );
    });
    const tree = expectValue(rendered);
    const root = tree.root as QueryableTestInstance;
    // Cancel is drawn 64x32 and the overflow glyph 30x30; hitSlop pads both to at least 44.
    expectPaddedTouchTarget(findByLabel(root, 'Cancel'), 64, 32);
    expectPaddedTouchTarget(findByLabel(root, 'More actions'), 30, 30);
    act(() => tree.unmount());
  });

  it('renders a restrained selection highlight only on the selected workspace tile', () => {
    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(
        renderPickerMatrix({
          selectedPath: '/Users/davidparks/Code/alpha-project',
          recentWorkspaces: [
            { path: '/Users/davidparks/Code/alpha-project', chatCount: 3 },
            { path: '/Users/davidparks/Code/beta-project', chatCount: 1 },
          ],
          favoriteWorkspacePaths: [
            '/Users/davidparks/Code/alpha-project',
            '/Users/davidparks/Code/beta-project',
          ],
        }),
      );
    });
    const tree = expectValue(rendered);
    const root = tree.root as QueryableTestInstance;
    const selectedTile = requireTestValue(
      root.findAll(
        (node) =>
          typeof node.props.onPress === 'function' &&
          flattenTreeText(node).includes('alpha-project') &&
          node.props['accessibilityState'] !== undefined,
      )[0],
      'indexed test value',
    );
    const unselectedTile = requireTestValue(
      root.findAll(
        (node) =>
          typeof node.props.onPress === 'function' &&
          flattenTreeText(node).includes('beta-project') &&
          node.props['accessibilityState'] !== undefined,
      )[0],
      'indexed test value',
    );
    expect(selectedTile.props['accessibilityState']).toEqual(
      expect.objectContaining({ selected: true }),
    );
    expect(unselectedTile.props['accessibilityState']).toEqual(
      expect.objectContaining({ selected: false }),
    );
    act(() => tree.unmount());
  });

  describe('typography tokens', () => {
    it('has no ad hoc numeric fontSize literals in owned workspace-picker source files', () => {
      const fs: typeof fsNode = jest.requireActual('fs');
      const path: typeof pathNode = jest.requireActual('path');
      const offenders: string[] = [];
      const scan = (dir: string, filter: (entry: string) => boolean) => {
        for (const entry of fs.readdirSync(dir)) {
          if (
            !filter(entry) ||
            !/\.tsx?$/.test(entry) ||
            entry.endsWith('.test.tsx') ||
            entry.endsWith('.test.ts')
          ) {
            continue;
          }
          const contents = fs.readFileSync(path.join(dir, entry), 'utf8');
          const matches = contents.match(/fontSize:\s*[0-9]/g);
          if (matches) {
            offenders.push(`${entry}: ${matches.join(', ')}`);
          }
        }
      };
      scan(__dirname, (entry) => /^WorkspacePicker|^workspacePicker/.test(entry));
      scan(path.join(__dirname, '.'), () => true);
      expect(offenders).toEqual([]);
    });

    it('renders the current folder as a large title', () => {
      let rendered: ReactTestRenderer | undefined;
      act(() => {
        rendered = renderer.create(renderPickerMatrix({}));
      });
      const tree = expectValue(rendered);
      const root = tree.root as QueryableTestInstance;
      const titleNode = root.findAll((node) => node.children.map(String).join('') === 'Code')[0];
      const style = Array.isArray(titleNode?.props['style'])
        ? Object.assign({}, ...(titleNode.props['style'] as object[]))
        : ((titleNode?.props['style'] as Record<string, unknown>) ?? {});
      expect(style.fontSize).toBe(theme.typography.largeTitle.fontSize);
      act(() => tree.unmount());
    });
  });

  function renderPickerMatrix(overrides: Record<string, unknown>) {
    return (
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 47, left: 0, right: 0, bottom: 34 },
        }}
      >
        <AppThemeProvider theme={theme}>
          <WorkspacePicker
            selectedPath="/Users/davidparks/Code/dappercode"
            bridgeRoot="/Users/davidparks/Code"
            recentWorkspaces={[{ path: '/Users/davidparks/Code', chatCount: 12 }]}
            favoriteWorkspacePaths={['/Users/davidparks/Code']}
            currentPath="/Users/davidparks/Code"
            parentPath="/Users/davidparks"
            entries={[
              directoryEntry('dappercode', '/Users/davidparks/Code/dappercode'),
              directoryEntry('notes', '/Users/davidparks/Code/notes'),
            ]}
            onBrowsePath={jest.fn()}
            onSelectPath={jest.fn()}
            onClose={jest.fn()}
            {...overrides}
          />
        </AppThemeProvider>
      </SafeAreaProvider>
    );
  }

  function renderPicker({
    onBrowsePath,
    onSelectPath,
    currentPath,
    parentPath,
    entries,
  }: {
    onBrowsePath: (path: string | null) => void;
    onSelectPath: (path: string | null) => void;
    currentPath: string;
    parentPath: string;
    entries: FileSystemEntry[];
  }) {
    return (
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 47, left: 0, right: 0, bottom: 34 },
        }}
      >
        <AppThemeProvider theme={theme}>
          <WorkspacePicker
            selectedPath={oldSelectionPath}
            bridgeRoot={oldSelectionPath}
            recentWorkspaces={[]}
            currentPath={currentPath}
            parentPath={parentPath}
            entries={entries}
            onBrowsePath={onBrowsePath}
            onSelectPath={onSelectPath}
            onClose={jest.fn()}
          />
        </AppThemeProvider>
      </SafeAreaProvider>
    );
  }
});

function directoryEntry(name: string, path: string): FileSystemEntry {
  return {
    name,
    path,
    kind: 'directory',
    hidden: false,
    selectable: true,
    isGitRepo: false,
  };
}

function expectValue<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('Expected value to be set');
  }
  return value;
}

function findByLabel(root: QueryableTestInstance, label: string): QueryableTestInstance {
  // Rows are composed, so several ancestors carry the same label; the innermost pressable is the
  // one holding the real press handler, accessibility state, and hit slop.
  const matches = root.findAll(
    (node) =>
      node.props['accessibilityLabel'] === label && typeof node.props['onPress'] === 'function',
  );
  return requireTestValue(matches[matches.length - 1], `control labelled "${label}"`);
}

function pressLabel(root: QueryableTestInstance, label: string): void {
  const target = findByLabel(root, label);
  act(() => readOnPress(target.props)());
}

function scrollList(root: QueryableTestInstance, offsetY: number): void {
  const list = requireTestValue(
    root.findAll(
      (node) => typeof node.props['onScroll'] === 'function' && Array.isArray(node.props['data']),
    )[0],
    'scrollable folder list',
  );
  (list.props['onScroll'] as (event: unknown) => void)({
    nativeEvent: { contentOffset: { y: offsetY } },
  });
}

function expectPaddedTouchTarget(node: QueryableTestInstance, width: number, height: number): void {
  const hitSlop = node.props['hitSlop'] as {
    top: number;
    bottom: number;
    left: number;
    right: number;
  };
  expect(height + hitSlop.top + hitSlop.bottom).toBeGreaterThanOrEqual(44);
  expect(width + hitSlop.left + hitSlop.right).toBeGreaterThanOrEqual(44);
}

function readOnPress(props: Record<string, unknown>): () => void {
  if (typeof props['onPress'] !== 'function') {
    throw new Error('Expected press handler');
  }
  return props['onPress'] as () => void;
}

function findPressableContainingText(
  root: ReactTestInstance,
  expectedText: string,
): ReactTestInstance {
  const matches = (root as QueryableTestInstance).findAll(
    (node: QueryableTestInstance) =>
      typeof node.props.onPress === 'function' && flattenTreeText(node).includes(expectedText),
  );
  if (matches.length === 0) {
    throw new Error(`Expected press target containing "${expectedText}"`);
  }
  return requireTestValue(matches[0], `press target containing "${expectedText}"`);
}

function findPressableWithExactText(
  root: ReactTestInstance,
  expectedText: string,
): ReactTestInstance {
  const matches = (root as QueryableTestInstance).findAll(
    (node: QueryableTestInstance) =>
      typeof node.props.onPress === 'function' && flattenTreeText(node) === expectedText,
  );
  if (matches.length === 0) {
    throw new Error(`Expected press target with text "${expectedText}"`);
  }
  return requireTestValue(matches[0], `press target with text "${expectedText}"`);
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

function flattenTreeText(node: QueryableTestInstance): string {
  if (node.type === Text) {
    return flattenRenderedText(node.props['children']);
  }

  return node.children
    .map((child) =>
      typeof child === 'string' || typeof child === 'number'
        ? String(child)
        : flattenTreeText(child as QueryableTestInstance),
    )
    .join('');
}
