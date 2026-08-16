import { Ionicons } from '@expo/vector-icons';
import { useMemo } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { BrandMark } from '@shared/ui/BrandMark';
import { GlassSurface } from '@shared/ui/glass/GlassSurface';
import { decorativeAccessibilityProps } from '@shared/accessibility';
import { useAppTheme } from '@shared/theme';
import { createStyles } from '../styles/styles';

const SUGGESTIONS = [
  { label: 'Explain the codebase', prompt: 'Explain the current codebase structure' },
  { label: 'Write tests', prompt: 'Write tests for the main module' },
  { label: 'Review my diff', prompt: 'Review my uncommitted changes and flag anything risky' },
] as const;

/**
 * The capsule is a pill, so it shows the folder the path ends in rather than the whole path. The
 * untruncated path stays on the accessibility label.
 */
function workspaceDisplayName(label: string): string {
  const trimmed = label.trim();
  const segment = trimmed.split('/').filter(Boolean).pop();
  return segment && segment.length > 0 ? segment : trimmed;
}

export function ComposeView({
  startWorkspaceLabel,
  keyboardVisible,
  bottomInset,
  topInset,
  onSuggestion,
  onOpenWorkspacePicker,
}: {
  startWorkspaceLabel: string;
  keyboardVisible: boolean;
  bottomInset: number;
  topInset: number;
  onSuggestion: (s: string) => void;
  onOpenWorkspacePicker: () => void;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const composeTopPadding = (keyboardVisible ? theme.spacing.xl : 0) + topInset;
  const contentContainerStyle = [
    styles.composeContainer,
    keyboardVisible ? styles.composeContainerKeyboardOpen : null,
    {
      paddingBottom:
        Platform.OS === 'ios' ? Math.max(theme.spacing.xxl * 2, bottomInset) : bottomInset,
      paddingTop: composeTopPadding,
    },
  ];

  return (
    <ScrollView
      style={styles.composeScroll}
      contentContainerStyle={contentContainerStyle}
      showsVerticalScrollIndicator={false}
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
      keyboardShouldPersistTaps="handled"
      onScrollBeginDrag={Keyboard.dismiss}
      alwaysBounceVertical
      overScrollMode="always"
    >
      <View style={styles.composeIcon}>
        <BrandMark size={52} />
      </View>
      <Text style={styles.composeTitle}>Let's build</Text>
      <Pressable
        style={({ pressed }) => [
          styles.workspaceCapsule,
          pressed && styles.workspaceCapsulePressed,
        ]}
        onPress={onOpenWorkspacePicker}
        accessibilityRole="button"
        accessibilityLabel={`Workspace, ${startWorkspaceLabel}`}
      >
        <GlassSurface
          pointerEvents="none"
          role="capsule"
          style={styles.workspaceCapsuleGlass}
          testID="compose-workspace-glass-surface"
        >
          <Ionicons
            {...decorativeAccessibilityProps}
            name="folder-outline"
            size={15}
            color={theme.colors.textSecondary}
          />
          <Text style={styles.workspaceCapsuleLabel} numberOfLines={1}>
            {workspaceDisplayName(startWorkspaceLabel)}
          </Text>
          <View style={styles.workspaceCapsuleChevron}>
            <Ionicons
              {...decorativeAccessibilityProps}
              name="chevron-forward"
              size={12}
              color={theme.colors.textSecondary}
            />
          </View>
        </GlassSurface>
      </Pressable>
      <View style={styles.suggestions}>
        {SUGGESTIONS.map((suggestion) => (
          <Pressable
            key={suggestion.label}
            style={({ pressed }) => [
              styles.suggestionCard,
              pressed && styles.suggestionCardPressed,
            ]}
            onPress={() => onSuggestion(suggestion.prompt)}
            accessibilityRole="button"
            accessibilityLabel={`Use suggestion: ${suggestion.label}`}
          >
            <Text style={styles.suggestionText}>{suggestion.label}</Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

export function ChatOpeningView({ topInset = 0 }: { topInset?: number }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <View
      style={[styles.chatOpeningShell, { paddingTop: theme.spacing.lg + topInset }]}
      accessibilityRole="progressbar"
      accessibilityLabel="Opening chat"
      accessibilityLiveRegion="polite"
    >
      <View style={styles.chatOpeningCard}>
        <View style={styles.chatOpeningTopRow}>
          <ActivityIndicator size="small" color={theme.colors.textMuted} />
          <Text style={styles.chatOpeningTitle}>Opening chat</Text>
        </View>
        <View style={styles.chatOpeningBubbleWide} />
        <View style={styles.chatOpeningBubbleShort} />
      </View>
    </View>
  );
}
