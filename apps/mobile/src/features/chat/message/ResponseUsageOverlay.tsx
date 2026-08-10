import { useAtom } from 'jotai';
import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  BackHandler,
  Pressable,
  Text,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import { useAppTheme } from '@shared/theme';
import { GlassSurface } from '@shared/ui/glass/GlassSurface';
import { responseUsageOverlayAtom, type ResponseUsageAnchor } from '../state/modals';
import { buildResponseUsageStats, buildResponseUsageSummary } from './responseUsage';
import { createStyles } from './styles';

const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

/** Breathing room between the panel and both its anchor and the screen edges. */
const ANCHOR_GAP = 8;
const SCREEN_EDGE_GAP = 12;

interface PanelSize {
  width: number;
  height: number;
}

/**
 * Places the panel above its anchor, flipping below only when the space above cannot hold it.
 *
 * Positions are resolved against the window rather than the transcript because the panel is
 * rendered by a screen-level host, which is what lets it cover the header and composer.
 */
export function resolveResponseUsagePlacement({
  anchor,
  panel,
  window: windowSize,
  insets,
}: {
  anchor: ResponseUsageAnchor;
  panel: PanelSize | null;
  window: { width: number; height: number };
  insets: { top: number; bottom: number };
}): { left: number; top: number; maxWidth: number } {
  const maxWidth = Math.max(0, windowSize.width - SCREEN_EDGE_GAP * 2);
  const width = panel?.width ?? 0;
  const height = panel?.height ?? 0;

  const rightmostLeft = windowSize.width - SCREEN_EDGE_GAP - width;
  const left = Math.max(
    SCREEN_EDGE_GAP,
    Math.min(anchor.x, Math.max(SCREEN_EDGE_GAP, rightmostLeft)),
  );

  const above = anchor.y - ANCHOR_GAP - height;
  const below = anchor.y + anchor.height + ANCHOR_GAP;
  const fitsAbove = above >= insets.top + SCREEN_EDGE_GAP;
  const lowestTop = windowSize.height - insets.bottom - SCREEN_EDGE_GAP - height;
  const top = fitsAbove
    ? above
    : Math.max(insets.top + SCREEN_EDGE_GAP, Math.min(below, Math.max(0, lowestTop)));

  return { left, top, maxWidth };
}

/**
 * The floating response usage panel, hosted at screen level so it overlays the whole chat.
 *
 * A backdrop covers the screen behind it: it dismisses on a tap anywhere outside the panel, and by
 * swallowing touches it also stops the transcript scrolling out from under an anchor that was
 * measured once, which would otherwise leave the panel pointing at nothing.
 */
export function ResponseUsageOverlay() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [overlay, setOverlay] = useAtom(responseUsageOverlayAtom);
  const [panel, setPanel] = useState<PanelSize | null>(null);
  const windowSize = useWindowDimensions();
  const insets = useContext(SafeAreaInsetsContext) ?? ZERO_INSETS;

  const dismiss = useCallback(() => {
    setOverlay(null);
  }, [setOverlay]);

  const overlayId = overlay?.id;
  useEffect(() => {
    // A panel measured for one response tells us nothing about the next one's size.
    setPanel(null);
  }, [overlayId]);

  useEffect(() => {
    if (!overlay) {
      return undefined;
    }
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setOverlay(null);
      return true;
    });
    return () => {
      subscription.remove();
    };
  }, [overlay, setOverlay]);

  const handlePanelLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setPanel((current) =>
      current && current.width === width && current.height === height ? current : { width, height },
    );
  }, []);

  if (!overlay) {
    return null;
  }

  const stats = buildResponseUsageStats(overlay.usage);
  // Both the anchor and the panel's own size are needed before it can be placed, and each arrives
  // a frame after the tap.
  const placed = overlay.anchor !== null && panel !== null;
  const placement = resolveResponseUsagePlacement({
    anchor: overlay.anchor ?? { x: 0, y: 0, width: 0, height: 0 },
    panel,
    window: { width: windowSize.width, height: windowSize.height },
    insets: { top: insets.top, bottom: insets.bottom },
  });

  return (
    <View
      style={styles.responseUsageOverlayRoot}
      testID="response-usage-overlay"
      accessibilityViewIsModal
    >
      <Pressable
        testID="response-usage-overlay-backdrop"
        style={styles.responseUsageBackdrop}
        onPress={dismiss}
        accessibilityRole="button"
        accessibilityLabel="Close response details"
      />
      <Pressable
        testID="response-usage-overlay-panel"
        onPress={dismiss}
        onLayout={handlePanelLayout}
        style={[
          styles.responseUsagePopover,
          { left: placement.left, top: placement.top, maxWidth: placement.maxWidth },
          // Parked off screen until placed, rather than left to visibly jump across the screen.
          placed ? null : styles.responseUsagePopoverMeasuring,
        ]}
        accessible
        accessibilityRole="button"
        accessibilityLabel={`Response details. ${buildResponseUsageSummary(overlay.usage)}`}
        accessibilityHint="Hides these details"
      >
        <GlassSurface
          role="capsule"
          testID="response-usage-overlay-card"
          style={styles.responseUsageCard}
        >
          {stats.map((stat) => (
            <View key={stat.key} style={styles.responseUsageRow} accessibilityElementsHidden>
              <Text style={styles.responseUsageLabel}>{stat.label}</Text>
              <Text style={styles.responseUsageValue} numberOfLines={1}>
                {stat.value}
              </Text>
            </View>
          ))}
        </GlassSurface>
      </Pressable>
    </View>
  );
}
