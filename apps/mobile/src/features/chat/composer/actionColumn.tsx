import type { ReactNode } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

/**
 * A column past the composer's trailing edge that takes the Send/Stop button out of the input row,
 * such as a vertical bar beside the composer. The button stays on the input box's bottom edge.
 */
export interface ComposerActionColumn {
  /** Distance from the composer's trailing edge to the column's leading edge. */
  readonly offset: number;
  readonly width: number;
}

interface ActionColumnLayout {
  readonly shell: ViewStyle | null;
  readonly container: ViewStyle | null;
  readonly group: ViewStyle | null;
}

const INLINE: ActionColumnLayout = { shell: null, container: null, group: null };

/**
 * Stretches the composer into the column so the button keeps sharing the input box's row, and so
 * its bottom edge, while the input box keeps `inputTrailingPadding` inside the composer.
 */
export function resolveActionColumnLayout(
  column: ComposerActionColumn | null,
  inputTrailingPadding: number,
): ActionColumnLayout {
  if (!column) {
    return INLINE;
  }
  return {
    shell: { marginRight: -(column.offset + column.width) },
    container: { paddingRight: 0 },
    group: { gap: inputTrailingPadding + column.offset },
  };
}

/** Centers the action in the column, like the column's own buttons, or leaves it inline. */
export function ComposerActionSlot({
  column,
  children,
}: {
  column: ComposerActionColumn | null;
  children: ReactNode;
}) {
  if (!column) {
    return children;
  }
  return (
    <View style={[styles.column, { width: column.width }]} testID="composer-action-column">
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  column: {
    flexShrink: 0,
    alignItems: 'center',
  },
});
