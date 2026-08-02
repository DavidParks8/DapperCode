import { LinearGradient } from 'expo-linear-gradient';
import { useMemo } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, View, type Text } from 'react-native';
import Animated, { FadeIn, ReduceMotion } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { decorativeAccessibilityProps, useModalAccessibilityFocus } from '../../accessibility';
import { motionDuration } from '../../components/motion';
import { useAppTheme } from '../../theme';
import { OnboardingConnectSection } from './OnboardingConnectSection';
import { OnboardingIntroSection } from './OnboardingIntroSection';
import { OnboardingScannerModal } from './OnboardingScannerModal';
import { useOnboardingScreenController } from './onboardingScreenController';
import { createOnboardingStyles } from './onboardingScreenStyles';
import type { OnboardingScreenProps } from './onboardingScreenTypes';

export type { OnboardingBridgeProfileDraft, OnboardingMode } from './onboardingScreenTypes';

export function OnboardingScreen({
  mode = 'initial',
  initialBridgeUrl,
  initialBridgeToken,
  allowInsecureRemoteBridge = false,
  allowQueryTokenAuth = false,
  onSave,
  onCancel,
}: OnboardingScreenProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createOnboardingStyles(theme), [theme]);
  const controller = useOnboardingScreenController({
    mode,
    initialBridgeUrl,
    initialBridgeToken,
    allowInsecureRemoteBridge,
    allowQueryTokenAuth,
    onSave,
  });
  const scannerFocusRef = useModalAccessibilityFocus<Text>(controller.scannerVisible);

  const onboardingBackgroundGradient = theme.isDark
    ? (['#020304', '#05070C', '#0A0E16'] as const)
    : (['#EEF3F8', '#E3EBF3', '#D8E2EC'] as const);
  const ambientPrimaryGradient = theme.isDark
    ? (['rgba(181, 189, 204, 0.20)', 'rgba(181, 189, 204, 0.04)', 'transparent'] as const)
    : (['rgba(56, 79, 106, 0.16)', 'rgba(56, 79, 106, 0.04)', 'transparent'] as const);
  const ambientSecondaryGradient = theme.isDark
    ? (['rgba(255, 255, 255, 0.10)', 'rgba(255, 255, 255, 0.02)', 'transparent'] as const)
    : (['rgba(255, 255, 255, 0.42)', 'rgba(255, 255, 255, 0.10)', 'transparent'] as const);

  return (
    <View style={styles.container}>
      <LinearGradient
        {...decorativeAccessibilityProps}
        colors={onboardingBackgroundGradient}
        style={StyleSheet.absoluteFill}
      />
      <View {...decorativeAccessibilityProps} pointerEvents="none" style={styles.ambientCanvas}>
        <LinearGradient colors={ambientPrimaryGradient} style={styles.ambientOrbPrimary} />
        <LinearGradient colors={ambientSecondaryGradient} style={styles.ambientOrbSecondary} />
      </View>
      <SafeAreaView style={styles.safeArea}>
        <KeyboardAvoidingView
          behavior={
            Platform.OS === 'ios' ? 'padding' : Platform.OS === 'android' ? 'height' : undefined
          }
          style={styles.keyboardAvoiding}
        >
          {controller.showIntroStep ? (
            <OnboardingIntroSection
              styles={styles}
              theme={theme}
              introHeroAnimatedStyle={controller.introHeroAnimatedStyle}
              introActionsAnimatedStyle={controller.introActionsAnimatedStyle}
              onContinue={controller.goToConnectStep}
            />
          ) : (
            <Animated.View
              key="connect"
              entering={FadeIn.duration(motionDuration.routine).reduceMotion(ReduceMotion.System)}
              style={styles.connectAnimatedRoot}
            >
              <OnboardingConnectSection
                styles={styles}
                theme={theme}
                mode={mode}
                onCancel={onCancel}
                showOnboardingDock={controller.showOnboardingDock}
                currentSetupStage={controller.currentSetupStage}
                continueLabel={controller.continueLabel}
                urlInput={controller.urlInput}
                tokenInput={controller.tokenInput}
                tokenHidden={controller.tokenHidden}
                formError={controller.formError}
                checkingConnection={controller.checkingConnection}
                connectionCheck={controller.connectionCheck}
                insecureRemoteWarning={controller.insecureRemoteWarning}
                onBack={controller.goBackToIntro}
                onOpenScanner={() => {
                  void controller.openScanner();
                }}
                onUrlChange={controller.setUrlInput}
                onTokenChange={controller.setTokenInput}
                onToggleTokenHidden={() => {
                  controller.setTokenHidden((previous) => !previous);
                }}
                onSubmitPrimary={() => {
                  void controller.handleSave();
                }}
                onTestConnection={() => {
                  void controller.handleConnectionCheck();
                }}
              />
            </Animated.View>
          )}

          <OnboardingScannerModal
            styles={styles}
            theme={theme}
            scannerVisible={controller.scannerVisible}
            cameraPermissionGranted={controller.cameraPermissionGranted}
            scannerLocked={controller.scannerLocked}
            scannerError={controller.scannerError}
            scannerFocusRef={scannerFocusRef}
            onClose={controller.closeScanner}
            onBarcodeScanned={controller.handleBarcodeScanned}
          />
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}
