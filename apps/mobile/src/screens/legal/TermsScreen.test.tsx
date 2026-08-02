import { Alert, Linking, Platform, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '../../theme';
import { TermsScreen } from './TermsScreen';

jest.mock('@expo/vector-icons', () => ({ Ionicons: ({ name }: { name: string }) => name }));
jest.mock('../../feedback', () => ({
  feedback: {
    selection: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockResolvedValue(undefined),
    success: jest.fn().mockResolvedValue(undefined),
    warning: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
    destructive: jest.fn().mockResolvedValue(undefined),
  },
}));

type Queryable = Omit<ReactTestInstance, 'children' | 'findAll' | 'parent' | 'props'> & {
  type: string | { displayName?: string; name?: string };
  children: unknown[];
  props: Record<string, unknown>;
  parent: Queryable | null;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
};

type PressCallback = () => void;

const theme = createAppTheme('dark');

function hasText(root: Queryable, text: string): boolean {
  return root.findAll((node) => node.children.map(String).join('').includes(text)).length > 0;
}

function typeName(node: Queryable): string {
  const { type } = node;
  return typeof type === 'string' ? type : (type.displayName ?? type.name ?? '');
}

function findPressableByText(root: Queryable, text: string): Queryable {
  const textNode = root.findAll((node) => node.children.map(String).join('') === text)[0];
  let current: Queryable | null = textNode ?? null;
  while (current && typeof current.props.onPress !== 'function') {
    current = current.parent as Queryable | null;
  }
  if (!current) {
    throw new Error(`Missing pressable: ${text}`);
  }
  return current;
}

function findPressableAncestor(node: Queryable): Queryable {
  let current: Queryable | null = node;
  while (current && typeof current.props.onPress !== 'function') {
    current = current.parent as Queryable | null;
  }
  if (!current) {
    throw new Error('Missing pressable ancestor');
  }
  return current;
}

function getPressCallback(node: Queryable): PressCallback {
  const callback = node.props.onPress;
  if (typeof callback !== 'function') {
    throw new Error('Expected onPress callback');
  }
  return callback as PressCallback;
}

/** Resolves a Pressable's (possibly function-form) style prop and returns its effective minHeight. */
function resolveMinHeight(node: Queryable): number {
  const rawStyle = node.props.style as unknown;
  const resolved = typeof rawStyle === 'function' ? rawStyle({ pressed: false }) : rawStyle;
  const flattened = StyleSheet.flatten(resolved) as { minHeight?: number } | undefined;
  return flattened?.minHeight ?? 0;
}

/** Effective diameter of a hitSlop-expanded control on a given axis. */
function effectiveSize(
  visible: number,
  hitSlop: { top?: number; bottom?: number; left?: number; right?: number } | number | undefined,
  axis: 'vertical' | 'horizontal',
): number {
  if (typeof hitSlop === 'number') {
    return visible + hitSlop * 2;
  }
  const [a, b] =
    axis === 'vertical' ? [hitSlop?.top, hitSlop?.bottom] : [hitSlop?.left, hitSlop?.right];
  return visible + (a ?? 0) + (b ?? 0);
}

async function renderTerms(url: string | null, onBack = jest.fn()): Promise<ReactTestRenderer> {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = renderer.create(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 47, left: 0, right: 0, bottom: 34 },
        }}
      >
        <AppThemeProvider theme={theme}>
          <TermsScreen termsUrl={url} onBack={onBack} />
        </AppThemeProvider>
      </SafeAreaProvider>,
    );
  });
  if (!tree) {
    throw new Error('Expected terms screen tree');
  }
  return tree;
}

async function press(node: Queryable): Promise<void> {
  await act(async () => {
    getPressCallback(node)();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('TermsScreen behavior', () => {
  const button = 'Open terms';
  const url = 'https://example.com/terms';
  const missing = 'Not configured. Set EXPO_PUBLIC_TERMS_OF_SERVICE_URL.';
  const unsupported = 'The terms URL is not supported on this device.';

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
  });

  it('renders configured and missing states, navigates back, and opens supported links', async () => {
    jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
    jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    const onBack = jest.fn();
    const configured = await renderTerms(url, onBack);
    const root = configured.root as Queryable;
    await press(findPressableByText(root, button));
    expect(Linking.canOpenURL).toHaveBeenCalledWith(url);
    expect(Linking.openURL).toHaveBeenCalledWith(url);
    const backIcon = root.findAll((node) => node.children.includes('chevron-back'))[0];
    await press(findPressableAncestor(backIcon));
    expect(onBack).toHaveBeenCalled();
    act(() => configured.unmount());

    const absent = await renderTerms(null);
    expect(hasText(absent.root as Queryable, missing)).toBe(true);
    expect(findPressableByText(absent.root as Queryable, button).props.disabled).toBe(true);
    act(() => absent.unmount());
  });

  it('alerts for unsupported links and open failures', async () => {
    jest.spyOn(Linking, 'canOpenURL').mockResolvedValueOnce(false);
    jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    const unsupportedTree = await renderTerms(url);
    await press(findPressableByText(unsupportedTree.root as Queryable, button));
    expect(Alert.alert).toHaveBeenCalledWith('Cannot open link', unsupported);
    expect(Linking.openURL).not.toHaveBeenCalled();
    act(() => unsupportedTree.unmount());

    jest.spyOn(Linking, 'canOpenURL').mockRejectedValueOnce(new Error('native failure'));
    const failedTree = await renderTerms(url);
    await press(findPressableByText(failedTree.root as Queryable, button));
    expect(Alert.alert).toHaveBeenCalledWith(
      'Could not open link',
      'Please open the terms URL manually.',
    );
    act(() => failedTree.unmount());
  });

  it('renders flat native sections without card chrome', async () => {
    const tree = await renderTerms(url);
    const root = tree.root as Queryable;
    expect(root.findAll((node) => /blur|gradient/i.test(typeName(node)))).toHaveLength(0);
    expect(hasText(root, 'Acceptable Use')).toBe(true);
    act(() => tree.unmount());
  });

  it('shows and guards the in-flight opening state', async () => {
    let resolveSupported: ((supported: boolean) => void) | undefined;
    jest.spyOn(Linking, 'canOpenURL').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSupported = resolve;
        }),
    );
    jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    const tree = await renderTerms(url);
    const root = tree.root as Queryable;
    const buttonNode = findPressableByText(root, button);
    act(() => getPressCallback(buttonNode)());
    expect(hasText(root, 'Opening...')).toBe(true);
    expect(buttonNode.props.disabled).toBe(true);
    act(() => getPressCallback(buttonNode)());
    expect(Linking.canOpenURL).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveSupported?.(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(Linking.openURL).toHaveBeenCalledWith(url);
    act(() => tree.unmount());
  });

  it('back button hitSlop plus icon meets the platform touch target minimum', async () => {
    const tree = await renderTerms(url);
    const root = tree.root as Queryable;
    const backIcon = root.findAll((node) => node.children.includes('chevron-back'))[0];
    const backBtn = findPressableAncestor(backIcon);
    const hitSlop = backBtn.props.hitSlop as
      { top?: number; bottom?: number; left?: number; right?: number } | number | undefined;
    const iconSize = 22;
    expect(effectiveSize(iconSize, hitSlop, 'vertical')).toBeGreaterThanOrEqual(
      theme.touchTarget.minimum,
    );
    expect(effectiveSize(iconSize, hitSlop, 'horizontal')).toBeGreaterThanOrEqual(
      theme.touchTarget.minimum,
    );
    act(() => tree.unmount());
  });

  it('open button meets the platform touch target minimum via resolved minHeight', async () => {
    const tree = await renderTerms(url);
    const root = tree.root as Queryable;
    const openBtn = findPressableByText(root, button);
    const minH = resolveMinHeight(openBtn);
    expect(minH).toBeGreaterThanOrEqual(theme.touchTarget.minimum);
    act(() => tree.unmount());
  });

  it('back button and open button meet the 48dp Android touch target minimum', async () => {
    const originalOS = Platform.OS;
    Platform.OS = 'android';
    try {
      const androidTheme = createAppTheme('dark');
      expect(androidTheme.touchTarget.minimum).toBe(48);
      let tree: ReactTestRenderer | undefined;
      await act(async () => {
        tree = renderer.create(
          <SafeAreaProvider
            initialMetrics={{
              frame: { x: 0, y: 0, width: 390, height: 844 },
              insets: { top: 47, left: 0, right: 0, bottom: 34 },
            }}
          >
            <AppThemeProvider theme={androidTheme}>
              <TermsScreen termsUrl={url} onBack={jest.fn()} />
            </AppThemeProvider>
          </SafeAreaProvider>,
        );
      });
      const root = tree!.root as Queryable;
      const backIcon = root.findAll((node) => node.children.includes('chevron-back'))[0];
      const backBtn = findPressableAncestor(backIcon);
      const hitSlop = backBtn.props.hitSlop as
        { top?: number; bottom?: number; left?: number; right?: number } | number | undefined;
      expect(effectiveSize(22, hitSlop, 'vertical')).toBeGreaterThanOrEqual(48);
      expect(effectiveSize(22, hitSlop, 'horizontal')).toBeGreaterThanOrEqual(48);
      const openBtn = findPressableByText(root, button);
      expect(resolveMinHeight(openBtn)).toBeGreaterThanOrEqual(48);
      act(() => tree!.unmount());
    } finally {
      Platform.OS = originalOS;
    }
  });
});
