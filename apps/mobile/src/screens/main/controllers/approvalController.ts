import type { HostBridgeApiClient } from '../../../api/client';
import type {
  PendingApproval,
  PendingUserInputRequest,
  UserInputQuestion,
  UserInputValue,
} from '../../../api/types';
import { normalizeQuestionAnswers } from '../mainScreenHelpers';

type ApprovalApi = Pick<
  HostBridgeApiClient,
  'listApprovals' | 'resolveApproval' | 'resolveUserInput'
>;

function parseUserInputValue(
  fieldType: NonNullable<UserInputQuestion['fieldType']>,
  draft: string,
  header: string,
): { value: UserInputValue } | { error: string } {
  switch (fieldType) {
    case 'integer': {
      const value = Number(draft);
      return Number.isInteger(value) ? { value } : { error: `"${header}" must be an integer` };
    }
    case 'number': {
      const value = Number(draft);
      return Number.isFinite(value) ? { value } : { error: `"${header}" must be a number` };
    }
    case 'boolean':
      return draft === 'true' || draft === 'false'
        ? { value: draft === 'true' }
        : { error: `"${header}" must be true or false` };
    case 'string-array':
      return { value: normalizeQuestionAnswers(draft) };
    case 'string':
    default:
      return { value: draft };
  }
}

export function buildUserInputAnswers(
  request: PendingUserInputRequest,
  drafts: Readonly<Record<string, string>>,
): { answers: Record<string, UserInputValue> } | { error: string } {
  const answers: Record<string, UserInputValue> = {};
  for (const question of request.questions) {
    const draft = (drafts[question.id] ?? '').trim();
    if (!draft && !question.required) {
      continue;
    }
    if (!draft) {
      return { error: `Please answer "${question.header}"` };
    }
    const parsed = parseUserInputValue(question.fieldType ?? 'string', draft, question.header);
    if ('error' in parsed) {
      return parsed;
    }
    answers[question.id] = parsed.value;
  }
  return { answers };
}

export class ApprovalController {
  private readonly failedResolutionIds = new Map<string, string>();
  private resolutionCounter = 0;

  constructor(private readonly api: ApprovalApi) {}

  async findForThread(threadId: string): Promise<PendingApproval | null> {
    const approvals = await this.api.listApprovals();
    return approvals.find((approval) => approval.threadId === threadId) ?? null;
  }

  async resolveApproval(id: string, optionId: string): Promise<void> {
    const key = `${id}:${optionId}`;
    const resolutionId =
      this.failedResolutionIds.get(key) ??
      `approval-${Date.now().toString(36)}-${(++this.resolutionCounter).toString(36)}`;
    try {
      await this.api.resolveApproval(id, optionId, resolutionId);
      this.failedResolutionIds.delete(key);
    } catch (error) {
      this.failedResolutionIds.set(key, resolutionId);
      throw error;
    }
  }

  async resolveUserInput(
    request: PendingUserInputRequest,
    drafts: Readonly<Record<string, string>>,
  ): Promise<string | null> {
    const result = buildUserInputAnswers(request, drafts);
    if ('error' in result) {
      return result.error;
    }
    await this.api.resolveUserInput(request.requestId, { answers: result.answers });
    return null;
  }

  async dismissUserInput(
    request: PendingUserInputRequest,
    action: 'decline' | 'cancel',
  ): Promise<void> {
    await this.api.resolveUserInput(request.requestId, { answers: {}, action });
  }
}
