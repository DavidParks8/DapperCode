import { BridgeUiModal as GenericBridgeUiModal } from './SurfaceRenderers';
import type { BridgeUiActionHandler } from './SurfaceRenderers';
import type { BridgeUiSurface } from '@bridge/types/types';
import { PhoneCallApprovalSheet } from '../phoneCall/PhoneCallApprovalSheet';
import { isPhoneCallApprovalSurface } from '../phoneCall/phoneCallApproval';

export { BridgeUiBanner, BridgeUiWorkflowCard } from './SurfaceRenderers';

export function BridgeUiModal({
  surface,
  onAction,
  onDismiss,
}: {
  surface: BridgeUiSurface;
  onAction: BridgeUiActionHandler;
  onDismiss: (surface: BridgeUiSurface) => void;
}) {
  if (isPhoneCallApprovalSurface(surface)) {
    return <PhoneCallApprovalSheet surface={surface} onAction={onAction} onDismiss={onDismiss} />;
  }
  return <GenericBridgeUiModal surface={surface} onAction={onAction} onDismiss={onDismiss} />;
}
