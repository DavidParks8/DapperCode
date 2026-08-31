import { useAtom } from 'jotai';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  BackHandler,
  Pressable,
  Text,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import Animated, { useReducedMotion } from 'react-native-reanimated';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import { useAppTheme } from '@shared/theme';
import { GlassSurface } from '@shared/ui/glass/GlassSurface';
import {
  responseUsageOverlayAtom,
  type ResponseUsageAnchor,
  type ResponseUsageOverlay as ResponseUsageOverlayState,
} from '../state/modals';
import { buildResponseUsageStats, buildResponseUsageSummary } from './responseUsage';
import {
  POUR_EXIT_MS,
  resolvePourContentOffset,
  resolvePourOrigin,
  useResponseUsagePour,
} from './responseUsagePour';
import { createStyles } from './styles';

const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** Breathing room between the panel and both its anchor and the screen edges. */
const ANCHOR_GAP = 8;
const SCREEN_EDGE_GAP = 12;

interface PanelSize {
  width: number;
  height: number;
}

/** A panel size together with the response it was measured for. */
interface MeasuredPanel extends PanelSize {
  id: string;
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
}): { left: number; top: number; maxWidth: number; placedAbove: boolean } {
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

  return { left, top, maxWidth, placedAbove: fitsAbove };
}

/**
 * Keeps a dismissed panel mounted for the length of its exit.
 *
 * Clearing the atom drops the panel out of the tree on the next frame, which is what made it
 * vanish mid-air; retaining the last panel gives the glass time to retract into the button it
 * came from. Reduce Motion skips the wait entirely, because there is then no exit to cover.
 */
export function useRetainedResponseUsage(
  overlay: ResponseUsageOverlayState | null,
): { overlay: ResponseUsageOverlayState; closing: boolean } | null {
  const retainedRef = useRef<ResponseUsageOverlayState | null>(null);
  if (overlay) {
    retainedRef.current = overlay;
  }
  const [cleared, setCleared] = useState(true);
  if (overlay && cleared) {
    setCleared(false);
  }
  const closing = !overlay && !cleared;
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (!closing) {
      return undefined;
    }
    if (reducedMotion) {
      setCleared(true);
      return undefined;
    }
    const timer = setTimeout(() => setCleared(true), POUR_EXIT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [closing, reducedMotion]);

  const retained = retainedRef.current;
  if (!retained || (!overlay && cleared)) {
    return null;
  }
  return { overlay: retained, closing };
}

/**
 * Resolves where the panel sits and which point it pours out of.
 *
 * A panel measured for one response tells us nothing about the next one's size, so the measurement
 * carries the response it belongs to: clearing it instead would leave a stale size in the frame the
 * pour starts on, and the replacement would arrive already formed.
 */
function useResponseUsageGeometry(active: ResponseUsageOverlayState | null): {
  contentOffset: number;
  onPanelLayout: (event: LayoutChangeEvent) => void;
  origin: { x: number; y: number };
  placed: boolean;
  placement: ReturnType<typeof resolveResponseUsagePlacement>;
} {
  const [panel, setPanel] = useState<MeasuredPanel | null>(null);
  const windowSize = useWindowDimensions();
  const insets = useContext(SafeAreaInsetsContext) ?? ZERO_INSETS;

  const activeId = active?.id;
  const activeIdRef = useRef<string | undefined>(activeId);
  activeIdRef.current = activeId;
  const measured = panel && panel.id === activeId ? panel : null;

  const onPanelLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    const id = activeIdRef.current;
    if (id === undefined) {
      return;
    }
    setPanel((current) =>
      current && current.id === id && current.width === width && current.height === height
        ? current
        : { id, width, height },
    );
  }, []);

  // Both the anchor and the panel's own size are needed before it can be placed, and each arrives
  // a frame after the tap.
  const anchor = active?.anchor ?? null;
  const placement = resolveResponseUsagePlacement({
    anchor: anchor ?? { x: 0, y: 0, width: 0, height: 0 },
    panel: measured,
    window: { width: windowSize.width, height: windowSize.height },
    insets: { top: insets.top, bottom: insets.bottom },
  });

  return {
    contentOffset: resolvePourContentOffset(placement.placedAbove),
    onPanelLayout,
    origin: resolvePourOrigin({
      anchor,
      left: placement.left,
      panel: measured,
      placedAbove: placement.placedAbove,
    }),
    placed: anchor !== null && measured !== null,
    placement,
  };
}

/**
 * The floating response usage panel, hosted at screen level so it overlays the whole chat.
 *
 * A backdrop covers the screen behind it: it dismisses on a tap anywhere outside the panel, and by
 * swallowing touches it also stops the transcript scrolling out from under an anchor that was
 * measured once, which would otherwise leave the panel pointing at nothing.
 *
 * The panel pours out of the button that opened it and retracts back into it, so a dismissed panel
 * stays mounted until that exit has run; see `useRetainedResponseUsage`.
 */
export function ResponseUsageOverlay() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [overlay, setOverlay] = useAtom(responseUsageOverlayAtom);
  const presentation = useRetainedResponseUsage(overlay);
  const active = presentation?.overlay ?? null;
  const closing = presentation?.closing ?? false;
  const { contentOffset, onPanelLayout, origin, placed, placement } =
    useResponseUsageGeometry(active);
  const dismiss = useCallback(() => {
    setOverlay(null);
  }, [setOverlay]);

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

  const { shellStyle, contentStyle } = useResponseUsagePour({
    closing,
    contentOffset,
    overlayId: active?.id,
    placed,
  });

  if (!active) {
    return null;
  }

  const stats = buildResponseUsageStats(active.usage);

  return (
    <View
      style={styles.responseUsageOverlayRoot}
      testID="response-usage-overlay"
      // A retracting panel must stop swallowing taps and stop holding VoiceOver, or dismissing it
      // would eat whatever the reader reached for next.
      pointerEvents={closing ? 'none' : 'auto'}
      accessibilityViewIsModal={!closing}
      accessibilityElementsHidden={closing}
      importantForAccessibility={closing ? 'no-hide-descendants' : 'auto'}
    >
      <Pressable
        testID="response-usage-overlay-backdrop"
        style={styles.responseUsageBackdrop}
        onPress={dismiss}
        accessibilityRole="button"
        accessibilityLabel="Close response details"
      />
      <AnimatedPressable
        testID="response-usage-overlay-panel"
        onPress={dismiss}
        onLayout={onPanelLayout}
        style={[
          styles.responseUsagePopover,
          {
            left: placement.left,
            top: placement.top,
            maxWidth: placement.maxWidth,
            // Scaling about the centre would grow the glass beside its button instead of out of it.
            transformOrigin: [origin.x, origin.y, 0],
          },
          // Parked off screen until placed, rather than left to visibly jump across the screen.
          placed ? null : styles.responseUsagePopoverMeasuring,
          shellStyle,
        ]}
        accessible
        accessibilityRole="button"
        accessibilityLabel={`Response details. ${buildResponseUsageSummary(active.usage)}`}
        accessibilityHint="Hides these details"
      >
        <GlassSurface
          role="capsule"
          testID="response-usage-overlay-card"
          style={styles.responseUsageCard}
        >
          <Animated.View
            testID="response-usage-overlay-content"
            style={[styles.responseUsageContent, contentStyle]}
          >
            {stats.map((stat) => (
              <View key={stat.key} style={styles.responseUsageRow} accessibilityElementsHidden>
                <Text style={styles.responseUsageLabel}>{stat.label}</Text>
                <Text style={styles.responseUsageValue} numberOfLines={1}>
                  {stat.value}
                </Text>
              </View>
            ))}
          </Animated.View>
        </GlassSurface>
      </AnimatedPressable>
    </View>
  );
}
