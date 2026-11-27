import type { BridgeUiSurface } from '@bridge/types/types';
import { AppSheet } from '@shared/ui/AppSheet';
import type { BridgeUiActionHandler } from '../approvals/SurfaceRenderers';
import { PhoneCallStageContent } from './PhoneCallStageContent';

interface PhoneCallStageSheetProps {
  visible: boolean;
  surface: BridgeUiSurface | null;
  whisperDraft: string;
  onChangeWhisperDraft: (value: string) => void;
  onClose: () => void;
  onAction: BridgeUiActionHandler;
  onDismiss: (surface: BridgeUiSurface) => void;
  hasPendingChatAttention: boolean;
  onJumpToChatAttention: () => void;
}

/**
 * Sheet host for the Live Call Stage on standard phones, Closed iPhone Duo, and Laptop iPhone Duo.
 * Uses the app's single `AppSheet` surface so backdrop, margins, and keyboard handling stay unified.
 */
export function PhoneCallStageSheet({
  visible,
  surface,
  whisperDraft,
  onChangeWhisperDraft,
  onClose,
  onAction,
  onDismiss,
  hasPendingChatAttention,
  onJumpToChatAttention,
}: PhoneCallStageSheetProps) {
  return (
    <AppSheet
      visible={visible && surface !== null}
      onClose={onClose}
      accessibilityLabel="Live phone call"
    >
      {surface ? (
        <PhoneCallStageContent
          surface={surface}
          host="sheet"
          whisperDraft={whisperDraft}
          onChangeWhisperDraft={onChangeWhisperDraft}
          onClose={onClose}
          onAction={onAction}
          onDismiss={onDismiss}
          hasPendingChatAttention={hasPendingChatAttention}
          onJumpToChatAttention={onJumpToChatAttention}
        />
      ) : null}
    </AppSheet>
  );
}
