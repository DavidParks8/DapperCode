import type { BridgeCapabilities } from '@bridge/types/types';
import { SettingsGroup, SettingsRow } from './SettingsList';

export function CallingIntegrationSection({
  connected,
  capabilities,
  localProfile,
}: {
  connected: boolean;
  capabilities: BridgeCapabilities | null | undefined;
  localProfile: boolean;
}) {
  if (localProfile) {
    return null;
  }
  const known = connected && Boolean(capabilities);
  const configured = capabilities?.supports.phoneCalls === true;
  return (
    <SettingsGroup
      title="Integrations"
      footer={
        !known
          ? 'Connect to the desktop host to check calling setup.'
          : configured
            ? 'Calling is enabled on this host. Every outbound call still needs your approval.'
            : 'Calling is off. Configure a SIP password and calling settings on the desktop host before enabling it.'
      }
    >
      <SettingsRow label="Phone calls" value={!known ? 'Unavailable' : configured ? 'On' : 'Off'} />
    </SettingsGroup>
  );
}
