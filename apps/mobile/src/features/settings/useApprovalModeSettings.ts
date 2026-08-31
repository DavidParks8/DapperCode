import { useAtom, useSetAtom } from 'jotai';
import { useMemo, useState } from 'react';

import type { HostBridgeApiClient } from '@bridge/client/client';
import type { ApprovalMode } from '@bridge/types/types';
import { feedback } from '@shared/feedback';
import type { SelectionSheetOption } from '@shared/ui/SelectionSheet';
import {
  requestApprovalPolicySyncAtom,
  toApprovalPolicyForMode,
} from '@shell/state/approvalPolicy';
import { approvalModeAtom } from '@shell/state/appState/settings';

const APPROVAL_MODE_OPTIONS: ReadonlyArray<{
  mode: ApprovalMode;
  title: string;
  description: string;
}> = [
  {
    mode: 'all',
    title: 'Require all approvals',
    description: 'Ask before every action the agent marks as permission-sensitive.',
  },
  {
    mode: 'some',
    title: 'Require some approvals',
    description: 'Allow routine reads, searches, and reasoning; ask before other actions.',
  },
  {
    mode: 'none',
    title: 'Require absolutely no approvals',
    description: 'Never show approval prompts, including for access outside the workspace.',
  },
];

export function approvalModeTitle(mode: ApprovalMode): string {
  return (
    APPROVAL_MODE_OPTIONS.find((option) => option.mode === mode)?.title ?? 'Require all approvals'
  );
}

function approvalModeStrictness(mode: ApprovalMode): number {
  return mode === 'all' ? 2 : mode === 'some' ? 1 : 0;
}

export function useApprovalModeSettings({
  api,
  bridgeConnected,
  onError,
}: {
  api: HostBridgeApiClient | null;
  bridgeConnected: boolean;
  onError: (message: string | null) => void;
}) {
  const [approvalMode, setApprovalMode] = useAtom(approvalModeAtom);
  const requestPolicySync = useSetAtom(requestApprovalPolicySyncAtom);
  const [approvalSheetVisible, setApprovalSheetVisible] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const approvalOptions = useMemo<SelectionSheetOption[]>(
    () =>
      APPROVAL_MODE_OPTIONS.map((option) => ({
        key: option.mode,
        title: option.title,
        description: option.description,
        selected: approvalMode === option.mode,
        disabled: approvalBusy,
        onPress: () => {
          void feedback.selection();
          const sameMode = option.mode === approvalMode;
          const tightensApprovalPolicy =
            approvalModeStrictness(option.mode) > approvalModeStrictness(approvalMode);
          setApprovalBusy(true);
          onError(null);
          void (async () => {
            try {
              if (tightensApprovalPolicy) {
                setApprovalMode(option.mode);
              }
              if (bridgeConnected) {
                if (!api) {
                  throw new Error('The connected bridge client is unavailable.');
                }
                await api.setApprovalPolicy(toApprovalPolicyForMode(option.mode));
              } else if (tightensApprovalPolicy) {
                requestPolicySync();
              }
              if (!tightensApprovalPolicy && !sameMode) {
                setApprovalMode(option.mode);
              }
              setApprovalSheetVisible(false);
            } catch (reason) {
              if (tightensApprovalPolicy || sameMode) {
                requestPolicySync();
              }
              if (tightensApprovalPolicy) {
                setApprovalSheetVisible(false);
              }
              onError(
                reason instanceof Error
                  ? reason.message
                  : 'Could not apply the approval requirement.',
              );
            } finally {
              setApprovalBusy(false);
            }
          })();
        },
      })),
    [api, approvalBusy, approvalMode, bridgeConnected, onError, requestPolicySync, setApprovalMode],
  );

  return {
    approvalBusy,
    approvalMode,
    approvalOptions,
    approvalSheetVisible,
    setApprovalSheetVisible,
  };
}
