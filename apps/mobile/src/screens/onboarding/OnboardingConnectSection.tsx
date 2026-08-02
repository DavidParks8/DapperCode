import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { controlAccessibilityState, decorativeAccessibilityProps } from '../../accessibility';
import { computeHitSlop } from '../../components/touchTarget';
import type { AppTheme } from '../../theme';
import { BRIDGE_SETUP_INSTRUCTION } from './onboardingScreenConstants';
import { CommandSnippet, OnboardingStepDock, StatusBanner } from './OnboardingScreenWidgets';
import type { ConnectionCheck, OnboardingMode } from './onboardingScreenTypes';
import type { createOnboardingStyles } from './onboardingScreenStyles';

interface ConnectSectionProps {
  styles: ReturnType<typeof createOnboardingStyles>;
  theme: AppTheme;
  mode: OnboardingMode;
  onCancel?: () => void;
  showOnboardingDock: boolean;
  currentSetupStage: number;
  continueLabel: string;
  urlInput: string;
  tokenInput: string;
  tokenHidden: boolean;
  formError: string | null;
  checkingConnection: boolean;
  connectionCheck: ConnectionCheck;
  insecureRemoteWarning: string | null;
  onBack: () => void;
  onOpenScanner: () => void;
  onUrlChange: (value: string) => void;
  onTokenChange: (value: string) => void;
  onToggleTokenHidden: () => void;
  onSubmitPrimary: () => void;
  onTestConnection: () => void;
}

interface ConnectHeaderRowProps {
  styles: ReturnType<typeof createOnboardingStyles>;
  theme: AppTheme;
  mode: OnboardingMode;
  onCancel?: () => void;
  showOnboardingDock: boolean;
  onBack: () => void;
}

function OnboardingConnectHeaderRow({
  styles,
  theme,
  mode,
  onCancel,
  showOnboardingDock,
  onBack,
}: ConnectHeaderRowProps) {
  const canCancel = (mode === 'edit' || mode === 'add' || mode === 'reconnect') && onCancel;
  return (
    <View style={styles.connectHeaderRow}>
      <View style={styles.heroTopRowLeft}>
        {showOnboardingDock ? (
          <Pressable
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel="Back"
            accessibilityHint="Returns to the introduction"
            style={({ pressed }) => [styles.connectTopButton, pressed && styles.cancelBtnPressed]}
          >
            <Ionicons
              {...decorativeAccessibilityProps}
              name="chevron-back"
              size={15}
              color={theme.colors.textPrimary}
            />
            <Text style={styles.connectTopButtonText}>Back</Text>
          </Pressable>
        ) : (
          <View style={styles.heroIconWrap}>
            <Ionicons
              {...decorativeAccessibilityProps}
              name="hardware-chip-outline"
              size={20}
              color={theme.colors.textPrimary}
            />
          </View>
        )}
      </View>
      <View style={styles.heroTopRowRight}>
        {canCancel ? (
          <Pressable
            onPress={onCancel}
            hitSlop={computeHitSlop({ width: 30, height: 30 })}
            style={({ pressed }) => [styles.cancelBtn, pressed && styles.cancelBtnPressed]}
            accessibilityRole="button"
            accessibilityLabel="Cancel connection setup"
          >
            <Ionicons
              {...decorativeAccessibilityProps}
              name="close"
              size={16}
              color={theme.colors.textPrimary}
            />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

interface ConnectStatusBannersProps {
  insecureRemoteWarning: string | null;
  formError: string | null;
  connectionCheck: ConnectionCheck;
}

function OnboardingConnectStatusBanners({
  insecureRemoteWarning,
  formError,
  connectionCheck,
}: ConnectStatusBannersProps) {
  return (
    <>
      {insecureRemoteWarning ? (
        <StatusBanner tone="warning" icon="warning-outline" message={insecureRemoteWarning} />
      ) : null}
      {formError ? (
        <StatusBanner tone="error" icon="close-circle-outline" message={formError} />
      ) : null}
      {connectionCheck.kind === 'success' ? (
        <StatusBanner
          tone="success"
          icon="checkmark-circle-outline"
          message={connectionCheck.message}
        />
      ) : null}
      {connectionCheck.kind === 'error' ? (
        <StatusBanner tone="error" icon="alert-circle-outline" message={connectionCheck.message} />
      ) : null}
    </>
  );
}

export function OnboardingConnectSection({
  styles,
  theme,
  mode,
  onCancel,
  showOnboardingDock,
  currentSetupStage,
  continueLabel,
  urlInput,
  tokenInput,
  tokenHidden,
  formError,
  checkingConnection,
  connectionCheck,
  insecureRemoteWarning,
  onBack,
  onOpenScanner,
  onUrlChange,
  onTokenChange,
  onToggleTokenHidden,
  onSubmitPrimary,
  onTestConnection,
}: ConnectSectionProps) {
  return (
    <View style={styles.connectRoot}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {showOnboardingDock ? <OnboardingStepDock currentStage={currentSetupStage} /> : null}
        <OnboardingConnectHeaderRow
          styles={styles}
          theme={theme}
          mode={mode}
          onCancel={onCancel}
          showOnboardingDock={showOnboardingDock}
          onBack={onBack}
        />

        <BlurView intensity={55} tint={theme.blurTint} style={styles.formCard}>
          <View style={styles.commandPanel}>
            <Text style={styles.formSectionEyebrow}>1. Start</Text>
            <CommandSnippet label="Desktop setup" command={BRIDGE_SETUP_INSTRUCTION} />
          </View>

          <View style={styles.formSectionHeader}>
            <Text style={styles.formSectionEyebrow}>2. Pair</Text>
            <Text style={styles.formSectionTitle}>Scan QR or paste details.</Text>
          </View>

          <View style={styles.connectPrimaryActions}>
            <Pressable
              onPress={onOpenScanner}
              accessibilityRole="button"
              accessibilityLabel="Scan QR"
              accessibilityHint="Opens the camera to scan a pairing QR code"
              style={({ pressed }) => [
                styles.scanButton,
                styles.connectActionPrimary,
                pressed && styles.scanButtonPressed,
              ]}
            >
              <Ionicons
                {...decorativeAccessibilityProps}
                name="qr-code-outline"
                size={16}
                color={theme.colors.textPrimary}
              />
              <Text style={styles.scanButtonText}>Scan QR</Text>
            </Pressable>
          </View>

          <View style={styles.fieldGroup}>
            <Text style={styles.label}>URL</Text>
            <View style={styles.inputRow}>
              <View style={styles.inputIconWrap}>
                <Ionicons
                  {...decorativeAccessibilityProps}
                  name="globe-outline"
                  size={16}
                  color={theme.colors.textSecondary}
                />
              </View>
              <TextInput
                value={urlInput}
                onChangeText={onUrlChange}
                keyboardAppearance={theme.keyboardAppearance}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="http://100.101.102.103:8787"
                placeholderTextColor={theme.colors.textMuted}
                style={styles.inputText}
                returnKeyType="done"
                onSubmitEditing={onSubmitPrimary}
                accessibilityLabel="Bridge URL"
              />
            </View>
          </View>

          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Token</Text>
            <View style={styles.tokenInputWrap}>
              <View style={styles.inputRow}>
                <View style={styles.inputIconWrap}>
                  <Ionicons
                    {...decorativeAccessibilityProps}
                    name="key-outline"
                    size={16}
                    color={theme.colors.textSecondary}
                  />
                </View>
                <TextInput
                  value={tokenInput}
                  onChangeText={onTokenChange}
                  keyboardAppearance={theme.keyboardAppearance}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="default"
                  placeholder="Paste connection token"
                  placeholderTextColor={theme.colors.textMuted}
                  style={styles.inputText}
                  secureTextEntry={tokenHidden}
                  returnKeyType="done"
                  onSubmitEditing={onSubmitPrimary}
                  accessibilityLabel="Bridge token"
                />
              </View>
              <Pressable
                onPress={onToggleTokenHidden}
                style={({ pressed }) => [
                  styles.tokenRevealBtn,
                  pressed && styles.tokenRevealBtnPressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel={tokenHidden ? 'Show bridge token' : 'Hide bridge token'}
                accessibilityState={controlAccessibilityState({ expanded: !tokenHidden })}
              >
                <Ionicons
                  {...decorativeAccessibilityProps}
                  name={tokenHidden ? 'eye-outline' : 'eye-off-outline'}
                  size={16}
                  color={theme.colors.textSecondary}
                />
                <Text style={styles.tokenRevealBtnText}>{tokenHidden ? 'Show' : 'Hide'}</Text>
              </Pressable>
            </View>
          </View>

          <OnboardingConnectStatusBanners
            insecureRemoteWarning={insecureRemoteWarning}
            formError={formError}
            connectionCheck={connectionCheck}
          />

          <View style={styles.formSectionHeader}>
            <Text style={styles.formSectionEyebrow}>3. Save</Text>
          </View>

          <View style={styles.actionRow}>
            <Pressable
              onPress={onTestConnection}
              disabled={checkingConnection}
              style={({ pressed }) => [
                styles.secondaryButton,
                pressed && !checkingConnection && styles.secondaryButtonPressed,
                checkingConnection && styles.secondaryButtonDisabled,
              ]}
              accessibilityRole="button"
              accessibilityState={controlAccessibilityState({
                disabled: checkingConnection,
                busy: checkingConnection,
              })}
            >
              {checkingConnection ? (
                <ActivityIndicator size="small" color={theme.colors.textPrimary} />
              ) : (
                <Ionicons
                  {...decorativeAccessibilityProps}
                  name="pulse-outline"
                  size={16}
                  color={theme.colors.textPrimary}
                />
              )}
              <Text style={styles.secondaryButtonText}>Test Connection</Text>
            </Pressable>
          </View>
        </BlurView>
      </ScrollView>
      <View style={styles.connectFooter}>
        <Pressable
          onPress={onSubmitPrimary}
          disabled={checkingConnection}
          style={({ pressed }) => [
            styles.primaryButton,
            styles.connectFooterButton,
            pressed && !checkingConnection && styles.primaryButtonPressed,
            checkingConnection && styles.primaryButtonDisabled,
          ]}
          accessibilityRole="button"
          accessibilityLabel={continueLabel}
          accessibilityHint="Saves this private bridge connection"
          accessibilityState={controlAccessibilityState({
            disabled: checkingConnection,
            busy: checkingConnection,
          })}
        >
          {checkingConnection ? (
            <View style={styles.primaryButtonIconWrap}>
              <ActivityIndicator size="small" color={theme.colors.accentText} />
            </View>
          ) : (
            <View style={styles.primaryButtonIconWrap}>
              <Ionicons
                {...decorativeAccessibilityProps}
                name="shield-checkmark-outline"
                size={18}
                color={theme.colors.accentText}
              />
            </View>
          )}
          <View style={styles.primaryButtonContent}>
            <View style={styles.primaryButtonCopy}>
              <Text style={styles.primaryButtonText}>{continueLabel}</Text>
              <Text style={styles.primaryButtonSubtext}>Start using DapperCode</Text>
            </View>
            <Ionicons
              {...decorativeAccessibilityProps}
              name="arrow-forward"
              size={20}
              color={theme.colors.accentText}
            />
          </View>
        </Pressable>
      </View>
    </View>
  );
}
