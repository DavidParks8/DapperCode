import type { ChatMessagePart } from '@bridge/types/types';
import { Linking } from 'react-native';
import { extractLocalPreviewUrls } from '../../browser/preview';
import { toMarkdownImageSource } from './imageSource';
import type {
  MessageBlock,
  TimelineDetailMediaPreview,
  TimelineDetailPreview,
  TimelineEntry,
  ToolGroupEntry,
} from './types';

export function parseMessageBlocks(
  content: string,
  bridgeUrl: string | null,
  bridgeToken: string | null,
): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  const pendingTextLines: string[] = [];
  const flushTextBlock = () => {
    if (pendingTextLines.length === 0) {
      return;
    }
    const value = pendingTextLines.join('\n');
    pendingTextLines.length = 0;
    if (value.trim()) {
      blocks.push({ kind: 'text', value });
    }
  };

  for (const line of content.split('\n')) {
    const inlineImage = toInlineImagePreviewFromMarkerLine(line, bridgeUrl, bridgeToken);
    if (inlineImage) {
      flushTextBlock();
      blocks.push({
        kind: 'image',
        source: inlineImage.source,
        accessibilityLabel: inlineImage.accessibilityLabel,
      });
      continue;
    }
    const fileMatch = line.match(/^\[file:\s*(.+?)\]$/i);
    const filePath = fileMatch?.[1];
    if (filePath) {
      const label = toLocalFileReferenceLabel(filePath) ?? toPathBasename(filePath);
      if (textContainsMentionLabel(pendingTextLines.join('\n'), label)) {
        continue;
      }
      flushTextBlock();
      blocks.push({ kind: 'file', value: label });
      continue;
    }
    pendingTextLines.push(line);
  }
  flushTextBlock();
  return blocks.length > 0 ? blocks : [{ kind: 'text', value: content }];
}

export function messagePartToBlocks(
  part: ChatMessagePart,
  bridgeUrl: string | null,
  bridgeToken: string | null,
): MessageBlock[] {
  if (part.type === 'text') {
    return part.text ? [{ kind: 'text', value: part.text }] : [];
  }
  if (part.type === 'image') {
    return imagePartToBlocks(part, bridgeUrl, bridgeToken);
  }
  if (part.type === 'audio') {
    return [{ kind: 'file', value: `[audio${part.mimeType ? `: ${part.mimeType}` : ''}]` }];
  }
  if (part.type === 'resourceLink') {
    return [{ kind: 'file', value: part.name ?? part.uri }];
  }
  const label = typeof part.resource.uri === 'string' ? part.resource.uri : '[embedded resource]';
  const blocks: MessageBlock[] = [{ kind: 'file', value: label }];
  if (typeof part.resource.text === 'string' && part.resource.text) {
    blocks.push({ kind: 'text', value: part.resource.text });
  }
  return blocks;
}

function imagePartToBlocks(
  part: Extract<ChatMessagePart, { type: 'image' }>,
  bridgeUrl: string | null,
  bridgeToken: string | null,
): MessageBlock[] {
  const sourceValue = [
    part.url,
    part.uri,
    part.data && part.mimeType ? `data:${part.mimeType};base64,${part.data}` : null,
  ].find((value): value is string => Boolean(value));
  const source = sourceValue ? toMarkdownImageSource(sourceValue, bridgeUrl, bridgeToken) : null;
  return source
    ? [{ kind: 'image', source, accessibilityLabel: 'Attached image' }]
    : [{ kind: 'file', value: '[image]' }];
}

export function toTimelineDetailPreview(
  entry: TimelineEntry | ToolGroupEntry,
  bridgeUrl: string | null,
  bridgeToken: string | null,
): TimelineDetailPreview {
  const images: TimelineDetailMediaPreview[] = [];
  const textDetails: string[] = [];
  if (/^•\s*Viewed image\b/i.test(entry.title)) {
    const path = entry.details[0]?.trim();
    const source = path ? toMarkdownImageSource(path, bridgeUrl, bridgeToken) : null;
    if (path && source) {
      images.push({ source, accessibilityLabel: toPathBasename(path) });
    }
  }
  for (const detail of entry.details) {
    const inlineImage = toInlineImagePreviewFromMarkerLine(detail, bridgeUrl, bridgeToken);
    if (inlineImage) {
      images.push(inlineImage);
    } else {
      textDetails.push(detail);
    }
  }
  return { textDetails, images };
}

function toInlineImagePreviewFromMarkerLine(
  line: string,
  bridgeUrl: string | null,
  bridgeToken: string | null,
): TimelineDetailMediaPreview | null {
  const match = line.trim().match(/^\[(?:local )?image:\s*(.+?)\]$/i);
  if (!match) {
    return null;
  }
  const imagePath = match[1];
  if (!imagePath) {
    return null;
  }
  const source = toMarkdownImageSource(imagePath, bridgeUrl, bridgeToken);
  return source ? { source, accessibilityLabel: toPathBasename(imagePath) } : null;
}

export function isViewedImageEntry(title: string, textDetails: string[]): boolean {
  return /^•\s*Viewed image\b/i.test(title) && textDetails.length > 0;
}

export function toPathBasename(path: string): string {
  const normalizedPath = path.trim().replace(/\\/g, '/');
  if (!normalizedPath || /^data:image\//i.test(normalizedPath)) {
    return 'image';
  }
  return normalizedPath.split('/').filter(Boolean).pop() ?? normalizedPath;
}

function textContainsMentionLabel(text: string, label: string): boolean {
  const trimmedLabel = label.trim();
  if (!trimmedLabel) {
    return false;
  }
  const escaped = trimmedLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w])@${escaped}(?=$|[^\\w])`, 'i').test(text);
}

export function toLocalFileReferenceLabel(href: string): string | null {
  let normalizedHref = href.trim();
  if (!normalizedHref) {
    return null;
  }
  try {
    normalizedHref = decodeURIComponent(normalizedHref);
  } catch {
    /* Keep original href. */
  }
  if (normalizedHref.startsWith('file://')) {
    normalizedHref = normalizedHref.replace(/^file:\/\//, '');
  }
  if (!normalizedHref.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(normalizedHref)) {
    return null;
  }
  const anchorLineMatch = normalizedHref.match(/#L(\d+)(?:C\d+)?$/i);
  const suffixLineMatch = normalizedHref.match(/:(\d+)(?::\d+)?$/);
  const line = anchorLineMatch?.[1] ?? suffixLineMatch?.[1] ?? null;
  const lineMatch = anchorLineMatch ?? suffixLineMatch;
  const pathOnly = lineMatch ? normalizedHref.slice(0, -lineMatch[0].length) : normalizedHref;
  const basename = pathOnly.split(/[\\/]/).filter(Boolean).pop();
  if (!basename) {
    return line ? `line ${line}` : null;
  }
  return line ? `${basename}:${line}` : basename;
}

export function openMarkdownLink(
  href: string,
  onLinkPress?: (url: string) => boolean,
  onOpenLocalPreview?: (targetUrl: string) => void,
): void {
  if (onOpenLocalPreview && extractLocalPreviewUrls(href).length > 0) {
    onOpenLocalPreview(href);
    return;
  }
  if (onLinkPress?.(href) === false) {
    return;
  }
  void Linking.openURL(href).catch(() => {});
}
