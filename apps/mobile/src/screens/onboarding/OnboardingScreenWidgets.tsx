import { Ionicons } from '@expo/vector-icons';
import { useCallback, useMemo, useState } from 'react';
import { BlurView } from 'expo-blur';
import * as Clipboard from 'expo-clipboard';
import { Platform, Pressable, Share, Text, View } from 'react-native';
import Animated, { FadeIn, ReduceMotion } from 'react-native-reanimated';

import { decorativeAccessibilityProps } from '../../accessibility';
import { feedback } from '../../feedback';
import { useAppTheme } from '../../theme';
import { BRIDGE_SETUP_URL, SETUP_STAGES } from './onboardingScreenConstants';
import { onboardingMotion } from './onboardingScreenMotion';
import { hitSlopToMeetMinimum } from './onboardingScreenTouch';
import { createOnboardingStyles } from './onboardingScreenStyles';

export function OnboardingStepDock({ currentStage }: { currentStage: number }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createOnboardingStyles(theme), [theme]);
  return (
    <BlurView intensity={45} tint={theme.blurTint} style={styles.stepperDock}>
      <View style={styles.stepperDockRow}>
        {SETUP_STAGES.map((stage, index) => {
          const stepNumber = index + 1;
          const isActive = stepNumber === currentStage;
          const isComplete = stepNumber < currentStage;
          return (
            <View
              key={stage.title}
              accessibilityLabel={`Step ${stepNumber} of ${SETUP_STAGES.length}: ${stage.title}${
                isComplete ? ', completed' : isActive ? ', current step' : ''
              }`}
              accessibilityState={{ selected: isActive }}
              style={[
                styles.stepperPill,
                isActive && styles.stepperPillActive,
                isComplete && styles.stepperPillComplete,
              ]}
            >
              <View
                style={[
                  styles.stepperPillIndex,
                  isActive && styles.stepperPillIndexActive,
                  isComplete && styles.stepperPillIndexComplete,
                ]}
              >
                <Text
                  style={[
                    styles.stepperPillIndexText,
                    (isActive || isComplete) && styles.stepperPillIndexTextActive,
                  ]}
                >
                  {isComplete ? '✓' : String(stepNumber)}
                </Text>
              </View>
              <Text
                numberOfLines={1}
                style={[
                  styles.stepperPillTitle,
                  isActive && styles.stepperPillTitleActive,
                  isComplete && styles.stepperPillTitleComplete,
                ]}
              >
                {stage.title}
              </Text>
            </View>
          );
        })}
      </View>
    </BlurView>
  );
}

export function CommandSnippet({ label, command }: { label: string; command: string }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createOnboardingStyles(theme), [theme]);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await Clipboard.setStringAsync(command);
    setCopied(true);
    void feedback.success();
    setTimeout(() => {
      setCopied(false);
    }, 1400);
  }, [command]);

  const handleShareGuide = useCallback(() => {
    void feedback.selection();
    const title = 'DapperCode bridge setup';
    void Share.share(
      Platform.OS === 'ios'
        ? { title, url: BRIDGE_SETUP_URL }
        : { title, message: `${title}\n${BRIDGE_SETUP_URL}` },
    ).catch(() => {});
  }, []);

  return (
    <View style={styles.commandCard}>
      <View style={styles.commandCardHeader}>
        <View style={styles.commandCardHeaderLeft}>
          <Ionicons name="terminal-outline" size={14} color={theme.colors.textSecondary} />
          <Text style={styles.commandCardLabel}>{label}</Text>
        </View>
        <View style={styles.commandCardActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Share bridge setup guide"
            onPress={handleShareGuide}
            hitSlop={hitSlopToMeetMinimum(30)}
            style={({ pressed }) => [
              styles.commandIconButton,
              pressed && styles.commandCopyButtonPressed,
            ]}
          >
            <Ionicons name="share-outline" size={14} color={theme.colors.textPrimary} />
          </Pressable>
          <Pressable
            onPress={() => {
              void handleCopy();
            }}
            hitSlop={hitSlopToMeetMinimum(30)}
            accessibilityRole="button"
            accessibilityLabel={copied ? 'Copied to clipboard' : 'Copy setup command'}
            style={({ pressed }) => [
              styles.commandCopyButton,
              copied && styles.commandCopyButtonCopied,
              pressed && styles.commandCopyButtonPressed,
            ]}
          >
            <Ionicons
              name={copied ? 'checkmark-outline' : 'copy-outline'}
              size={14}
              color={copied ? theme.colors.accentText : theme.colors.textPrimary}
            />
            <Text
              style={[styles.commandCopyButtonText, copied && styles.commandCopyButtonTextCopied]}
            >
              {copied ? 'Copied' : 'Copy'}
            </Text>
          </Pressable>
        </View>
      </View>
      <View style={styles.commandCodeWrap}>
        <Text selectable style={styles.commandCodeText}>
          {command}
        </Text>
      </View>
    </View>
  );
}

export function StatusBanner({
  tone,
  icon,
  message,
}: {
  tone: 'warning' | 'error' | 'success';
  icon: keyof typeof Ionicons.glyphMap;
  message: string;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createOnboardingStyles(theme), [theme]);
  const iconColor =
    tone === 'warning'
      ? '#F7D27E'
      : tone === 'success'
        ? theme.colors.statusComplete
        : theme.colors.error;

  return (
    <Animated.View
      entering={FadeIn.duration(onboardingMotion.duration.routine).reduceMotion(
        ReduceMotion.System,
      )}
      accessibilityRole={tone === 'error' ? 'alert' : undefined}
      accessibilityLiveRegion={tone === 'error' ? 'assertive' : 'polite'}
      style={[
        styles.statusBanner,
        tone === 'warning'
          ? styles.statusBannerWarning
          : tone === 'success'
            ? styles.statusBannerSuccess
            : styles.statusBannerError,
      ]}
    >
      <Ionicons {...decorativeAccessibilityProps} name={icon} size={16} color={iconColor} />
      <Text
        style={[
          styles.statusBannerText,
          tone === 'warning'
            ? styles.warningText
            : tone === 'success'
              ? styles.successText
              : styles.errorText,
        ]}
      >
        {message}
      </Text>
    </Animated.View>
  );
}
