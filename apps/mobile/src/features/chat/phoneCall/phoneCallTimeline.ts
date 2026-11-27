export type CallToolStatus = 'running' | 'completed' | 'failed';

export type CallTimelineItem =
  | { kind: 'agent'; text: string; interrupted: boolean }
  | { kind: 'recipient'; speakerLabel: string; text: string; interrupted: boolean }
  | { kind: 'whisper'; text: string }
  | { kind: 'event'; text: string }
  | { kind: 'tool'; label: string; status: CallToolStatus; detail: string | null }
  | { kind: 'omitted'; text: string };

const INTERRUPTED_SUFFIX = /\s*\[interrupted\]$/i;
const MARKDOWN_ENTRY_PATTERN = /^\*\*([^*]+?):\*\*\s*(.*)$/;
const MARKDOWN_OMITTED_PATTERN = /^_(.+)_$/;
const PLAIN_OMITTED_PATTERN = /^\[(.+)\]$/;
const TOOL_STATUS_PATTERN = /^(.+?)\s*·\s*(running|completed|failed)(?::\s*(.+))?$/i;

const KNOWN_PLAIN_LABELS = [
  'Agent',
  'Instruction (not spoken)',
  'Whisper',
  'Steer',
  'Event',
  'Tool',
  'Recipient',
] as const;

function matchPlainSpeakerPrefix(
  line: string,
  knownLabels: readonly string[],
): [string, string] | null {
  for (const label of knownLabels) {
    const prefix = `${label}:`;
    if (
      line.length >= prefix.length &&
      line.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()
    ) {
      return [label, line.slice(prefix.length).trimStart()];
    }
  }
  return null;
}

function stripInterrupted(text: string): { text: string; interrupted: boolean } {
  if (INTERRUPTED_SUFFIX.test(text)) {
    return { text: text.replace(INTERRUPTED_SUFFIX, '').trim(), interrupted: true };
  }
  return { text: text.trim(), interrupted: false };
}

function parseToolEntry(raw: string): CallTimelineItem {
  const trimmed = raw.trim();
  const match = TOOL_STATUS_PATTERN.exec(trimmed);
  if (match && match[1] && match[2]) {
    const status = match[2].toLowerCase() as CallToolStatus;
    return {
      kind: 'tool',
      label: match[1].trim(),
      status,
      detail: match[3]?.trim() || null,
    };
  }
  const running = trimmed.endsWith('…') || trimmed.endsWith('...');
  return {
    kind: 'tool',
    label: trimmed,
    status: running ? 'running' : 'completed',
    detail: null,
  };
}

function classifyTranscriptLine(label: string, body: string): CallTimelineItem {
  const normalizedLabel = label.trim();
  const lower = normalizedLabel.toLowerCase();
  if (lower === 'agent') {
    const { text, interrupted } = stripInterrupted(body);
    return { kind: 'agent', text, interrupted };
  }
  if (lower === 'instruction (not spoken)' || lower === 'whisper' || lower === 'steer') {
    return { kind: 'whisper', text: body.trim() };
  }
  if (lower === 'event') {
    return { kind: 'event', text: body.trim() };
  }
  if (lower === 'tool') {
    return parseToolEntry(body);
  }
  const { text, interrupted } = stripInterrupted(body);
  return { kind: 'recipient', speakerLabel: normalizedLabel, text, interrupted };
}

function parseTranscriptChunk(
  chunk: string,
  format: 'markdown' | 'plain',
  plainLabels: readonly string[],
): CallTimelineItem | null {
  const omittedPattern = format === 'markdown' ? MARKDOWN_OMITTED_PATTERN : PLAIN_OMITTED_PATTERN;
  const omitted = omittedPattern.exec(chunk);
  if (omitted?.[1]) {
    return { kind: 'omitted', text: omitted[1].trim() };
  }
  if (format === 'markdown') {
    const entry = MARKDOWN_ENTRY_PATTERN.exec(chunk);
    return entry && entry[1] !== undefined && entry[2] !== undefined
      ? classifyTranscriptLine(entry[1], entry[2])
      : null;
  }
  const plainEntry = matchPlainSpeakerPrefix(chunk, plainLabels);
  return plainEntry ? classifyTranscriptLine(plainEntry[0], plainEntry[1]) : null;
}

/**
 * Parses either live rolling markdown transcript blocks or plain-text post-call reports into
 * structured timeline items (two-sided speech bubbles, whispers, system events, and tool chips).
 */
export function parseCallTranscript(
  raw: string | null | undefined,
  format: 'markdown' | 'plain' = 'markdown',
  recipientLabel?: string | null,
): CallTimelineItem[] {
  if (!raw) {
    return [];
  }
  const splitter = format === 'markdown' ? /\n{2,}/ : '\n';
  const chunks = raw
    .split(splitter)
    .map((chunk) => chunk.trim())
    .filter((chunk) => Boolean(chunk) && chunk !== '(no spoken transcript recorded)');
  const trimmedRecipient = recipientLabel?.trim();
  const plainLabels = trimmedRecipient
    ? [trimmedRecipient, ...KNOWN_PLAIN_LABELS]
    : KNOWN_PLAIN_LABELS;

  const items: CallTimelineItem[] = [];
  for (const chunk of chunks) {
    const parsed = parseTranscriptChunk(chunk, format, plainLabels);
    if (parsed) {
      items.push(parsed);
      continue;
    }
    // Continuation lines append to the previous spoken bubble when present.
    const previous = items[items.length - 1];
    if (previous && (previous.kind === 'agent' || previous.kind === 'recipient')) {
      previous.text = `${previous.text}\n${chunk}`;
    } else {
      items.push({ kind: 'event', text: chunk });
    }
  }
  return items;
}
