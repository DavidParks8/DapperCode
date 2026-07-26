import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppTheme, type AppTheme } from '../theme';

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
}

const BACKDROP_APPEARS_AT = 0;
const BACKDROP_DISAPPEARS_AT = -1;

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
}: AppSheetProps) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheetModal>(null);
  const styles = useMemo(() => createAppSheetStyles(theme), [theme]);
  const contentBottomPadding = useMemo(
    () => ({ paddingBottom: insets.bottom + theme.spacing.lg + contentBottomInset }),
    [contentBottomInset, insets.bottom, theme.spacing.lg]
  );
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    if (visible) {
      sheetRef.current?.present();
      return;
    }
    sheetRef.current?.dismiss();
  }, [visible]);

  // Fires for drag-to-dismiss and backdrop taps as well as programmatic dismissal; the guard
  // keeps a close driven by `visible` from bouncing back into the caller.
  const handleDismiss = useCallback(() => {
    if (visibleRef.current) {
      onClose();
    }
  }, [onClose]);

  const renderBackdrop = useCallback(    (backdropProps: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...backdropProps}
        appearsOnIndex={BACKDROP_APPEARS_AT}
        disappearsOnIndex={BACKDROP_DISAPPEARS_AT}
        pressBehavior="close"
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ? `Close ${accessibilityLabel}` : 'Close sheet'}
      />
    ),
    [accessibilityLabel]
  );

  return (
    <BottomSheetModal
      ref={sheetRef}
      enablePanDownToClose
      enableDynamicSizing={snapPoints === undefined}
      maxDynamicContentSize={maxDynamicContentSize}
      snapPoints={snapPoints}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      onDismiss={handleDismiss}
      backdropComponent={renderBackdrop}
      backgroundStyle={styles.background}
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
          contentContainerStyle={[styles.content, styles.contentInner, contentBottomPadding]}
        >
          {children}
        </BottomSheetScrollView>
      ) : (
        <BottomSheetView
          accessibilityViewIsModal
          importantForAccessibility="yes"
          accessibilityLabel={accessibilityLabel}
          style={[styles.content, contentBottomPadding]}
        >
          <View style={styles.contentInner}>{children}</View>
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
    handleIndicator: { backgroundColor: theme.colors.border, width: 38, height: 4 },
    content: { paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.xs },
    contentInner: { gap: theme.spacing.md },
  });
}
