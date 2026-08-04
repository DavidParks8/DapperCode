import { GlassContainer, type GlassContainerProps } from 'expo-glass-effect';
import { View } from 'react-native';

import { isGlassAvailable } from '@shared/ui/glass/capability';

export function GlassGroup({ spacing, ...props }: GlassContainerProps) {
  if (isGlassAvailable()) {
    return <GlassContainer spacing={spacing} {...props} />;
  }

  return <View {...props} />;
}
