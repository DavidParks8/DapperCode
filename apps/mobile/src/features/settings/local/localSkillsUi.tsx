import { useState } from 'react';
import { ActivityIndicator } from 'react-native';

import { feedback } from '@shared/feedback';
import { useAppTheme } from '@shared/theme';
import { confirmAction } from '@shared/ui/confirm';
import { SelectionSheet } from '@shared/ui/SelectionSheet';
import { useOnDeviceSelector } from '../../on-device/runtime/OnDeviceProvider';
import type { OnDeviceRuntime } from '../../on-device/runtime/runtime';
import type {
  LocalSkill,
  LocalSkillEffect,
  LocalSkillListEntry,
} from '../../on-device/runtime/skills';
import type { OnDeviceRuntimeSlice } from '../../on-device/runtime/types';
import { SettingsCardNote, SettingsGroup, SettingsRow } from '../SettingsList';
import { failureMessage, useLocalRuntime } from './hooks';
import { SettingsInlineActions } from './localSettingsUi';

export const LOCAL_SKILLS_TITLE = 'Skills';
export const SKILL_EFFECTS: readonly LocalSkillEffect[] = ['allow', 'ask', 'deny'];
export const EFFECT_LABEL: Record<LocalSkillEffect, string> = {
  allow: 'Allow',
  ask: 'Ask',
  deny: 'Deny',
};
export const EFFECT_ICON = {
  allow: 'checkmark-circle-outline',
  ask: 'help-circle-outline',
  deny: 'remove-circle-outline',
} as const;
const PREFERENCE_SLICES: readonly OnDeviceRuntimeSlice[] = ['preferences'];
const WORKSPACE_SLICES: readonly OnDeviceRuntimeSlice[] = ['workspaces'];

export function skillSourceLine(skill: LocalSkill): string {
  switch (skill.sourceKind) {
    case 'personal':
      return 'Personal · every workspace';
    case 'catalog':
      return `${skill.source === 'personal' ? 'Personal' : 'Project'} catalog · ${skill.sourceRoot}`;
    case 'config-path':
      return `Project · ${skill.location} (opencode.json)`;
    case 'project-root':
      return `Project · ${skill.location}`;
  }
}

function hiddenReason(skill: LocalSkillListEntry): string {
  if (!skill.modelInvocable) {
    return `Hidden from the model: loads only with /${skill.id}`;
  }
  return skill.description ? 'Hidden from the model' : 'Hidden from the model: no description';
}

export function modelVisibility(skill: LocalSkillListEntry): string {
  return skill.advertised ? 'Shown to the model' : hiddenReason(skill);
}

/** How the skill can load and run, in the terms of Copilot's `/skills info`. */
export function skillTraits(skill: LocalSkillListEntry): string[] {
  return [
    skill.userInvocable
      ? `/${skill.id}${skill.argumentHint ? ` ${skill.argumentHint}` : ''}`
      : 'No slash command',
    modelVisibility(skill),
    ...(skill.context === 'fork' ? ['Runs in a forked agent'] : []),
    ...(skill.layout === 'flat' ? ['Single file'] : []),
  ];
}

/** The effective permission and the rule that decided it. */
export function permissionLine(skill: LocalSkillListEntry): string {
  const { effect, rule } = skill.permission;
  const decidedBy = !rule
    ? 'no rule matches'
    : rule.origin !== 'user'
      ? `${rule.origin}: ${rule.pattern}`
      : rule.pattern === skill.id
        ? 'your choice'
        : `your rule ${rule.pattern}`;
  return `${EFFECT_LABEL[effect]} · ${decidedBy}`;
}

/**
 * Records the device owner's choice for one skill: an exact-ID rule after their other rules, or
 * Deny as the Copilot-style off switch (which always wins). Null removes the choice so project
 * and pattern rules decide.
 */
export async function setSkillEffect(
  skills: OnDeviceRuntime['skills'],
  id: string,
  effect: LocalSkillEffect | null,
): Promise<void> {
  const others = () => skills.rules().filter((rule) => rule.pattern !== id);
  if (effect === 'deny') {
    await skills.setRules(others());
    await skills.setEnabled(id, false);
    return;
  }
  await skills.setEnabled(id, true);
  await skills.setRules(effect ? [...others(), { pattern: id, effect }] : others());
}

/** One sheet per page for Allow / Ask / Deny; rows open it with `open(skill)`. */
export function useSkillPermissionSheet(onError: (message: string | null) => void) {
  const runtime = useLocalRuntime();
  const [choosing, setChoosing] = useState<LocalSkillListEntry | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const id = choosing?.id ?? null;
  const overridden = useOnDeviceSelector(
    (current) =>
      id !== null &&
      (current.skills.rules().some((rule) => rule.pattern === id) ||
        (current.preferences().disabledSkills ?? []).includes(id)),
    PREFERENCE_SLICES,
  );
  const choose = (skill: LocalSkillListEntry, effect: LocalSkillEffect | null) => {
    setChoosing(null);
    onError(null);
    setSaving(skill.id);
    setSkillEffect(runtime.skills, skill.id, effect)
      .catch((error: unknown) =>
        onError(failureMessage(error, `The permission for ${skill.id} could not be saved.`)),
      )
      .finally(() => setSaving(null));
  };
  const descriptions: Record<LocalSkillEffect, string> = {
    allow: 'The model can load it when relevant, and you can run it.',
    ask: `The model asks before loading it. Running /${id ?? ''} or @${id ?? ''} yourself counts as consent.`,
    deny: 'Off: hidden from the model, the skill tool, and slash commands.',
  };
  const sheet = (
    <SelectionSheet
      visible={choosing !== null}
      title={`Permission for ${id ?? 'skill'}`}
      subtitle={choosing ? `Now ${permissionLine(choosing)}.` : undefined}
      options={
        choosing
          ? [
              ...SKILL_EFFECTS.map((effect) => ({
                key: effect,
                title: EFFECT_LABEL[effect],
                description: descriptions[effect],
                icon: EFFECT_ICON[effect],
                selected: choosing.permission.effect === effect,
                onPress: () => choose(choosing, effect),
              })),
              ...(overridden
                ? [
                    {
                      key: 'rules',
                      title: 'Follow rules',
                      description:
                        'Remove your choice for this skill; project and pattern rules decide.',
                      icon: 'list-outline' as const,
                      onPress: () => choose(choosing, null),
                    },
                  ]
                : []),
            ]
          : []
      }
      onClose={() => setChoosing(null)}
    />
  );
  return { open: setChoosing, saving, sheet };
}

/** The compact Allow / Ask / Deny control at the end of a skill row. */
export function SkillPermissionButton({
  skill,
  busy,
  onPress,
}: {
  skill: LocalSkillListEntry;
  busy: boolean;
  onPress: () => void;
}) {
  const { effect } = skill.permission;
  return (
    <SettingsInlineActions
      actions={[
        {
          key: 'permission',
          label: EFFECT_LABEL[effect],
          accessibilityLabel: `Permission for ${skill.id}, ${EFFECT_LABEL[effect]}`,
          icon: EFFECT_ICON[effect],
          tone: effect === 'deny' ? 'destructive' : 'default',
          busy,
          testID: `settings-local-skill-permission-${skill.id}`,
          onPress,
        },
      ]}
    />
  );
}

/** Removes an imported personal skill once the user confirms; resolves whether it was removed. */
export function useSkillRemoval(onError: (message: string | null) => void) {
  const runtime = useLocalRuntime();
  const [removing, setRemoving] = useState<string | null>(null);
  const remove = async (name: string): Promise<boolean> => {
    const confirmed = await confirmAction({
      title: `Remove ${name}?`,
      message:
        'The personal skill is deleted from this iPhone for every workspace. The folder it was added from is unchanged.',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!confirmed) {
      return false;
    }
    onError(null);
    setRemoving(name);
    try {
      await runtime.skills.removePersonal(name);
      void feedback.success();
      return true;
    } catch (error) {
      onError(failureMessage(error, `${name} could not be removed.`));
      return false;
    } finally {
      setRemoving(null);
    }
  };
  return { removing, remove };
}

/** The workspace whose project skills (and catalogs) are shown; a sheet chooses another one. */
export function SkillWorkspacePicker({
  workspaceId,
  onChange,
  footer,
}: {
  workspaceId: string | null;
  onChange: (id: string) => void;
  footer: string;
}) {
  const workspaces = useOnDeviceSelector((runtime) => runtime.workspaces(), WORKSPACE_SLICES);
  const [open, setOpen] = useState(false);
  const current = workspaces.find((workspace) => workspace.id === workspaceId);
  const choosable = workspaces.length > 1;
  return (
    <>
      <SettingsGroup footer={footer}>
        <SettingsRow
          label="Workspace"
          value={current?.name ?? 'None'}
          accessory={choosable ? 'expand' : 'none'}
          onPress={choosable ? () => setOpen(true) : undefined}
        />
      </SettingsGroup>
      <SelectionSheet
        visible={open}
        title="Workspace"
        subtitle="Choose whose project skills to show."
        options={workspaces.map((workspace) => ({
          key: workspace.id,
          title: workspace.name,
          icon: 'folder-outline',
          selected: workspace.id === workspaceId,
          onPress: () => {
            setOpen(false);
            onChange(workspace.id);
          },
        }))}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

export function SkillsLoading({ label = 'Loading skills' }: { label?: string }) {
  const theme = useAppTheme();
  return (
    <SettingsGroup>
      <SettingsCardNote>
        <ActivityIndicator accessibilityLabel={label} color={theme.colors.accent} />
      </SettingsCardNote>
    </SettingsGroup>
  );
}
