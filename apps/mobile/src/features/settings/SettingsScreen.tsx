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

import type { AgentDescriptor, BridgeCapabilities } from '@bridge/types/types';
import type { HostBridgeApiClient } from '@bridge/client/client';
import type { WorkspaceChatLimit } from '@shell/state/appSettings';
import { AgentIcon } from '@shared/ui/AgentIcon';
import { SelectionSheet } from '@shared/ui/SelectionSheet';
import { disablePush, enablePush, updatePushEvents } from '@shell/push/controller';
import { retryPersistenceAtom } from '@shell/state/appState/actions';
import {
  appStatePersistenceErrorAtom,
  pushSettingsAtom,
  bridgeProfilesAtom,
} from '@shell/state/appState/atoms';
import {
  confirmSessionDeletionAtom,
  showToolCallsAtom,
  workspaceChatLimitAtom,
} from '@shell/state/appState/settings';
import {
  activeBridgeProfileAtom,
  apiClientAtom,
  bridgeConnectedAtom,
} from '@shell/state/bridge/atoms';
import { useBridgeCapabilitiesResource } from '@shell/state/bridge/capabilities';
import { drawerCommandsAtom } from '@shell/state/drawer/atoms';
import { routes } from '@shell/navigation/routes';
import { replaceRoot } from '@shell/navigation/routeNavigation';
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
  activeBridgeProfile: { id: string; name: string } | null;
  activeBridgeProfileId: string | null;
  bridgeConnected: boolean;
  bridgeProfiles: { id: string; name: string }[];
  profileId: string;
  router: ReturnType<typeof useRouter>;
}

function ConnectionSection({
  activeBridgeProfile,
  activeBridgeProfileId,
  bridgeConnected,
  bridgeProfiles,
  profileId,
  router,
}: ConnectionSectionProps) {
  return (
    <>
      <SettingsGroup title="Connection">
        <SettingsRow
          label={activeBridgeProfile?.name ?? 'Current bridge'}
          value={bridgeConnected ? 'Connected' : 'Disconnected'}
          accessory="chevron"
          onPress={() => router.push(routes.settingsConnection(profileId, 'edit'))}
        />
        <SettingsRow
          label="Add bridge"
          tone="accent"
          onPress={() => router.push(routes.settingsConnection(profileId, 'add'))}
        />
      </SettingsGroup>
      {bridgeProfiles.length > 0 ? (
        <SettingsGroup
          title="Bridges"
          footer="Switching bridges opens a new chat on that workspace."
        >
          {bridgeProfiles.map((profile) => (
            <SettingsRow
              key={profile.id}
              label={profile.name}
              accessory="check"
              selected={profile.id === activeBridgeProfileId}
              onPress={() => replaceRoot(routes.newChat(profile.id))}
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
  theme: AppTheme;
}

function InstalledAgentsSection({ loading, capabilities, theme }: InstalledAgentsSectionProps) {
  return (
    <SettingsGroup
      title="Installed ACP agents"
      footer="Agents are installed and registered on the desktop host."
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
}

function ChatSettingsSection({ api, bridgeConnected, onError }: ChatSettingsSectionProps) {
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
      <SettingsGroup title="Chat" footer="Approvals decide when an agent must ask before it acts.">
        <SettingsRow
          label="Approvals"
          value={approvalModeTitle(approvalMode)}
          accessory="expand"
          onPress={() => setApprovalSheetVisible(true)}
        />
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
  const styles = useMemo(() => createStyles(theme), [theme]);
  const api = useAtomValue(apiClientAtom);
  const bridgeConnected = useAtomValue(bridgeConnectedAtom);
  const activeBridgeProfile = useAtomValue(activeBridgeProfileAtom);
  const activeBridgeProfileId = activeBridgeProfile?.id ?? null;
  const profileId = routeProfileId ?? activeBridgeProfileId ?? '';
  const bridgeProfiles = useAtomValue(bridgeProfilesAtom);
  const pushSettings = useAtomValue(pushSettingsAtom);
  const persistenceError = useAtomValue(appStatePersistenceErrorAtom);
  const drawerCommands = useAtomValue(drawerCommandsAtom);
  const retryPersistence = useSetAtom(retryPersistenceAtom);

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
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <SettingsHeader
        title="Settings"
        collapsed={titleCollapsed}
        onMenuPress={drawerCommands?.toggleNavigation}
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
          activeBridgeProfile={activeBridgeProfile}
          activeBridgeProfileId={activeBridgeProfileId}
          bridgeConnected={bridgeConnected}
          bridgeProfiles={bridgeProfiles}
          profileId={profileId}
          router={router}
        />

        <InstalledAgentsSection loading={loading} capabilities={capabilities} theme={theme} />

        <ChatSettingsSection api={api} bridgeConnected={bridgeConnected} onError={setError} />

        <NotificationsSection
          pushSettings={pushSettings}
          pushBusy={pushBusy}
          updatePush={updatePush}
          updatePushEvent={updatePushEvent}
        />

        <LegalSection profileId={profileId} router={router} />
      </ScrollView>
    </SafeAreaView>
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
