import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState, type ReactElement } from 'react';

import { useAccessibilityAnnouncement } from '@shared/accessibility';
import { feedback } from '@shared/feedback';
import { PROJECT_SKILL_ROOTS, type LocalSkillImport } from '../../on-device/runtime/skills';
import {
  joinWorkspacePath,
  parentWorkspacePath,
  type LocalDirectoryListing,
} from '../../on-device/workspaces/types';
import {
  SettingsCardNote,
  SettingsGroup,
  SettingsNoteText,
  SettingsNotice,
  SettingsRow,
} from '../SettingsList';
import { ICON_ROW_SEPARATOR_INSET } from '../settingsListStyles';
import { failureMessage, useLocalRuntime, useSkillListing, useSkillWorkspace } from './hooks';
import { LOCAL_SKILLS_TITLE, SkillsLoading, SkillWorkspacePicker } from './localSkillsUi';
import {
  SettingsButtonRow,
  SettingsCardText,
  SettingsDetailRow,
  SettingsInlineActions,
} from './localSettingsUi';
import { SettingsSubpage } from './SettingsSubpage';

const FOLDER_ENTRIES = 500;

/** The last add attempt, shown beside the row or folder it came from. */
type ImportOutcome = { directory: string } & ({ value: LocalSkillImport } | { error: string });

function outcomeAnnouncement(outcome: ImportOutcome | null): string | null {
  if (!outcome) {
    return null;
  }
  if ('error' in outcome) {
    return outcome.error;
  }
  const { name, files, skipped } = outcome.value;
  return `Added ${name}. ${String(files.length)} copied, ${String(skipped.length)} skipped.`;
}

/**
 * Adds a personal skill from a workspace folder that contains SKILL.md: one tap for the
 * workspace's discovered project skills, or browse to any folder (such as a cloned skills repo).
 */
export function LocalSkillImportScreen() {
  const router = useRouter();
  const runtime = useLocalRuntime();
  const { workspaceId: requested } = useLocalSearchParams<{ workspaceId?: string }>();
  const [workspaceId, chooseWorkspace] = useSkillWorkspace(requested);
  const { listing, error, reload } = useSkillListing(workspaceId);
  const [importing, setImporting] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  useAccessibilityAnnouncement(outcomeAnnouncement(outcome));
  // Only directory skills from workspace folders can be copied (not flat files or catalog copies).
  const candidates =
    listing?.skills.filter(
      (skill) =>
        (skill.sourceKind === 'project-root' || skill.sourceKind === 'config-path') &&
        skill.layout === 'directory',
    ) ?? [];

  const add = (workspace: string, directory: string) => {
    setImporting(directory);
    setOutcome(null);
    runtime.skills
      .importPersonal(workspace, directory)
      .then((value) => {
        void feedback.success();
        setOutcome({ directory, value });
      })
      .catch((reason: unknown) =>
        setOutcome({ directory, error: failureMessage(reason, 'The skill could not be added.') }),
      )
      .finally(() => setImporting(null));
  };

  return (
    <SettingsSubpage
      title="Add personal skill"
      onBack={() => router.back()}
      backTitle={LOCAL_SKILLS_TITLE}
      testID="settings-local-skill-add-screen"
    >
      {workspaceId === null ? (
        <SettingsGroup footer="Clone a skills repository or create a workspace from a chat’s workspace picker, then add its skills here.">
          <SettingsRow label="No workspaces yet" />
        </SettingsGroup>
      ) : (
        <>
          <SkillWorkspacePicker
            workspaceId={workspaceId}
            onChange={(id) => {
              setOutcome(null);
              chooseWorkspace(id);
            }}
            footer="Choose the workspace that contains the skill, such as a cloned skills repository."
          />
          {error ? (
            <SettingsNotice text={error} action="Try again" onPress={reload} />
          ) : !listing ? (
            <SkillsLoading />
          ) : (
            <SettingsGroup
              title="Skills in this workspace"
              footer="Adding copies SKILL.md and the folder’s text files to this iPhone. Adding a skill with the same name again replaces it."
              separatorInset={ICON_ROW_SEPARATOR_INSET}
            >
              {candidates.length === 0 ? (
                <SettingsCardNote>
                  <SettingsNoteText>
                    {`None in ${PROJECT_SKILL_ROOTS.join(', ')}. Browse below for a folder that contains SKILL.md.`}
                  </SettingsNoteText>
                </SettingsCardNote>
              ) : null}
              {candidates.map((skill) => [
                <SettingsDetailRow
                  key={skill.name}
                  icon="folder-outline"
                  title={skill.name}
                  subtitle={skill.description}
                  status={skill.location}
                >
                  <SettingsInlineActions
                    actions={[
                      {
                        key: 'add',
                        label: 'Add',
                        accessibilityLabel: `Add ${skill.name}`,
                        icon: 'add-circle-outline',
                        busy: importing === skill.location,
                        disabled: importing !== null,
                        testID: `settings-local-skill-import-${skill.name}`,
                        onPress: () => add(workspaceId, skill.location),
                      },
                    ]}
                  />
                </SettingsDetailRow>,
                ...outcomeRows(outcome, skill.location),
              ])}
            </SettingsGroup>
          )}
          <SkillFolderBrowser
            key={workspaceId}
            workspaceId={workspaceId}
            importing={importing}
            outcome={outcome}
            onAdd={(directory) => add(workspaceId, directory)}
          />
        </>
      )}
    </SettingsSubpage>
  );
}

/** Rows for the outcome of adding `directory`, placed right after the control that added it. */
function outcomeRows(outcome: ImportOutcome | null, directory: string): ReactElement[] {
  if (outcome?.directory !== directory) {
    return [];
  }
  if ('error' in outcome) {
    return [
      <SettingsDetailRow
        key="error"
        icon="alert-circle-outline"
        title="Not added"
        status={outcome.error}
        statusTone="error"
        testID="settings-local-skill-add-error"
      />,
    ];
  }
  const { name, files, skipped } = outcome.value;
  const rows = [
    <SettingsDetailRow
      key="files"
      icon="checkmark-circle-outline"
      title={`Added ${name}`}
      subtitle={`${String(files.length)} ${files.length === 1 ? 'file' : 'files'} copied: ${files.join(', ')}`}
      status="Personal skills work in every workspace. A project skill with the same name wins."
      testID="settings-local-skill-added"
    />,
  ];
  if (skipped.length > 0) {
    rows.push(
      <SettingsDetailRow
        key="skipped"
        icon="warning-outline"
        title={`${String(skipped.length)} skipped`}
        subtitle={skipped.map((entry) => `${entry.path}: ${entry.reason}`).join('\n')}
        testID="settings-local-skill-add-skipped"
      />,
    );
  }
  return rows;
}

interface FolderState {
  path: string;
  listing: LocalDirectoryListing | null;
  error: string | null;
}

/** One workspace folder's entries; null while the folder at `path` is still being listed. */
function useFolder(workspaceId: string, path: string): FolderState | null {
  const runtime = useLocalRuntime();
  const [state, setState] = useState<FolderState | null>(null);
  useEffect(() => {
    let current = true;
    void runtime.native.listWorkspaceFiles(workspaceId, path, FOLDER_ENTRIES).then(
      (listing) => {
        if (current) {
          setState({ path, listing, error: null });
        }
      },
      (error: unknown) => {
        if (current) {
          setState({
            path,
            listing: null,
            error: failureMessage(error, 'This folder could not be opened.'),
          });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [path, runtime, workspaceId]);
  return state?.path === path ? state : null;
}

function folderStatus(folder: FolderState | null, empty: boolean) {
  if (!folder) {
    return <SettingsCardText>Opening…</SettingsCardText>;
  }
  if (folder.error) {
    return <SettingsCardText tone="error">{folder.error}</SettingsCardText>;
  }
  return empty ? <SettingsCardText>No folders here.</SettingsCardText> : null;
}

/** Folder-by-folder browsing of one workspace; a folder with SKILL.md can be added. */
function SkillFolderBrowser({
  workspaceId,
  importing,
  outcome,
  onAdd,
}: {
  workspaceId: string;
  importing: string | null;
  outcome: ImportOutcome | null;
  onAdd: (directory: string) => void;
}) {
  const [path, setPath] = useState('');
  const folder = useFolder(workspaceId, path);
  const entries = folder?.listing?.entries ?? [];
  const folders = entries
    .filter((entry) => entry.kind === 'directory')
    .map((entry) => entry.name)
    .sort();
  const hasSkill =
    path !== '' && entries.some((entry) => entry.kind === 'file' && entry.name === 'SKILL.md');
  const truncated = folder?.listing?.truncated
    ? ` Only the first ${String(FOLDER_ENTRIES)} entries are shown.`
    : '';

  return (
    <SettingsGroup
      title="Browse"
      footer={`Open the folder that contains SKILL.md, then add it.${truncated}`}
    >
      <SettingsDetailRow
        icon="folder-open-outline"
        title={path ? `/${path}` : 'Workspace root'}
        testID="settings-local-skill-browse-path"
      />
      {path ? (
        <SettingsRow label="Parent folder" onPress={() => setPath(parentWorkspacePath(path))} />
      ) : null}
      {hasSkill ? (
        <SettingsButtonRow
          label={`Add ${path.split('/').at(-1) ?? path}`}
          busy={importing === path}
          disabled={importing !== null}
          testID="settings-local-skill-browse-add"
          onPress={() => onAdd(path)}
        />
      ) : null}
      {outcomeRows(outcome, path)}
      {folderStatus(folder, folders.length === 0 && !hasSkill)}
      {folders.map((name) => (
        <SettingsRow
          key={name}
          label={name}
          accessory="chevron"
          onPress={() => setPath(joinWorkspacePath(path, name))}
        />
      ))}
    </SettingsGroup>
  );
}
