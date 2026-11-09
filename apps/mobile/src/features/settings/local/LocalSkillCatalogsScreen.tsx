import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState, type ReactElement } from 'react';

import { useAccessibilityAnnouncement } from '@shared/accessibility';
import { feedback } from '@shared/feedback';
import { confirmAction } from '@shared/ui/confirm';
import type { OnDeviceRuntime } from '../../on-device/runtime/runtime';
import type {
  LocalSkillCatalogDownload,
  LocalSkillCatalogStatus,
} from '../../on-device/runtime/skills';
import { SettingsGroup, SettingsNotice } from '../SettingsList';
import { ICON_ROW_SEPARATOR_INSET } from '../settingsListStyles';
import { failureMessage, useLocalRuntime, useSkillsQuery, useSkillWorkspace } from './hooks';
import {
  SettingsButtonRow,
  SettingsCardText,
  SettingsDetailRow,
  SettingsInlineActions,
  SettingsTextFieldRow,
} from './localSettingsUi';
import { LOCAL_SKILLS_TITLE, SkillsLoading, SkillWorkspacePicker } from './localSkillsUi';
import { SettingsSubpage } from './SettingsSubpage';

const listCatalogs = (runtime: OnDeviceRuntime, workspaceId: string | null) =>
  runtime.skills.catalogs(workspaceId);

/** The last download attempt per catalog URL, shown beside that catalog. */
type DownloadOutcome = { value: LocalSkillCatalogDownload } | { error: string };

function downloadSummary(download: LocalSkillCatalogDownload): string {
  const count = (status: string) =>
    download.skills.filter((skill) => skill.status === status).length;
  return `${String(count('downloaded'))} downloaded, ${String(count('unchanged'))} unchanged, ${String(count('failed'))} failed`;
}

function catalogState(catalog: LocalSkillCatalogStatus): string {
  const cached = catalog.skills.map((skill) => `${skill.name} ${skill.version}`).join(', ');
  if (catalog.state === 'failed') {
    const failure = (catalog.error ?? 'unknown error').replace(/\.$/u, '');
    return `Failed: ${failure}.${cached ? ` Cached: ${cached}` : ''}`;
  }
  return catalog.state === 'cached' ? `Cached: ${cached}` : 'Not downloaded yet';
}

/**
 * OpenCode HTTPS skill catalogs: the workspace's `opencode.json` ones and personal ones. A
 * catalog is contacted only when the user taps Download or Update here; the agent never is.
 */
export function LocalSkillCatalogsScreen() {
  const router = useRouter();
  const runtime = useLocalRuntime();
  const { workspaceId: requested } = useLocalSearchParams<{ workspaceId?: string }>();
  const [workspaceId, chooseWorkspace] = useSkillWorkspace(requested);
  const {
    value: catalogs,
    error,
    reload,
  } = useSkillsQuery(workspaceId, listCatalogs, 'Catalogs could not be read.');
  const [downloading, setDownloading] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, DownloadOutcome>>({});
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  useAccessibilityAnnouncement(announcement);

  const download = (catalog: LocalSkillCatalogStatus) => {
    setDownloading(catalog.url);
    setAnnouncement(null);
    runtime.skills
      .downloadCatalog(catalog.scope === 'personal' ? null : workspaceId, catalog.url)
      .then((value) => {
        void feedback.success();
        setOutcomes((current) => ({ ...current, [catalog.url]: { value } }));
        setAnnouncement(`${catalog.url}: ${downloadSummary(value)}.`);
      })
      .catch((reason: unknown) => {
        const text = failureMessage(reason, 'The catalog could not be downloaded.');
        setOutcomes((current) => ({ ...current, [catalog.url]: { error: text } }));
        setAnnouncement(text);
      })
      .finally(() => setDownloading(null));
  };

  const remove = async (catalog: LocalSkillCatalogStatus) => {
    const confirmed = await confirmAction({
      title: 'Remove catalog?',
      message: `${catalog.url} and the skills downloaded from it are removed from this iPhone.`,
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!confirmed) {
      return;
    }
    setNotice(null);
    setRemoving(catalog.url);
    try {
      await runtime.skills.removePersonalCatalog(catalog.url);
      void feedback.success();
    } catch (reason) {
      setNotice(failureMessage(reason, 'The catalog could not be removed.'));
    } finally {
      setRemoving(null);
    }
  };

  const add = () => {
    setAdding(true);
    setAddError(null);
    runtime.skills
      .addPersonalCatalog(url)
      .then(() => setUrl(''))
      .catch((reason: unknown) =>
        setAddError(failureMessage(reason, 'The catalog could not be added.')),
      )
      .finally(() => setAdding(false));
  };

  const rows = (catalog: LocalSkillCatalogStatus): ReactElement[] => {
    const busy = downloading === catalog.url;
    const outcome = outcomes[catalog.url];
    const rowsForCatalog = [
      <SettingsDetailRow
        key={catalog.url}
        icon="cloud-download-outline"
        title={catalog.url}
        subtitle={catalog.file ? `Listed in ${catalog.file}` : 'Added on this iPhone'}
        status={catalogState(catalog)}
        statusTone={catalog.state === 'failed' ? 'error' : 'default'}
        testID="settings-local-skill-catalog"
      >
        <SettingsInlineActions
          actions={[
            {
              key: 'download',
              label: catalog.state === 'not-downloaded' ? 'Download' : 'Update',
              accessibilityLabel: `${catalog.state === 'not-downloaded' ? 'Download' : 'Update'} ${catalog.url}`,
              icon: 'cloud-download-outline',
              busy,
              disabled: downloading !== null && !busy,
              onPress: () => download(catalog),
            },
            ...(catalog.scope === 'personal'
              ? [
                  {
                    key: 'remove',
                    label: 'Remove',
                    accessibilityLabel: `Remove ${catalog.url}`,
                    icon: 'trash-outline' as const,
                    tone: 'destructive' as const,
                    busy: removing === catalog.url,
                    disabled: busy,
                    onPress: () => void remove(catalog),
                  },
                ]
              : []),
          ]}
        />
      </SettingsDetailRow>,
    ];
    if (outcome && 'error' in outcome) {
      rowsForCatalog.push(
        <SettingsDetailRow
          key="error"
          icon="alert-circle-outline"
          title="Not downloaded"
          status={outcome.error}
          statusTone="error"
          testID="settings-local-skill-catalog-error"
        />,
      );
    } else if (outcome) {
      rowsForCatalog.push(
        <SettingsDetailRow
          key="result"
          icon="checkmark-circle-outline"
          title={downloadSummary(outcome.value)}
          subtitle={outcome.value.skills
            .map(
              (skill) =>
                `${skill.name}${skill.version ? ` ${skill.version}` : ''}: ${skill.status}${skill.error ? ` (${skill.error})` : ''}`,
            )
            .join('\n')}
          testID="settings-local-skill-catalog-result"
        />,
      );
    }
    return rowsForCatalog;
  };

  const project = catalogs?.filter((catalog) => catalog.scope === 'project') ?? [];
  const personal = catalogs?.filter((catalog) => catalog.scope === 'personal') ?? [];
  return (
    <SettingsSubpage
      title="Catalogs"
      onBack={() => router.back()}
      backTitle={LOCAL_SKILLS_TITLE}
      testID="settings-local-skills-catalogs-screen"
    >
      {notice ? <SettingsNotice text={notice} /> : null}
      <SettingsGroup>
        <SettingsCardText>
          This iPhone contacts a catalog URL only when you tap Download or Update, over HTTPS
          without following redirects. The agent uses only the downloaded copies and never downloads
          skills itself.
        </SettingsCardText>
      </SettingsGroup>
      {workspaceId === null ? null : (
        <SkillWorkspacePicker
          workspaceId={workspaceId}
          onChange={chooseWorkspace}
          footer="Project catalogs come from this workspace’s opencode.json skills list."
        />
      )}
      {error ? (
        <SettingsNotice text={error} action="Try again" onPress={reload} />
      ) : !catalogs ? (
        <SkillsLoading label="Loading catalogs" />
      ) : (
        <>
          {workspaceId === null ? null : (
            <SettingsGroup
              title="Project"
              footer="Edit the workspace’s opencode.json to add or remove these."
              separatorInset={ICON_ROW_SEPARATOR_INSET}
            >
              {project.length === 0 ? (
                <SettingsCardText>
                  No catalogs in this workspace’s opencode.json skills list.
                </SettingsCardText>
              ) : (
                project.map(rows)
              )}
            </SettingsGroup>
          )}
          <SettingsGroup
            title="Personal"
            footer="Personal catalogs work in every workspace. Removing one also deletes its downloaded skills."
            separatorInset={ICON_ROW_SEPARATOR_INSET}
          >
            {personal.length === 0 ? (
              <SettingsCardText>No personal catalogs.</SettingsCardText>
            ) : null}
            {personal.map(rows)}
          </SettingsGroup>
        </>
      )}
      <SettingsGroup
        title="Add catalog"
        footer="An https:// address whose index.json lists skills, as in OpenCode. Adding does not download anything."
      >
        <SettingsTextFieldRow
          label="URL"
          value={url}
          onChangeText={(value) => {
            setUrl(value);
            setAddError(null);
          }}
          placeholder="https://example.com/skills/"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="done"
          error={addError}
          testID="settings-local-skill-catalog-url"
        />
        <SettingsButtonRow
          label="Add catalog"
          disabled={!url.trim()}
          busy={adding}
          testID="settings-local-skill-catalog-add"
          onPress={add}
        />
      </SettingsGroup>
    </SettingsSubpage>
  );
}
