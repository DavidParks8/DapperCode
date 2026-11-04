import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { decorativeAccessibilityProps } from '@shared/accessibility';
import { BrandMark } from '@shared/ui/BrandMark';
import { ChoiceAction } from '../ChoiceAction';
import type { AppTheme } from '@shared/theme';
import type { OnboardingHeroAnimatedStyle, OnboardingTranslateAnimatedStyle } from './animations';
import type { createOnboardingStyles } from './styles';

/** The bridge choice is always offered; pairing a desktop stays first-class. */
export const INTRO_BRIDGE_CHOICE = {
  title: 'Your machine',
  meta: 'Pair with DapperCode on your computer',
  hint: 'Pairs with a bridge to use the agents installed on your computer.',
} as const;

/**
 * Hero copy states the choices that are actually available: with a local choice it presents both
 * places agents can run; without one it describes pairing only.
 */
export function introCopy(offersLocal: boolean): { titleTail: string; description: string } {
  return offersLocal
    ? {
        titleTail: 'in your pocket',
        description:
          'Run a private model offline on this iPhone, or pair with your own machine to use its agents.',
      }
    : {
        titleTail: 'from your phone',
        description: 'Pair this device with your own machine to use its installed agents.',
      };
}

interface IntroSectionProps {
  /** A second place agents can run, such as on this iPhone. Omit when it is unavailable. */
  action?: ReactNode;
  styles: ReturnType<typeof createOnboardingStyles>;
  theme: AppTheme;
  introHeroAnimatedStyle: OnboardingHeroAnimatedStyle;
  introActionsAnimatedStyle: OnboardingTranslateAnimatedStyle;
  onContinue: () => void;
}

export function OnboardingIntroSection({
  action,
  styles,
  theme,
  introHeroAnimatedStyle,
  introActionsAnimatedStyle,
  onContinue,
}: IntroSectionProps) {
  const copy = introCopy(Boolean(action));
  return (
    <View style={styles.introRoot}>
      <View style={styles.introHeader}>
        <View style={styles.introBrandRow}>
          <BrandMark size={24} />
          <Text style={styles.introBrandName}>DapperCode</Text>
        </View>
      </View>

      <View style={styles.introBody}>
        <Animated.View style={introHeroAnimatedStyle}>
          <View style={styles.introHero}>
            <View style={styles.introHeroArt}>
              <View {...decorativeAccessibilityProps} style={styles.introHeroAgentCloud}>
                <View style={styles.introHeroAgentCard}>
                  <Ionicons
                    name="hardware-chip-outline"
                    size={48}
                    color={theme.colors.textPrimary}
                  />
                </View>
              </View>
            </View>
            <View style={styles.introHeroTitleWrap}>
              <View style={styles.introHeroAgentWord}>
                <Text style={styles.introHeroAgentLabel} numberOfLines={1} adjustsFontSizeToFit>
                  ACP agents
                </Text>
              </View>
              <Text style={styles.introHeroTitleTail} numberOfLines={1} adjustsFontSizeToFit>
                {copy.titleTail}
              </Text>
            </View>
            <Text style={styles.introHeroDescription}>{copy.description}</Text>
          </View>
        </Animated.View>
      </View>

      <Animated.View style={[styles.introFooter, introActionsAnimatedStyle]}>
        {action ? (
          <Text accessibilityRole="header" style={styles.introChoicesTitle}>
            Choose where agents run
          </Text>
        ) : null}
        <ChoiceAction
          variant="primary"
          logo="dappercode"
          title={INTRO_BRIDGE_CHOICE.title}
          meta={INTRO_BRIDGE_CHOICE.meta}
          accessibilityHint={INTRO_BRIDGE_CHOICE.hint}
          testID="onboarding-choice-bridge"
          onPress={onContinue}
        />
        {action}
      </Animated.View>
    </View>
  );
}
