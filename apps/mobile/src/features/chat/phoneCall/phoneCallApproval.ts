import type { BridgeUiAction, BridgeUiSurface } from '@bridge/types/types';
import { formatPhoneNumber, parseCalleeDisplay, type CalleeDisplay } from './formatPhoneNumber';

export interface PhoneCallApprovalModel {
  callee: CalleeDisplay;
  callerIdFormatted: string | null;
  onBehalfOf: string | null;
  objective: string;
  firstMessage: string;
  context: string;
  approveAction: BridgeUiAction | null;
  cancelAction: BridgeUiAction | null;
}

const OPENING_MESSAGE_HEADING = /^\*\*Opening message\*\*\s*/;
const BACKGROUND_HEADING = /^\*\*Background for the calling agent\*\*\s*/;

export function isPhoneCallApprovalSurface(surface: BridgeUiSurface): boolean {
  return (
    surface.presentation === 'modal' &&
    (surface.kind === 'phone-call' || surface.id.startsWith('phone-call-approval:'))
  );
}

function extractApprovalBlocks(surface: BridgeUiSurface) {
  const values = new Map<string, string>();
  let firstMessage = '';
  let context = '';

  for (const block of surface.blocks) {
    if (block.type === 'keyValue') {
      for (const item of block.items) {
        values.set(item.label, item.value);
      }
    } else if (block.type === 'markdown') {
      if (OPENING_MESSAGE_HEADING.test(block.markdown)) {
        firstMessage = block.markdown.replace(OPENING_MESSAGE_HEADING, '').trim();
      } else if (BACKGROUND_HEADING.test(block.markdown)) {
        context = block.markdown.replace(BACKGROUND_HEADING, '').trim();
      }
    }
  }
  return { values, firstMessage, context };
}

/** Parses the bridge's phone-call approval modal surface into an editable call confirmation model. */
export function parsePhoneCallApproval(surface: BridgeUiSurface): PhoneCallApprovalModel {
  const { values, firstMessage, context } = extractApprovalBlocks(surface);
  const callee = parseCalleeDisplay(values.get('To') ?? surface.subtitle ?? surface.title);
  const callerRaw = values.get('From') ?? null;
  const callerIdFormatted =
    callerRaw && callerRaw !== '+unknown' ? formatPhoneNumber(callerRaw) : null;

  return {
    callee,
    callerIdFormatted,
    onBehalfOf: values.get('On behalf of') ?? null,
    objective: values.get('Objective') ?? '',
    firstMessage,
    context,
    approveAction: surface.actions.find((action) => action.id === 'approve') ?? null,
    cancelAction: surface.actions.find((action) => action.id === 'cancel') ?? null,
  };
}
