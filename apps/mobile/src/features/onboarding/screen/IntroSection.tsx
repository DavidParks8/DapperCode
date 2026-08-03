import { Ionicons } from '@expo/vector-icons';
import { Text, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { BrandMark } from '@shared/ui/BrandMark';
import { ChoiceAction } from '../ChoiceAction';
import type { AppTheme } from '@shared/theme';
import type { OnboardingHeroAnimatedStyle, OnboardingTranslateAnimatedStyle } from './animations';
import type { createOnboardingStyles } from './styles';

interface IntroSectionProps {
  styles: ReturnType<typeof createOnboardingStyles>;
  theme: AppTheme;
  introHeroAnimatedStyle: OnboardingHeroAnimatedStyle;
  introActionsAnimatedStyle: OnboardingTranslateAnimatedStyle;
  onContinue: () => void;
}

export function OnboardingIntroSection({
  styles,
  theme,
  introHeroAnimatedStyle,
  introActionsAnimatedStyle,
  onContinue,
}: IntroSectionProps) {
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
              <View style={styles.introHeroAgentCloud} accessibilityLabel="ACP agents">
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
                on your device
              </Text>
            </View>
            <Text style={styles.introHeroDescription}>Pair this device with your own machine.</Text>
          </View>
        </Animated.View>
      </View>

      <Animated.View style={[styles.introFooter, introActionsAnimatedStyle]}>
        <ChoiceAction
          variant="primary"
          logo="dappercode"
          title="Private connection"
          meta="Your machine"
          onPress={onContinue}
        />
      </Animated.View>
    </View>
  );
}
