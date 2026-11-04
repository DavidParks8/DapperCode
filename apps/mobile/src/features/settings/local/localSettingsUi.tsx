import { Ionicons } from '@expo/vector-icons';
import { useMemo, type ComponentProps, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';

import { decorativeAccessibilityProps } from '@shared/accessibility';
import { feedback } from '@shared/feedback';
import { useAppTheme, type AppTheme } from '@shared/theme';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

/** An iOS search field: magnifier, placeholder, and the system clear button. */
export function SettingsSearchField({
  value,
  onChangeText,
  placeholder,
  accessibilityLabel,
  testID,
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  accessibilityLabel: string;
  testID?: string;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <View style={styles.search}>
      <Ionicons
        {...decorativeAccessibilityProps}
        name="search"
        size={17}
        color={theme.colors.textMuted}
      />
      <TextInput
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="search"
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
        keyboardAppearance={theme.keyboardAppearance}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.textMuted}
        returnKeyType="search"
        style={styles.searchInput}
        testID={testID}
        value={value}
      />
    </View>
  );
}

/** A determinate progress bar that VoiceOver reads as a percentage plus any transfer details. */
export function SettingsProgressBar({
  label,
  value,
  valueText,
  testID,
}: {
  label: string;
  value: number;
  /** Spoken value, such as "41%, 310 MB of 740 MB, 2 min left"; defaults to the percentage. */
  valueText?: string | null;
  testID?: string;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const now = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <View
      accessible
      accessibilityLabel={label}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now, text: valueText ?? `${now}%` }}
      style={styles.progressTrack}
      testID={testID}
    >
      <View style={[styles.progressFill, { width: `${now}%` }]} />
    </View>
  );
}

/** A small capsule, used for the same "Recommended" badge on family and quant rows. */
export function SettingsBadge({ label, tone = 'accent' }: { label: string; tone?: BadgeTone }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <View style={[styles.badge, tone === 'muted' && styles.badgeMuted]}>
      <Text style={[styles.badgeText, tone === 'muted' && styles.badgeTextMuted]}>{label}</Text>
    </View>
  );
}

type BadgeTone = 'accent' | 'muted';

export interface InlineAction {
  key: string;
  label: string;
  /** VoiceOver label when the visible text alone would be ambiguous in a list. */
  accessibilityLabel?: string;
  icon?: IoniconName;
  tone?: 'default' | 'destructive' | 'prominent';
  disabled?: boolean;
  busy?: boolean;
  onPress: () => void;
  testID?: string;
}

/** A wrapping row of compact capsule buttons for actions that apply to one list row. */
export function SettingsInlineActions({ actions }: { actions: readonly InlineAction[] }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  if (actions.length === 0) {
    return null;
  }
  return (
    <View style={styles.actions}>
      {actions.map((action) => {
        const tone = action.tone ?? 'default';
        const color = action.disabled
          ? theme.colors.textMuted
          : tone === 'destructive'
            ? theme.colors.error
            : tone === 'prominent'
              ? theme.colors.accentText
              : theme.colors.textPrimary;
        return (
          <Pressable
            key={action.key}
            accessibilityLabel={action.accessibilityLabel ?? action.label}
            accessibilityRole="button"
            accessibilityState={{ disabled: Boolean(action.disabled), busy: Boolean(action.busy) }}
            disabled={action.disabled || action.busy}
            hitSlop={6}
            onPress={() => {
              void feedback.selection();
              action.onPress();
            }}
            style={({ pressed }) => [
              styles.action,
              tone === 'prominent' && !action.disabled && styles.actionProminent,
              pressed && styles.actionPressed,
            ]}
            testID={action.testID}
          >
            {action.busy ? (
              <ActivityIndicator size="small" color={color} />
            ) : action.icon ? (
              <Ionicons
                {...decorativeAccessibilityProps}
                name={action.icon}
                size={15}
                color={color}
              />
            ) : null}
            <Text style={[styles.actionText, { color }]}>{action.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * A grouped-list row with a leading icon, a title (and optional badge), and supporting lines.
 * `onPress` makes the whole row a navigation button with a chevron.
 */
export function SettingsDetailRow({
  icon,
  title,
  badge,
  subtitle,
  status,
  statusTone = 'default',
  accessibilityLabel,
  onPress,
  children,
  testID,
}: {
  icon?: IoniconName;
  title: string;
  badge?: string | null;
  subtitle?: string | null;
  status?: string | null;
  statusTone?: 'default' | 'accent' | 'error';
  accessibilityLabel?: string;
  onPress?: () => void;
  children?: ReactNode;
  testID?: string;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const content = (
    <>
      {icon ? (
        <View style={styles.detailIcon}>
          <Ionicons
            {...decorativeAccessibilityProps}
            name={icon}
            size={20}
            color={theme.colors.accent}
          />
        </View>
      ) : null}
      <View style={styles.detailBody}>
        <View style={styles.detailTitleRow}>
          <Text style={styles.detailTitle}>{title}</Text>
          {badge ? <SettingsBadge label={badge} /> : null}
        </View>
        {subtitle ? <Text style={styles.detailSubtitle}>{subtitle}</Text> : null}
        {status ? (
          <Text
            style={[
              styles.detailStatus,
              statusTone === 'accent' && styles.detailStatusAccent,
              statusTone === 'error' && styles.detailStatusError,
            ]}
          >
            {status}
          </Text>
        ) : null}
        {children}
      </View>
      {onPress ? (
        <Ionicons
          {...decorativeAccessibilityProps}
          name="chevron-forward"
          size={16}
          color={theme.colors.textMuted}
          style={styles.chevron}
        />
      ) : null}
    </>
  );
  if (!onPress) {
    return (
      <View style={styles.detailRow} testID={testID}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      onPress={() => {
        void feedback.selection();
        onPress();
      }}
      style={({ pressed }) => [styles.detailRow, pressed && styles.detailRowPressed]}
      testID={testID}
    >
      {content}
    </Pressable>
  );
}

/** A full-width action row in a grouped card, like iOS "Sign Out" rows. */
export function SettingsButtonRow({
  label,
  tone = 'accent',
  disabled = false,
  busy = false,
  onPress,
  testID,
}: {
  label: string;
  tone?: 'accent' | 'destructive';
  disabled?: boolean;
  busy?: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const color = disabled
    ? theme.colors.textMuted
    : tone === 'destructive'
      ? theme.colors.error
      : theme.colors.accent;
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={() => {
        void feedback.selection();
        onPress();
      }}
      style={({ pressed }) => [styles.buttonRow, pressed && styles.detailRowPressed]}
      testID={testID}
    >
      <Text style={[styles.buttonRowText, { color }]}>{label}</Text>
      {busy ? <ActivityIndicator size="small" color={theme.colors.textMuted} /> : null}
    </Pressable>
  );
}

/** A labelled text field inside a grouped card, laid out like iOS form rows. */
export function SettingsTextFieldRow({
  label,
  error,
  ...input
}: TextInputProps & { label: string; error?: string | null }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <View style={styles.fieldRow}>
      <View style={styles.fieldLine}>
        <Text style={styles.fieldLabel}>{label}</Text>
        <TextInput
          accessibilityLabel={label}
          accessibilityHint={error ?? undefined}
          keyboardAppearance={theme.keyboardAppearance}
          placeholderTextColor={theme.colors.textMuted}
          style={styles.fieldInput}
          {...input}
        />
      </View>
      {error ? (
        <Text accessibilityLiveRegion="polite" style={styles.fieldError}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/** A supporting line inside a row, such as a memory note or an error. */
export function SettingsRowNote({
  children,
  tone = 'muted',
}: {
  children: ReactNode;
  tone?: 'muted' | 'error';
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <Text
      accessibilityLiveRegion={tone === 'error' ? 'polite' : undefined}
      style={[styles.rowNote, tone === 'error' && styles.cardTextError]}
    >
      {children}
    </Text>
  );
}

/** Supporting text inside a grouped card, such as an explanation above actions. */
export function SettingsCardText({
  children,
  tone = 'muted',
}: {
  children: ReactNode;
  tone?: 'muted' | 'error' | 'success';
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <Text
      style={[
        styles.cardText,
        tone === 'error' && styles.cardTextError,
        tone === 'success' && styles.cardTextSuccess,
      ]}
    >
      {children}
    </Text>
  );
}

function createStyles(theme: AppTheme) {
  const { colors } = theme;
  return StyleSheet.create({
    search: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      minHeight: 40,
      paddingHorizontal: 10,
      borderRadius: theme.radius.md,
      borderCurve: 'continuous',
      backgroundColor: colors.bgItem,
    },
    searchInput: {
      ...theme.typography.body,
      color: colors.textPrimary,
      flex: 1,
      minHeight: 40,
      paddingVertical: 8,
    },
    progressTrack: {
      height: 4,
      borderRadius: theme.radius.full,
      backgroundColor: colors.bgInput,
      overflow: 'hidden',
      marginTop: 2,
    },
    progressFill: {
      height: '100%',
      borderRadius: theme.radius.full,
      backgroundColor: colors.accent,
    },
    badge: {
      alignSelf: 'center',
      borderRadius: theme.radius.full,
      paddingHorizontal: 8,
      paddingVertical: 2,
      backgroundColor: colors.bgCanvasAccent,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.accent,
    },
    badgeMuted: { borderColor: colors.borderLight },
    badgeText: { ...theme.typography.metadata, color: colors.accent, fontWeight: '600' },
    badgeTextMuted: { color: colors.textMuted },
    actions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.spacing.sm,
      marginTop: theme.spacing.xs,
    },
    action: {
      minHeight: 32,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 12,
      borderRadius: theme.radius.full,
      backgroundColor: colors.bgInput,
    },
    actionProminent: { backgroundColor: colors.accent },
    actionPressed: { opacity: 0.7 },
    actionText: { ...theme.typography.caption, fontWeight: '600' },
    detailRow: {
      minHeight: theme.touchTarget.minimum,
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: theme.spacing.md,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: 11,
      backgroundColor: colors.bgItem,
    },
    detailRowPressed: { backgroundColor: colors.bgInput },
    detailIcon: {
      width: 28,
      height: 28,
      borderRadius: theme.radius.sm,
      borderCurve: 'continuous',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.bgInput,
    },
    detailBody: { flex: 1, gap: 3 },
    detailTitleRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
    detailTitle: { ...theme.typography.headline, fontWeight: '400', flexShrink: 1 },
    detailSubtitle: { ...theme.typography.caption, color: colors.textMuted },
    detailStatus: { ...theme.typography.caption, color: colors.textSecondary },
    detailStatusAccent: { color: colors.textPrimary, fontWeight: '600' },
    detailStatusError: { color: colors.error },
    chevron: { opacity: 0.5, alignSelf: 'center' },
    buttonRow: {
      minHeight: theme.touchTarget.minimum,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: 11,
      backgroundColor: colors.bgItem,
    },
    buttonRowText: { ...theme.typography.headline, fontWeight: '400' },
    fieldRow: {
      minHeight: theme.touchTarget.minimum,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: 4,
      justifyContent: 'center',
      backgroundColor: colors.bgItem,
    },
    fieldLine: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md },
    fieldLabel: { ...theme.typography.headline, fontWeight: '400', width: 64 },
    fieldInput: {
      ...theme.typography.body,
      color: colors.textPrimary,
      flex: 1,
      minHeight: 40,
      paddingVertical: 8,
    },
    fieldError: { ...theme.typography.caption, color: colors.error, paddingBottom: 6 },
    cardText: {
      ...theme.typography.caption,
      color: colors.textMuted,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      backgroundColor: colors.bgItem,
    },
    cardTextError: { color: colors.error },
    rowNote: { ...theme.typography.caption, color: colors.textMuted },
    cardTextSuccess: { color: colors.success },
  });
}
