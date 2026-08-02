import {
  normalizeInline,
  normalizeMultiline,
  normalizeType,
} from './chatMappingToolArgumentParsers';
import { readString, toRecord } from '../runtimeValidation';

export function withNestedDetail(title: string, detail: string | null): string {
  if (!detail) {
    return title;
  }
  const lines = detail
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return title;
  }
  const firstLine = lines[0];
  if (firstLine === undefined) {
    return title;
  }
  const first = `  └ ${firstLine}`;
  if (lines.length === 1) {
    return `${title}\n${first}`;
  }
  const rest = lines.slice(1).map((line) => `    ${line}`);
  return [title, first, ...rest].join('\n');
}

export function toStructuredPreview(value: unknown, maxChars: number): string | null {
  if (value == null) {
    return null;
  }
  const structuredPreview = toStructuredContentPreview(value, maxChars);
  if (structuredPreview) {
    return structuredPreview;
  }
  if (typeof value === 'string') {
    return normalizeMultiline(value, maxChars);
  }
  try {
    const serialized = JSON.stringify(value);
    return normalizeInline(serialized, maxChars);
  } catch {
    return null;
  }
}

export function stringifyStructuredContentEntries(entries: unknown[]): string {
  return entries.flatMap((entry) => stringifyStructuredContentEntry(entry)).join('\n');
}

export function stringifyStructuredContentEntry(entry: unknown): string[] {
  const entryRecord = toRecord(entry);
  if (!entryRecord) {
    const text = readString(entry)?.trim();
    return text ? [text] : [];
  }
  const entryType = normalizeType(readString(entryRecord['type']) ?? '');
  if (isStructuredTextType(entryType)) {
    const text = readStructuredText(entryRecord);
    return text ? [text] : [];
  }
  if (isStructuredImageType(entryType)) {
    return stringifyStructuredImage(entryRecord);
  }
  if (entryType === 'mention') {
    const mentionPath = readStructuredMentionPath(entryRecord);
    return mentionPath ? [`[file: ${mentionPath}]`] : [];
  }
  return [];
}

function isStructuredTextType(type: string): boolean {
  return ['text', 'inputtext', 'outputtext', 'summarytext'].includes(type);
}

function isStructuredImageType(type: string): boolean {
  return ['image', 'inputimage', 'localimage'].includes(type);
}

function stringifyStructuredImage(entry: Record<string, unknown>): string[] {
  const localImagePath = readStructuredLocalImagePath(entry);
  if (localImagePath) {
    return [`[local image: ${localImagePath}]`];
  }
  const imageUrl = readStructuredImageUrl(entry);
  return imageUrl ? [`[image: ${imageUrl}]`] : [];
}

export function readStructuredText(entryRecord: Record<string, unknown>): string | null {
  return (
    readString(entryRecord['text'])?.trim() ??
    readString(toRecord(entryRecord['data'])?.['text'])?.trim() ??
    null
  );
}

export function readStructuredImageUrl(entryRecord: Record<string, unknown>): string | null {
  const data = toRecord(entryRecord['data']);
  return (
    readInlineImageDataUrl(entryRecord, data) ?? readStructuredImageUrlValue(entryRecord, data)
  );
}

function readInlineImageDataUrl(
  entry: Record<string, unknown>,
  data: Record<string, unknown> | null,
): string | null {
  const imageData = firstTrimmedString([entry['data'], data?.['data']]);
  const mimeType = firstTrimmedString([
    entry['mimeType'],
    entry['mime_type'],
    data?.['mimeType'],
    data?.['mime_type'],
  ]);
  return imageData && mimeType ? `data:${mimeType};base64,${imageData}` : null;
}

function readStructuredImageUrlValue(
  entry: Record<string, unknown>,
  data: Record<string, unknown> | null,
): string | null {
  return firstTrimmedString([
    entry['url'],
    entry['image_url'],
    entry['imageUrl'],
    data?.['url'],
    data?.['image_url'],
    data?.['imageUrl'],
  ]);
}

function firstTrimmedString(values: unknown[]): string | null {
  for (const value of values) {
    const text = readString(value)?.trim();
    if (text) {
      return text;
    }
  }
  return null;
}

export function readStructuredLocalImagePath(entryRecord: Record<string, unknown>): string | null {
  const data = toRecord(entryRecord['data']);
  return readString(entryRecord['path'])?.trim() ?? readString(data?.['path'])?.trim() ?? null;
}

export function readStructuredMentionPath(entryRecord: Record<string, unknown>): string | null {
  const data = toRecord(entryRecord['data']);
  return readString(entryRecord['path'])?.trim() ?? readString(data?.['path'])?.trim() ?? null;
}

export function toStructuredContentPreview(value: unknown, maxChars: number): string | null {
  const lines = extractStructuredContentPreviewLines(value);
  if (lines.length === 0) {
    return null;
  }
  const previewLines: string[] = [];
  let remainingChars = maxChars;
  let textLineCount = 0;
  let mediaLineCount = 0;
  for (const line of lines) {
    if (isImageMarker(line)) {
      if (mediaLineCount >= 3) {
        break;
      }
      previewLines.push(line);
      mediaLineCount += 1;
      continue;
    }
    if (textLineCount >= 8 || remainingChars <= 0) {
      break;
    }
    const normalizedLine = normalizeMultiline(line, remainingChars);
    if (!normalizedLine) {
      continue;
    }
    previewLines.push(normalizedLine);
    textLineCount += 1;
    remainingChars -= normalizedLine.length;
  }
  return previewLines.length > 0 ? previewLines.join('\n') : null;
}

export function extractStructuredContentPreviewLines(value: unknown, depth = 0): string[] {
  if (depth > 3 || value == null) {
    return [];
  }
  if (Array.isArray(value)) {
    const directLines = value.flatMap((entry) => stringifyStructuredContentEntry(entry));
    if (directLines.length > 0) {
      return directLines;
    }
    for (const entry of value) {
      const nestedLines = extractStructuredContentPreviewLines(entry, depth + 1);
      if (nestedLines.length > 0) {
        return nestedLines;
      }
    }
    return [];
  }
  const directLines = stringifyStructuredContentEntry(value);
  if (directLines.length > 0) {
    return directLines;
  }
  const record = toRecord(value);
  if (!record) {
    return [];
  }
  const candidateKeys = [
    'content',
    'contents',
    'items',
    'item',
    'result',
    'results',
    'output',
    'data',
    'structuredContent',
    'structured_content',
    '_meta',
    'meta',
  ];
  for (const key of candidateKeys) {
    if (!(key in record)) {
      continue;
    }
    const nestedLines = extractStructuredContentPreviewLines(record[key], depth + 1);
    if (nestedLines.length > 0) {
      return nestedLines;
    }
  }
  return [];
}

export function isImageMarker(value: string): boolean {
  return /^\[(?:image|local image):\s*.+?\]$/i.test(value.trim());
}
