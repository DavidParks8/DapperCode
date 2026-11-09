import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import { useAppTheme } from '@shared/theme';
import {
  SKILL_PAGE_BYTES,
  type LocalSkill,
  type LocalSkillListEntry,
  type LocalSkillPage,
  type LocalSkippedSkillFile,
} from '../../on-device/runtime/skills';
import { SettingsGroup, SettingsNotice, SettingsRow } from '../SettingsList';
import { failureMessage, useLocalRuntime, useSkillListing, useSkillWorkspace } from './hooks';
import { SettingsButtonRow, SettingsCardText, SettingsDetailRow } from './localSettingsUi';
import {
  EFFECT_ICON,
  EFFECT_LABEL,
  LOCAL_SKILLS_TITLE,
  modelVisibility,
  permissionLine,
  SkillsLoading,
  skillSourceLine,
  useSkillPermissionSheet,
  useSkillRemoval,
} from './localSkillsUi';
import { SettingsSubpage } from './SettingsSubpage';

const PRE_APPROVED_FOOTER =
  'These run without asking for confirmation once the skill loads, for the rest of that run; shell and unknown tools are ignored. Only enable skills you have reviewed.';

/** Copilot CLI `/skills info <name>`: where a skill comes from, how it loads, and what it may do. */
export function LocalSkillInfoScreen() {
  const router = useRouter();
  const { name = '', workspaceId: requested } = useLocalSearchParams<{
    name?: string;
    workspaceId?: string;
  }>();
  const [workspaceId] = useSkillWorkspace(requested);
  const { listing, error, reload } = useSkillListing(workspaceId);
  const [notice, setNotice] = useState<string | null>(null);
  const { removing, remove } = useSkillRemoval(setNotice);
  const permissions = useSkillPermissionSheet(setNotice);
  const skill = listing?.skills.find((entry) => entry.id === name);

  return (
    <SettingsSubpage
      title={name || 'Skill'}
      onBack={() => router.back()}
      backTitle={LOCAL_SKILLS_TITLE}
      testID="settings-local-skill-screen"
    >
      {notice ? <SettingsNotice text={notice} /> : null}
      {error ? (
        <SettingsNotice text={error} action="Try again" onPress={reload} />
      ) : workspaceId !== null && !listing ? (
        <SkillsLoading />
      ) : !skill ? (
        <SettingsGroup footer="It was removed or renamed. Go back to see the current skills.">
          <SettingsRow label="This skill is no longer available" />
        </SettingsGroup>
      ) : (
        <>
          <SettingsGroup>
            <SettingsDetailRow
              icon={skill.source === 'personal' ? 'person-outline' : 'folder-outline'}
              title={skill.displayName}
              subtitle={skill.description}
              status={skillSourceLine(skill)}
            />
          </SettingsGroup>
          <SettingsGroup
            title="Permission"
            footer={`${permissionLine(skill)}. Ask means the model asks before loading it; running /${skill.id} or @${skill.id} yourself counts as consent. Your choice overrides the workspace’s rules.`}
          >
            {/* A detail row wraps at accessibility text sizes, where a value row truncates. */}
            <SettingsDetailRow
              icon={EFFECT_ICON[skill.permission.effect]}
              title={
                permissions.saving === skill.id ? 'Saving…' : EFFECT_LABEL[skill.permission.effect]
              }
              accessibilityLabel={`Permission, ${EFFECT_LABEL[skill.permission.effect]}`}
              onPress={() => permissions.open(skill)}
              testID="settings-local-skill-permission"
            />
          </SettingsGroup>
          <SettingsGroup title="Details" footer={UPDATE_HINT[skill.sourceKind]}>
            {skillDetails(skill).map(([title, value]) => (
              <SettingsDetailRow key={title} title={title} subtitle={value} />
            ))}
          </SettingsGroup>
          {skill.allowedTools.length > 0 ? (
            <SettingsGroup title="Pre-approved tools" footer={PRE_APPROVED_FOOTER}>
              <SettingsDetailRow
                icon="warning-outline"
                title={skill.allowedTools.join(', ')}
                testID="settings-local-skill-allowed-tools"
              />
            </SettingsGroup>
          ) : null}
          <SkillContents workspaceId={workspaceId} skill={skill} />
          {skill.sourceKind === 'personal' ? (
            <SettingsGroup>
              <SettingsButtonRow
                label="Remove personal skill"
                tone="destructive"
                busy={removing === skill.id}
                testID="settings-local-skill-remove"
                onPress={() => {
                  void remove(skill.id).then((removed) => {
                    if (removed) {
                      router.back();
                    }
                  });
                }}
              />
            </SettingsGroup>
          ) : null}
        </>
      )}
      {permissions.sheet}
    </SettingsSubpage>
  );
}

const UPDATE_HINT: Record<LocalSkill['sourceKind'], string> = {
  'project-root': 'Edit or delete this skill in the workspace to change it.',
  'config-path': 'Edit or delete this skill, or the opencode.json skills path, in the workspace.',
  catalog: 'Update the catalog in Settings › Skills › Catalogs to get a newer version.',
  personal: 'Add the skill again from a workspace to update this copy.',
};

const SOURCE_KIND: Record<LocalSkill['sourceKind'], string> = {
  'project-root': 'Project skills folder',
  'config-path': 'opencode.json skills path',
  catalog: 'Downloaded catalog',
  personal: 'Imported personal skill',
};

function location(skill: LocalSkill): string {
  if (skill.sourceKind === 'personal') {
    return 'Stored on this iPhone';
  }
  if (skill.sourceKind === 'catalog' || skill.layout === 'flat') {
    return skill.location;
  }
  return `${skill.location}/SKILL.md`;
}

function skillDetails(skill: LocalSkillListEntry): [string, string][] {
  const rows: [string, string | null][] = [
    ['ID', skill.id],
    ['Display name', skill.displayName === skill.id ? null : skill.displayName],
    ['Source', `${SOURCE_KIND[skill.sourceKind]} · ${skill.sourceRoot}`],
    ['Location', location(skill)],
    ['Layout', skill.layout === 'flat' ? 'Single file, no bundled files' : 'Folder with SKILL.md'],
    ['Model list', modelVisibility(skill)],
    ['Slash command', skill.userInvocable ? `/${skill.id}` : 'Off (user-invocable: false)'],
    ['Argument hint', skill.argumentHint],
    [
      'Model loading',
      skill.modelInvocable
        ? 'The model can load it when relevant'
        : `Only after you run /${skill.id} (disable-model-invocation)`,
    ],
    [
      'Runs in',
      skill.context === 'fork'
        ? 'A forked agent; only its final result returns'
        : 'The current conversation',
    ],
    ['License', skill.license],
    ['Compatibility', skill.compatibility],
  ];
  return rows.filter((row): row is [string, string] => row[1] !== null);
}

interface SkillContentsState {
  skill: LocalSkill;
  page?: LocalSkillPage;
  files?: { files: string[]; filesTruncated: boolean; skippedFiles: LocalSkippedSkillFile[] };
  error?: string;
}

/** The first SKILL.md page and bundled files, so a skill can be reviewed before it is enabled. */
function SkillContents({ workspaceId, skill }: { workspaceId: string | null; skill: LocalSkill }) {
  const runtime = useLocalRuntime();
  const theme = useAppTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        source: {
          ...theme.typography.mono,
          paddingHorizontal: theme.spacing.lg,
          paddingVertical: theme.spacing.md,
          backgroundColor: theme.colors.bgItem,
        },
      }),
    [theme],
  );
  const [state, setState] = useState<SkillContentsState | null>(null);
  useEffect(() => {
    if (!workspaceId) {
      return;
    }
    let current = true;
    void Promise.all([
      runtime.skills.read(workspaceId, skill, 'SKILL.md', 0),
      runtime.skills.files(workspaceId, skill),
    ]).then(
      ([page, files]) => {
        if (current) {
          setState({ skill, page, files });
        }
      },
      (error: unknown) => {
        if (current) {
          setState({ skill, error: failureMessage(error, 'SKILL.md could not be read.') });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [runtime, skill, workspaceId]);
  // A refreshed listing keeps showing the previous read until the new one lands.
  const own =
    state?.skill.name === skill.name && state.skill.source === skill.source ? state : null;
  if (own?.error) {
    return (
      <SettingsGroup title="SKILL.md">
        <SettingsCardText tone="error">{own.error}</SettingsCardText>
      </SettingsGroup>
    );
  }
  if (!own?.page || !own.files) {
    return (
      <SettingsGroup title="SKILL.md">
        <SettingsCardText>Reading…</SettingsCardText>
      </SettingsGroup>
    );
  }
  const { files, filesTruncated, skippedFiles } = own.files;
  return (
    <>
      <SettingsGroup
        title="SKILL.md"
        footer={
          own.page.nextOffset === null
            ? 'What the agent reads when it loads this skill.'
            : `The first ${String(SKILL_PAGE_BYTES / 1024)} KB. The agent reads the rest in pages.`
        }
      >
        <Text selectable style={styles.source} testID="settings-local-skill-source">
          {own.page.content.trimEnd()}
        </Text>
      </SettingsGroup>
      <SettingsGroup
        title="Bundled files"
        footer={
          filesTruncated
            ? 'More files are bundled than are listed; the agent sees the same list.'
            : 'The agent can read these on request. Scripts never run on this iPhone.'
        }
      >
        <SettingsDetailRow
          icon="documents-outline"
          title={
            files.length === 0
              ? 'No bundled files'
              : `${String(files.length)} ${files.length === 1 ? 'file' : 'files'}`
          }
          subtitle={files.join('\n')}
          testID="settings-local-skill-files"
        />
        {skippedFiles.length > 0 ? (
          <SettingsDetailRow
            icon="warning-outline"
            title={`${String(skippedFiles.length)} skipped`}
            subtitle={skippedFiles.map((entry) => `${entry.path}: ${entry.reason}`).join('\n')}
          />
        ) : null}
      </SettingsGroup>
    </>
  );
}
