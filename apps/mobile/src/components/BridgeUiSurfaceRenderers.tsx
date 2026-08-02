import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  LinearTransition,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Markdown from 'react-native-markdown-display';

import type {
  BridgeUiAction,
  BridgeUiBlock,
  BridgeUiProgressBlock,
  BridgeUiSurface,
} from '../api/types';
import {
  formatNumber,
  getChecklistGlyph,
  getSurfaceCollapsedSummary,
  getSurfaceIconName,
  getToneColor,
} from './bridge-ui-surface-helpers';
import { AppSheet } from './AppSheet';
import { createBridgeUiSurfaceStyles } from './bridge-ui-surface-styles';
import { useAppTheme } from '../theme';
import { motionDuration, motionEasing } from './motion';
import { computeHitSlop } from './touchTarget';
import { feedback } from '../feedback';
import { createWorkflowMarkdownStyles } from '../screens/main/mainScreenStyles';
import {
  controlAccessibilityState,
  decorativeAccessibilityProps,
  useAccessibilityAnnouncement,
  useModalAccessibilityFocus,
} from '../accessibility';

interface BridgeUiSurfaceProps {
  surface: BridgeUiSurface;
  scrollMaxHeight?: number;
  onAction: (surface: BridgeUiSurface, action: BridgeUiAction) => void;
  onDismiss: (surface: BridgeUiSurface) => void;
}

export function BridgeUiWorkflowCard({
  surface,
  scrollMaxHeight = 320,
  onAction,
  onDismiss,
}: BridgeUiSurfaceProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createBridgeUiSurfaceStyles(theme), [theme]);
  const [collapsed, setCollapsed] = useState(false);

  const handleToggleCollapse = useCallback(() => {
    setCollapsed((value) => !value);
  }, []);

  return (
    <Animated.View
      style={[styles.surfaceCard, styles.workflowCard]}
      layout={LinearTransition.duration(motionDuration.layout).easing(
        Easing.bezier(...motionEasing.standard),
      )}
    >
      <SurfaceHeader
        surface={surface}
        onDismiss={onDismiss}
        collapsed={collapsed}
        onToggleCollapse={handleToggleCollapse}
      />
      {collapsed ? null : (
        <Animated.View
          entering={FadeIn.duration(motionDuration.routine).easing(
            Easing.bezier(...motionEasing.standard),
          )}
          exiting={FadeOut.duration(motionDuration.immediate)}
        >
          <ScrollView
            nestedScrollEnabled
            bounces={false}
            style={{ maxHeight: scrollMaxHeight }}
            contentContainerStyle={styles.surfaceBody}
            showsVerticalScrollIndicator
          >
            <SurfaceContent surface={surface} />
          </ScrollView>
          <SurfaceActions surface={surface} onAction={onAction} />
        </Animated.View>
      )}
    </Animated.View>
  );
}

export function BridgeUiBanner({ surface, onAction, onDismiss }: BridgeUiSurfaceProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createBridgeUiSurfaceStyles(theme), [theme]);

  return (
    <View style={[styles.surfaceCard, styles.bannerCard]}>
      <SurfaceHeader surface={surface} onDismiss={onDismiss} compact />
      <SurfaceContent surface={surface} compact />
      <SurfaceActions surface={surface} onAction={onAction} compact />
    </View>
  );
}

export function BridgeUiModal({ surface, onAction, onDismiss }: BridgeUiSurfaceProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createBridgeUiSurfaceStyles(theme), [theme]);
  const modalFocusRef = useModalAccessibilityFocus(true);
  useAccessibilityAnnouncement(`${surface.title}. ${surface.subtitle ?? ''}`);

  const dismissible = surface.dismissible !== false;

  return (
    <AppSheet
      visible
      dismissible={dismissible}
      accessibilityLabel={surface.title}
      onClose={() => {
        if (dismissible) {
          onDismiss(surface);
        }
      }}
    >
      <View ref={modalFocusRef}>
        <SurfaceHeader surface={surface} onDismiss={onDismiss} />
      </View>
      <ScrollView
        style={styles.modalScroll}
        contentContainerStyle={styles.surfaceBody}
        showsVerticalScrollIndicator={false}
      >
        <SurfaceContent surface={surface} />
      </ScrollView>
      <SurfaceActions surface={surface} onAction={onAction} />
    </AppSheet>
  );
}

function SurfaceHeader({
  surface,
  onDismiss,
  compact = false,
  collapsed,
  onToggleCollapse,
}: {
  surface: BridgeUiSurface;
  onDismiss: (surface: BridgeUiSurface) => void;
  compact?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createBridgeUiSurfaceStyles(theme), [theme]);
  const iconName = getSurfaceIconName(surface);
  const collapsible = typeof onToggleCollapse === 'function';
  const collapsedSummary = useMemo(() => getSurfaceCollapsedSummary(surface), [surface]);
  const headerContent = (
    <>
      <View style={styles.headerIcon}>
        <Ionicons
          {...decorativeAccessibilityProps}
          name={iconName}
          size={15}
          color={getToneColor(theme, surface)}
        />
      </View>
      <View style={styles.headerCopy}>
        <Text style={styles.title}>{surface.title}</Text>
        {collapsed && collapsedSummary ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {collapsedSummary}
          </Text>
        ) : surface.subtitle ? (
          <Text style={styles.subtitle} numberOfLines={compact ? 1 : 2}>
            {surface.subtitle}
          </Text>
        ) : null}
      </View>
    </>
  );

  if (collapsible) {
    return (
      <Pressable
        onPress={() => {
          void feedback.selection();
          onToggleCollapse();
        }}
        style={({ pressed }) => [
          styles.header,
          styles.headerPressable,
          compact && styles.headerCompact,
          pressed && styles.pressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel={collapsed ? 'Expand surface' : 'Collapse surface'}
        accessibilityHint={`${collapsed ? 'Shows' : 'Hides'} ${surface.title} details`}
        accessibilityState={controlAccessibilityState({ expanded: !collapsed })}
      >
        {headerContent}
        <Ionicons
          {...decorativeAccessibilityProps}
          name={collapsed ? 'chevron-down-outline' : 'chevron-up-outline'}
          size={16}
          color={theme.colors.textMuted}
        />
      </Pressable>
    );
  }

  return (
    <View style={[styles.header, compact && styles.headerCompact]}>
      {headerContent}
      {surface.dismissible === false ? null : (
        <Pressable
          onPress={() => onDismiss(surface)}
          hitSlop={computeHitSlop({ width: 26, height: 26 })}
          style={({ pressed }) => [styles.dismissButton, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={`Dismiss ${surface.title}`}
        >
          <Ionicons
            {...decorativeAccessibilityProps}
            name="close"
            size={16}
            color={theme.colors.textMuted}
          />
        </Pressable>
      )}
    </View>
  );
}

function SurfaceContent({
  surface,
  compact = false,
}: {
  surface: BridgeUiSurface;
  compact?: boolean;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createBridgeUiSurfaceStyles(theme), [theme]);
  const markdownStyles = useMemo(() => createWorkflowMarkdownStyles(theme), [theme]);

  return (
    <>
      {surface.bodyMarkdown ? (
        <Markdown style={markdownStyles}>{surface.bodyMarkdown}</Markdown>
      ) : null}
      {surface.blocks.map((block, index) => (
        <SurfaceBlock
          key={`${surface.id}-${String(index)}-${block.type}`}
          block={block}
          compact={compact}
        />
      ))}
      {!surface.bodyMarkdown && surface.blocks.length === 0 ? (
        <Text style={styles.emptyText}>No details provided.</Text>
      ) : null}
    </>
  );
}

function SurfaceBlock({ block, compact }: { block: BridgeUiBlock; compact?: boolean }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createBridgeUiSurfaceStyles(theme), [theme]);
  const markdownStyles = useMemo(() => createWorkflowMarkdownStyles(theme), [theme]);

  switch (block.type) {
    case 'text':
      return <Text style={styles.bodyText}>{block.text}</Text>;
    case 'markdown':
      return <Markdown style={markdownStyles}>{block.markdown}</Markdown>;
    case 'checklist':
      return (
        <View style={styles.checklist}>
          {block.items.map((item, index) => (
            <View key={`${item.label}-${String(index)}`} style={styles.checklistRow}>
              <Text style={styles.checklistGlyph}>{getChecklistGlyph(item.status)}</Text>
              <View style={styles.checklistCopy}>
                <Text style={styles.bodyText}>{item.label}</Text>
                {item.detail ? <Text style={styles.detailText}>{item.detail}</Text> : null}
              </View>
            </View>
          ))}
        </View>
      );
    case 'keyValue':
      return (
        <View style={[styles.keyValueGrid, compact && styles.keyValueGridCompact]}>
          {block.items.map((item) => (
            <View key={item.label} style={styles.keyValueRow}>
              <Text style={styles.keyLabel}>{item.label}</Text>
              <Text style={styles.keyValue}>{item.value}</Text>
            </View>
          ))}
        </View>
      );
    case 'code':
      return (
        <View style={styles.codeBlock}>
          {block.language ? <Text style={styles.codeLanguage}>{block.language}</Text> : null}
          <Text selectable style={styles.codeText}>
            {block.text}
          </Text>
        </View>
      );
    case 'progress':
      return <ProgressBlock block={block} />;
  }
}

function ProgressBlock({ block }: { block: BridgeUiProgressBlock }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createBridgeUiSurfaceStyles(theme), [theme]);
  const ratio = Math.max(0, Math.min(1, block.value / block.max));
  const progressWidth = useSharedValue(ratio);

  useEffect(() => {
    progressWidth.value = withTiming(ratio, {
      duration: motionDuration.routine,
      easing: Easing.bezier(...motionEasing.standard),
      reduceMotion: ReduceMotion.System,
    });
  }, [ratio, progressWidth]);

  const fillStyle = useAnimatedStyle(() => ({
    width: `${progressWidth.value * 100}%` as `${number}%`,
  }));

  return (
    <View
      style={styles.progressBlock}
      accessibilityRole="progressbar"
      accessibilityLabel={block.label}
      accessibilityValue={{
        min: 0,
        max: block.max,
        now: block.value,
        text: block.detail ?? undefined,
      }}
      accessibilityLiveRegion="polite"
    >
      <View style={styles.progressHeader}>
        <Text style={styles.bodyText}>{block.label}</Text>
        <Text style={styles.detailText}>
          {`${formatNumber(block.value)} / ${formatNumber(block.max)}`}
        </Text>
      </View>
      <View style={styles.progressTrack}>
        <Animated.View style={[styles.progressFill, fillStyle]} />
      </View>
      {block.detail ? <Text style={styles.detailText}>{block.detail}</Text> : null}
    </View>
  );
}

function SurfaceActions({
  surface,
  onAction,
  compact = false,
}: {
  surface: BridgeUiSurface;
  onAction: (surface: BridgeUiSurface, action: BridgeUiAction) => void;
  compact?: boolean;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createBridgeUiSurfaceStyles(theme), [theme]);

  if (surface.actions.length === 0) {
    return null;
  }

  return (
    <View style={[styles.actions, compact && styles.actionsCompact]}>
      {surface.actions.map((action) => (
        <Pressable
          key={action.id}
          onPress={() => {
            void feedback.selection();
            onAction(surface, action);
          }}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          style={({ pressed }) => [
            styles.actionButton,
            action.style === 'primary' && styles.actionButtonPrimary,
            action.style === 'destructive' && styles.actionButtonDestructive,
            pressed && styles.pressed,
          ]}
        >
          <Text
            style={[
              styles.actionLabel,
              action.style === 'primary' && styles.actionLabelPrimary,
              action.style === 'destructive' && styles.actionLabelDestructive,
            ]}
          >
            {action.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
