import { Ionicons } from '@expo/vector-icons';
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, G, Path, Rect } from 'react-native-svg';
import Animated, {
  type SharedValue,
  useAnimatedProps,
  useDerivedValue,
  useReducedMotion,
} from 'react-native-reanimated';

import { decorativeAccessibilityProps } from '@shared/accessibility';
import { type AppTheme, useAppTheme } from '@shared/theme';
import { repeatingProgress, useChatAnimationTime } from '../../animation/ChatAnimationClock';
import { createMermaidDiagramStyles } from './mermaidDiagramStyles';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedRect = Animated.createAnimatedComponent(Rect);

const CYCLE_DURATION_MS = 2_800;
const STATIC_PHASE = 0.88;
const ROUTE_DASH_LENGTH = 164;

type Point = readonly [x: number, y: number];

interface Route {
  id: 'left' | 'right';
  path: string;
  points: readonly [Point, Point, Point, Point];
  startsAt: number;
  endsAt: number;
  target: Point;
}

const ROUTES: readonly Route[] = [
  {
    id: 'left',
    path: 'M160 52 C160 88 68 82 68 126',
    points: [
      [160, 52],
      [160, 88],
      [68, 82],
      [68, 126],
    ],
    startsAt: 0.12,
    endsAt: 0.4,
    target: [68, 143],
  },
  {
    id: 'right',
    path: 'M160 52 C160 88 252 82 252 126',
    points: [
      [160, 52],
      [160, 88],
      [252, 82],
      [252, 126],
    ],
    startsAt: 0.44,
    endsAt: 0.72,
    target: [252, 143],
  },
];

function clampUnit(value: number): number {
  'worklet';
  return Math.min(1, Math.max(0, value));
}

function progressBetween(phase: number, startsAt: number, endsAt: number): number {
  'worklet';
  const progress = clampUnit((phase - startsAt) / (endsAt - startsAt));
  return 1 - (1 - progress) ** 3;
}

function cycleIntensity(phase: number): number {
  'worklet';
  const fade = clampUnit((1 - phase) / 0.12);
  return fade * fade * (3 - 2 * fade);
}

function cubicBezierPoint(points: Route['points'], progress: number): Point {
  'worklet';
  const inverse = 1 - progress;
  const [start, controlOne, controlTwo, end] = points;
  return [
    inverse ** 3 * start[0] +
      3 * inverse ** 2 * progress * controlOne[0] +
      3 * inverse * progress ** 2 * controlTwo[0] +
      progress ** 3 * end[0],
    inverse ** 3 * start[1] +
      3 * inverse ** 2 * progress * controlOne[1] +
      3 * inverse * progress ** 2 * controlTwo[1] +
      progress ** 3 * end[1],
  ];
}

function DrawingRoute({
  phase,
  route,
  theme,
}: {
  phase: SharedValue<number>;
  route: Route;
  theme: AppTheme;
}) {
  const routeProps = useAnimatedProps(() => {
    const progress = progressBetween(phase.value, route.startsAt, route.endsAt);
    return {
      opacity: progress * cycleIntensity(phase.value),
      strokeDashoffset: ROUTE_DASH_LENGTH * (1 - progress),
    };
  });
  const signalProps = useAnimatedProps(() => {
    const progress = progressBetween(phase.value, route.startsAt, route.endsAt);
    const [cx, cy] = cubicBezierPoint(route.points, progress);
    const visibility = Math.sin(Math.PI * progress);
    return {
      cx,
      cy,
      opacity: visibility,
      r: 2.75 + visibility * 1.25,
    };
  });

  return (
    <>
      <Path
        d={route.path}
        fill="none"
        stroke={theme.colors.borderLight}
        strokeLinecap="round"
        strokeWidth={1.5}
      />
      <AnimatedPath
        testID={`mermaid-loading-route-${route.id}`}
        d={route.path}
        fill="none"
        stroke={theme.colors.accent}
        strokeDasharray={[ROUTE_DASH_LENGTH, ROUTE_DASH_LENGTH]}
        strokeLinecap="round"
        strokeWidth={2}
        animatedProps={routeProps}
      />
      <AnimatedCircle
        testID={`mermaid-loading-signal-${route.id}`}
        fill={theme.colors.accent}
        animatedProps={signalProps}
      />
    </>
  );
}

function ActivatingNode({
  phase,
  startsAt,
  target,
  testID,
  theme,
}: {
  phase: SharedValue<number>;
  startsAt: number;
  target: Point;
  testID: string;
  theme: AppTheme;
}) {
  const [cx, cy] = target;
  const x = cx - 36;
  const y = cy - 17;
  const activeProps = useAnimatedProps(() => {
    const progress = progressBetween(phase.value, startsAt, startsAt + 0.1);
    const intensity = cycleIntensity(phase.value);
    return {
      fillOpacity: progress * intensity * 0.13,
      strokeOpacity: progress * intensity,
    };
  });

  return (
    <G transform={`translate(${String(x)} ${String(y)})`}>
      <Rect
        width={72}
        height={34}
        rx={9}
        fill={theme.colors.bgItem}
        stroke={theme.colors.borderHighlight}
        strokeWidth={1}
      />
      <Rect
        transform="translate(13 11)"
        width={30}
        height={4}
        rx={2}
        fill={theme.colors.textMuted}
        opacity={0.42}
      />
      <Rect
        transform="translate(13 19)"
        width={46}
        height={3}
        rx={1.5}
        fill={theme.colors.textMuted}
        opacity={0.2}
      />
      <AnimatedRect
        testID={testID}
        width={72}
        height={34}
        rx={9}
        fill={theme.colors.accent}
        stroke={theme.colors.accent}
        strokeWidth={1.5}
        animatedProps={activeProps}
      />
    </G>
  );
}

export function MermaidLoadingCanvas({
  accessibilityLabel,
  testID,
}: {
  accessibilityLabel: string;
  testID: string;
}) {
  const theme = useAppTheme();
  const reduceMotion = useReducedMotion();
  const animationTime = useChatAnimationTime(!reduceMotion);
  const phase = useDerivedValue(
    () => (reduceMotion ? STATIC_PHASE : repeatingProgress(animationTime.value, CYCLE_DURATION_MS)),
    [animationTime, reduceMotion],
  );

  return (
    <View
      testID={testID}
      style={styles.canvas}
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ busy: true }}
    >
      <Svg
        width="100%"
        height="100%"
        viewBox="0 0 320 180"
        preserveAspectRatio="xMidYMid meet"
        pointerEvents="none"
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {ROUTES.map((route) => (
          <DrawingRoute key={route.id} phase={phase} route={route} theme={theme} />
        ))}
        <ActivatingNode
          phase={phase}
          startsAt={0}
          target={[160, 35]}
          testID="mermaid-loading-node-root"
          theme={theme}
        />
        {ROUTES.map((route) => (
          <ActivatingNode
            key={route.id}
            phase={phase}
            startsAt={route.endsAt}
            target={route.target}
            testID={`mermaid-loading-node-${route.id}`}
            theme={theme}
          />
        ))}
      </Svg>
    </View>
  );
}

export function MermaidStreamingPlaceholder() {
  const theme = useAppTheme();
  const diagramStyles = useMemo(() => createMermaidDiagramStyles(theme), [theme]);
  const componentStyles = useMemo(() => createStyles(theme), [theme]);

  return (
    <View style={diagramStyles.surface} testID="mermaid-streaming-placeholder">
      <View
        style={diagramStyles.header}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <View style={diagramStyles.headerTitleGroup}>
          <Ionicons
            {...decorativeAccessibilityProps}
            name="git-network-outline"
            size={15}
            color={theme.colors.textMuted}
          />
          <Text style={diagramStyles.languageLabel} numberOfLines={1}>
            Mermaid
          </Text>
        </View>
        <View style={componentStyles.status}>
          <View style={componentStyles.statusDot} />
          <Text style={componentStyles.statusText}>Building</Text>
        </View>
      </View>
      <View style={[diagramStyles.preview, componentStyles.preview]}>
        <MermaidLoadingCanvas
          testID="mermaid-streaming-canvas"
          accessibilityLabel="Building Mermaid diagram"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: {
    width: '100%',
    height: '100%',
  },
});

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    preview: {
      height: 196,
    },
    status: {
      minHeight: theme.touchTarget.minimum,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      paddingHorizontal: theme.spacing.md,
    },
    statusDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: theme.colors.accent,
    },
    statusText: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
    },
  });
