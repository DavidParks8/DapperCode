import { useAtom } from 'jotai';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo } from 'react';

import { LOCAL_MODEL_CATALOG, LOCAL_MODEL_FAMILIES } from '../../on-device/models/catalog';
import { modelMemoryAdmission } from '../../on-device/models/memory';
import type { DeviceMemory, LocalModelFamily } from '../../on-device/models/types';
import { useOnDeviceSelector } from '../../on-device/runtime/OnDeviceProvider';
import type { OnDeviceRuntimeSlice } from '../../on-device/runtime/types';
import { replaceRoot } from '@shell/navigation/routeNavigation';
import { routes } from '@shell/navigation/routes';
import { LOCAL_PROFILE_ID } from '@shell/state/localProfile';
import { SettingsGroup, SettingsRow, SettingsToggleRow } from '../SettingsList';
import { ICON_ROW_SEPARATOR_INSET } from '../settingsListStyles';
import {
  useDeviceMemory,
  useDownloadedModelKey,
  useLocalRuntime,
  useModelAnnouncements,
  useModelStorage,
} from './hooks';
import { LocalModelRow } from './LocalModelRow';
import { SettingsDetailRow, SettingsSearchField } from './localSettingsUi';
import {
  describeTransfer,
  familySizes,
  filterModels,
  formatBytes,
  modelResidency,
} from './modelPresentation';
import { SettingsSubpage } from './SettingsSubpage';
import { localModelFiltersAtom } from './state';

const DOWNLOAD_SLICES: readonly OnDeviceRuntimeSlice[] = ['downloads'];
const SUMMARY_SLICES: readonly OnDeviceRuntimeSlice[] = ['downloads', 'models', 'preferences'];

/** True when the model exceeds this device's RAM budget, whatever is currently free. */
function tooLargeFor(memory: DeviceMemory) {
  return (model: (typeof LOCAL_MODEL_CATALOG)[number]) =>
    modelMemoryAdmission(model, memory).status === 'unsupported';
}

/** The model library for On this iPhone, presented as a Settings page. */
export function LocalModelsScreen() {
  const router = useRouter();
  const { profileId = LOCAL_PROFILE_ID } = useLocalSearchParams<{ profileId?: string }>();
  const runtime = useLocalRuntime();
  const memory = useDeviceMemory(runtime);
  const storage = useModelStorage(runtime);
  useModelAnnouncements();
  const downloadedKey = useDownloadedModelKey();
  const [filters, setFilters] = useAtom(localModelFiltersAtom);
  const downloaded = useMemo(
    () => new Set(downloadedKey.split(',').filter(Boolean)),
    [downloadedKey],
  );
  const visible = filterModels(LOCAL_MODEL_CATALOG, LOCAL_MODEL_FAMILIES, filters, {
    downloaded: (model) => downloaded.has(model.id),
    tooLarge: tooLargeFor(memory),
  });
  const families = LOCAL_MODEL_FAMILIES.map((family) => ({
    family,
    models: visible.filter((model) => model.family === family.name),
  })).filter((entry) => entry.models.length > 0);

  return (
    <SettingsSubpage
      title="Models"
      onBack={() => router.back()}
      testID="settings-local-models-screen"
    >
      <SettingsSearchField
        accessibilityLabel="Search models"
        onChangeText={(query) => setFilters((current) => ({ ...current, query }))}
        placeholder="Search families, sizes, or quants"
        testID="settings-local-models-search"
        value={filters.query}
      />
      <SettingsGroup>
        <SettingsToggleRow
          label="Downloaded only"
          value={filters.downloadedOnly}
          onChange={(downloadedOnly) => setFilters((current) => ({ ...current, downloadedOnly }))}
        />
        <SettingsToggleRow
          label="Include models too large for this iPhone"
          value={filters.showLarger}
          onChange={(showLarger) => setFilters((current) => ({ ...current, showLarger }))}
        />
      </SettingsGroup>

      <InUseSection memory={memory} onNewChat={() => replaceRoot(routes.newChat(profileId))} />
      <TransfersSection memory={memory} />

      {[true, false].map((featured) => {
        const entries = families.filter((entry) => entry.family.featured === featured);
        return entries.length > 0 ? (
          <SettingsGroup
            key={String(featured)}
            title={featured ? 'Featured' : 'More families'}
            separatorInset={ICON_ROW_SEPARATOR_INSET}
          >
            {entries.map(({ family, models }) => (
              <FamilyRow
                key={family.id}
                family={family}
                modelIds={models.map((model) => model.id)}
                onPress={() => router.push(routes.settingsModelFamily(profileId, family.id))}
              />
            ))}
          </SettingsGroup>
        ) : null;
      })}
      {families.length === 0 ? (
        <SettingsGroup footer="Try another search, or turn off the filters above.">
          <SettingsRow label="No models match" />
        </SettingsGroup>
      ) : null}

      <SettingsGroup
        title="Storage"
        footer="Downloads continue in the background, two at a time. Each file is checked against its published checksum before it can load."
      >
        <SettingsRow
          label="Used by models"
          value={storage ? formatBytes(storage.usedBytes) : 'Checking…'}
        />
        <SettingsRow
          label="Available"
          value={storage ? formatBytes(storage.freeBytes) : 'Checking…'}
        />
      </SettingsGroup>
    </SettingsSubpage>
  );
}

/** The loaded model and the model new chats use, with memory headroom. */
function InUseSection({ memory, onNewChat }: { memory: DeviceMemory; onNewChat: () => void }) {
  const ids = useOnDeviceSelector((runtime) => {
    const session = runtime.models.snapshot();
    const loaded = session.phase !== 'empty' && session.phase !== 'error' ? session.modelId : null;
    const selected = runtime.preferences().modelId;
    return [loaded, selected]
      .filter((id, index, all): id is string => Boolean(id) && all.indexOf(id) === index)
      .join(',');
  }, SUMMARY_SLICES);
  const models = ids
    .split(',')
    .filter(Boolean)
    .flatMap((id) => LOCAL_MODEL_CATALOG.filter((model) => model.id === id));
  const memoryLine = `${formatBytes(memory.availableBytes)} of memory free${
    memory.isSimulator ? ' (simulator estimate)' : ''
  }. Loading a model releases the current one first.`;
  return (
    <SettingsGroup title="In use" footer={memoryLine}>
      {models.length === 0 ? (
        <SettingsRow label="No model selected" value="Download one below" />
      ) : (
        models.map((model) => (
          <LocalModelRow key={model.id} model={model} memory={memory} fullName />
        ))
      )}
      {models.length > 0 ? (
        <SettingsRow label="Start a new chat" tone="accent" onPress={onNewChat} />
      ) : null}
    </SettingsGroup>
  );
}

/** Every queued, running, paused, or failed download, so parallel transfers are visible together. */
function TransfersSection({ memory }: { memory: DeviceMemory }) {
  const ids = useOnDeviceSelector(
    (runtime) =>
      LOCAL_MODEL_CATALOG.filter((model) => {
        const kind = describeTransfer(runtime.downloads.snapshot(model.id), model).kind;
        return kind !== 'none' && kind !== 'ready' && kind !== 'checking';
      })
        .map((model) => model.id)
        .join(','),
    DOWNLOAD_SLICES,
  );
  const models = LOCAL_MODEL_CATALOG.filter((model) => ids.split(',').includes(model.id));
  if (models.length === 0) {
    return null;
  }
  return (
    <SettingsGroup title="Downloads">
      {models.map((model) => (
        <LocalModelRow key={model.id} model={model} memory={memory} fullName />
      ))}
    </SettingsGroup>
  );
}

function FamilyRow({
  family,
  modelIds,
  onPress,
}: {
  family: LocalModelFamily;
  modelIds: readonly string[];
  onPress: () => void;
}) {
  const models = LOCAL_MODEL_CATALOG.filter((model) => modelIds.includes(model.id));
  const summary = useOnDeviceSelector((runtime) => {
    const session = runtime.models.snapshot();
    let downloaded = 0;
    let transferring = 0;
    let loaded = false;
    for (const model of models) {
      const kind = describeTransfer(runtime.downloads.snapshot(model.id), model).kind;
      downloaded += kind === 'ready' ? 1 : 0;
      transferring += kind === 'downloading' || kind === 'queued' || kind === 'verifying' ? 1 : 0;
      loaded ||= modelResidency(session, model) === 'loaded';
    }
    return [
      loaded ? 'Loaded' : null,
      downloaded > 0 ? `${downloaded} downloaded` : null,
      transferring > 0 ? `${transferring} downloading` : null,
    ]
      .filter(Boolean)
      .join(' · ');
  }, SUMMARY_SLICES);
  const subtitle = `${family.publisher} · ${familySizes(models).join(', ')} · ${models.length} ${
    models.length === 1 ? 'quant' : 'quants'
  }`;
  return (
    <SettingsDetailRow
      icon={family.icon}
      title={family.name}
      badge={family.badge}
      subtitle={`${subtitle}\n${family.description}`}
      status={summary || null}
      statusTone="accent"
      accessibilityLabel={[family.name, family.badge, subtitle, summary].filter(Boolean).join(', ')}
      onPress={onPress}
      testID={`settings-local-family-${family.id}`}
    />
  );
}
