import { Ionicons } from '@expo/vector-icons';
import { useMemo } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ImageStyle,
} from 'react-native';

import dappercodeMark from '../../../assets/brand/mark.png';
import { controlAccessibilityState, decorativeAccessibilityProps } from '@shared/accessibility';
import { useAppTheme, type AppTheme } from '@shared/theme';

type ChoiceActionVariant = 'primary' | 'secondary';
type ChoiceActionLogo = 'github' | 'dappercode';

interface ChoiceActionProps {
  title: string;
  meta?: string;
  variant?: ChoiceActionVariant;
  logo?: ChoiceActionLogo;
  iconName?: keyof typeof Ionicons.glyphMap;
  loading?: boolean;
  disabled?: boolean;
  /** Spoken after the label; describes what happens on activation. */
  accessibilityHint?: string;
  testID?: string;
  onPress: () => void;
}

/** VoiceOver label: the visible title and meta, without empty segments from missing copy. */
export function choiceActionAccessibilityLabel(title: string, meta?: string): string {
  return [title, meta]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(', ');
}

export function ChoiceAction({
  title,
  meta,
  variant = 'secondary',
  logo,
  iconName,
  loading = false,
  disabled = false,
  accessibilityHint,
  testID,
  onPress,
}: ChoiceActionProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const isPrimary = variant === 'primary';
  const iconColor = isPrimary ? theme.colors.accentText : theme.colors.textPrimary;
  const arrowColor = isPrimary ? theme.colors.accentText : theme.colors.textMuted;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={choiceActionAccessibilityLabel(title, meta)}
      accessibilityHint={accessibilityHint}
      accessibilityState={controlAccessibilityState({
        disabled: disabled || loading,
        busy: loading,
      })}
      testID={testID}
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.root,
        isPrimary ? styles.rootPrimary : styles.rootSecondary,
        (disabled || loading) && styles.rootDisabled,
        pressed && !(disabled || loading) && styles.rootPressed,
      ]}
    >
      <View
        {...decorativeAccessibilityProps}
        style={[styles.iconWrap, isPrimary && styles.iconWrapPrimary]}
      >
        <ChoiceIcon
          loading={loading}
          logo={logo}
          iconName={iconName}
          color={iconColor}
          logoStyle={styles.logoImage}
        />
      </View>
      <View style={styles.copy}>
        <Text style={[styles.title, isPrimary ? styles.titlePrimary : styles.titleSecondary]}>
          {title}
        </Text>
        {meta ? (
          <Text style={[styles.meta, isPrimary ? styles.metaPrimary : styles.metaSecondary]}>
            {meta}
          </Text>
        ) : null}
      </View>
      <Ionicons
        {...decorativeAccessibilityProps}
        name="arrow-forward"
        size={20}
        color={arrowColor}
      />
    </Pressable>
  );
}

function ChoiceIcon({
  loading,
  logo,
  iconName,
  color,
  logoStyle,
}: {
  loading: boolean;
  logo?: ChoiceActionLogo;
  iconName?: keyof typeof Ionicons.glyphMap;
  color: string;
  logoStyle: ImageStyle;
}) {
  if (loading) {
    return <ActivityIndicator size="small" color={color} />;
  }
  if (logo === 'github') {
    return <Ionicons name="logo-github" size={19} color={color} />;
  }
  if (logo === 'dappercode') {
    return (
      <Image
        source={dappercodeMark}
        resizeMode="contain"
        style={[logoStyle, { tintColor: color }]}
      />
    );
  }
  return iconName ? <Ionicons name={iconName} size={19} color={color} /> : null;
}

const createStyles = (theme: AppTheme) => {
  const secondaryBackground = theme.isDark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.62)';

  return StyleSheet.create({
    root: {
      minHeight: 78,
      borderRadius: 24,
      borderWidth: 1,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      borderCurve: 'continuous',
    },
    rootPrimary: {
      backgroundColor: theme.colors.accent,
      borderColor: theme.colors.accent,
      boxShadow: theme.isDark
        ? '0px 14px 28px rgba(0, 0, 0, 0.34)'
        : '0px 14px 28px rgba(15, 23, 42, 0.18)',
    },
    rootSecondary: {
      backgroundColor: secondaryBackground,
      borderColor: theme.colors.borderHighlight,
    },
    rootPressed: {
      opacity: 0.92,
    },
    rootDisabled: {
      opacity: 0.68,
    },
    iconWrap: {
      width: 42,
      height: 42,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.78)',
    },
    iconWrapPrimary: {
      backgroundColor: 'rgba(255,255,255,0.14)',
      borderColor: 'rgba(255,255,255,0.24)',
    },
    logoImage: {
      width: 22,
      height: 22,
    },
    copy: {
      flex: 1,
      minWidth: 0,
      gap: 2,
    },
    title: {
      ...theme.typography.headline,
    },
    titlePrimary: {
      color: theme.colors.accentText,
    },
    titleSecondary: {
      color: theme.colors.textPrimary,
    },
    meta: {
      ...theme.typography.caption,
      fontWeight: '600',
    },
    metaPrimary: {
      color: theme.colors.accentText,
    },
    metaSecondary: {
      color: theme.colors.textMuted,
    },
  });
};
