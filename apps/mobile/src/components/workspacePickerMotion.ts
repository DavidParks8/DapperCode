import { Easing } from 'react-native-reanimated';

/**
 * Restrained motion tokens for the workspace picker. `theme.motion` is planned as a shared
 * design-system foundation but is not yet present on `AppTheme`; this mirrors its intended
 * resolution locally until that lands. Migrate call sites to `theme.motion` directly once it does.
 */
export const workspacePickerMotion = {
  duration: {
    immediate: 120,
    routine: 200,
  },
  easing: {
    decelerate: Easing.bezier(0.16, 1, 0.3, 1),
  },
};
