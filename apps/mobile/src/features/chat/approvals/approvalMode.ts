import type { AlertButton } from 'react-native';

import type { ApprovalMode } from '@bridge/types/types';

type ShowAlert = (title: string, message?: string, buttons?: AlertButton[]) => void;

export function selectApprovalModeWithConfirmation(
  mode: ApprovalMode,
  onChange: (mode: ApprovalMode) => void,
  showAlert: ShowAlert,
): void {
  if (mode === 'normal') {
    onChange('normal');
    return;
  }

  showAlert(
    'Enable YOLO approvals?',
    'YOLO mode lets the agent run commands and change files without asking. Only enable it when you trust the active workspace and instructions.',
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Enable YOLO',
        style: 'destructive',
        onPress: () => onChange('yolo'),
      },
    ],
  );
}
