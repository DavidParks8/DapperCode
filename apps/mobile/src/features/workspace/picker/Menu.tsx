import { Ionicons } from '@expo/vector-icons';
import { Fragment, type ComponentProps } from 'react';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';

import { controlAccessibilityState, decorativeAccessibilityProps } from '@shared/accessibility';
import type { AppTheme } from '@shared/theme';
import { motionDuration } from '@shared/ui/motion';
import { MENU_ROW_HEIGHT, MENU_TITLE_HEIGHT, MENU_WIDTH } from './stylesLayout';
import type { WorkspacePickerStyles } from './styles';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

const MENU_EDGE_INSET = 12;
const MENU_ANCHOR_GAP = 6;
/** Each nesting level in the path menu steps in by this much, the way Finder indents ancestors. */
const MENU_INDENT_STEP = 14;

export interface WorkspacePickerMenuItem {
  key: string;
  label: string;
  icon: IoniconName;
  /** Overrides the spoken label when the visible text alone would not say what the item does. */
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** Nesting level for hierarchical menus; the path menu uses it to show how far up a folder sits. */
  indent?: number;
  selected?: boolean;
  disabled?: boolean;
  onPress: () => void;
}

export interface WorkspacePickerMenuAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WorkspacePickerMenuState {
  id: string;
  accessibilityLabel: string;
  title?: string;
  anchor: WorkspacePickerMenuAnchor;
  /** `end` right-aligns the card under the anchor, which is what nav bar buttons need. */
  align: 'start' | 'end';
  items: WorkspacePickerMenuItem[];
}

interface MeasurableTarget {
  measureInWindow: (
    callback: (x: number, y: number, width: number, height: number) => void,
  ) => void;
}

/**
 * Native measurement is asynchronous and never resolves off-device, so the menu is presented
 * against a predicted rect immediately and this only refines it once real geometry arrives.
 */
export function measureMenuAnchor(
  target: MeasurableTarget | null | undefined,
  onMeasured: (anchor: WorkspacePickerMenuAnchor) => void,
): void {
  if (!target || typeof target.measureInWindow !== 'function') {
    return;
  }
  target.measureInWindow((x, y, width, height) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(width > 0) || !(height > 0)) {
      return;
    }
    onMeasured({ x, y, width, height });
  });
}

function resolveMenuPosition(
  menu: WorkspacePickerMenuState,
  windowWidth: number,
  windowHeight: number,
): { top: number; left: number } {
  const estimatedHeight =
    menu.items.length * MENU_ROW_HEIGHT + (menu.title ? MENU_TITLE_HEIGHT : 0) + MENU_EDGE_INSET;
  const below = menu.anchor.y + menu.anchor.height + MENU_ANCHOR_GAP;
  const overflowsBelow = below + estimatedHeight > windowHeight - MENU_EDGE_INSET;
  const top = overflowsBelow
    ? Math.max(MENU_EDGE_INSET, menu.anchor.y - MENU_ANCHOR_GAP - estimatedHeight)
    : below;
  const preferredLeft =
    menu.align === 'end' ? menu.anchor.x + menu.anchor.width - MENU_WIDTH : menu.anchor.x;
  const maxLeft = Math.max(MENU_EDGE_INSET, windowWidth - MENU_WIDTH - MENU_EDGE_INSET);
  return { top, left: Math.min(Math.max(MENU_EDGE_INSET, preferredLeft), maxLeft) };
}

function WorkspacePickerMenuRow({
  item,
  styles,
  theme,
  showCheckSlot,
  onDismiss,
}: {
  item: WorkspacePickerMenuItem;
  styles: WorkspacePickerStyles;
  theme: AppTheme;
  showCheckSlot: boolean;
  onDismiss: () => void;
}) {
  return (
    <Pressable
      onPress={() => {
        onDismiss();
        item.onPress();
      }}
      disabled={item.disabled}
      style={({ pressed }) => [
        styles.menuRow,
        item.disabled && styles.buttonDisabled,
        pressed && !item.disabled && styles.menuRowPressed,
      ]}
      accessibilityRole="menuitem"
      accessibilityLabel={item.accessibilityLabel ?? item.label}
      accessibilityHint={item.accessibilityHint}
      accessibilityState={controlAccessibilityState({
        selected: item.selected,
        disabled: item.disabled,
      })}
    >
      {showCheckSlot ? (
        <View style={styles.menuCheckSlot}>
          {item.selected ? (
            <Ionicons
              {...decorativeAccessibilityProps}
              name="checkmark"
              size={15}
              color={theme.colors.accent}
            />
          ) : null}
        </View>
      ) : null}
      <Text
        style={[styles.menuRowLabel, { marginLeft: (item.indent ?? 0) * MENU_INDENT_STEP }]}
        numberOfLines={1}
      >
        {item.label}
      </Text>
      <Ionicons
        {...decorativeAccessibilityProps}
        name={item.icon}
        size={17}
        color={theme.colors.textSecondary}
      />
    </Pressable>
  );
}

/**
 * A UIMenu-shaped popover anchored to whatever opened it. It replaces the picker's old confirmation
 * alerts and standing chrome: actions live one press away from the thing they act on.
 */
export function WorkspacePickerMenu({
  menu,
  styles,
  theme,
  onDismiss,
}: {
  menu: WorkspacePickerMenuState;
  styles: WorkspacePickerStyles;
  theme: AppTheme;
  onDismiss: () => void;
}) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const { top, left } = resolveMenuPosition(menu, windowWidth, windowHeight);
  const showCheckSlot = menu.items.some((item) => item.selected);

  return (
    <View style={styles.menuLayer}>
      <Pressable
        style={styles.menuScrim}
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel="Close menu"
      />
      <Animated.View
        entering={FadeIn.duration(motionDuration.immediate).reduceMotion(ReduceMotion.System)}
        exiting={FadeOut.duration(motionDuration.immediate).reduceMotion(ReduceMotion.System)}
        style={[styles.menuCard, { top, left }]}
        accessibilityViewIsModal
        accessibilityRole="menu"
        accessibilityLabel={menu.accessibilityLabel}
      >
        {menu.title ? (
          <Text style={styles.menuTitle} numberOfLines={1}>
            {menu.title}
          </Text>
        ) : null}
        {menu.items.map((item, index) => (
          <Fragment key={item.key}>
            {index > 0 || menu.title ? <View style={styles.menuSeparator} /> : null}
            <WorkspacePickerMenuRow
              item={item}
              styles={styles}
              theme={theme}
              showCheckSlot={showCheckSlot}
              onDismiss={onDismiss}
            />
          </Fragment>
        ))}
      </Animated.View>
    </View>
  );
}
