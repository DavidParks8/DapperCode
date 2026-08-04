import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { AgentDescriptor } from '@bridge/types/types';
import { AgentIcon } from '@shared/ui/AgentIcon';
import { useAppTheme, type AppTheme } from '@shared/theme';
import { GlassSurface } from '@shared/ui/glass/GlassSurface';
import { computeHitSlop } from '@shared/ui/touchTarget';
import { decorativeAccessibilityProps } from '@shared/accessibility';

const MENU_BUTTON_VISIBLE_SIZE = { width: 24, height: 24 };
const RIGHT_BUTTON_VISIBLE_SIZE = { width: 22, height: 22 };

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
  const menuHitSlop = useMemo(() => computeHitSlop(MENU_BUTTON_VISIBLE_SIZE, { minimum: 48 }), []);
  const rightHitSlop = useMemo(
    () => computeHitSlop(RIGHT_BUTTON_VISIBLE_SIZE, { minimum: 48 }),
    [],
  );

  const header = (
    <SafeAreaView edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        {onOpenDrawer ? (
          <Pressable
            onPress={onOpenDrawer}
            hitSlop={menuHitSlop}
            style={styles.menuBtn}
            accessibilityRole="button"
            accessibilityLabel="Open navigation drawer"
          >
            <Ionicons
              {...decorativeAccessibilityProps}
              name="menu"
              size={20}
              color={colors.textPrimary}
            />
          </Pressable>
        ) : null}
        {/*
            The title is a horizontally scrollable surface so a long session name can be read in
            full. It must not sit inside a Pressable: a press wrapper swallows the drag gesture on
            the scroll view and its own press never fires, which made tapping the title a no-op.
            Renaming lives in the dedicated button beside it instead.
          */}
        <View style={styles.titleRow}>
          <ScrollableTitle title={titleDisplay} />
          <AgentIcon agent={agent} size={18} />
          {onRenameTitle ? (
            <Pressable
              onPress={onRenameTitle}
              style={({ pressed }) => [styles.editBtn, pressed && styles.editBtnPressed]}
              accessibilityRole="button"
              accessibilityLabel="Edit session title"
              accessibilityHint="Opens the rename form for this session"
            >
              <Ionicons
                {...decorativeAccessibilityProps}
                name="pencil"
                size={18}
                color={colors.textMuted}
              />
            </Pressable>
          ) : null}
        </View>
        <View style={{ flex: 1 }} />
        {rightIconName ? (
          onRightActionPress ? (
            <Pressable
              onPress={onRightActionPress}
              hitSlop={rightHitSlop}
              style={styles.rightBtn}
              accessibilityRole="button"
              accessibilityLabel="Open Git"
            >
              <Ionicons
                {...decorativeAccessibilityProps}
                name={rightIconName}
                size={18}
                color={colors.textMuted}
              />
            </Pressable>
          ) : (
            <Ionicons
              {...decorativeAccessibilityProps}
              name={rightIconName}
              size={18}
              color={colors.textMuted}
            />
          )
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
      gap: theme.spacing.sm,
      minHeight: 48,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.sm,
    },
    menuBtn: {
      padding: 2,
    },
    rightBtn: {
      padding: 2,
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      flexShrink: 1,
      minWidth: 0,
    },
    editBtn: {
      flexShrink: 0,
      width: 48,
      height: 48,
      borderRadius: theme.radius.sm,
      alignItems: 'center',
      justifyContent: 'center',
    },
    editBtnPressed: {
      backgroundColor: theme.colors.bgItem,
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
