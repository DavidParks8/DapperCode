import { useAtomValue } from 'jotai';
import { useRouter } from 'expo-router';

import { localModelDisplayName } from '../on-device/models/catalog';
import { OnDeviceRuntimeScope, useOnDeviceSelector } from '../on-device/runtime/OnDeviceProvider';
import type { OnDeviceRuntime } from '../on-device/runtime/runtime';
import type { OnDeviceRuntimeSlice } from '../on-device/runtime/types';
import { routes } from '@shell/navigation/routes';
import { localRuntimeAtom } from '@shell/state/local/atoms';
import { LOCAL_PROFILE_ID } from '@shell/state/localProfile';
import { useSkillListing, useSkillWorkspace } from './local/hooks';
import { LocalIssueNotices } from './local/LocalIssueNotices';
import { LOCAL_GIT_ACCOUNT_TITLE } from './local/LocalGitAccountScreen';
import { LOCAL_SKILLS_TITLE, skillsSummary } from './local/LocalSkillsScreen';
import { SettingsGroup, SettingsRow } from './SettingsList';

const SUMMARY_SLICES: readonly OnDeviceRuntimeSlice[] = ['models', 'preferences'];

/**
 * Settings for the built-in "On this iPhone" profile: models, Git identity, and skills. Workspaces
 * are managed in the chat's workspace picker and Files screen.
 */
export function LocalProfileSection() {
  const runtime = useAtomValue(localRuntimeAtom);
  return runtime ? (
    <OnDeviceRuntimeScope runtime={runtime}>
      <LocalProfileRows />
    </OnDeviceRuntimeScope>
  ) : (
    <LocalProfileGroup models={undefined} account={undefined} skills={undefined} />
  );
}

function modelSummary(runtime: OnDeviceRuntime): string {
  const session = runtime.models.snapshot();
  if (session.modelId && (session.phase === 'ready' || session.phase === 'running')) {
    return localModelDisplayName(session.modelId);
  }
  if (session.modelId && session.phase === 'loading') {
    return 'Loading…';
  }
  const selected = runtime.preferences().modelId;
  return selected ? localModelDisplayName(selected) : 'None';
}

function LocalProfileRows() {
  const models = useOnDeviceSelector(modelSummary, SUMMARY_SLICES);
  const account = useOnDeviceSelector(
    (runtime) => runtime.preferences().account?.login ?? 'Not signed in',
    SUMMARY_SLICES,
  );
  // The same preference `skills.skillsEnabled()` reads; absent means on.
  const skillsOn = useOnDeviceSelector(
    (runtime) => runtime.preferences().skillsEnabled !== false,
    SUMMARY_SLICES,
  );
  const [workspaceId] = useSkillWorkspace();
  const { listing } = useSkillListing(workspaceId);
  const skills = !skillsOn
    ? 'Off'
    : workspaceId === null
      ? 'None'
      : listing
        ? skillsSummary(listing)
        : undefined;
  return (
    <>
      <LocalIssueNotices />
      <LocalProfileGroup models={models} account={account} skills={skills} />
    </>
  );
}

function LocalProfileGroup({
  models,
  account,
  skills,
}: {
  models: string | undefined;
  account: string | undefined;
  skills: string | undefined;
}) {
  const router = useRouter();
  return (
    <SettingsGroup
      title="On this iPhone"
      footer="Models, workspaces, and conversations stay on this device."
    >
      <SettingsRow
        label="Models"
        value={models}
        accessory="chevron"
        onPress={() => router.push(routes.settingsModels(LOCAL_PROFILE_ID))}
      />
      <SettingsRow
        label={LOCAL_GIT_ACCOUNT_TITLE}
        value={account}
        accessory="chevron"
        onPress={() => router.push(routes.settingsGitHub(LOCAL_PROFILE_ID))}
      />
      <SettingsRow
        label={LOCAL_SKILLS_TITLE}
        value={skills}
        accessory="chevron"
        onPress={() => router.push(routes.settingsSkills(LOCAL_PROFILE_ID))}
      />
    </SettingsGroup>
  );
}
