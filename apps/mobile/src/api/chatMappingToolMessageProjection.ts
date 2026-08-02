import {
  normalizeInline,
  normalizeMultiline,
  normalizeType,
  parseMcpFunctionToolName,
  readFunctionCommand,
  readFunctionSearchQuery,
  readFunctionToolArguments,
  readFunctionToolInput,
  readPatchTargetPaths,
  readReceiverThreadIds,
  reasoningTextFromItem,
  toFileChangeTargetLabel,
  toNestedOutput,
} from './chatMappingToolArgumentParsers';
import { readFileChangePaths } from './chatMappingRawTypesAndReaders';
import {
  lookupDispatchEntry,
  readCoercedFiniteNumber,
  readString,
  toRecord,
} from '../runtimeValidation';
import { toStructuredPreview, withNestedDetail } from './chatMappingStructuredContentPreview';

type ToolLikeMessageHandler = (item: Record<string, unknown>) => string | null;

function toPlanToolLikeMessage(item: Record<string, unknown>): string | null {
  const text = normalizeMultiline(readString(item.text), 1800);
  return text || null;
}

function toReasoningToolLikeMessage(item: Record<string, unknown>): string | null {
  const text = normalizeMultiline(reasoningTextFromItem(item), 2400);
  return withNestedDetail('• Reasoning', text);
}

function toCommandExecutionToolLikeMessage(item: Record<string, unknown>): string | null {
  const command = normalizeInline(readString(item.command), 240) ?? 'command';
  const status = normalizeType(readString(item.status) ?? '');
  const output =
    normalizeMultiline(readString(item.aggregatedOutput), 2400) ??
    normalizeMultiline(readString(item.aggregated_output), 2400);
  const exitCode =
    readCoercedFiniteNumber(item.exitCode) ?? readCoercedFiniteNumber(item.exit_code);
  const title =
    status === 'failed' || status === 'error'
      ? `• Command failed \`${command}\``
      : `• Ran \`${command}\``;
  const outputPreview = output ? toNestedOutput(output, 8, 1600) : null;
  const detail = outputPreview ?? (exitCode !== null ? `exit code ${String(exitCode)}` : null);
  return withNestedDetail(title, detail);
}

function toMcpToolCallToolLikeMessage(item: Record<string, unknown>): string | null {
  const server = normalizeInline(readString(item.server), 120);
  const tool = normalizeInline(readString(item.tool), 120);
  const label = [server, tool].filter(Boolean).join(' / ') || 'MCP tool call';
  const status = normalizeType(readString(item.status) ?? '');
  const errorRecord = toRecord(item.error);
  const errorDetail =
    normalizeInline(readString(errorRecord?.message), 240) ??
    normalizeInline(readString(item.error), 240);
  const resultDetail = toStructuredPreview(item.result, 240);
  const detail =
    status === 'failed' || status === 'error' ? (errorDetail ?? resultDetail) : resultDetail;
  const title =
    status === 'failed' || status === 'error'
      ? `• Tool failed \`${label}\``
      : `• Called tool \`${label}\``;
  return withNestedDetail(title, detail);
}

function toFunctionCallOutputToolLikeMessage(item: Record<string, unknown>): string | null {
  const output =
    normalizeMultiline(readString(item.output), 2400) ?? toStructuredPreview(item.output, 1200);
  if (!output) {
    return null;
  }
  const callId = normalizeInline(readString(item.call_id) ?? readString(item.callId), 120);
  const title = callId ? `• Tool output \`${callId}\`` : '• Tool output';
  return withNestedDetail(title, toNestedOutput(output, 8, 1600));
}

function buildCollabToolCallTitle(tool: string, status: string): string {
  const failed = status === 'failed' || status === 'error';
  if (tool === 'spawnagent') {
    if (failed) return '• Sub-agent spawn failed';
    if (status === 'completed' || status === 'complete' || status === 'succeeded') {
      return '• Spawned sub-agent';
    }
    return '• Spawning sub-agent';
  }
  if (tool === 'sendinput') {
    return failed ? '• Sub-agent update failed' : '• Sent follow-up to sub-agent';
  }
  if (tool === 'wait') {
    return failed ? '• Waiting on sub-agent failed' : '• Waiting on sub-agent';
  }
  if (tool === 'closeagent') {
    return failed ? '• Closing sub-agent failed' : '• Closed sub-agent thread';
  }
  return failed ? '• Sub-agent action failed' : '• Updated sub-agent thread';
}

function toCollabToolCallToolLikeMessage(item: Record<string, unknown>): string | null {
  const tool = normalizeType(readString(item.tool) ?? '');
  const status = normalizeType(readString(item.status) ?? '');
  const prompt = normalizeInline(readString(item.prompt), 220);
  const receiverThreadIds = readReceiverThreadIds(item);
  const primaryReceiverThreadId = normalizeInline(receiverThreadIds[0], 120);
  const newThreadId = normalizeInline(
    readString(item.newThreadId) ?? readString(item.new_thread_id) ?? primaryReceiverThreadId,
    120,
  );
  const senderThreadId = normalizeInline(
    readString(item.senderThreadId) ?? readString(item.sender_thread_id),
    120,
  );
  const agentStatus = normalizeInline(
    readString(item.agentStatus) ?? readString(item.agent_status),
    120,
  );
  const title = buildCollabToolCallTitle(tool, status);
  const detailParts = [
    prompt ? `Prompt: ${prompt}` : null,
    newThreadId ? `Thread: ${newThreadId}` : null,
    primaryReceiverThreadId ? `Target: ${primaryReceiverThreadId}` : null,
    senderThreadId ? `From: ${senderThreadId}` : null,
    agentStatus ? `Status: ${agentStatus}` : null,
  ].filter(Boolean);
  return withNestedDetail(title, detailParts.join('\n') || null);
}

function toWebSearchToolLikeMessage(item: Record<string, unknown>): string | null {
  const query = normalizeInline(readString(item.query), 180);
  const actionRecord = toRecord(item.action);
  const actionType = normalizeType(readString(actionRecord?.type) ?? '');
  let detail: string | null = query;
  if (actionType === 'openpage') {
    detail = normalizeInline(readString(actionRecord?.url), 240) ?? detail;
  } else if (actionType === 'findinpage') {
    const url = normalizeInline(readString(actionRecord?.url), 180);
    const pattern = normalizeInline(readString(actionRecord?.pattern), 120);
    detail = [url, pattern ? `pattern: ${pattern}` : null].filter(Boolean).join(' | ') || detail;
  }
  const title = query ? `• Searched web for "${query}"` : '• Searched web';
  return withNestedDetail(title, detail && detail !== query ? detail : null);
}

function toFileChangeToolLikeMessage(item: Record<string, unknown>): string | null {
  const status = normalizeType(readString(item.status) ?? '');
  const changedPaths = readFileChangePaths(item);
  const changeCount = changedPaths.length;
  const detail = changeCount > 0 ? changedPaths.join('\n') : null;
  const titleSuffix =
    changeCount === 0
      ? ''
      : changeCount === 1
        ? ` to ${toFileChangeTargetLabel(changedPaths[0])}`
        : ` to ${toFileChangeTargetLabel(changedPaths[0])} +${String(changeCount - 1)} more`;
  const title =
    status === 'failed' || status === 'error'
      ? `• File changes failed${titleSuffix}`
      : `• Applied file changes${titleSuffix}`;
  return withNestedDetail(title, detail);
}

function toImageViewToolLikeMessage(item: Record<string, unknown>): string | null {
  const path = normalizeInline(readString(item.path), 220);
  if (!path) {
    return null;
  }
  return withNestedDetail(`• Viewed image ${toFileChangeTargetLabel(path)}`, path);
}

const TOOL_LIKE_MESSAGE_HANDLERS: Partial<Record<string, ToolLikeMessageHandler>> = {
  plan: toPlanToolLikeMessage,
  reasoning: toReasoningToolLikeMessage,
  commandexecution: toCommandExecutionToolLikeMessage,
  mcptoolcall: toMcpToolCallToolLikeMessage,
  functioncalloutput: toFunctionCallOutputToolLikeMessage,
  customtoolcalloutput: toFunctionCallOutputToolLikeMessage,
  collabtoolcall: toCollabToolCallToolLikeMessage,
  websearch: toWebSearchToolLikeMessage,
  filechange: toFileChangeToolLikeMessage,
  imageview: toImageViewToolLikeMessage,
  enteredreviewmode: () => '• Entered review mode',
  exitedreviewmode: () => '• Exited review mode',
  contextcompaction: () => '• Compacted conversation context',
};

export function toToolLikeMessage(item: Record<string, unknown>): string | null {
  const rawType = readString(item.type);
  if (!rawType) {
    return null;
  }
  const type = normalizeType(rawType);
  if (type === 'functioncall' || type === 'customtoolcall') {
    return toFunctionToolLikeMessage(item);
  }
  const handler = lookupDispatchEntry(TOOL_LIKE_MESSAGE_HANDLERS, type);
  return handler ? handler(item) : null;
}

type FunctionToolCategory = 'exec_command' | 'mcp' | 'search_query' | 'apply_patch' | 'default';

function classifyFunctionToolName(normalizedToolName: string): FunctionToolCategory {
  if (normalizedToolName === 'exec_command') {
    return 'exec_command';
  }
  if (parseMcpFunctionToolName(normalizedToolName)) {
    return 'mcp';
  }
  if (normalizedToolName === 'search_query' || normalizedToolName === 'image_query') {
    return 'search_query';
  }
  if (normalizedToolName === 'apply_patch') {
    return 'apply_patch';
  }
  return 'default';
}

function buildExecCommandToolMessage(
  args: ReturnType<typeof readFunctionToolArguments>,
  item: Record<string, unknown>,
  status: string,
): string | null {
  const command = readFunctionCommand(args) ?? normalizeInline(readFunctionToolInput(item), 240);
  const title =
    status === 'failed' || status === 'error'
      ? `• Command failed \`${command ?? 'command'}\``
      : status === 'running' || status === 'inprogress'
        ? `• Running command \`${command ?? 'command'}\``
        : `• Ran \`${command ?? 'command'}\``;
  const workdir = normalizeInline(readString(args?.workdir), 220);
  return withNestedDetail(title, workdir ? `cwd: ${workdir}` : null);
}

function buildMcpFunctionToolMessage(
  normalizedToolName: string,
  status: string,
  inputPreview: string | null,
): string | null {
  const mcpToolName = parseMcpFunctionToolName(normalizedToolName);
  if (!mcpToolName) return null;
  const title =
    status === 'failed' || status === 'error'
      ? `• Tool failed \`${mcpToolName.server} / ${mcpToolName.tool}\``
      : status === 'running' || status === 'inprogress'
        ? `• Calling tool \`${mcpToolName.server} / ${mcpToolName.tool}\``
        : `• Called tool \`${mcpToolName.server} / ${mcpToolName.tool}\``;
  return withNestedDetail(title, inputPreview ? `Input: ${inputPreview}` : null);
}

function buildSearchQueryToolMessage(
  args: ReturnType<typeof readFunctionToolArguments>,
): string | null {
  const query = normalizeInline(readFunctionSearchQuery(args), 180);
  const title = query ? `• Searched web for "${query}"` : '• Searched web';
  return withNestedDetail(title, null);
}

function buildApplyPatchToolMessage(item: Record<string, unknown>): string | null {
  const patchInput = readFunctionToolInput(item);
  const changedPaths = patchInput ? readPatchTargetPaths(patchInput) : [];
  const detail = changedPaths.length > 0 ? changedPaths.join('\n') : null;
  const title =
    changedPaths.length === 0
      ? '• Applied file changes'
      : changedPaths.length === 1
        ? `• Applied file changes to ${toFileChangeTargetLabel(changedPaths[0])}`
        : `• Applied file changes to ${toFileChangeTargetLabel(changedPaths[0])} +${String(changedPaths.length - 1)} more`;
  return withNestedDetail(title, detail);
}

function buildDefaultFunctionToolMessage(
  normalizedToolName: string,
  status: string,
  inputPreview: string | null,
): string | null {
  const title =
    status === 'failed' || status === 'error'
      ? `• Tool failed \`${normalizedToolName}\``
      : status === 'running' || status === 'inprogress'
        ? `• Calling tool \`${normalizedToolName}\``
        : `• Called tool \`${normalizedToolName}\``;
  return withNestedDetail(title, inputPreview ? `Input: ${inputPreview}` : null);
}

export function toFunctionToolLikeMessage(item: Record<string, unknown>): string | null {
  const rawName =
    readString(item.name) ??
    readString(item.tool) ??
    readString(item.function) ??
    readString(item.function_name);
  const toolName = normalizeInline(rawName, 160) ?? 'tool';
  const normalizedToolName = toolName.replace(/^functions\./, '');
  const status = normalizeType(readString(item.status) ?? '');
  const args = readFunctionToolArguments(item);
  const inputPreview = args ? toStructuredPreview(args, 900) : readFunctionToolInput(item);
  const category = classifyFunctionToolName(normalizedToolName);
  if (category === 'exec_command') {
    return buildExecCommandToolMessage(args, item, status);
  }
  if (category === 'mcp') {
    return buildMcpFunctionToolMessage(normalizedToolName, status, inputPreview);
  }
  if (category === 'search_query') {
    return buildSearchQueryToolMessage(args);
  }
  if (category === 'apply_patch') {
    return buildApplyPatchToolMessage(item);
  }
  return buildDefaultFunctionToolMessage(normalizedToolName, status, inputPreview);
}
