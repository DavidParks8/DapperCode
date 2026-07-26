import { Ionicons } from '@expo/vector-icons';
import { useMemo } from 'react';
import { ActivityIndicator, Keyboard, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { BrandMark } from '../../components/BrandMark';
import { decorativeAccessibilityProps } from '../../accessibility';
import { useAppTheme } from '../../theme';
import { createStyles } from './mainScreenStyles';







const SUGGESTIONS = [
  'Explain the current codebase structure',
  'Write tests for the main module',
];


export function ComposeView({
  startWorkspaceLabel,
  showAgentPicker,
  agentLabel,
  showModelControls,
  modelLabel,
  showThinkingControls,
  thinkingLabel,
  collaborationModeLabel,
  showFastMode,
  fastModeEnabled,
  fastModeLabel,
  keyboardVisible,
  bottomInset,
  onSuggestion,
  onOpenWorkspacePicker,
  onOpenAgentPicker,
  onOpenModelPicker,
  onOpenThinkingPicker,
  onOpenCollaborationModePicker,
  onToggleFastMode,
}: {
  startWorkspaceLabel: string;
  showAgentPicker: boolean;
  agentLabel: string;
  showModelControls: boolean;
  modelLabel: string;
  showThinkingControls: boolean;
  thinkingLabel: string;
  collaborationModeLabel: string;
  showFastMode: boolean;
  fastModeEnabled: boolean;
  fastModeLabel: string;
  keyboardVisible: boolean;
  bottomInset: number;
  onSuggestion: (s: string) => void;
  onOpenWorkspacePicker: () => void;
  onOpenAgentPicker: () => void;
  onOpenModelPicker: () => void;
  onOpenThinkingPicker: () => void;
  onOpenCollaborationModePicker: () => void;
  onToggleFastMode: () => void;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const contentContainerStyle =
    Platform.OS === 'android'
      ? [
          styles.composeContainer,
          keyboardVisible ? styles.composeContainerKeyboardOpen : null,
          { paddingBottom: bottomInset },
        ]
      : styles.composeContainer;

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
          styles.workspaceSelectBtn,
          styles.workspacePathSelectBtn,
          pressed && styles.workspaceSelectBtnPressed,
        ]}
        onPress={onOpenWorkspacePicker}
        accessibilityRole="button"
        accessibilityLabel={`Workspace, ${startWorkspaceLabel}`}
      >
        <Ionicons {...decorativeAccessibilityProps} name="folder-open-outline" size={16} color={theme.colors.textMuted} />
        <Text style={[styles.workspaceSelectLabel, styles.workspacePathSelectLabel]}>
          {startWorkspaceLabel}
        </Text>
        <Ionicons {...decorativeAccessibilityProps} name="chevron-forward" size={14} color={theme.colors.textMuted} />
      </Pressable>
      {showAgentPicker ? (
        <Pressable
          style={({ pressed }) => [
            styles.workspaceSelectBtn,
            pressed && styles.workspaceSelectBtnPressed,
          ]}
          onPress={onOpenAgentPicker}
          accessibilityRole="button"
          accessibilityLabel={`Agent, ${agentLabel}`}
        >
          <Ionicons {...decorativeAccessibilityProps} name="layers-outline" size={16} color={theme.colors.textMuted} />
          <Text style={styles.workspaceSelectLabel} numberOfLines={1}>
            {agentLabel}
          </Text>
          <Ionicons {...decorativeAccessibilityProps} name="chevron-forward" size={14} color={theme.colors.textMuted} />
        </Pressable>
      ) : null}
      {showModelControls ? (
        <Pressable
          style={({ pressed }) => [
            styles.workspaceSelectBtn,
            pressed && styles.workspaceSelectBtnPressed,
          ]}
          onPress={onOpenModelPicker}
          accessibilityRole="button"
          accessibilityLabel={`Model, ${modelLabel}`}
        >
          <Ionicons {...decorativeAccessibilityProps} name="sparkles-outline" size={16} color={theme.colors.textMuted} />
          <Text style={styles.workspaceSelectLabel} numberOfLines={1}>
            {modelLabel}
          </Text>
          <Ionicons {...decorativeAccessibilityProps} name="chevron-forward" size={14} color={theme.colors.textMuted} />
        </Pressable>
      ) : null}
      {showThinkingControls ? (
        <Pressable
          style={({ pressed }) => [
            styles.workspaceSelectBtn,
            pressed && styles.workspaceSelectBtnPressed,
          ]}
          onPress={onOpenThinkingPicker}
          accessibilityRole="button"
          accessibilityLabel={`Thinking level, ${thinkingLabel}`}
        >
          <Ionicons {...decorativeAccessibilityProps} name="pulse-outline" size={16} color={theme.colors.textMuted} />
          <Text style={styles.workspaceSelectLabel} numberOfLines={1}>
            {thinkingLabel}
          </Text>
          <Ionicons {...decorativeAccessibilityProps} name="chevron-forward" size={14} color={theme.colors.textMuted} />
        </Pressable>
      ) : null}
      <Pressable
        style={({ pressed }) => [
          styles.workspaceSelectBtn,
          pressed && styles.workspaceSelectBtnPressed,
        ]}
        onPress={onOpenCollaborationModePicker}
        accessibilityRole="button"
        accessibilityLabel={`Agent mode, ${collaborationModeLabel}`}
      >
        <Ionicons {...decorativeAccessibilityProps} name="map-outline" size={16} color={theme.colors.textMuted} />
        <Text style={styles.workspaceSelectLabel} numberOfLines={1}>
          {collaborationModeLabel}
        </Text>
        <Ionicons {...decorativeAccessibilityProps} name="chevron-forward" size={14} color={theme.colors.textMuted} />
      </Pressable>
      {showFastMode ? (
        <Pressable
          style={({ pressed }) => [
            styles.workspaceSelectBtn,
            pressed && styles.workspaceSelectBtnPressed,
          ]}
          onPress={onToggleFastMode}
          accessibilityRole="switch"
          accessibilityLabel="Fast mode"
          accessibilityState={{ checked: fastModeEnabled }}
        >
          <Ionicons {...decorativeAccessibilityProps} name="flash-outline" size={16} color={theme.colors.textMuted} />
          <Text style={styles.workspaceSelectLabel} numberOfLines={1}>
            {fastModeLabel}
          </Text>
          <Ionicons
            {...decorativeAccessibilityProps}
            name={fastModeEnabled ? 'checkmark-circle' : 'ellipse-outline'}
            size={14}
            color={theme.colors.textMuted}
          />
        </Pressable>
      ) : null}
      <View style={styles.suggestions}>
        {SUGGESTIONS.map((s, index) => (
          <Pressable
            key={`${s}-${String(index)}`}
            style={({ pressed }) => [
              styles.suggestionCard,
              pressed && styles.suggestionCardPressed,
            ]}
            onPress={() => onSuggestion(s)}
            accessibilityRole="button"
            accessibilityLabel={`Use suggestion: ${s}`}
          >
            <Text style={styles.suggestionText}>{s}</Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}



export function ChatOpeningView() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <View style={styles.chatOpeningShell} accessibilityRole="progressbar" accessibilityLabel="Opening chat" accessibilityLiveRegion="polite">
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