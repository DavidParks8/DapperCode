import { requireTestValue } from '@shared/testing/requireTestValue';
jest.mock('expo-router', () => jest.requireActual('@shared/testing/expoRouterMock'));
jest.mock('expo-router/react-navigation', () => ({
  usePreventRemove: jest.fn(),
}));
jest.mock('react-native-reanimated', () => {
  // Require react-native in this context so View/Text are valid renderable types.
  const rnActual = jest.requireActual('react-native');
  const { View, Text, Image, ScrollView } = rnActual;
  const base = jest.requireActual('@shared/testing/reanimatedMock');
  // Extend the passthrough builder with the reduceMotion method used by GitCheckoutScreen.
  const passthrough: Record<string, unknown> = {
    duration: () => passthrough,
    delay: () => passthrough,
    easing: () => passthrough,
    springify: () => passthrough,
    withInitialValues: () => passthrough,
    reduceMotion: () => passthrough,
  };
  return {
    __esModule: true,
    default: { View, Text, Image, ScrollView, createAnimatedComponent: (c: unknown) => c },
    Easing: base.Easing,
    ReduceMotion: base.ReduceMotion,
    FadeIn: passthrough,
    FadeInUp: passthrough,
    FadeInDown: passthrough,
    FadeOut: passthrough,
    LinearTransition: passthrough,
    useSharedValue: base.useSharedValue,
    useAnimatedStyle: base.useAnimatedStyle,
    withTiming: base.withTiming,
    withSpring: base.withSpring,
    cancelAnimation: base.cancelAnimation,
    clamp: base.clamp,
    interpolate: base.interpolate,
    runOnJS: base.runOnJS,
    useDerivedValue: base.useDerivedValue,
  };
});
jest.mock('@expo/vector-icons', () => ({ Ionicons: ({ name }: { name: string }) => name }));
jest.mock('@shared/feedback', () => ({
  feedback: {
    success: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
    selection: jest.fn().mockResolvedValue(undefined),
  },
}));

import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { feedback } from '@shared/feedback';
import {
  gitCheckoutCloningAtom,
  gitCheckoutDirectoryNameAtom,
  gitCheckoutErrorAtom,
  gitCheckoutParentPathAtom,
  gitCheckoutRepoUrlAtom,
} from '../state/gitCheckout';
import { createTestStore, withAppStore } from '@shell/state/testing';
import type { AppStore } from '@shell/state/types';
import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { GitCheckoutScreen } from './Screen';

type Queryable = ReactTestInstance & {
  children: unknown[];
  props: Record<string, unknown>;
  parent: Queryable | null;
  type: unknown;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
};

const theme = createAppTheme('dark');

const mockFeedback = feedback as unknown as {
  success: jest.MockedFunction<() => Promise<void>>;
  error: jest.MockedFunction<() => Promise<void>>;
};

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function hasText(root: Queryable, text: string): boolean {
  return root.findAll((node) => node.children.map(String).join('').includes(text)).length > 0;
}

function findByAccessibilityRole(root: Queryable, role: string): Queryable[] {
  return root.findAll((node) => node.props['accessibilityRole'] === role);
}

async function renderScreen(store: AppStore): Promise<ReactTestRenderer> {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = renderer.create(
      withAppStore(
        store,
        <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
          <AppThemeProvider theme={theme}>
            <GitCheckoutScreen />
          </AppThemeProvider>
        </SafeAreaProvider>,
      ),
    );
    await Promise.resolve();
  });
  if (!tree) {
    throw new Error('Expected GitCheckoutScreen tree');
  }
  return tree;
}

describe('GitCheckoutScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('idle state', () => {
    it('renders the form with URL and directory inputs', async () => {
      const store = createTestStore();
      const tree = await renderScreen(store);
      const root = tree.root as Queryable;

      expect(hasText(root, 'Git checkout')).toBe(true);
      const inputs = root.findAll((node) => node.props['accessibilityLabel'] !== undefined);
      const urlInput = inputs.find((n) => n.props['accessibilityLabel'] === 'Repository URL');
      const dirInput = inputs.find((n) => n.props['accessibilityLabel'] === 'Clone directory name');
      expect(urlInput).toBeDefined();
      expect(dirInput).toBeDefined();

      act(() => tree.unmount());
    });

    it('does not render the progress indicator when not cloning', async () => {
      const store = createTestStore();
      const tree = await renderScreen(store);
      const root = tree.root as Queryable;

      const progressbars = findByAccessibilityRole(root, 'progressbar');
      expect(progressbars).toHaveLength(0);

      act(() => tree.unmount());
    });
  });

  describe('cloning/progress state', () => {
    it('shows ActivityIndicator with accessibilityRole=progressbar when cloning', async () => {
      const store = createTestStore();
      store.set(gitCheckoutRepoUrlAtom, 'git@github.com:org/repo.git');
      store.set(gitCheckoutDirectoryNameAtom, 'repo');
      store.set(gitCheckoutParentPathAtom, '/home/user');
      store.set(gitCheckoutCloningAtom, true);

      const tree = await renderScreen(store);
      const root = tree.root as Queryable;

      const progressbars = findByAccessibilityRole(root, 'progressbar');
      expect(progressbars.length).toBeGreaterThan(0);
      expect(
        requireTestValue(progressbars[0], 'indexed test value').props['accessibilityLabel'],
      ).toBe('Cloning repository');

      act(() => tree.unmount());
    });

    it('shows "Cloning repository…" text alongside the indicator', async () => {
      const store = createTestStore();
      store.set(gitCheckoutCloningAtom, true);

      const tree = await renderScreen(store);
      expect(hasText(tree.root as Queryable, 'Cloning repository')).toBe(true);

      act(() => tree.unmount());
    });

    it('disables form inputs and buttons while cloning', async () => {
      const store = createTestStore();
      store.set(gitCheckoutRepoUrlAtom, 'git@github.com:org/repo.git');
      store.set(gitCheckoutDirectoryNameAtom, 'repo');
      store.set(gitCheckoutCloningAtom, true);

      const tree = await renderScreen(store);
      const root = tree.root as Queryable;

      const urlInputs = root.findAll((n) => n.props['accessibilityLabel'] === 'Repository URL');
      expect(urlInputs[0]?.props['editable']).toBe(false);

      const cancelBtn = root.findAll(
        (n) => n.props['accessibilityLabel'] === 'Cancel git checkout',
      );
      expect(cancelBtn[0]?.props['disabled']).toBe(true);

      act(() => tree.unmount());
    });
  });

  describe('error state', () => {
    it('shows error text with accessibilityRole=alert', async () => {
      const store = createTestStore();
      store.set(gitCheckoutErrorAtom, 'Clone failed: repository not found');

      const tree = await renderScreen(store);
      const root = tree.root as Queryable;

      expect(hasText(root, 'Clone failed: repository not found')).toBe(true);
      const alerts = findByAccessibilityRole(root, 'alert');
      expect(alerts.length).toBeGreaterThan(0);

      act(() => tree.unmount());
    });

    it('does not show progress indicator alongside an error', async () => {
      const store = createTestStore();
      store.set(gitCheckoutErrorAtom, 'Some error');
      // cloning=false, error present

      const tree = await renderScreen(store);
      const root = tree.root as Queryable;

      const progressbars = findByAccessibilityRole(root, 'progressbar');
      expect(progressbars).toHaveLength(0);

      act(() => tree.unmount());
    });

    it('does not show error text during cloning (no stale error)', async () => {
      const store = createTestStore();
      store.set(gitCheckoutCloningAtom, true);
      // error is null while cloning per action behavior

      const tree = await renderScreen(store);
      const root = tree.root as Queryable;

      const alerts = findByAccessibilityRole(root, 'alert');
      expect(alerts).toHaveLength(0);

      act(() => tree.unmount());
    });
  });

  describe('haptic feedback', () => {
    it('fires feedback.error() when clone transitions from cloning to failed', async () => {
      const store = createTestStore();
      store.set(gitCheckoutRepoUrlAtom, 'git@github.com:org/repo.git');
      store.set(gitCheckoutDirectoryNameAtom, 'repo');
      store.set(gitCheckoutCloningAtom, true);

      const tree = await renderScreen(store);

      // Simulate clone failure: set error then clear cloning flag
      await act(async () => {
        store.set(gitCheckoutErrorAtom, 'Clone failed');
        store.set(gitCheckoutCloningAtom, false);
        await Promise.resolve();
      });

      expect(mockFeedback.error).toHaveBeenCalledTimes(1);
      expect(mockFeedback.success).not.toHaveBeenCalled();

      act(() => tree.unmount());
    });

    it('fires feedback.success() when clone transitions from cloning to idle with no error', async () => {
      const store = createTestStore();
      store.set(gitCheckoutRepoUrlAtom, 'git@github.com:org/repo.git');
      store.set(gitCheckoutDirectoryNameAtom, 'repo');
      store.set(gitCheckoutCloningAtom, true);

      const tree = await renderScreen(store);

      // Simulate successful clone: clear cloning flag with no error
      await act(async () => {
        store.set(gitCheckoutCloningAtom, false);
        await Promise.resolve();
      });

      expect(mockFeedback.success).toHaveBeenCalledTimes(1);
      expect(mockFeedback.error).not.toHaveBeenCalled();

      act(() => tree.unmount());
    });

    it('does not fire haptics on initial render', async () => {
      const store = createTestStore();
      const tree = await renderScreen(store);

      expect(mockFeedback.success).not.toHaveBeenCalled();
      expect(mockFeedback.error).not.toHaveBeenCalled();

      act(() => tree.unmount());
    });

    it('does not double-fire haptics on re-renders unrelated to cloning', async () => {
      const store = createTestStore();
      store.set(gitCheckoutCloningAtom, true);

      const tree = await renderScreen(store);

      // Trigger a re-render by changing URL while still cloning
      await act(async () => {
        store.set(gitCheckoutRepoUrlAtom, 'git@github.com:other/repo.git');
        await Promise.resolve();
      });

      expect(mockFeedback.success).not.toHaveBeenCalled();
      expect(mockFeedback.error).not.toHaveBeenCalled();

      act(() => tree.unmount());
    });
  });

  describe('touch targets', () => {
    it('action buttons meet minimum height (44pt)', async () => {
      const store = createTestStore();
      const tree = await renderScreen(store);

      // Verify via the stylesheet factory that button styles meet the 44pt iOS minimum.
      const { createGitCheckoutScreenStyles } = jest.requireActual('./styles');
      const styles = createGitCheckoutScreenStyles(theme);
      expect(styles.button.minHeight).toBeGreaterThanOrEqual(44);

      act(() => tree.unmount());
    });

    it('back button has hitSlop to meet minimum touch target', async () => {
      const store = createTestStore();
      const tree = await renderScreen(store);
      const root = tree.root as Queryable;

      const backBtn = root.findAll((n) => n.props['accessibilityLabel'] === 'Back')[0];
      const hitSlop = backBtn?.props['hitSlop'] as
        { top: number; bottom: number; left: number; right: number } | undefined;

      // Back button is 36×36; hitSlop must expand to at least 44 (iOS minimum)
      expect(hitSlop).toBeDefined();
      const effectiveSize = 36 + (hitSlop?.top ?? 0) + (hitSlop?.bottom ?? 0);
      expect(effectiveSize).toBeGreaterThanOrEqual(44);

      act(() => tree.unmount());
    });
  });

  describe('typography tokens', () => {
    it('title uses a semantic typography role (no raw fontSize literal)', async () => {
      const store = createTestStore();
      const tree = await renderScreen(store);
      const root = tree.root as Queryable;

      const titleNode = root.findAll((n) => n.children.map(String).join('') === 'Git checkout')[0];
      const style = Array.isArray(titleNode?.props['style'])
        ? Object.assign({}, ...titleNode.props['style'])
        : ((titleNode?.props['style'] as Record<string, unknown>) ?? {});

      // Screen-title baseline uses the `title` role (22pt), one step below `largeTitle`.
      expect(style.fontSize).toBe(22);

      act(() => tree.unmount());
    });
  });
});
