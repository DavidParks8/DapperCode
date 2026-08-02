import { Ionicons } from '@expo/vector-icons';
import { useMemo } from 'react';
import { Modal, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { decorativeAccessibilityProps } from '@shared/accessibility';
import { useAppTheme } from '@shared/theme';
import { computeHitSlop } from '@shared/ui/touchTarget';
import { createStyles } from './styles';

const CLOSE_BUTTON_VISIBLE_SIZE = { width: 32, height: 32 };

/**
 * Shows a response in a read-only multiline `TextInput`.
 *
 * React Native's `<Text selectable>` cannot select part of a block: on iOS it only attaches a long
 * press that opens an edit menu whose sole action copies the whole paragraph. A `TextInput` is
 * backed by a `UITextView`, so it gives real selection handles, a magnifier, and partial copy.
 */
export function SelectableTextSheet({
  text,
  onClose,
  testID,
}: {
  text: string;
  onClose: () => void;
  testID?: string;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const insets = useSafeAreaInsets();
  const closeHitSlop = useMemo(() => computeHitSlop(CLOSE_BUTTON_VISIBLE_SIZE), []);

  return (
    <Modal
      testID={testID}
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      supportedOrientations={['portrait', 'landscape']}
      onRequestClose={onClose}
    >
      <View
        style={[styles.selectTextRoot, { paddingBottom: insets.bottom }]}
        accessibilityViewIsModal
      >
        <View style={styles.selectTextHeader}>
          <Text style={styles.selectTextTitle}>Select text</Text>
          <Pressable
            testID={testID ? `${testID}-close` : undefined}
            onPress={onClose}
            hitSlop={closeHitSlop}
            style={({ pressed }) => [
              styles.selectTextCloseButton,
              pressed && styles.messageActionButtonPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Close text selection"
          >
            <Ionicons
              {...decorativeAccessibilityProps}
              name="close"
              size={20}
              color={theme.colors.textPrimary}
            />
          </Pressable>
        </View>
        <TextInput
          testID={testID ? `${testID}-input` : undefined}
          style={styles.selectTextInput}
          value={text}
          editable={false}
          multiline
          scrollEnabled
          textAlignVertical="top"
          accessibilityLabel="Response text"
        />
      </View>
    </Modal>
  );
}
