import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { decorativeAccessibilityProps } from '@shared/accessibility';
import { useAppTheme } from '@shared/theme';
import { LOCAL_MODEL_CATALOG, LOCAL_MODEL_FAMILIES } from '../models/catalog';
import { modelMemoryAdmission } from '../models/memory';
import type { LocalModelDefinition, LocalModelFamily } from '../models/types';
import { useOnDeviceRuntime } from '../runtime/OnDeviceProvider';
import { LocalCard, LocalField, LocalPage, LocalText } from './ui';

export function ModelLibraryScreen() {
  const runtime = useOnDeviceRuntime();
  const router = useRouter();
  const { threadId } = useLocalSearchParams<{ threadId?: string }>();
  const [search, setSearch] = useState('');
  const [showUnsupported, setShowUnsupported] = useState(false);
  const [downloadedOnly, setDownloadedOnly] = useState(false);
  const [memory] = useState(() => runtime.native.getMemoryInfo());
  const families = LOCAL_MODEL_FAMILIES.map((family) => ({
    family,
    models: LOCAL_MODEL_CATALOG.filter(
      (model) =>
        model.family === family.name &&
        (!downloadedOnly || runtime.downloads.snapshot(model.id).phase === 'ready') &&
        (showUnsupported || modelMemoryAdmission(model, memory).status !== 'unsupported'),
    ),
  })).filter(
    ({ family, models }) =>
      models.length > 0 &&
      `${family.name} ${family.publisher} ${family.description}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const open = (family: LocalModelFamily) =>
    router.push({
      pathname: '/on-device/models/[familyId]',
      params: {
        familyId: family.id,
        ...(threadId ? { threadId } : {}),
        ...(downloadedOnly ? { downloadedOnly: 'true' } : {}),
        ...(showUnsupported ? { showUnsupported: 'true' } : {}),
      },
    });
  return (
    <LocalPage title="Model library" error={runtime.error()?.message}>
      <LocalField
        label="Search model families"
        value={search}
        onChangeText={setSearch}
        placeholder="Bonsai, Qwen, Gemma…"
      />
      <View style={styles.filter}>
        <Switch
          accessibilityLabel="Downloaded models only"
          value={downloadedOnly}
          onValueChange={setDownloadedOnly}
        />
        <LocalText>Downloaded only</LocalText>
      </View>
      {[true, false].map((featured) => {
        const entries = families.filter((entry) => entry.family.featured === featured);
        return entries.length > 0 ? (
          <View key={String(featured)} style={styles.section}>
            <LocalText title>{featured ? 'Featured' : 'More families'}</LocalText>
            <LocalCard>
              {entries.map(({ family, models }) => (
                <ModelFamilyRow
                  key={family.id}
                  family={family}
                  models={models}
                  onPress={() => open(family)}
                />
              ))}
            </LocalCard>
          </View>
        ) : null;
      })}
      {families.length === 0 ? <LocalText>No model families match these filters.</LocalText> : null}
      <View style={styles.filter}>
        <Switch
          accessibilityLabel="Show models beyond this device's RAM budget"
          value={showUnsupported}
          onValueChange={setShowUnsupported}
        />
        <LocalText>Show larger models</LocalText>
      </View>
      <LocalText>
        {memory.isSimulator
          ? 'Compatibility uses simulator host estimates, not measured iPhone support.'
          : 'Models are filtered by the conservative RAM budget for this iPhone.'}{' '}
        Choose a family to compare sizes and quants.
      </LocalText>
    </LocalPage>
  );
}

function ModelFamilyRow({
  family,
  models,
  onPress,
}: {
  family: LocalModelFamily;
  models: readonly LocalModelDefinition[];
  onPress: () => void;
}) {
  const theme = useAppTheme();
  const runtime = useOnDeviceRuntime();
  const downloaded = models.filter(
    (model) => runtime.downloads.snapshot(model.id).phase === 'ready',
  ).length;
  const sizes = [...new Set(models.map((model) => model.parameters))];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${family.name} model family`}
      accessibilityHint={`${family.publisher}. ${family.description} ${models.length} quants. ${family.badge ?? ''}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, { opacity: pressed ? 0.65 : 1 }]}
    >
      <View style={[styles.icon, { backgroundColor: theme.colors.bgItem }]}>
        <Ionicons
          {...decorativeAccessibilityProps}
          name={family.icon}
          size={23}
          color={theme.colors.accent}
        />
      </View>
      <View style={styles.copy}>
        <Text style={[theme.typography.headline, { color: theme.colors.textPrimary }]}>
          {family.name}
        </Text>
        <Text style={[theme.typography.caption, { color: theme.colors.textMuted }]}>
          {family.publisher}
        </Text>
        <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
          {family.description}
        </Text>
        <Text style={[theme.typography.metadata, { color: theme.colors.textMuted }]}>
          {sizes.join(' · ')} · {models.length} quants
          {downloaded > 0 ? ` · ${downloaded} downloaded` : ''}
        </Text>
        {family.badge ? (
          <Text
            style={[
              theme.typography.metadata,
              styles.badge,
              { color: theme.colors.accent, backgroundColor: theme.colors.bgItem },
            ]}
          >
            {family.badge}
          </Text>
        ) : null}
      </View>
      <Ionicons
        {...decorativeAccessibilityProps}
        name="chevron-forward"
        size={18}
        color={theme.colors.textMuted}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  filter: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  section: { gap: 10 },
  row: { flexDirection: 'row', gap: 12, alignItems: 'center', minHeight: 112, paddingVertical: 8 },
  icon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  copy: { flex: 1, gap: 4 },
  badge: { alignSelf: 'flex-start', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
});
