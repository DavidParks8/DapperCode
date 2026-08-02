import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

function runNativeHaptic(effect: () => Promise<void>): void {
  if (Platform.OS === 'web') {
    return;
  }
  void effect().catch(() => {
    // Haptics are best-effort feedback and must never interrupt the interaction.
  });
}

export function playLightImpact(): void {
  runNativeHaptic(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
}

export function playSelectionTick(): void {
  runNativeHaptic(() => Haptics.selectionAsync());
}
