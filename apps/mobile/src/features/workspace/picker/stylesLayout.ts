import { StyleSheet } from 'react-native';

import type { AppTheme } from '@shared/theme';

/** iOS nav bar height, so the picker's chrome lines up with every pushed screen in the app. */
const NAV_BAR_HEIGHT = 44;
export const NAV_BAR_CIRCLE_SIZE = 30;
/** Text bar buttons are drawn compact; `computeHitSlop` pads them back to the platform minimum. */
export const NAV_BAR_TEXT_BUTTON_HEIGHT = 32;
export const NAV_BAR_TEXT_BUTTON_WIDTH = 64;
const SEARCH_FIELD_HEIGHT = 36;
/** Grouped section headers sit one gutter further in than the group itself, as UIKit insets them. */
const SECTION_TITLE_INSET = 32;
/** Shared with the menu so its anchor math and its card agree on a size. */
export const MENU_WIDTH = 264;
export const MENU_ROW_HEIGHT = 46;
export const MENU_TITLE_HEIGHT = 32;

export const createWorkspacePickerLayoutStyles = (theme: AppTheme) => ({
  root: { flex: 1, backgroundColor: theme.colors.bgMain },
  screen: { flex: 1 },

  navBar: {
    height: NAV_BAR_HEIGHT,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    paddingHorizontal: theme.spacing.lg,
    gap: theme.spacing.sm,
  },
  navBarTextButton: {
    minHeight: NAV_BAR_TEXT_BUTTON_HEIGHT,
    justifyContent: 'center' as const,
  },
  navBarButtonLabel: {
    ...theme.typography.headline,
    fontWeight: '400' as const,
    color: theme.colors.accent,
  },
  navBarSide: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
  },
  navBarSideEnd: { justifyContent: 'flex-end' as const },
  navBarTitleSlot: {
    flexShrink: 1,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  navBarTitleWrap: { maxWidth: '100%' as const },
  navBarTitleButton: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: theme.spacing.xs,
    paddingVertical: theme.spacing.xs,
  },
  navBarTitle: { ...theme.typography.headline, flexShrink: 1 },
  navBarCircleButton: {
    width: NAV_BAR_CIRCLE_SIZE,
    height: NAV_BAR_CIRCLE_SIZE,
    borderRadius: theme.radius.full,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    backgroundColor: theme.colors.bgItem,
  },

  listHeader: { paddingTop: theme.spacing.xs },
  largeTitleWrap: {
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.md,
  },
  largeTitleButton: {
    alignSelf: 'flex-start' as const,
    maxWidth: '100%' as const,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: theme.spacing.sm,
  },
  largeTitle: { ...theme.typography.largeTitle, flexShrink: 1 },
  largeTitleChevron: { marginTop: 3 },

  searchField: {
    height: SEARCH_FIELD_HEIGHT,
    marginHorizontal: theme.spacing.lg,
    marginBottom: theme.spacing.xl,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.bgInput,
    paddingHorizontal: theme.spacing.md,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: theme.spacing.sm,
  },
  searchInput: {
    flex: 1,
    ...theme.typography.headline,
    fontWeight: '400' as const,
    paddingVertical: 0,
  },

  section: { marginBottom: theme.spacing.xxl },
  sectionTitle: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    fontWeight: '600' as const,
    marginLeft: SECTION_TITLE_INSET,
    marginRight: theme.spacing.lg,
    marginBottom: theme.spacing.sm,
  },
  group: {
    marginHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.bgItem,
    overflow: 'hidden' as const,
  },
  /** Rows rendered straight into the list own their corners individually, not as a block. */
  groupFlush: { borderRadius: 0 },
  groupFirst: {
    borderTopLeftRadius: theme.radius.md,
    borderTopRightRadius: theme.radius.md,
  },
  groupLast: {
    borderBottomLeftRadius: theme.radius.md,
    borderBottomRightRadius: theme.radius.md,
  },

  menuLayer: { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0 },
  menuScrim: {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.colors.overlayBackdrop,
  },
  menuCard: {
    position: 'absolute' as const,
    width: MENU_WIDTH,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.bgInput,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    overflow: 'hidden' as const,
    ...theme.shadow.sm,
  },
  menuTitle: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    fontWeight: '600' as const,
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.xs,
  },
  menuSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.borderLight,
  },
  menuRow: {
    minHeight: MENU_ROW_HEIGHT,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    paddingHorizontal: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  menuRowPressed: { backgroundColor: theme.colors.bgItem },
  menuRowLabel: {
    flex: 1,
    ...theme.typography.headline,
    fontWeight: '400' as const,
  },
  menuCheckSlot: { width: 16, alignItems: 'center' as const },

  buttonDisabled: { opacity: 0.42 },
  pressed: { opacity: 0.72 },
});
