import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Keyboard, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  MIN_TOUCH_TARGET,
  SHEET_HANDLE_INDICATOR_HEIGHT,
  SHEET_HANDLE_INDICATOR_WIDTH,
  sheetContentBottomPadding,
  sheetContentHorizontalPadding,
  sheetHandleVerticalPadding,
} from '@shared/ui/sheetLayout';
import { useAppTheme, type AppTheme } from '@shared/theme';

export interface AppSheetProps {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Accessibility label for the sheet container. */
  accessibilityLabel?: string;
  /**
   * Fixed snap points. Omit to let the sheet size itself to its content, which is the right
   * default for menus and short forms.
   */
  snapPoints?: (string | number)[];
  /** Caps content-driven sizing so a long list still leaves the backdrop tappable. */
  maxDynamicContentSize?: number;
  /** Extra bottom padding beyond the safe-area inset. */
  contentBottomInset?: number;
  /** Renders the content in a scrollable container, for lists that can outgrow the sheet. */
  scrollable?: boolean;
  /**
   * Whether the sheet can be dismissed by dragging it down or tapping the backdrop. Prompts that
   * require an answer set this to false so the only way out is an explicit choice.
   */
  dismissible?: boolean;
}

const BACKDROP_APPEARS_AT = 0;
const BACKDROP_DISAPPEARS_AT = -1;
const HANDLE_VERTICAL_PADDING = sheetHandleVerticalPadding(
  SHEET_HANDLE_INDICATOR_HEIGHT,
  MIN_TOUCH_TARGET,
);

/**
 * The app's single sheet surface.
 *
 * Every picker, menu, and short form renders through this so there is one backdrop, one set of
 * sheet chrome, and one dismissal behaviour instead of a hand-rolled `<Modal>` per feature.
 */
export function AppSheet({
  visible,
  onClose,
  children,
  accessibilityLabel,
  snapPoints,
  maxDynamicContentSize,
  contentBottomInset = 0,
  scrollable = false,
  dismissible = true,
}: AppSheetProps) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheetModal>(null);
  const styles = useMemo(() => createAppSheetStyles(theme), [theme]);
  const contentEdgeInsets = useMemo(
    () => ({
      paddingLeft: sheetContentHorizontalPadding(insets.left, theme.spacing.lg),
      paddingRight: sheetContentHorizontalPadding(insets.right, theme.spacing.lg),
      paddingBottom: sheetContentBottomPadding(insets.bottom, theme.spacing.lg, contentBottomInset),
    }),
    [contentBottomInset, insets.bottom, insets.left, insets.right, theme.spacing.lg],
  );
  const visibleRef = useRef(visible);
  const presentedRef = useRef(false);
  visibleRef.current = visible;

  useEffect(() => {
    if (visible) {
      if (!presentedRef.current) {
        const present = () => {
          if (!visibleRef.current || presentedRef.current) {
            return;
          }
          presentedRef.current = true;
          sheetRef.current?.present();
        };

        if (Keyboard.isVisible()) {
          const keyboardHideSubscription = Keyboard.addListener('keyboardDidHide', present);
          Keyboard.dismiss();
          return () => keyboardHideSubscription.remove();
        }

        // Also clear text focus when a hardware keyboard is attached or the software keyboard has
        // already finished hiding. This keeps every sheet transition at the same interaction
        // boundary without delaying presentation when no keyboard occupies the viewport.
        Keyboard.dismiss();
        present();
      }
      return;
    }

    // @gorhom/bottom-sheet 5.2.11+ wedges a modal when dismiss() runs before its first
    // presentation or after a user dismissal. Only dismiss a sheet we still own as presented.
    if (presentedRef.current) {
      sheetRef.current?.dismiss();
    }
    return undefined;
  }, [visible]);

  // Fires for drag-to-dismiss and backdrop taps as well as programmatic dismissal; the guard
  // keeps a close driven by `visible` from bouncing back into the caller.
  const handleDismiss = useCallback(() => {
    const wasPresented = presentedRef.current;
    presentedRef.current = false;
    if (wasPresented && visibleRef.current) {
      onClose();
    }
  }, [onClose]);

  const renderBackdrop = useCallback(
    (backdropProps: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...backdropProps}
        appearsOnIndex={BACKDROP_APPEARS_AT}
        disappearsOnIndex={BACKDROP_DISAPPEARS_AT}
        pressBehavior={dismissible ? 'close' : 'none'}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ? `Close ${accessibilityLabel}` : 'Close sheet'}
      />
    ),
    [accessibilityLabel, dismissible],
  );

  return (
    <BottomSheetModal
      ref={sheetRef}
      enablePanDownToClose={dismissible}
      enableDynamicSizing={snapPoints === undefined}
      maxDynamicContentSize={maxDynamicContentSize}
      snapPoints={snapPoints}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      onDismiss={handleDismiss}
      backdropComponent={renderBackdrop}
      backgroundStyle={styles.background}
      handleStyle={styles.handle}
      handleIndicatorStyle={styles.handleIndicator}
      style={styles.sheet}
    >
      {scrollable ? (
        <BottomSheetScrollView
          accessibilityViewIsModal
          importantForAccessibility="yes"
          accessibilityLabel={accessibilityLabel}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.content}
        >
          <View testID="app-sheet-content" style={[styles.contentInner, contentEdgeInsets]}>
            {children}
          </View>
        </BottomSheetScrollView>
      ) : (
        <BottomSheetView
          accessibilityViewIsModal
          importantForAccessibility="yes"
          accessibilityLabel={accessibilityLabel}
          style={styles.content}
        >
          <View testID="app-sheet-content" style={[styles.contentInner, contentEdgeInsets]}>
            {children}
          </View>
        </BottomSheetView>
      )}
    </BottomSheetModal>
  );
}

function createAppSheetStyles(theme: AppTheme) {
  return StyleSheet.create({
    sheet: {
      boxShadow: theme.isDark
        ? '0 -10px 34px rgba(0, 0, 0, 0.42)'
        : '0 -10px 34px rgba(15, 23, 42, 0.12)',
    },
    background: {
      backgroundColor: theme.colors.bgElevated,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      borderCurve: 'continuous',
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
    },
    handle: {
      paddingTop: HANDLE_VERTICAL_PADDING,
      paddingBottom: HANDLE_VERTICAL_PADDING,
    },
    handleIndicator: {
      backgroundColor: theme.colors.border,
      width: SHEET_HANDLE_INDICATOR_WIDTH,
      height: SHEET_HANDLE_INDICATOR_HEIGHT,
    },
    content: { paddingTop: theme.spacing.xs },
    contentInner: { gap: theme.spacing.md },
  });
}
