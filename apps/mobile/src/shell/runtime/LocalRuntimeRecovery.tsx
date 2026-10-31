import { View } from 'react-native';

import { SettingsButtonRow } from '../../features/settings/local/localSettingsUi';
import { SettingsSubpage } from '../../features/settings/local/SettingsSubpage';
import { SettingsGroup, SettingsNotice } from '../../features/settings/SettingsList';
import type { OnDeviceStartup } from '../../features/on-device/runtime/OnDeviceProvider';
import { LOCAL_PROFILE_NAME } from '@shell/state/localProfile';
import { LocalProfileExit } from './LocalProfileExit';

/**
 * Covers the shell when the local runtime fails to start. While it is still starting the host shows
 * nothing, so the profile route's own "Opening On this iPhone" indicator is the only loading state.
 */
export function LocalRuntimeRecovery({ error, retry }: OnDeviceStartup) {
  if (!error) {
    return null;
  }
  return (
    <SettingsSubpage title={LOCAL_PROFILE_NAME} testID="local-runtime-recovery">
      <View accessible accessibilityRole="alert" accessibilityLiveRegion="assertive">
        <SettingsNotice text={error} />
      </View>
      <SettingsGroup footer="Your models, workspaces, and conversations stay on this iPhone. Retrying never resets them.">
        <SettingsButtonRow label="Retry without resetting storage" onPress={retry} />
      </SettingsGroup>
      <LocalProfileExit />
    </SettingsSubpage>
  );
}
