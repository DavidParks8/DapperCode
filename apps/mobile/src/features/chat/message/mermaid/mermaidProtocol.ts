import type { AppTheme } from '@shared/theme';

export const MERMAID_MAX_SOURCE_BYTES = 64 * 1024;
export const MERMAID_MAX_SVG_BYTES = 2 * 1024 * 1024;
export const MERMAID_RENDER_TIMEOUT_MS = 5_000;
export const MERMAID_FRAME_STARTUP_TIMEOUT_MS = 15_000;

export type MermaidThemePayload = Record<string, string>;

export interface MermaidRenderCommand {
  type: 'render';
  id: string;
  source: string;
  theme: MermaidThemePayload;
}

export interface MermaidDisplayCommand {
  type: 'display';
  id: string;
  svg: string;
  width: number;
  height: number;
}

export type MermaidControlCommand =
  { type: 'zoomIn'; id: string } | { type: 'zoomOut'; id: string } | { type: 'reset'; id: string };

export type MermaidFrameMessage =
  | { type: 'ready' }
  | { type: 'rendered'; id: string; width: number; height: number; svg?: string }
  | { type: 'error'; id: string; message: string }
  | { type: 'viewState'; id: string; zoom: number };

export function createMermaidTheme(theme: AppTheme): MermaidThemePayload {
  const { colors } = theme;
  return {
    background: colors.bgElevated,
    primaryColor: colors.bgInput,
    primaryTextColor: colors.textPrimary,
    primaryBorderColor: colors.borderHighlight,
    secondaryColor: colors.bgItem,
    secondaryTextColor: colors.textPrimary,
    secondaryBorderColor: colors.borderHighlight,
    tertiaryColor: colors.bgElevated,
    tertiaryTextColor: colors.textPrimary,
    tertiaryBorderColor: colors.borderLight,
    lineColor: colors.textMuted,
    textColor: colors.textPrimary,
    mainBkg: colors.bgInput,
    nodeBorder: colors.borderHighlight,
    clusterBkg: colors.bgElevated,
    clusterBorder: colors.borderHighlight,
    edgeLabelBackground: colors.bgElevated,
    actorBkg: colors.bgInput,
    actorBorder: colors.borderHighlight,
    actorTextColor: colors.textPrimary,
    actorLineColor: colors.borderLight,
    signalColor: colors.textSecondary,
    signalTextColor: colors.textPrimary,
    labelBoxBkgColor: colors.bgElevated,
    labelBoxBorderColor: colors.borderHighlight,
    labelTextColor: colors.textPrimary,
    loopTextColor: colors.textPrimary,
    noteBkgColor: colors.bgItem,
    noteBorderColor: colors.borderHighlight,
    noteTextColor: colors.textPrimary,
    activationBkgColor: colors.bgInput,
    activationBorderColor: colors.borderHighlight,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  };
}

export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    if (codePoint <= 0x7f) {
      bytes += 1;
    } else if (codePoint <= 0x7ff) {
      bytes += 2;
    } else if (codePoint <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }
  return bytes;
}

export function parseMermaidFrameMessage(raw: unknown): MermaidFrameMessage | null {
  if (typeof raw !== 'string') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed['type'] !== 'string') {
    return null;
  }
  if (parsed['type'] === 'ready') {
    return { type: 'ready' };
  }
  const id = parsed['id'];
  if (typeof id !== 'string') {
    return null;
  }
  return parseIdentifiedFrameMessage(parsed, id);
}

function parseIdentifiedFrameMessage(
  parsed: Record<string, unknown>,
  id: string,
): MermaidFrameMessage | null {
  const type = parsed['type'];
  if (type === 'rendered') {
    const width = parsed['width'];
    const height = parsed['height'];
    if (!isPositiveFiniteNumber(width) || !isPositiveFiniteNumber(height)) {
      return null;
    }
    const svg = parsed['svg'];
    return typeof svg === 'string'
      ? { type: 'rendered', id, width, height, svg }
      : { type: 'rendered', id, width, height };
  }
  if (type === 'error') {
    const message = parsed['message'];
    return typeof message === 'string' && message.trim()
      ? { type: 'error', id, message: message.trim().slice(0, 500) }
      : null;
  }
  if (type === 'viewState') {
    const zoom = parsed['zoom'];
    return isPositiveFiniteNumber(zoom)
      ? { type: 'viewState', id, zoom: Math.min(5, Math.max(1, zoom)) }
      : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
