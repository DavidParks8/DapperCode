import type { Href } from 'expo-router';
import { useRouter } from 'expo-router';

import { SettingsGroup, SettingsRow } from './SettingsList';

/**
 * Settings for the built-in "On this iPhone" profile.
 *
 * Workspaces are managed in the chat's workspace picker and Files screen.
 *
 * Extension point: the rows below still open the legacy `/on-device/*` screens. The model and
 * account tracks replace them with native Settings sections (storage, downloads, GitHub, commit
 * author) built from `SettingsGroup`/`SettingsRow` without changing how this section is mounted.
 */
export const LOCAL_SETTINGS_LINKS: { label: string; href: Href; id: string }[] = [
  { label: 'Models', href: '/on-device/models', id: 'settings-local-models' },
  { label: 'GitHub and author', href: '/on-device/account', id: 'settings-local-account' },
];

export function LocalProfileSection() {
  const router = useRouter();
  return (
    <SettingsGroup
      title="On this iPhone"
      footer="Models, workspaces, and conversations stay on this device."
    >
      {LOCAL_SETTINGS_LINKS.map((link) => (
        <SettingsRow
          key={link.id}
          label={link.label}
          accessory="chevron"
          onPress={() => router.push(link.href)}
        />
      ))}
    </SettingsGroup>
  );
}
