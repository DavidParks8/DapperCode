import { nonEmptyString, record } from './agUiValueReaders';

export function renderAgUiCustomContent(value: unknown): string {
  const structured = renderStructuredContent(value, 0);
  if (structured.length > 0) return structured.join('\n');
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '[content unavailable]';
  }
}

/**
 * Ordered parts win over `content` when a message is rendered, so they must only
 * be carried across a snapshot when they still describe the authoritative text.
 * Non-text parts (images, resources) are always kept because a plain string
 * cannot represent them.
 */
export function partsMatchMessageContent(
  parts: readonly unknown[] | undefined,
  content: unknown,
): boolean {
  if (!parts || parts.length === 0) return false;
  if (typeof content !== 'string') return true;
  if (parts.some((part) => record(part)?.type !== 'text')) return true;
  return parts.map(renderAgUiCustomContent).filter(Boolean).join('\n') === content;
}

function renderStructuredContent(value: unknown, depth: number): string[] {
  if (depth > 4 || value == null) return [];
  if (Array.isArray(value))
    return value.flatMap((entry) => renderStructuredContent(entry, depth + 1));
  if (typeof value === 'string') return value.trim() ? [value] : [];
  const entry = record(value);
  if (!entry) return [];
  const type = nonEmptyString(entry.type)
    ?.replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
  if (type === 'text') return nonEmptyString(entry.text) ? [String(entry.text)] : [];
  if (type === 'image') {
    const url =
      nonEmptyString(entry.url) ??
      nonEmptyString(entry.imageUrl) ??
      nonEmptyString(entry.image_url);
    const data = nonEmptyString(entry.data);
    const mimeType = nonEmptyString(entry.mimeType) ?? nonEmptyString(entry.mime_type);
    const source = url ?? (data && mimeType ? `data:${mimeType};base64,${data}` : null);
    return source ? [`[image: ${source}]`] : ['[image]'];
  }
  if (type === 'audio') {
    const mimeType = nonEmptyString(entry.mimeType) ?? nonEmptyString(entry.mime_type);
    return [`[audio${mimeType ? `: ${mimeType}` : ''}]`];
  }
  if (type === 'resourcelink') {
    const uri = nonEmptyString(entry.uri);
    const name = nonEmptyString(entry.name);
    return uri ? [`[file: ${uri}]${name && name !== uri ? ` ${name}` : ''}`] : [];
  }
  if (type === 'resource') {
    const resource = record(entry.resource);
    const uri = nonEmptyString(resource?.uri);
    const text = nonEmptyString(resource?.text);
    return [uri ? `[resource: ${uri}]` : '[resource]', ...(text ? [text] : [])];
  }
  if (type === 'content') return renderStructuredContent(entry.content, depth + 1);
  if (type === 'diff') {
    const path = nonEmptyString(entry.path) ?? 'file';
    return [
      `[diff: ${path}]`,
      ...[entry.oldText, entry.newText].flatMap((part) => renderStructuredContent(part, depth + 1)),
    ];
  }
  if (type === 'terminal') {
    const terminalId = nonEmptyString(entry.terminalId) ?? nonEmptyString(entry.terminal_id);
    return [
      `[terminal${terminalId ? `: ${terminalId}` : ''}]`,
      ...['output', 'content'].flatMap((key) =>
        key in entry ? renderStructuredContent(entry[key], depth + 1) : [],
      ),
    ];
  }
  const nested = [
    'content',
    'structuredContent',
    'structured_content',
    'locations',
    'result',
    'output',
  ].flatMap((key) => (key in entry ? renderStructuredContent(entry[key], depth + 1) : []));
  if (nested.length > 0) return nested;
  const path = nonEmptyString(entry.path);
  const line = typeof entry.line === 'number' ? entry.line : null;
  return path ? [`[location: ${path}${line ? `:${line}` : ''}]`] : [];
}

/**
 * A tool's plain text and its structured rendering usually describe the same
 * payload. Returns only the part of the structured rendering the plain text does
 * not already contain, so nothing is printed twice.
 *
 * The overlap is removed as one contiguous run rather than line by line: a diff
 * or terminal payload can legitimately repeat a line (a brace, a blank line, an
 * import) that also appears in the plain text, and dropping those individually
 * would punch holes in the middle of the block.
 */
/**
 * Index of `needle` inside `haystack` where it occupies whole lines. Anchoring to
 * line boundaries stops a one-line plain body from being carved out of the middle
 * of a diff line that merely repeats it (e.g. `-const a = 1;`).
 */
function findWholeLineRun(haystack: string, needle: string): number {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return -1;
    const startsLine = at === 0 || haystack[at - 1] === '\n';
    const end = at + needle.length;
    const endsLine = end === haystack.length || haystack[end] === '\n';
    if (startsLine && endsLine) return at;
    from = at + 1;
  }
}

export function structuredTextRemainder(text: string, structured: string): string {
  if (!structured.trim()) return '';
  if (!text.trim()) return structured;
  const trimmed = text.trim();
  const overlapStart = findWholeLineRun(structured, trimmed);
  if (overlapStart === -1) {
    return text.includes(structured.trim()) ? '' : structured;
  }
  const remainder =
    structured.slice(0, overlapStart) + structured.slice(overlapStart + trimmed.length);
  return remainder.trim() ? remainder.replace(/^\n+/, '').replace(/\n+$/, '') : '';
}
