import { atom } from 'jotai';

import type { ApprovalMode, ApprovalPolicy } from '@bridge/types/types';

export const approvalPolicySyncRevisionAtom = atom(0);

export const requestApprovalPolicySyncAtom = atom(null, (get, set): void => {
  set(approvalPolicySyncRevisionAtom, get(approvalPolicySyncRevisionAtom) + 1);
});

export function toApprovalPolicyForMode(mode: ApprovalMode | null | undefined): ApprovalPolicy {
  if (mode === 'none') {
    return 'never';
  }
  return mode === 'some' ? 'on-request' : 'untrusted';
}
