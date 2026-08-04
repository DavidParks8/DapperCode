import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useRef } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { AgentDescriptor } from '@bridge/types/types';
import { AgentIcon } from '@shared/ui/AgentIcon';
import { useAppTheme, type AppTheme } from '@shared/theme';
import { GlassSurface } from '@shared/ui/glass/GlassSurface';
import { decorativeAccessibilityProps } from '@shared/accessibility';
import {
  CIRCULAR_TOOLBAR_BUTTON_SIZE,
  CircularToolbarButton,
} from '@shared/ui/CircularToolbarButton';

interface ChatHeaderProps {
  onOpenDrawer?: () => void;
  title: string;
  agent?: AgentDescriptor | null;
  /** Opens the rename sheet. Rendered as a dedicated button so the title stays draggable. */
  onRenameTitle?: () => void;
  /** Avoids nesting glass when the header shares a surface with adjacent chrome. */
  embeddedInGlass?: boolean;
  rightIconName?: keyof typeof Ionicons.glyphMap;
  onRightActionPress?: () => void;
}

export function ChatHeader({
  onOpenDrawer,
  title,
  agent,
  onRenameTitle,
  embeddedInGlass = false,
  rightIconName,
  onRightActionPress,
}: ChatHeaderProps) {
  const theme = useAppTheme();
  const { colors } = theme;
  const styles = useMemo(() => createStyles(theme), [theme]);
  const titleDisplay = title.trim() || 'New chat';

  const header = (
    <SafeAreaView edges={['top', 'left', 'right']}>
      <View style={styles.header} testID="chat-header-row">
        {onOpenDrawer ? (
          <CircularToolbarButton onPress={onOpenDrawer} accessibilityLabel="Open navigation drawer">
            <Ionicons
              {...decorativeAccessibilityProps}
              name="menu"
              size={20}
              color={colors.textPrimary}
            />
          </CircularToolbarButton>
        ) : null}
        {/*
            The title is a horizontally scrollable surface so a long session name can be read in
            full. It must not sit inside a Pressable: a press wrapper swallows the drag gesture on
            the scroll view and its own press never fires, which made tapping the title a no-op.
            Renaming lives in the dedicated button beside it instead.
          */}
        <View style={styles.titleRow} testID="chat-header-title-row">
          <ScrollableTitle title={titleDisplay} />
          <AgentIcon agent={agent} size={18} />
        </View>
        <View style={styles.headerSpacer} />
        {onRenameTitle || rightIconName ? (
          <View style={styles.toolbarActions} testID="chat-header-actions">
            {onRenameTitle ? (
              <CircularToolbarButton
                onPress={onRenameTitle}
                accessibilityLabel="Edit session title"
                accessibilityHint="Opens the rename form for this session"
              >
                <Ionicons
                  {...decorativeAccessibilityProps}
                  name="pencil"
                  size={18}
                  color={colors.textMuted}
                />
              </CircularToolbarButton>
            ) : null}
            {rightIconName ? (
              onRightActionPress ? (
                <CircularToolbarButton onPress={onRightActionPress} accessibilityLabel="Open Git">
                  <Ionicons
                    {...decorativeAccessibilityProps}
                    name={rightIconName}
                    size={18}
                    color={colors.textMuted}
                  />
                </CircularToolbarButton>
              ) : (
                <View style={styles.toolbarPlaceholder}>
                  <Ionicons
                    {...decorativeAccessibilityProps}
                    name={rightIconName}
                    size={18}
                    color={colors.textMuted}
                  />
                </View>
              )
            ) : null}
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );

  if (embeddedInGlass) {
    return header;
  }

  return (
    <GlassSurface role="chrome" style={styles.headerContainer} testID="chat-header-glass-surface">
      {header}
    </GlassSurface>
  );
}

function ScrollableTitle({ title }: { title: string }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ x: 0, animated: false });
  }, [title]);

  return (
    <View style={styles.titleViewport}>
      <ScrollView
        ref={scrollRef}
        horizontal
        bounces={false}
        scrollEnabled
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.titleScrollContent}
        accessibilityLabel={title}
      >
        <Text style={styles.modelName}>{title}</Text>
      </ScrollView>
    </View>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    headerContainer: {},
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      minHeight: 48,
      paddingHorizontal: theme.spacing.xs,
      // The selector row below is pulled up into this row's dead space, so the header has to win
      // touches in the overlap band or the leading button would lose its bottom edge.
      zIndex: 1,
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      flexShrink: 1,
      minWidth: 0,
    },
    headerSpacer: {
      flexGrow: 1,
      flexShrink: 0,
      minWidth: theme.spacing.sm,
    },
    toolbarActions: {
      flexDirection: 'row',
      alignItems: 'center',
      flexShrink: 0,
    },
    toolbarPlaceholder: {
      width: CIRCULAR_TOOLBAR_BUTTON_SIZE,
      height: CIRCULAR_TOOLBAR_BUTTON_SIZE,
      alignItems: 'center',
      justifyContent: 'center',
    },
    modelName: {
      ...theme.typography.headline,
    },
    titleViewport: {
      flexShrink: 1,
      minWidth: 0,
      height: 48,
      overflow: 'hidden',
    },
    titleScrollContent: {
      minHeight: 48,
      alignItems: 'center',
    },
  });
