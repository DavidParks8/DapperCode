import { useAtom } from 'jotai';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo } from 'react';

import { LOCAL_MODEL_CATALOG, LOCAL_MODEL_FAMILIES } from '../../on-device/models/catalog';
import { modelMemoryAdmission } from '../../on-device/models/memory';
import { SettingsGroup, SettingsRow, SettingsToggleRow } from '../SettingsList';
import {
  useDeviceMemory,
  useDownloadedModelKey,
  useLocalRuntime,
  useModelAnnouncements,
} from './hooks';
import { LocalModelRow } from './LocalModelRow';
import { SettingsSearchField } from './localSettingsUi';
import { familySizes, filterModels, sortQuants } from './modelPresentation';
import { SettingsSubpage } from './SettingsSubpage';
import { localModelFiltersAtom } from './state';

const DEFAULT_QUANT_NOTE =
  'Smaller quants download faster and use less memory; larger ones keep more precision. All run text-only on this iPhone.';

/** One model family: its sizes, each with the quants that can be downloaded and loaded. */
export function LocalModelFamilyScreen() {
  const router = useRouter();
  const { familyId } = useLocalSearchParams<{ familyId?: string }>();
  const runtime = useLocalRuntime();
  const memory = useDeviceMemory(runtime);
  useModelAnnouncements();
  const downloadedKey = useDownloadedModelKey();
  const [filters, setFilters] = useAtom(localModelFiltersAtom);
  const downloaded = useMemo(
    () => new Set(downloadedKey.split(',').filter(Boolean)),
    [downloadedKey],
  );
  const family = LOCAL_MODEL_FAMILIES.find((entry) => entry.id === familyId);
  if (!family) {
    return (
      <SettingsSubpage title="Models" onBack={() => router.back()}>
        <SettingsGroup footer="Go back to choose another model family.">
          <SettingsRow label="This model family is no longer available" />
        </SettingsGroup>
      </SettingsSubpage>
    );
  }
  const familyModels = LOCAL_MODEL_CATALOG.filter((model) => model.family === family.name);
  const models = filterModels(familyModels, [family], filters, {
    downloaded: (model) => downloaded.has(model.id),
    tooLarge: (model) => modelMemoryAdmission(model, memory).status === 'unsupported',
  });
  const hidden = familyModels.length - models.length;

  return (
    <SettingsSubpage
      title={family.name}
      onBack={() => router.back()}
      testID="settings-local-family-screen"
    >
      <SettingsSearchField
        accessibilityLabel={`Search ${family.name} sizes and quants`}
        onChangeText={(query) => setFilters((current) => ({ ...current, query }))}
        placeholder="Search sizes or quants"
        value={filters.query}
      />
      <SettingsGroup
        footer={`${family.publisher}. ${family.quantizationNote ?? DEFAULT_QUANT_NOTE}`}
      >
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
      {familySizes(models).map((size) => (
        <SettingsGroup key={size} title={size}>
          {sortQuants(models.filter((model) => model.parameters === size)).map((model) => (
            <LocalModelRow key={model.id} model={model} memory={memory} />
          ))}
        </SettingsGroup>
      ))}
      {models.length === 0 ? (
        <SettingsGroup footer="Try another search, or turn off the filters above.">
          <SettingsRow label="No quants match" />
        </SettingsGroup>
      ) : hidden > 0 ? (
        <SettingsGroup
          footer={`${hidden} more ${hidden === 1 ? 'quant is' : 'quants are'} hidden by search or filters.`}
        >
          <SettingsRow
            label="Show all quants"
            tone="accent"
            onPress={() => setFilters({ query: '', downloadedOnly: false, showLarger: true })}
          />
        </SettingsGroup>
      ) : null}
    </SettingsSubpage>
  );
}
