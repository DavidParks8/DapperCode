import { Pressable, Text, View } from 'react-native';

import { controlAccessibilityState } from '@shared/accessibility';
import type { WorkspacePickerStyles } from './styles';

/**
 * Grouped-list footer copy: errors first, then the notices that explain a partial listing, then
 * the one hint that makes the hidden long-press menu discoverable.
 */
export function WorkspacePickerListFooter({
  styles,
  error,
  refreshError,
  truncationMessage,
  hint,
}: {
  styles: WorkspacePickerStyles;
  error: string | null;
  refreshError: string | null;
  truncationMessage: string | null;
  hint: string | null;
}) {
  return (
    <View style={styles.listFooter}>
      {error ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
          style={styles.errorText}
        >
          {error}
        </Text>
      ) : null}
      {refreshError ? (
        <Text accessibilityLiveRegion="polite" style={styles.errorText}>
          {refreshError}
        </Text>
      ) : null}
      {truncationMessage ? (
        <Text accessibilityLiveRegion="polite" style={styles.footerNote}>
          {truncationMessage}
        </Text>
      ) : null}
      {hint ? <Text style={styles.footerNote}>{hint}</Text> : null}
    </View>
  );
}

/**
 * The bottom bar. One prominent, unambiguous commit action naming the folder it will use, with the
 * full path above it so the choice is legible before it is made.
 */
export function WorkspacePickerToolbar({
  styles,
  footerPath,
  footerTitle,
  footerSubtitle,
  onSelectPath,
}: {
  styles: WorkspacePickerStyles;
  footerPath: string | null;
  footerTitle: string;
  footerSubtitle: string;
  onSelectPath: (path: string | null) => void;
}) {
  const disabled = !footerPath;
  return (
    <View style={styles.toolbar}>
      <Text style={styles.toolbarPath} numberOfLines={1} ellipsizeMode="middle">
        {footerSubtitle}
      </Text>
      <Pressable
        onPress={() => footerPath && onSelectPath(footerPath)}
        disabled={disabled}
        style={({ pressed }) => [
          styles.useButton,
          disabled && styles.buttonDisabled,
          pressed && !disabled && styles.useButtonPressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel={`Use ${footerTitle}`}
        accessibilityState={controlAccessibilityState({ disabled })}
      >
        <Text style={styles.useButtonText} numberOfLines={1}>
          Use {footerTitle}
        </Text>
      </Pressable>
    </View>
  );
}
