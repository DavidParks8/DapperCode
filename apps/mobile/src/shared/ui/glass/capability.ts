import { isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import { Platform } from 'react-native';

/**
 * The Expo component already degrades to a plain view. This gate decides whether our shared
 * surface should opt into glass or apply its intentional solid fallback treatment.
 */
export function isGlassAvailable(): boolean {
  return Platform.OS === 'ios' && isLiquidGlassAvailable() && isGlassEffectAPIAvailable();
}
