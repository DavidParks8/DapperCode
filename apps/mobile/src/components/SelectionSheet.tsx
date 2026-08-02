import { Ionicons } from '@expo/vector-icons';
import { useMemo, type ComponentProps } from 'react';
import {
  ActivityIndicator,
  Pressable,
  Text,
  type TextStyle,
  useWindowDimensions,
  View,
} from 'react-native';
import { AppSheet } from './AppSheet';
import { createSelectionSheetStyles } from './selection-sheet-styles';
import { useAppTheme } from '../theme';
import {
  controlAccessibilityState,
  decorativeAccessibilityProps,
  useAccessibilityAnnouncement,
  useModalAccessibilityFocus,
} from '../accessibility';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

type OptionTone = 'default' | 'accent' | 'danger';
type SelectionSheetPresentation = 'default' | 'expanded';

export interface SelectionSheetOption {
  key: string;
  title: string;
  description?: string;
  descriptionNumberOfLines?: number;
  badge?: string;
  meta?: string;
  icon?: IoniconName;
  titleColor?: string;
  descriptionColor?: string;
  titleStyle?: TextStyle;
  descriptionStyle?: TextStyle;
  badgeBackgroundColor?: string;
  badgeTextColor?: string;
  metaColor?: string;
  iconColor?: string;
  selected?: boolean;
  disabled?: boolean;
  tone?: OptionTone;
  onPress: () => void;
}

interface SelectionSheetProps {
  visible: boolean;
  title: string;
  subtitle?: string;
  eyebrow?: string;
  options: SelectionSheetOption[];
  onClose: () => void;
  closeLabel?: string;
  loading?: boolean;
  loadingLabel?: string;
  emptyLabel?: string;
  presentation?: SelectionSheetPresentation;
}

export function SelectionSheet({
  visible,
  title,
  subtitle,
  eyebrow,
  options,
  onClose,
  closeLabel = 'Close',
  loading = false,
  loadingLabel = 'Loading…',
  emptyLabel = 'No options available.',
  presentation = 'default',
}: SelectionSheetProps) {
  const theme = useAppTheme();
  const { colors } = theme;
  const styles = useMemo(() => createSelectionSheetStyles(theme), [theme]);
  const { height: windowHeight } = useWindowDimensions();
  const expanded = presentation === 'expanded';
  const maxSheetHeight = Math.round(windowHeight * (expanded ? 0.82 : 0.56));
  const modalFocusRef = useModalAccessibilityFocus(visible);
  useAccessibilityAnnouncement(visible && loading ? loadingLabel : null);

  return (
    <AppSheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel={title}
      maxDynamicContentSize={maxSheetHeight}
      scrollable
    >
      <View
        ref={modalFocusRef}
        accessible
        accessibilityRole="header"
        accessibilityLabel={[title, subtitle].filter(Boolean).join('. ')}
        style={styles.header}
      >
        {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
        <Text style={styles.title}>{title}</Text>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={expanded ? 3 : 2}>
            {subtitle}
          </Text>
        ) : null}
      </View>

      {loading ? (
        <View
          style={styles.loadingState}
          accessibilityRole="progressbar"
          accessibilityLiveRegion="polite"
          accessibilityLabel={loadingLabel}
        >
          <ActivityIndicator color={colors.textPrimary} />
          <Text style={styles.loadingLabel}>{loadingLabel}</Text>
        </View>
      ) : options.length > 0 ? (
        <View style={styles.list}>
          {options.map((option) => (
            <SelectionSheetRow key={option.key} option={option} styles={styles} theme={theme} />
          ))}
        </View>
      ) : (
        <View style={styles.loadingState}>
          <Text accessibilityLiveRegion="polite" style={styles.loadingLabel}>
            {emptyLabel}
          </Text>
        </View>
      )}

      <View style={styles.footer} testID="selection-sheet-footer">
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={closeLabel}
          testID="selection-sheet-close"
          style={({ pressed }) => [styles.closeButton, pressed && styles.closeButtonPressed]}
        >
          <Text style={styles.closeText}>{closeLabel}</Text>
        </Pressable>
      </View>
    </AppSheet>
  );
}

function resolveSelectionSheetIconColor(
  option: SelectionSheetOption,
  tone: OptionTone,
  colors: ReturnType<typeof useAppTheme>['colors'],
): string {
  if (option.iconColor) {
    return option.iconColor;
  }
  if (tone === 'danger') {
    return colors.error;
  }
  if (option.selected || tone === 'accent') {
    return colors.textPrimary;
  }
  return colors.textMuted;
}

function resolveSelectionSheetRowColors(
  option: SelectionSheetOption,
  theme: ReturnType<typeof useAppTheme>,
  styles: ReturnType<typeof createSelectionSheetStyles>,
): {
  tone: OptionTone;
  iconColor: string;
  titleColor: string;
  descriptionColor: string;
  metaColor: string;
  badgeBackgroundColor: string;
  badgeTextColor: string;
} {
  const { colors } = theme;
  const tone = option.tone ?? 'default';
  return {
    tone,
    iconColor: resolveSelectionSheetIconColor(option, tone, colors),
    titleColor: option.titleColor ?? colors.textPrimary,
    descriptionColor: option.descriptionColor ?? colors.textMuted,
    metaColor: option.metaColor ?? colors.textMuted,
    badgeBackgroundColor: option.badgeBackgroundColor ?? styles.badge.backgroundColor,
    badgeTextColor: option.badgeTextColor ?? styles.badgeText.color,
  };
}

function SelectionSheetRowIcon({
  option,
  tone,
  iconColor,
  styles,
}: {
  option: SelectionSheetOption;
  tone: OptionTone;
  iconColor: string;
  styles: ReturnType<typeof createSelectionSheetStyles>;
}) {
  if (!option.icon) {
    return null;
  }
  return (
    <View
      style={[
        styles.iconWrap,
        option.selected && styles.iconWrapSelected,
        tone === 'danger' && styles.iconWrapDanger,
      ]}
    >
      <Ionicons {...decorativeAccessibilityProps} name={option.icon} size={15} color={iconColor} />
    </View>
  );
}

function SelectionSheetRowCopy({
  option,
  titleColor,
  descriptionColor,
  badgeBackgroundColor,
  badgeTextColor,
  styles,
}: {
  option: SelectionSheetOption;
  titleColor: string;
  descriptionColor: string;
  badgeBackgroundColor: string;
  badgeTextColor: string;
  styles: ReturnType<typeof createSelectionSheetStyles>;
}) {
  return (
    <View style={styles.copy}>
      <View style={styles.titleRow}>
        <Text
          style={[
            styles.optionTitle,
            option.selected && styles.optionTitleSelected,
            { color: titleColor },
            option.titleStyle,
          ]}
          numberOfLines={2}
        >
          {option.title}
        </Text>
        {option.badge ? (
          <View style={[styles.badge, { backgroundColor: badgeBackgroundColor }]}>
            <Text style={[styles.badgeText, { color: badgeTextColor }]}>{option.badge}</Text>
          </View>
        ) : null}
      </View>
      {option.description ? (
        <Text
          style={[styles.optionDescription, { color: descriptionColor }, option.descriptionStyle]}
          numberOfLines={option.descriptionNumberOfLines ?? 2}
        >
          {option.description}
        </Text>
      ) : null}
    </View>
  );
}

function SelectionSheetRowAccessory({
  option,
  metaColor,
  colors,
  styles,
}: {
  option: SelectionSheetOption;
  metaColor: string;
  colors: ReturnType<typeof useAppTheme>['colors'];
  styles: ReturnType<typeof createSelectionSheetStyles>;
}) {
  return (
    <View style={styles.accessory}>
      {option.meta ? (
        <Text style={[styles.meta, { color: metaColor }]} numberOfLines={1}>
          {option.meta}
        </Text>
      ) : null}
      {option.selected ? (
        <Ionicons
          {...decorativeAccessibilityProps}
          name="checkmark-circle"
          size={18}
          color={colors.textPrimary}
        />
      ) : null}
    </View>
  );
}

function SelectionSheetRow({
  option,
  styles,
  theme,
}: {
  option: SelectionSheetOption;
  styles: ReturnType<typeof createSelectionSheetStyles>;
  theme: ReturnType<typeof useAppTheme>;
}) {
  const { colors } = theme;
  const {
    tone,
    iconColor,
    titleColor,
    descriptionColor,
    metaColor,
    badgeBackgroundColor,
    badgeTextColor,
  } = resolveSelectionSheetRowColors(option, theme, styles);

  return (
    <Pressable
      disabled={option.disabled}
      onPress={option.onPress}
      accessibilityRole="button"
      accessibilityLabel={option.title}
      accessibilityHint={option.description}
      accessibilityState={controlAccessibilityState({
        disabled: option.disabled,
        selected: option.selected,
      })}
      style={({ pressed }) => [
        styles.option,
        option.selected && styles.optionSelected,
        option.disabled && styles.optionDisabled,
        pressed && !option.disabled && styles.optionPressed,
      ]}
    >
      <View style={styles.optionMain}>
        <SelectionSheetRowIcon option={option} tone={tone} iconColor={iconColor} styles={styles} />
        <SelectionSheetRowCopy
          option={option}
          titleColor={titleColor}
          descriptionColor={descriptionColor}
          badgeBackgroundColor={badgeBackgroundColor}
          badgeTextColor={badgeTextColor}
          styles={styles}
        />
      </View>

      <SelectionSheetRowAccessory
        option={option}
        metaColor={metaColor}
        colors={colors}
        styles={styles}
      />
    </Pressable>
  );
}
