import type { Ionicons } from '@expo/vector-icons';

import { getMessageText, getToolCallDisplayLines } from '../api/messages';
import type { ChatMessage, ChatToolKind, ChatToolMeta, ChatToolStatus } from '../api/types';
import { parseTimelineEntries, toTimelineVisual } from './chatMessageTimelineHelpers';

export interface ToolInvocationLocation {
  path: string;
  line?: number;
}

export interface ToolInvocationDiff {
  path: string;
  oldText: string | null;
  newText: string;
}

export interface ToolInvocationTerminal {
  terminalId: string | null;
  output: string;
}

/**
 * One row in the transcript. Every message-production path (live events, bridge
 * snapshot, persisted history) folds into this shape so the row and its body
 * never have to care where the invocation came from.
 */
export interface ToolInvocation {
  id: string;
  kind: ChatToolKind;
  status: ChatToolStatus;
  title: string;
  monospaceTitle: boolean;
  isError: boolean;
  locations: ToolInvocationLocation[];
  diffs: ToolInvocationDiff[];
  terminals: ToolInvocationTerminal[];
  textLines: string[];
  images: string[];
  truncated: boolean;
  /** True while the invocation only has metadata, i.e. no output to expand. */
  empty: boolean;
}

const KIND_ICONS: Record<ChatToolKind, keyof typeof Ionicons.glyphMap> = {
  read: 'document-text-outline',
  edit: 'create-outline',
  delete: 'trash-outline',
  move: 'arrow-forward-outline',
  search: 'search-outline',
  execute: 'terminal-outline',
  think: 'bulb-outline',
  fetch: 'globe-outline',
  switch_mode: 'swap-horizontal-outline',
  other: 'construct-outline',
};

export function toolKindIcon(kind: ChatToolKind): keyof typeof Ionicons.glyphMap {
  return KIND_ICONS[kind] ?? KIND_ICONS.other;
}

export function buildToolInvocations(messages: ChatMessage[]): ToolInvocation[] {
  const order: string[] = [];
  const drafts = new Map<string, ToolInvocationDraft>();

  const draftFor = (id: string): ToolInvocationDraft => {
    const existing = drafts.get(id);
    if (existing) return existing;
    const created: ToolInvocationDraft = {
      id,
      meta: null,
      textLines: [],
      legacyTitle: null,
    };
    drafts.set(id, created);
    order.push(id);
    return created;
  };

  for (const message of messages) {
    const meta = message.toolMeta;
    const callId = meta?.toolCallId ?? toolCallIdOf(message);
    if (callId) {
      const draft = draftFor(callId);
      if (meta) draft.meta = meta;
      const parsed = readToolMessage(message, Boolean(meta ?? draft.meta));
      draft.legacyTitle ??= parsed.title;
      appendLines(draft.textLines, parsed.lines);
      continue;
    }
    for (const legacy of legacyInvocations(message)) {
      const draft = draftFor(legacy.id);
      draft.legacyTitle ??= legacy.title;
      appendLines(draft.textLines, legacy.details);
    }
  }

  return order
    .map((id) => finalizeInvocation(drafts.get(id)))
    .filter((invocation): invocation is ToolInvocation => invocation !== null);
}

interface ToolInvocationDraft {
  id: string;
  meta: ChatToolMeta | null;
  textLines: string[];
  legacyTitle: string | null;
}

function finalizeInvocation(draft: ToolInvocationDraft | undefined): ToolInvocation | null {
  if (!draft) return null;
  const meta = draft.meta;
  const legacyTitle = draft.legacyTitle?.trim() ?? '';
  const fallbackTitle = draft.textLines[0]?.trim() ?? '';
  const title = meta?.title.trim() || legacyTitle || fallbackTitle;
  if (!title) return null;
  // A title lifted out of the output must not also be printed inside it.
  const rawLines = meta?.title.trim() || legacyTitle ? draft.textLines : draft.textLines.slice(1);
  const legacyVisual = meta ? null : toTimelineVisual(title);
  const kind = meta?.kind ?? 'other';
  const status = meta?.status ?? 'completed';
  const parsed = parseStructuredContent(meta?.content);
  const locations = parseLocations(meta?.locations);
  // A `read` result is the file it echoed back, and the same text is already in
  // the diff or console block, so it is not repeated as loose lines.
  const textLines = rawLines.filter(
    (line) => !parsed.suppressedLines.has(line.trim()) && line.trim().length > 0,
  );
  return {
    id: draft.id,
    kind,
    status,
    title: stripBullet(title),
    monospaceTitle: meta ? kind === 'execute' : legacyVisual?.useMonospaceTitle === true,
    isError: status === 'failed' || legacyVisual?.isError === true,
    locations,
    diffs: parsed.diffs,
    terminals: parsed.terminals,
    textLines,
    images: parsed.images,
    truncated: meta?.truncated === true,
    empty:
      textLines.length === 0 &&
      parsed.diffs.length === 0 &&
      parsed.terminals.length === 0 &&
      parsed.images.length === 0 &&
      locations.length === 0,
  };
}

function toolCallIdOf(message: ChatMessage): string | null {
  if (message.role === 'tool') return message.toolCallId || null;
  if (message.role === 'assistant') return message.toolCalls?.[0]?.id ?? null;
  return null;
}

/**
 * A tool-call message only carries the synthetic `• Called tool ...` line, which
 * the row header already says better, so it is dropped once metadata exists.
 * Without metadata the legacy timeline text is the only source of a title.
 */
function readToolMessage(
  message: ChatMessage,
  hasMeta: boolean,
): { title: string | null; lines: string[] } {
  const isToolCall = message.role === 'assistant';
  const text = isToolCall ? getToolCallDisplayLines(message).join('\n') : getMessageText(message);
  if (!text.trim()) return { title: null, lines: [] };
  if (hasMeta) return { title: null, lines: isToolCall ? [] : text.split('\n') };
  const entries = parseTimelineEntries(text);
  if (entries?.length) {
    return {
      title: entries[0].title,
      lines: [
        ...entries[0].details,
        ...entries.slice(1).flatMap((entry) => [entry.title, ...entry.details]),
      ],
    };
  }
  return { title: null, lines: text.split('\n') };
}

interface LegacyInvocation {
  id: string;
  title: string;
  details: string[];
}

function legacyInvocations(message: ChatMessage): LegacyInvocation[] {
  if (message.role !== 'system' && message.role !== 'tool') return [];
  const entries = parseTimelineEntries(getMessageText(message));
  if (!entries?.length) return [];
  return entries.map((entry, index) => ({
    id: `${message.id}-${String(index)}`,
    title: entry.title,
    details: entry.details,
  }));
}

function appendLines(target: string[], lines: string[]): void {
  for (const line of lines) {
    if (target[target.length - 1] === line && !line.trim()) continue;
    target.push(line);
  }
}

interface ParsedStructuredContent {
  diffs: ToolInvocationDiff[];
  terminals: ToolInvocationTerminal[];
  images: string[];
  /** Lines already rendered by a richer block, so they are not printed twice. */
  suppressedLines: Set<string>;
}

function parseStructuredContent(content: unknown): ParsedStructuredContent {
  const parsed: ParsedStructuredContent = {
    diffs: [],
    terminals: [],
    images: [],
    suppressedLines: new Set(),
  };
  visitStructuredContent(content, parsed, 0);
  return parsed;
}

function visitStructuredContent(
  value: unknown,
  parsed: ParsedStructuredContent,
  depth: number,
): void {
  if (depth > 4 || value == null) return;
  if (Array.isArray(value)) {
    for (const entry of value) visitStructuredContent(entry, parsed, depth + 1);
    return;
  }
  const entry = asRecord(value);
  if (!entry) return;
  const type = normalizedType(entry.type);
  if (type === 'diff') {
    const path = asString(entry.path) ?? 'file';
    const newText = asString(entry.newText) ?? asString(entry.new_text) ?? '';
    const oldText = asString(entry.oldText) ?? asString(entry.old_text) ?? null;
    parsed.diffs.push({ path, oldText, newText });
    parsed.suppressedLines.add(`[diff: ${path}]`);
    for (const text of [oldText, newText]) {
      if (text) for (const line of text.split('\n')) parsed.suppressedLines.add(line.trim());
    }
    return;
  }
  if (type === 'terminal') {
    const terminalId = asString(entry.terminalId) ?? asString(entry.terminal_id) ?? null;
    const output = collectText([entry.output, entry.content]);
    parsed.terminals.push({ terminalId, output });
    parsed.suppressedLines.add(`[terminal${terminalId ? `: ${terminalId}` : ''}]`);
    for (const line of output.split('\n')) parsed.suppressedLines.add(line.trim());
    return;
  }
  if (type === 'image') {
    const source =
      asString(entry.url) ??
      asString(entry.imageUrl) ??
      asString(entry.image_url) ??
      toDataUrl(entry);
    if (source) {
      parsed.images.push(source);
      parsed.suppressedLines.add(`[image: ${source}]`);
    }
    parsed.suppressedLines.add('[image]');
    return;
  }
  if (type === 'content') {
    visitStructuredContent(entry.content, parsed, depth + 1);
    return;
  }
  for (const nested of Object.values(entry)) {
    if (nested && typeof nested === 'object') visitStructuredContent(nested, parsed, depth + 1);
  }
}

function parseLocations(value: unknown): ToolInvocationLocation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const location = asRecord(entry);
    const path = asString(location?.path);
    if (!path) return [];
    const line = location?.line;
    return [{ path, ...(typeof line === 'number' ? { line } : {}) }];
  });
}

function collectText(values: unknown[]): string {
  const lines: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 4 || value == null) return;
    if (typeof value === 'string') {
      if (value) lines.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    const entry = asRecord(value);
    if (!entry) return;
    if (normalizedType(entry.type) === 'text') {
      const text = asString(entry.text);
      if (text) lines.push(text);
      return;
    }
    for (const nested of Object.values(entry)) visit(nested, depth + 1);
  };
  for (const value of values) visit(value, 0);
  return lines.join('\n');
}

function toDataUrl(entry: Record<string, unknown>): string | null {
  const data = asString(entry.data);
  const mimeType = asString(entry.mimeType) ?? asString(entry.mime_type);
  return data && mimeType ? `data:${mimeType};base64,${data}` : null;
}

function normalizedType(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[^a-z0-9]/gi, '').toLowerCase() : '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stripBullet(title: string): string {
  return title
    .trim()
    .replace(/^[•\u2022]\s*/, '')
    .trim();
}
