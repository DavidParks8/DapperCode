import { Ionicons } from '@expo/vector-icons';
import { useAtomValue } from 'jotai';
import { useState, type ReactNode } from 'react';
import { View, useWindowDimensions } from 'react-native';

import { decorativeAccessibilityProps } from '@shared/accessibility';
import { useAppTheme } from '@shared/theme';
import {
  CIRCULAR_TOOLBAR_BUTTON_SIZE,
  CircularToolbarButton,
} from '@shared/ui/CircularToolbarButton';
import { SelectionSheet } from '@shared/ui/SelectionSheet';
import { GlassSurface } from '@shared/ui/glass/GlassSurface';
import { useShellLayout, useVerticalBarFrame } from '@shell/layout/useShellLayout';
import { drawerCommandsAtom, useNavigationToggleLabel } from '@shell/state/drawer/atoms';

export interface SceneToolbarItem {
  readonly key: string;
  readonly icon: keyof typeof Ionicons.glyphMap;
  /** Accessibility label, and the title shown when the item moves into the overflow menu. */
  readonly label: string;
  readonly onPress: () => void;
  /**
   * Where the item sits in a vertical bar: `navigation` (menu, back, close) first, then `action`
   * items, with `bottom` items at the far end, mirroring a top bar and a bottom toolbar.
   */
  readonly group: 'navigation' | 'action' | 'bottom';
  /** Items with higher priority stay visible longest; navigation items never overflow. */
  readonly priority?: number;
  readonly disabled?: boolean;
}

export const VERTICAL_TOOLBAR_GAP = 4;
const OVERFLOW_LABEL = 'More';

/**
 * Whether a header shows its own toolbar buttons. When the system lays bars out vertically, the
 * buttons move to `SceneVerticalToolbar` and the header keeps only text, which stays horizontal.
 */
export function useInlineToolbar(): boolean {
  return useVerticalBarFrame() === null;
}

export function useToolbarPlacement() {
  return useShellLayout().toolbarPlacement;
}

/** Splits items into those that fit `capacity` slots and those that move to the overflow menu. */
export function partitionToolbarItems(
  items: readonly SceneToolbarItem[],
  capacity: number,
): { visible: SceneToolbarItem[]; overflow: SceneToolbarItem[] } {
  if (items.length <= capacity) {
    return { visible: [...items], overflow: [] };
  }
  // One slot goes to the overflow button. Items overflow from the bottom of the bar up unless a
  // priority says otherwise, and navigation always stays reachable.
  const ranked = items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        Number(b.item.group === 'navigation') - Number(a.item.group === 'navigation') ||
        (b.item.priority ?? 0) - (a.item.priority ?? 0) ||
        a.index - b.index,
    );
  const keep = new Set(ranked.slice(0, Math.max(0, capacity - 1)).map(({ item }) => item.key));
  for (const item of items) {
    if (item.group === 'navigation') {
      keep.add(item.key);
    }
  }
  return {
    visible: items.filter((item) => keep.has(item.key)),
    overflow: items.filter((item) => !keep.has(item.key)),
  };
}

/**
 * Renders a scene's toolbar items as a vertical bar in the safe-area column where the system puts
 * its own bars, below the status bar. Renders nothing while bars are horizontal.
 */
export function SceneVerticalToolbar({ items }: { items: readonly SceneToolbarItem[] }) {
  const frame = useVerticalBarFrame();
  const placement = useToolbarPlacement();
  const { width: windowWidth } = useWindowDimensions();
  const theme = useAppTheme();
  const [overflowVisible, setOverflowVisible] = useState(false);
  if (!frame || items.length === 0) {
    return null;
  }
  const slot = CIRCULAR_TOOLBAR_BUTTON_SIZE + VERTICAL_TOOLBAR_GAP;
  const capacity = Math.floor((frame.height + VERTICAL_TOOLBAR_GAP) / slot);
  const { visible, overflow } = partitionToolbarItems(items, capacity);
  const renderButton = (item: SceneToolbarItem) => (
    <GlassSurface
      key={item.key}
      role="capsule"
      isInteractive={!item.disabled}
      style={{
        width: CIRCULAR_TOOLBAR_BUTTON_SIZE,
        height: CIRCULAR_TOOLBAR_BUTTON_SIZE,
        borderRadius: theme.radius.full,
        overflow: 'hidden',
      }}
      testID={`scene-toolbar-button-glass-${item.key}`}
    >
      <CircularToolbarButton
        accessibilityLabel={item.label}
        accessibilityState={item.disabled ? { disabled: true } : undefined}
        disabled={item.disabled}
        onPress={item.onPress}
      >
        <Ionicons
          {...decorativeAccessibilityProps}
          name={item.icon}
          size={20}
          color={theme.colors.textPrimary}
        />
      </CircularToolbarButton>
    </GlassSurface>
  );

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        top: frame.y,
        height: frame.height,
        width: frame.width,
        [placement === 'leading' ? 'left' : 'right']:
          placement === 'leading' ? frame.x : windowWidth - frame.x - frame.width,
        alignItems: 'center',
        justifyContent: 'space-between',
        zIndex: 7,
      }}
      testID="scene-vertical-toolbar"
    >
      <View style={{ alignItems: 'center', gap: VERTICAL_TOOLBAR_GAP }}>
        {visible.filter((item) => item.group !== 'bottom').map(renderButton)}
        {overflow.length > 0
          ? renderButton({
              key: 'overflow',
              label: OVERFLOW_LABEL,
              icon: 'ellipsis-horizontal',
              group: 'action',
              onPress: () => setOverflowVisible(true),
            })
          : null}
      </View>
      <View style={{ alignItems: 'center', gap: VERTICAL_TOOLBAR_GAP }}>
        {visible.filter((item) => item.group === 'bottom').map(renderButton)}
      </View>
      <SelectionSheet
        visible={overflowVisible}
        title={OVERFLOW_LABEL}
        onClose={() => setOverflowVisible(false)}
        options={overflow.map((item) => ({
          key: item.key,
          title: item.label,
          icon: item.icon,
          disabled: item.disabled,
          onPress: () => {
            setOverflowVisible(false);
            item.onPress();
          },
        }))}
      />
    </View>
  );
}

/**
 * Wraps a scene whose root pads for safe areas. The vertical bar lives in that padding, so it is
 * rendered as an unpadded sibling of the scene rather than inside it.
 */
export function SceneToolbarHost({
  items,
  children,
}: {
  items: readonly SceneToolbarItem[];
  children: ReactNode;
}) {
  return (
    <View style={{ flex: 1 }}>
      {children}
      <SceneVerticalToolbar items={items} />
    </View>
  );
}

/** The drawer's menu or sidebar toggle as a toolbar item, when the scene has one. */
export function useDrawerNavigationItem(): SceneToolbarItem | null {
  const toggle = useAtomValue(drawerCommandsAtom)?.toggleNavigation;
  const label = useNavigationToggleLabel();
  return toggle
    ? { key: 'navigation', icon: 'menu', label, onPress: toggle, group: 'navigation' }
    : null;
}
