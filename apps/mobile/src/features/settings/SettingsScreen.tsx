import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSceneHorizontalInsets } from '@shell/layout/useShellLayout';
import {
  SceneToolbarHost,
  useDrawerNavigationItem,
  useInlineToolbar,
} from '@shell/layout/SceneToolbar';

import type { AgentDescriptor, BridgeCapabilities } from '@bridge/types/types';
import type { HostBridgeApiClient } from '@bridge/client/client';
import type { WorkspaceChatLimit } from '@shell/state/appSettings';
import { AgentIcon } from '@shared/ui/AgentIcon';
import { SelectionSheet } from '@shared/ui/SelectionSheet';
import { disablePush, enablePush, updatePushEvents } from '@shell/push/controller';
import { retryPersistenceAtom } from '@shell/state/appState/actions';
import { appStatePersistenceErrorAtom, pushSettingsAtom } from '@shell/state/appState/atoms';
import {
  confirmSessionDeletionAtom,
  showToolCallsAtom,
  workspaceChatLimitAtom,
} from '@shell/state/appState/settings';
import {
  activeBridgeProfileAtom,
  activeProfileAtom,
  activeProfileFeaturesAtom,
  activeProfileIsLocalAtom,
  apiClientAtom,
  bridgeConnectedAtom,
  shellProfilesAtom,
} from '@shell/state/bridge/atoms';
import type { ShellProfile } from '@shell/state/localProfile';
import { openProfileAtom } from '@shell/profiles/actions';
import { useLocalSetup } from '@shell/profiles/localSetup';
import {
  describeProfile,
  installedAgentsFooter,
  profilesFooter,
} from '@shell/profiles/profilePresentation';
import { useBridgeCapabilitiesResource } from '@shell/state/bridge/capabilities';
import { drawerCommandsAtom } from '@shell/state/drawer/atoms';
import { routes } from '@shell/navigation/routes';
import { useAppTheme, type AppTheme } from '@shared/theme';
import { LARGE_TITLE_COLLAPSE_OFFSET, SettingsHeader } from './SettingsHeader';
import {
  SettingsCardNote,
  SettingsGroup,
  SettingsNotice,
  SettingsNoteText,
  SettingsRow,
  SettingsToggleRow,
} from './SettingsList';
import { ICON_ROW_SEPARATOR_INSET } from './settingsListStyles';
import { approvalModeTitle, useApprovalModeSettings } from './useApprovalModeSettings';
import { LocalProfileSection } from './LocalProfileSection';

function cycleWorkspaceChatLimit(current: WorkspaceChatLimit): WorkspaceChatLimit {
  if (current === 5) {
    return 10;
  }
  if (current === 10) {
    return 25;
  }
  if (current === 25) {
    return null;
  }
  return 5;
}

interface ConnectionSectionProps {
  activeProfile: ShellProfile | null;
  bridgeConnected: boolean;
  /** Whether the open profile has a bridge URL and token to edit. */
  connectionSettings: boolean;
  profiles: ShellProfile[];
  profileId: string;
  router: ReturnType<typeof useRouter>;
}

function ConnectionSection({
  activeProfile,
  bridgeConnected,
  connectionSettings,
  profiles,
  profileId,
  router,
}: ConnectionSectionProps) {
  const localSetup = useLocalSetup();
  const openProfile = useSetAtom(openProfileAtom);
  const present = (profile: ShellProfile) =>
    describeProfile(profile, {
      active: profile.id === activeProfile?.id,
      bridgeConnected,
      localSetup,
    });
  const activeStatus = activeProfile ? present(activeProfile).status : null;
  return (
    <>
      <SettingsGroup title="Connection">
        <SettingsRow
          label={activeProfile?.name ?? 'Current bridge'}
          value={activeStatus ?? undefined}
          accessory={connectionSettings ? 'chevron' : 'none'}
          onPress={
            connectionSettings
              ? () => router.push(routes.settingsConnection(profileId, 'edit'))
              : undefined
          }
        />
        <SettingsRow
          label="Add bridge"
          tone="accent"
          onPress={() => router.push(routes.settingsConnection(profileId, 'add'))}
        />
      </SettingsGroup>
      {profiles.length > 0 ? (
        <SettingsGroup title="Profiles" footer={profilesFooter(profiles)}>
          {profiles.map((profile) => (
            <SettingsRow
              key={profile.id}
              label={profile.name}
              value={present(profile).detail}
              accessory="check"
              selected={profile.id === activeProfile?.id}
              onPress={() => openProfile(profile.id)}
            />
          ))}
        </SettingsGroup>
      ) : null}
    </>
  );
}

interface InstalledAgentsSectionProps {
  loading: boolean;
  capabilities: BridgeCapabilities | null | undefined;
  footer: string;
  theme: AppTheme;
}

function InstalledAgentsSection({
  loading,
  capabilities,
  footer,
  theme,
}: InstalledAgentsSectionProps) {
  return (
    <SettingsGroup
      title="Installed ACP agents"
      footer={footer}
      separatorInset={ICON_ROW_SEPARATOR_INSET}
    >
      {loading ? (
        <SettingsCardNote>
          <ActivityIndicator color={theme.colors.accent} />
        </SettingsCardNote>
      ) : null}
      {!loading && (capabilities?.agents.length ?? 0) === 0 ? (
        <SettingsCardNote>
          <SettingsNoteText>No agents reported by this bridge.</SettingsNoteText>
        </SettingsCardNote>
      ) : null}
      {capabilities?.agents.map((agent) => (
        <AgentRow key={agent.agentId} agent={agent} capabilities={capabilities} />
      ))}
    </SettingsGroup>
  );
}

interface ChatSettingsSectionProps {
  api: HostBridgeApiClient | null;
  bridgeConnected: boolean;
  onError: (message: string | null) => void;
  /** The local agent has no approval flow, so its profile hides the approvals row. */
  showApprovals: boolean;
}

function ChatSettingsSection({
  api,
  bridgeConnected,
  onError,
  showApprovals,
}: ChatSettingsSectionProps) {
  const [confirmSessionDeletion, setConfirmSessionDeletion] = useAtom(confirmSessionDeletionAtom);
  const [showToolCalls, setShowToolCalls] = useAtom(showToolCallsAtom);
  const [workspaceChatLimit, setWorkspaceChatLimit] = useAtom(workspaceChatLimitAtom);
  const {
    approvalBusy,
    approvalMode,
    approvalOptions,
    approvalSheetVisible,
    setApprovalSheetVisible,
  } = useApprovalModeSettings({ api, bridgeConnected, onError });

  return (
    <>
      <SettingsGroup
        title="Chat"
        footer={
          showApprovals ? 'Approvals decide when an agent must ask before it acts.' : undefined
        }
      >
        {showApprovals ? (
          <SettingsRow
            label="Approvals"
            value={approvalModeTitle(approvalMode)}
            accessory="expand"
            onPress={() => setApprovalSheetVisible(true)}
          />
        ) : null}
        <SettingsToggleRow
          label="Show tool calls"
          value={showToolCalls}
          onChange={setShowToolCalls}
        />
        <SettingsToggleRow
          label="Confirm before deleting sessions"
          value={confirmSessionDeletion}
          onChange={setConfirmSessionDeletion}
        />
        <SettingsRow
          label="Chats per workspace"
          value={workspaceChatLimit === null ? 'All' : String(workspaceChatLimit)}
          accessory="expand"
          onPress={() => setWorkspaceChatLimit(cycleWorkspaceChatLimit(workspaceChatLimit))}
        />
      </SettingsGroup>
      <SelectionSheet
        visible={approvalSheetVisible}
        title="Approval requirements"
        subtitle="Choose when agents must ask before acting."
        options={approvalOptions}
        onClose={() => setApprovalSheetVisible(false)}
        loading={approvalBusy}
        loadingLabel="Applying approval requirement"
      />
    </>
  );
}

interface NotificationsSectionProps {
  pushSettings: {
    optedOut: boolean;
    events: { turnCompleted: boolean; approvalRequested: boolean };
  };
  pushBusy: boolean;
  updatePush: (value: boolean) => void | Promise<void>;
  updatePushEvent: (
    key: 'turnCompleted' | 'approvalRequested',
    value: boolean,
  ) => void | Promise<void>;
}

function NotificationsSection({
  pushSettings,
  pushBusy,
  updatePush,
  updatePushEvent,
}: NotificationsSectionProps) {
  return (
    <SettingsGroup
      title="Notifications"
      footer="Alerts arrive when a turn finishes or an agent asks for approval."
    >
      <SettingsToggleRow
        label="Push notifications"
        value={!pushSettings.optedOut}
        disabled={pushBusy}
        onChange={(value) => void updatePush(value)}
      />
      <SettingsToggleRow
        label="Turn completed"
        value={pushSettings.events.turnCompleted}
        onChange={(value) => void updatePushEvent('turnCompleted', value)}
      />
      <SettingsToggleRow
        label="Approval requested"
        value={pushSettings.events.approvalRequested}
        onChange={(value) => void updatePushEvent('approvalRequested', value)}
      />
    </SettingsGroup>
  );
}

function LegalSection({
  profileId,
  router,
}: {
  profileId: string;
  router: ReturnType<typeof useRouter>;
}) {
  return (
    <SettingsGroup title="Legal">
      <SettingsRow
        label="Privacy policy"
        accessory="chevron"
        onPress={() => router.push(routes.privacy(profileId))}
      />
      <SettingsRow
        label="Terms of service"
        accessory="chevron"
        onPress={() => router.push(routes.terms(profileId))}
      />
    </SettingsGroup>
  );
}

export function SettingsScreen() {
  const theme = useAppTheme();
  const router = useRouter();
  const { profileId: routeProfileId } = useLocalSearchParams<{ profileId?: string }>();
  const store = useStore();
  const insets = useSafeAreaInsets();
  const sceneInsets = useSceneHorizontalInsets();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const api = useAtomValue(apiClientAtom);
  const bridgeConnected = useAtomValue(bridgeConnectedAtom);
  const activeProfile = useAtomValue(activeProfileAtom);
  const activeBridgeProfileId = useAtomValue(activeBridgeProfileAtom)?.id ?? null;
  const localProfile = useAtomValue(activeProfileIsLocalAtom);
  const profileId = routeProfileId ?? activeProfile?.id ?? '';
  const profiles = useAtomValue(shellProfilesAtom);
  const features = useAtomValue(activeProfileFeaturesAtom);
  const pushSettings = useAtomValue(pushSettingsAtom);
  const persistenceError = useAtomValue(appStatePersistenceErrorAtom);
  const drawerCommands = useAtomValue(drawerCommandsAtom);
  const retryPersistence = useSetAtom(retryPersistenceAtom);
  const inlineToolbar = useInlineToolbar();
  const navigationItem = useDrawerNavigationItem();

  const {
    value: capabilities,
    refreshing: capabilitiesRefreshing,
    error: capabilitiesError,
  } = useBridgeCapabilitiesResource();
  const loading = capabilitiesRefreshing && !capabilities;
  const [error, setError] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [titleCollapsed, setTitleCollapsed] = useState(false);

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const collapsed = event.nativeEvent.contentOffset.y > LARGE_TITLE_COLLAPSE_OFFSET;
    setTitleCollapsed((current) => (current === collapsed ? current : collapsed));
  };

  const updatePush = async (enabled: boolean) => {
    if (!api || !activeBridgeProfileId || pushBusy) {
      return;
    }
    setPushBusy(true);
    setError(null);
    try {
      if (enabled) {
        await enablePush(api, store, activeBridgeProfileId);
      } else {
        await disablePush(api, store, activeBridgeProfileId);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not update notifications.');
    } finally {
      setPushBusy(false);
    }
  };

  const updatePushEvent = async (key: 'turnCompleted' | 'approvalRequested', value: boolean) => {
    if (!api || !activeBridgeProfileId) {
      return;
    }
    await updatePushEvents(api, store, activeBridgeProfileId, {
      ...pushSettings.events,
      [key]: value,
    });
  };

  return (
    <SceneToolbarHost items={navigationItem ? [navigationItem] : []}>
      <SafeAreaView style={[styles.safeArea, sceneInsets]} edges={['top']}>
        <SettingsHeader
          title="Settings"
          collapsed={titleCollapsed}
          onMenuPress={inlineToolbar ? drawerCommands?.toggleNavigation : undefined}
        />
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          scrollIndicatorInsets={{ right: 1 }}
        >
          <Text accessibilityRole="header" style={styles.largeTitle}>
            Settings
          </Text>

          {persistenceError ? (
            <SettingsNotice
              text={persistenceError.message}
              action="Retry"
              onPress={retryPersistence}
            />
          ) : null}
          {capabilitiesError ? <SettingsNotice text={capabilitiesError} /> : null}
          {error ? <SettingsNotice text={error} /> : null}

          <ConnectionSection
            activeProfile={activeProfile}
            bridgeConnected={bridgeConnected}
            connectionSettings={features.connectionSettings}
            profiles={profiles}
            profileId={profileId}
            router={router}
          />
          {localProfile ? <LocalProfileSection /> : null}

          <InstalledAgentsSection
            loading={loading}
            capabilities={capabilities}
            footer={installedAgentsFooter(activeProfile)}
            theme={theme}
          />

          <ChatSettingsSection
            api={api}
            bridgeConnected={bridgeConnected}
            onError={setError}
            showApprovals={!localProfile}
          />

          {features.pushNotifications ? (
            <NotificationsSection
              pushSettings={pushSettings}
              pushBusy={pushBusy}
              updatePush={updatePush}
              updatePushEvent={updatePushEvent}
            />
          ) : null}

          <LegalSection profileId={profileId} router={router} />
        </ScrollView>
      </SafeAreaView>
    </SceneToolbarHost>
  );
}

function AgentRow({
  agent,
  capabilities,
}: {
  agent: AgentDescriptor;
  capabilities: BridgeCapabilities;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const statuses = [
    agent.agentId === capabilities.preferredAgentId ? 'Preferred' : null,
    agent.agentId === capabilities.activeAgentId ? 'Active' : null,
    agent.lifecycle,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <View style={styles.agentRow}>
      <AgentIcon agent={agent} size={28} />
      <View style={styles.agentText}>
        <Text style={styles.agentName}>{agent.displayName}</Text>
        <Text style={styles.agentMeta}>
          {statuses} · {agent.version} · {agent.provenance}
        </Text>
        {agent.lastError ? (
          <Text style={styles.agentError}>Agent unavailable (details redacted)</Text>
        ) : null}
      </View>
    </View>
  );
}

function createStyles(theme: AppTheme) {
  const { colors } = theme;
  return StyleSheet.create({
    safeArea: { flex: 1, backgroundColor: colors.bgMain },
    content: {
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.xs,
      paddingBottom: 48,
      gap: theme.spacing.xxl,
    },
    largeTitle: { ...theme.typography.largeTitle },
    agentRow: {
      minHeight: theme.touchTarget.minimum,
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: theme.spacing.md,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: 11,
      backgroundColor: colors.bgItem,
    },
    agentText: { flex: 1, gap: 2 },
    agentName: { ...theme.typography.headline, fontWeight: '400' },
    agentMeta: { ...theme.typography.caption, color: colors.textMuted },
    agentError: { ...theme.typography.caption, color: colors.error },
  });
}
