import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { controlAccessibilityState, useModalAccessibilityFocus } from '@shared/accessibility';
import { useAppTheme, type AppTheme } from '@shared/theme';
import { AppSheet } from '@shared/ui/AppSheet';

export interface NameSheetProps {
  visible: boolean;
  title: string;
  /** Initial value whenever the sheet opens. */
  initialValue?: string;
  placeholder: string;
  submitLabel: string;
  /** Live validation; returning copy disables submit and shows it under the field. */
  validate?: (value: string) => string | null;
  /** Resolves true when the sheet should close. */
  onSubmit: (value: string) => Promise<boolean>;
  onClose: () => void;
  testID?: string;
}

/** A one-field form sheet for naming things: new files, renames, new workspaces. */
export function NameSheet({
  visible,
  title,
  initialValue = '',
  placeholder,
  submitLabel,
  validate,
  onSubmit,
  onClose,
  testID,
}: NameSheetProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createNameSheetStyles(theme), [theme]);
  const [value, setValue] = useState(initialValue);
  const [submitting, setSubmitting] = useState(false);
  const focusRef = useModalAccessibilityFocus<Text>(visible);

  useEffect(() => {
    if (visible) {
      setValue(initialValue);
      setSubmitting(false);
    }
  }, [initialValue, visible]);

  const trimmed = value.trim();
  const validation = trimmed && validate ? validate(value) : null;
  const disabled = !trimmed || Boolean(validation) || submitting || trimmed === initialValue.trim();

  const submit = async () => {
    if (disabled) {
      return;
    }
    setSubmitting(true);
    try {
      if (await onSubmit(trimmed)) {
        onClose();
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AppSheet visible={visible} onClose={onClose} accessibilityLabel={title}>
      <View style={styles.body} testID={testID}>
        <Text ref={focusRef} accessibilityRole="header" style={styles.title}>
          {title}
        </Text>
        <BottomSheetTextInput
          value={value}
          onChangeText={setValue}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.textMuted}
          keyboardAppearance={theme.keyboardAppearance}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={() => void submit()}
          editable={!submitting}
          style={styles.input}
          accessibilityLabel={title}
          testID={testID ? `${testID}-input` : undefined}
        />
        {validation ? <Text style={styles.error}>{validation}</Text> : null}
        <View style={styles.actions}>
          <Pressable
            onPress={onClose}
            style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
            accessibilityRole="button"
          >
            <Text style={styles.secondaryText}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={() => void submit()}
            disabled={disabled}
            style={({ pressed }) => [
              styles.primary,
              pressed && styles.pressed,
              disabled && styles.disabled,
            ]}
            accessibilityRole="button"
            accessibilityState={controlAccessibilityState({ disabled, busy: submitting })}
            testID={testID ? `${testID}-submit` : undefined}
          >
            {submitting ? (
              <ActivityIndicator size="small" color={theme.colors.accentText} />
            ) : (
              <Text style={styles.primaryText}>{submitLabel}</Text>
            )}
          </Pressable>
        </View>
      </View>
    </AppSheet>
  );
}

function createNameSheetStyles(theme: AppTheme) {
  return StyleSheet.create({
    body: {
      gap: theme.spacing.md,
      paddingBottom: theme.spacing.sm,
    },
    title: {
      ...theme.typography.headline,
      color: theme.colors.textPrimary,
    },
    input: {
      ...theme.typography.body,
      minHeight: theme.touchTarget.minimum,
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgInput,
      paddingHorizontal: theme.spacing.md,
      color: theme.colors.textPrimary,
    },
    error: {
      ...theme.typography.caption,
      color: theme.colors.error,
    },
    actions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: theme.spacing.sm,
    },
    secondary: {
      minHeight: theme.touchTarget.minimum,
      justifyContent: 'center',
      paddingHorizontal: theme.spacing.lg,
      borderRadius: theme.radius.full,
    },
    secondaryText: {
      ...theme.typography.body,
      color: theme.colors.textSecondary,
      fontWeight: '600',
    },
    primary: {
      minHeight: theme.touchTarget.minimum,
      minWidth: 96,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: theme.spacing.lg,
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.accent,
    },
    primaryText: {
      ...theme.typography.body,
      color: theme.colors.accentText,
      fontWeight: '600',
    },
    pressed: {
      opacity: 0.8,
    },
    disabled: {
      opacity: 0.45,
    },
  });
}
