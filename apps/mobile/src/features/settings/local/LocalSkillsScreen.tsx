import { useRouter } from 'expo-router';
import { useState } from 'react';

import { useOnDeviceSelector } from '../../on-device/runtime/OnDeviceProvider';
import {
  PROJECT_SKILL_ROOTS,
  type LocalSkillDiagnostic,
  type LocalSkillListEntry,
  type LocalSkillListing,
} from '../../on-device/runtime/skills';
import type { OnDeviceRuntimeSlice } from '../../on-device/runtime/types';
import { routes } from '@shell/navigation/routes';
import { LOCAL_PROFILE_ID } from '@shell/state/localProfile';
import {
  SettingsCardNote,
  SettingsGroup,
  SettingsNoteText,
  SettingsNotice,
  SettingsRow,
  SettingsToggleRow,
} from '../SettingsList';
import { ICON_ROW_SEPARATOR_INSET } from '../settingsListStyles';
import { failureMessage, useLocalRuntime, useSkillListing, useSkillWorkspace } from './hooks';
import {
  SettingsButtonRow,
  SettingsDetailRow,
  SettingsInlineActions,
  SettingsRowNote,
} from './localSettingsUi';
import {
  LOCAL_SKILLS_TITLE,
  permissionLine,
  SkillPermissionButton,
  SkillsLoading,
  skillSourceLine,
  skillTraits,
  SkillWorkspacePicker,
  useSkillPermissionSheet,
  useSkillRemoval,
} from './localSkillsUi';
import { SettingsSubpage } from './SettingsSubpage';

export { LOCAL_SKILLS_TITLE } from './localSkillsUi';

const PREFERENCE_SLICES: readonly OnDeviceRuntimeSlice[] = ['preferences'];
const WORKSPACE_SLICES: readonly OnDeviceRuntimeSlice[] = ['workspaces'];
const OFF_FOOTER =
  'Skills are off: the agent gets no skill list, no skill tool, and no slash commands. Your skills, choices, and rules are kept.';
const ON_FOOTER =
  'Turning this off gives the agent no skill list, no skill tool, and no slash commands. Your skills, choices, and rules are kept.';

/** The On this iPhone Settings row summary: None, or how many skills are not denied. */
export function skillsSummary(listing: LocalSkillListing): string {
  const enabled = listing.skills.filter((skill) => skill.enabled).length;
  return listing.skills.length === 0 ? 'None' : `${String(enabled)} enabled`;
}

/**
 * Settings › On this iPhone › Skills: a workspace's project skills merged with personal and
 * catalog skills, as the agent sees them, with the global switch, per-skill Allow / Ask / Deny,
 * details, removal, rules, catalogs, and diagnostics.
 */
export function LocalSkillsScreen() {
  const router = useRouter();
  const runtime = useLocalRuntime();
  const [workspaceId, chooseWorkspace] = useSkillWorkspace();
  const { listing, error, reload } = useSkillListing(workspaceId);
  const workspaceName = useOnDeviceSelector(
    (current) => current.workspaces().find((workspace) => workspace.id === workspaceId)?.name,
    WORKSPACE_SLICES,
  );
  const skillsOn = useOnDeviceSelector(
    (current) => current.skills.skillsEnabled(),
    PREFERENCE_SLICES,
  );
  const ruleCount = useOnDeviceSelector(
    (current) =>
      current.skills.rules().length + (current.preferences().disabledSkills?.length ?? 0),
    PREFERENCE_SLICES,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [savingSwitch, setSavingSwitch] = useState(false);
  const { removing, remove } = useSkillRemoval(setNotice);
  const permissions = useSkillPermissionSheet(setNotice);

  const row = (skill: LocalSkillListEntry, id: string) => (
    <SettingsDetailRow
      key={skill.id}
      icon={skill.source === 'personal' ? 'person-outline' : 'folder-outline'}
      title={skill.displayName}
      subtitle={skill.description}
      status={skillSourceLine(skill)}
      accessory={
        <SkillPermissionButton
          skill={skill}
          busy={permissions.saving === skill.id}
          onPress={() => permissions.open(skill)}
        />
      }
      testID={`settings-local-skill-row-${skill.id}`}
    >
      {skill.displayName === skill.id ? null : (
        <SettingsRowNote>{`ID ${skill.id}`}</SettingsRowNote>
      )}
      <SettingsRowNote>{skillTraits(skill).join(' · ')}</SettingsRowNote>
      <SettingsRowNote>{permissionLine(skill)}</SettingsRowNote>
      {skill.allowedTools.length > 0 ? (
        <SettingsRowNote tone="error">
          {`Pre-approves ${skill.allowedTools.join(', ')}: they run without confirmation once the skill loads.`}
        </SettingsRowNote>
      ) : null}
      <SettingsInlineActions
        actions={[
          {
            key: 'details',
            label: 'Details',
            accessibilityLabel: `${skill.id} details`,
            icon: 'information-circle-outline',
            testID: `settings-local-skill-details-${skill.id}`,
            onPress: () => router.push(routes.settingsSkill(LOCAL_PROFILE_ID, skill.id, id)),
          },
          ...(skill.sourceKind === 'personal'
            ? [
                {
                  key: 'remove',
                  label: 'Remove',
                  accessibilityLabel: `Remove ${skill.id}`,
                  icon: 'trash-outline' as const,
                  tone: 'destructive' as const,
                  busy: removing === skill.id,
                  testID: `settings-local-skill-remove-${skill.id}`,
                  onPress: () => void remove(skill.id),
                },
              ]
            : []),
        ]}
      />
    </SettingsDetailRow>
  );

  return (
    <SettingsSubpage
      title={LOCAL_SKILLS_TITLE}
      onBack={() => router.back()}
      testID="settings-local-skills-screen"
    >
      {notice ? <SettingsNotice text={notice} /> : null}
      <SettingsGroup footer={skillsOn ? ON_FOOTER : OFF_FOOTER}>
        <SettingsToggleRow
          label="Use skills"
          value={skillsOn}
          disabled={savingSwitch}
          onChange={(next) => {
            setNotice(null);
            setSavingSwitch(true);
            runtime.skills
              .setSkillsEnabled(next)
              .catch((reason: unknown) =>
                setNotice(failureMessage(reason, 'Skills could not be turned on or off.')),
              )
              .finally(() => setSavingSwitch(false));
          }}
        />
      </SettingsGroup>
      {workspaceId === null ? (
        <SettingsGroup footer="Skills live in a workspace. Create or clone one from a chat’s workspace picker, then come back here.">
          <SettingsRow label="No workspaces yet" />
        </SettingsGroup>
      ) : (
        <SkillWorkspacePicker
          workspaceId={workspaceId}
          onChange={chooseWorkspace}
          footer="Allow, Ask, and Deny apply to every skill with that ID, in every workspace."
        />
      )}
      {workspaceId === null ? null : error ? (
        <SettingsNotice text={error} action="Try again" onPress={reload} />
      ) : !listing ? (
        <SkillsLoading />
      ) : (
        <>
          <SettingsGroup
            title="Project"
            footer={`Read from opencode.json skills paths and catalogs, then ${PROJECT_SKILL_ROOTS.join(', ')}, in that order.`}
            separatorInset={ICON_ROW_SEPARATOR_INSET}
          >
            {listing.skills
              .filter((skill) => skill.source === 'project')
              .map((skill) => row(skill, workspaceId))}
            {listing.skills.some((skill) => skill.source === 'project') ? null : (
              <SettingsCardNote>
                <SettingsNoteText>
                  {`No project skills in ${workspaceName ?? 'this workspace'}. Add a folder with a SKILL.md file, such as .github/skills/<name>/SKILL.md.`}
                </SettingsNoteText>
              </SettingsCardNote>
            )}
          </SettingsGroup>
          <SettingsGroup
            title="Personal"
            footer="Personal skills are stored on this iPhone and work in every workspace. A project skill with the same ID wins. In place of gh skill install, clone a skills repository as a workspace, then add its skills here."
            separatorInset={ICON_ROW_SEPARATOR_INSET}
          >
            {listing.skills
              .filter((skill) => skill.source === 'personal')
              .map((skill) => row(skill, workspaceId))}
            <SettingsButtonRow
              label="Add personal skill"
              testID="settings-local-skill-add"
              onPress={() => router.push(routes.settingsSkillImport(LOCAL_PROFILE_ID, workspaceId))}
            />
          </SettingsGroup>
          <Diagnostics
            title="Skipped"
            footer="The agent can’t use these. Fix the SKILL.md or config, or rename a shadowed skill."
            diagnostics={listing.diagnostics.filter((entry) => entry.severity === 'skipped')}
            testID="settings-local-skill-diagnostic"
          />
          <Diagnostics
            title="Warnings"
            footer="These skills still load. Fix them to keep them portable to GitHub Copilot and OpenCode."
            diagnostics={listing.diagnostics.filter((entry) => entry.severity === 'warning')}
            testID="settings-local-skill-warning"
          />
        </>
      )}
      <SettingsGroup title="Manage">
        <SettingsRow
          label="Permission rules"
          value={ruleCount === 0 ? 'None' : String(ruleCount)}
          accessory="chevron"
          onPress={() => router.push(routes.settingsSkillRules(LOCAL_PROFILE_ID))}
        />
        <SettingsRow
          label="Catalogs"
          accessory="chevron"
          onPress={() => router.push(routes.settingsSkillCatalogs(LOCAL_PROFILE_ID, workspaceId))}
        />
      </SettingsGroup>
      {permissions.sheet}
    </SettingsSubpage>
  );
}

function Diagnostics({
  title,
  footer,
  diagnostics,
  testID,
}: {
  title: string;
  footer: string;
  diagnostics: readonly LocalSkillDiagnostic[];
  testID: string;
}) {
  if (diagnostics.length === 0) {
    return null;
  }
  return (
    <SettingsGroup title={title} footer={footer} separatorInset={ICON_ROW_SEPARATOR_INSET}>
      {diagnostics.map((diagnostic, index) => (
        <SettingsDetailRow
          key={`${diagnostic.source}:${diagnostic.location}:${String(index)}`}
          icon="warning-outline"
          title={diagnostic.location}
          subtitle={diagnostic.message}
          status={diagnostic.source === 'personal' ? 'Personal' : 'Project'}
          testID={testID}
        />
      ))}
    </SettingsGroup>
  );
}
