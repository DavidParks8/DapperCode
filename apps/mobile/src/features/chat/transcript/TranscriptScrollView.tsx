import type { Ref } from 'react';
import { ScrollView, type ScrollViewProps, View } from 'react-native';

const IDLE_CONTENT_POSITION = { minIndexForVisible: 0 };
// Absolute insets ignore content padding, so the keyboard inset never moves the sentinel.
const ANCHOR_SENTINEL_STYLE = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  left: 0,
  width: 0,
} as const;

/**
 * iOS captures the scroll anchor with the previous props but adjusts with the next ones, and only
 * captures while anchoring is on. Enabling it mid-gesture would replay every content shift since
 * it was last on as one jump. Native anchoring therefore stays on: while the list anchors nothing,
 * it tracks a sentinel fixed at the content origin, which keeps the anchor fresh and never scrolls.
 */
function TranscriptScrollView({
  children,
  maintainVisibleContentPosition,
  ref,
  ...props
}: ScrollViewProps & { ref?: Ref<ScrollView> }) {
  return (
    <ScrollView
      {...props}
      ref={ref}
      maintainVisibleContentPosition={
        maintainVisibleContentPosition
          ? {
              ...maintainVisibleContentPosition,
              minIndexForVisible: maintainVisibleContentPosition.minIndexForVisible + 1,
            }
          : IDLE_CONTENT_POSITION
      }
    >
      <View collapsable={false} style={ANCHOR_SENTINEL_STYLE} />
      {children}
    </ScrollView>
  );
}

export const renderTranscriptScrollView = (props: ScrollViewProps) => (
  <TranscriptScrollView {...props} />
);
