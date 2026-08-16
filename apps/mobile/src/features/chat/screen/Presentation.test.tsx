import React from 'react';
import { StyleSheet } from 'react-native';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '@shared/theme';
import {
  getRenderedGlassViewProps,
  resetMockGlassEffect,
  setMockGlassEffectAPIAvailable,
  setMockLiquidGlassAvailable,
} from '@shared/testing/glassEffectMock';
import { ComposeView } from './Presentation';

jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));
jest.mock('@expo/vector-icons', () => {
  const mockReact = jest.requireActual('react');
  return {
    Ionicons: ({ name, color }: { name: string; color: string }) =>
      mockReact.createElement('ionicon', { name, color }),
  };
});

type QueryableInstance = Omit<ReactTestInstance, 'props' | 'children' | 'findAll'> & {
  type: unknown;
  props: Record<string, unknown>;
  children: Array<QueryableInstance | string>;
  findAll(predicate: (node: QueryableInstance) => boolean): QueryableInstance[];
};

const theme = createAppTheme('dark');

function renderCompose(overrides: Partial<React.ComponentProps<typeof ComposeView>> = {}) {
  const props: React.ComponentProps<typeof ComposeView> = {
    startWorkspaceLabel: '/Users/dev/Code/clawdex-mobile',
    keyboardVisible: false,
    bottomInset: 0,
    topInset: 0,
    onSuggestion: jest.fn(),
    onOpenWorkspacePicker: jest.fn(),
    ...overrides,
  };
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <AppThemeProvider theme={theme}>
        <ComposeView {...props} />
      </AppThemeProvider>,
    );
  });
  if (!tree) {
    throw new Error('Component did not render');
  }
  return { tree, root: tree.root as QueryableInstance, props };
}

function findByLabel(root: QueryableInstance, label: string): QueryableInstance {
  const match = root.findAll(
    (node) =>
      typeof node.props['onPress'] === 'function' && node.props['accessibilityLabel'] === label,
  )[0];
  if (!match) {
    throw new Error(`Missing pressable labelled: ${label}`);
  }
  return match;
}

function findAllByLabelPrefix(root: QueryableInstance, prefix: string): QueryableInstance[] {
  return root.findAll(
    (node) =>
      typeof node.props['onPress'] === 'function' &&
      typeof node.props['accessibilityLabel'] === 'string' &&
      node.props['accessibilityLabel'].startsWith(prefix),
  );
}

function hasText(root: QueryableInstance, text: string): boolean {
  return root.findAll((node) => node.children.includes(text)).length > 0;
}

describe('ComposeView', () => {
  beforeEach(() => {
    resetMockGlassEffect();
  });

  it('names the workspace by its folder while the full path stays available to screen readers', () => {
    const { tree, root } = renderCompose();

    // The capsule is a pill: a full path would either wrap or truncate to nothing readable.
    expect(hasText(root, 'clawdex-mobile')).toBe(true);
    expect(hasText(root, '/Users/dev/Code/clawdex-mobile')).toBe(false);
    expect(() => findByLabel(root, 'Workspace, /Users/dev/Code/clawdex-mobile')).not.toThrow();
    act(() => tree.unmount());
  });

  it('keeps a workspace label that is not a path intact', () => {
    const { tree, root } = renderCompose({ startWorkspaceLabel: 'Select project' });

    expect(hasText(root, 'Select project')).toBe(true);
    expect(() => findByLabel(root, 'Workspace, Select project')).not.toThrow();
    act(() => tree.unmount());
  });

  it('opens the workspace picker from the capsule', () => {
    const { tree, root, props } = renderCompose();

    act(() => {
      (
        findByLabel(root, 'Workspace, /Users/dev/Code/clawdex-mobile').props[
          'onPress'
        ] as () => void
      )();
    });

    expect(props.onOpenWorkspacePicker).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });

  it('renders the workspace capsule as a glass capsule rather than an opaque form row', () => {
    setMockLiquidGlassAvailable(true);
    setMockGlassEffectAPIAvailable(true);
    const { tree } = renderCompose();

    const glassProps = getRenderedGlassViewProps().find(
      (candidate) => candidate.testID === 'compose-workspace-glass-surface',
    );

    expect(glassProps?.glassEffectStyle).toBe(theme.glass.capsule.glassEffectStyle);
    expect(glassProps?.tintColor).toBe(theme.glass.capsule.tintColor);
    // GlassSurface owns the material; a caller-supplied fill would defeat it.
    const glassStyle = StyleSheet.flatten(glassProps?.style) as {
      backgroundColor?: string;
      borderRadius?: number;
    };
    expect(glassStyle.backgroundColor).toBeUndefined();
    expect(glassStyle.borderRadius).toBe(theme.radius.full);
    act(() => tree.unmount());
  });

  it('sends the full prompt when a short suggestion pill is tapped', () => {
    const { tree, root, props } = renderCompose();

    const pills = findAllByLabelPrefix(root, 'Use suggestion: ');
    expect(pills.length).toBeGreaterThan(0);
    // The pill reads short so it fits the row; the draft it produces has to stay a usable prompt.
    for (const pill of pills) {
      const label = String(pill.props['accessibilityLabel']).replace('Use suggestion: ', '');
      expect(hasText(pill, label)).toBe(true);
    }

    act(() => {
      (pills[0]?.props['onPress'] as () => void)();
    });

    expect(props.onSuggestion).toHaveBeenCalledTimes(1);
    const [sent] = (props.onSuggestion as jest.Mock).mock.calls[0] as [string];
    expect(sent).toBe('Explain the current codebase structure');
    act(() => tree.unmount());
  });

  it('no longer stacks the session controls as full-width rows above the suggestions', () => {
    // These moved to the header chip row. Rebuilding them here would restore the tall stack that
    // pushed the suggestions off screen.
    const { tree, root } = renderCompose();

    for (const prefix of ['Agent,', 'Model,', 'Thinking level,', 'Agent mode,', 'Fast mode']) {
      expect(findAllByLabelPrefix(root, prefix)).toHaveLength(0);
    }
    act(() => tree.unmount());
  });

  it('lays the suggestions out as wrapping pills instead of stretched cards', () => {
    const { tree, root } = renderCompose();

    const pill = findAllByLabelPrefix(root, 'Use suggestion: ')[0];
    const pillStyle = StyleSheet.flatten(
      (pill?.props['style'] as (state: { pressed: boolean }) => unknown)({
        pressed: false,
      }) as never,
    ) as { borderRadius?: number; flex?: number };

    expect(pillStyle.borderRadius).toBe(theme.radius.full);
    expect(pillStyle.flex).toBeUndefined();

    // A centered row shrink-wraps, and a shrink-wrapped row never reaches a wrap point, so the
    // pills would overflow the screen edge instead of falling to a second line.
    const pillRow = root.findAll((node) => {
      const style = StyleSheet.flatten(node.props['style'] as never) as
        { flexWrap?: string } | undefined;
      return style?.flexWrap === 'wrap';
    })[0];
    const rowStyle = StyleSheet.flatten(pillRow?.props['style'] as never) as {
      width?: number | string;
      justifyContent?: string;
    };
    expect(rowStyle.width).toBe('100%');
    expect(rowStyle.justifyContent).toBe('center');
    act(() => tree.unmount());
  });
});
