import { Ionicons } from '@expo/vector-icons';
import { Children, Fragment, useMemo, type ReactNode } from 'react';
import { Pressable, Switch, Text, View } from 'react-native';

import { feedback } from '@shared/feedback';
import { useAppTheme } from '@shared/theme';
import { ROW_SEPARATOR_INSET, createSettingsListStyles } from './settingsListStyles';

/**
 * iOS inset-grouped list primitives: a titled card of hairline-separated rows on the grouped
 * background, with an optional explanatory footer beneath it.
 */
export function SettingsGroup({
  title,
  footer,
  separatorInset = ROW_SEPARATOR_INSET,
  children,
}: {
  title?: string;
  footer?: string;
  separatorInset?: number;
  children: ReactNode;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createSettingsListStyles(theme), [theme]);
  const rows = Children.toArray(children);
  return (
    <View style={styles.group}>
      {title ? (
        <Text accessibilityRole="header" style={styles.groupTitle}>
          {title}
        </Text>
      ) : null}
      <View style={styles.card}>
        {rows.map((row, index) => (
          <Fragment key={index}>
            {index > 0 ? <View style={[styles.separator, { marginLeft: separatorInset }]} /> : null}
            {row}
          </Fragment>
        ))}
      </View>
      {footer ? <Text style={styles.groupFooter}>{footer}</Text> : null}
    </View>
  );
}

/** Trailing affordance a row carries: iOS uses distinct glyphs for push, in-place pick, and choice. */
export type SettingsRowAccessory = 'none' | 'chevron' | 'expand' | 'check';

function RowAccessory({ accessory }: { accessory: SettingsRowAccessory }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createSettingsListStyles(theme), [theme]);
  if (accessory === 'none') {
    return null;
  }
  if (accessory === 'check') {
    return <Ionicons name="checkmark" size={20} color={theme.colors.accent} />;
  }
  return (
    <Ionicons
      name={accessory === 'expand' ? 'chevron-expand' : 'chevron-forward'}
      size={16}
      color={theme.colors.textMuted}
      style={styles.rowChevron}
    />
  );
}

export function SettingsRow({
  label,
  value,
  accessory = 'none',
  selected = false,
  tone = 'default',
  onPress,
}: {
  label: string;
  value?: string;
  accessory?: SettingsRowAccessory;
  selected?: boolean;
  tone?: 'default' | 'accent';
  onPress?: () => void;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createSettingsListStyles(theme), [theme]);
  const spokenState = selected ? 'Active' : value;
  return (
    <Pressable
      accessibilityLabel={spokenState ? `${label}, ${spokenState}` : label}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityState={accessory === 'check' ? { selected } : undefined}
      disabled={!onPress}
      onPress={() => {
        if (!onPress) {
          return;
        }
        void feedback.selection();
        onPress();
      }}
      style={({ pressed }) => [styles.row, pressed && onPress && styles.rowPressed]}
    >
      <Text style={[styles.rowLabel, tone === 'accent' && styles.rowLabelAccent]}>{label}</Text>
      <View style={styles.rowTrailing}>
        {value ? (
          <Text numberOfLines={1} style={styles.rowValue}>
            {value}
          </Text>
        ) : null}
        <RowAccessory accessory={accessory} />
      </View>
    </Pressable>
  );
}

export function SettingsToggleRow({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createSettingsListStyles(theme), [theme]);
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Switch
        accessibilityLabel={label}
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          void feedback.selection();
          onChange(next);
        }}
      />
    </View>
  );
}

/** Non-interactive card content: loading indicators and empty states keep the group's shape. */
export function SettingsCardNote({ children }: { children: ReactNode }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createSettingsListStyles(theme), [theme]);
  return <View style={styles.note}>{children}</View>;
}

export function SettingsNoteText({ children }: { children: ReactNode }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createSettingsListStyles(theme), [theme]);
  return <Text style={styles.noteText}>{children}</Text>;
}

export function SettingsNotice({
  text,
  action,
  onPress,
}: {
  text: string;
  action?: string;
  onPress?: () => void | Promise<void>;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createSettingsListStyles(theme), [theme]);
  return (
    <View style={styles.notice}>
      <Text style={styles.noticeText}>{text}</Text>
      {action ? (
        <Pressable
          accessibilityLabel={action}
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => {
            void feedback.selection();
            void onPress?.();
          }}
          style={styles.noticeAction}
        >
          <Text style={styles.noticeActionText}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
