import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { AgentDescriptor } from '../api/types';
import { AgentIcon } from './AgentIcon';
import { useAppTheme, type AppTheme } from '../theme';
import { computeHitSlop } from './touchTarget';
import { decorativeAccessibilityProps } from '../accessibility';

const MENU_BUTTON_VISIBLE_SIZE = { width: 24, height: 24 };
const RIGHT_BUTTON_VISIBLE_SIZE = { width: 22, height: 22 };
const EDIT_BUTTON_VISIBLE_SIZE = { width: 22, height: 22 };


interface ChatHeaderProps {
  onOpenDrawer?: () => void;
  title: string;
  agent?: AgentDescriptor | null;
  /** Opens the rename sheet. Rendered as a dedicated button so the title stays draggable. */
  onRenameTitle?: () => void;
  rightIconName?: keyof typeof Ionicons.glyphMap;
  onRightActionPress?: () => void;
}

export function ChatHeader({
  onOpenDrawer,
  title,
  agent,
  onRenameTitle,
  rightIconName,
  onRightActionPress,
}: ChatHeaderProps) {
  const theme = useAppTheme();
  const { colors } = theme;
  const styles = useMemo(() => createStyles(theme), [theme]);
  const titleDisplay = title.trim() || 'New chat';
  const menuHitSlop = useMemo(() => computeHitSlop(MENU_BUTTON_VISIBLE_SIZE), []);
  const rightHitSlop = useMemo(() => computeHitSlop(RIGHT_BUTTON_VISIBLE_SIZE), []);
  const editHitSlop = useMemo(() => computeHitSlop(EDIT_BUTTON_VISIBLE_SIZE), []);

  return (
    <View style={styles.headerContainer}>
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
                hitSlop={editHitSlop}
                style={({ pressed }) => [styles.editBtn, pressed && styles.editBtnPressed]}
                accessibilityRole="button"
                accessibilityLabel="Edit session title"
                accessibilityHint="Opens the rename form for this session"
              >
                <Ionicons
                  {...decorativeAccessibilityProps}
                  name="pencil"
                  size={14}
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
    </View>
  );
}

function ScrollableTitle({ title }: { title: string }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const scrollRef = useRef<ScrollView>(null);
  const viewportWidthRef = useRef(0);
  const contentWidthRef = useRef(0);
  const offsetRef = useRef(0);
  const [showLeftFade, setShowLeftFade] = useState(false);
  const [showRightFade, setShowRightFade] = useState(false);

  const updateFades = (offsetX: number) => {
    offsetRef.current = offsetX;
    const maxOffset = Math.max(0, contentWidthRef.current - viewportWidthRef.current);
    setShowLeftFade(offsetX > 1);
    setShowRightFade(offsetX < maxOffset - 1);
  };

  useEffect(() => {
    scrollRef.current?.scrollTo({ x: 0, animated: false });
    updateFades(0);
  }, [title]);

  return (
    <View style={styles.titleViewport}>
      <ScrollView
        ref={scrollRef}
        horizontal
        bounces={false}
        scrollEnabled
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={16}
        accessibilityLabel={title}
        onLayout={(event) => {
          viewportWidthRef.current = event.nativeEvent.layout.width;
          updateFades(offsetRef.current);
        }}
        onContentSizeChange={(width) => {
          contentWidthRef.current = width;
          updateFades(offsetRef.current);
        }}
        onScroll={(event: NativeSyntheticEvent<NativeScrollEvent>) => {
          updateFades(event.nativeEvent.contentOffset.x);
        }}
      >
        <Text style={styles.modelName}>{title}</Text>
      </ScrollView>
      {showLeftFade ? (
        <LinearGradient
          pointerEvents="none"
          colors={[theme.colors.bgMain, theme.colors.transparent]}
          style={[styles.titleFade, styles.titleFadeLeft]}
        />
      ) : null}
      {showRightFade ? (
        <LinearGradient
          pointerEvents="none"
          colors={[theme.colors.transparent, theme.colors.bgMain]}
          style={[styles.titleFade, styles.titleFadeRight]}
        />
      ) : null}
    </View>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    headerContainer: {
      backgroundColor: theme.colors.bgMain,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
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
      borderRadius: theme.radius.sm,
      padding: 4,
    },
    editBtnPressed: {
      backgroundColor: theme.colors.bgItem,
    },
    modelName: {
      ...theme.typography.headline,
    },
    titleViewport: {
      position: 'relative',
      flexShrink: 1,
      minWidth: 0,
      overflow: 'hidden',
    },
    titleFade: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      width: 22,
    },
    titleFadeLeft: {
      left: 0,
    },
    titleFadeRight: {
      right: 0,
    },
  });
