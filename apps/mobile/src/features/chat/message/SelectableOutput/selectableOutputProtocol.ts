import type { AppTheme } from '@shared/theme';

export const SELECTABLE_OUTPUT_LINE_HEIGHT = 18;

export interface SelectableOutputHtmlStyle {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  color: string;
}

export interface SelectableOutputReadyMessage {
  type: 'ready';
}

export interface SelectableOutputHeightMessage {
  type: 'height';
  height: number;
}

export type SelectableOutputFrameMessage =
  SelectableOutputReadyMessage | SelectableOutputHeightMessage;

export interface SelectableOutputSetTextCommand {
  type: 'setText';
  text: string;
}

export function selectableOutputHtmlStyle(theme: AppTheme): SelectableOutputHtmlStyle {
  return {
    fontFamily: theme.fonts.monoRegular,
    fontSize: theme.typography.mono.fontSize ?? 13,
    lineHeight: SELECTABLE_OUTPUT_LINE_HEIGHT,
    color: theme.colors.textSecondary,
  };
}

export function escapeHtmlText(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

export function stripTrailingLineBreak(value: string): string {
  return value.replace(/\n$/u, '');
}

export function estimateSelectableOutputHeight(text: string, lineHeight: number): number {
  return Math.max(1, text.split('\n').length) * lineHeight;
}

export function createSelectableOutputHtml(text: string, style: SelectableOutputHtmlStyle): string {
  const content = escapeHtmlText(text);
  const fontFamily = style.fontFamily.replace(/"/gu, '');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<style>
html, body { margin: 0; padding: 0; background: transparent; }
body {
  -webkit-user-select: text;
  user-select: text;
  -webkit-touch-callout: default;
}
pre {
  margin: 0;
  padding: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  font-family: ${fontFamily}, Menlo, monospace;
  font-size: ${String(style.fontSize)}px;
  line-height: ${String(style.lineHeight)}px;
  color: ${style.color};
}
</style>
</head>
<body>
<pre id="content">${content}</pre>
<script>
(() => {
  'use strict';
  const content = document.getElementById('content');
  function deliver(message) {
    const raw = JSON.stringify(message);
    if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
      window.ReactNativeWebView.postMessage(raw);
    }
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(raw, '*');
    }
  }
  function reportHeight() {
    const height = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight,
      content.scrollHeight,
    );
    deliver({ type: 'height', height: Math.ceil(height) });
  }
  function setText(raw) {
    if (typeof raw !== 'string') {
      return;
    }
    content.textContent = raw;
    reportHeight();
  }
  function handleCommand(raw) {
    if (typeof raw !== 'string') {
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return;
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.type === 'setText' &&
      typeof parsed.text === 'string'
    ) {
      setText(parsed.text);
    }
  }
  window.addEventListener('message', (event) => handleCommand(event.data));
  document.addEventListener('message', (event) => handleCommand(event.data));
  if (window.ResizeObserver) {
    new ResizeObserver(reportHeight).observe(document.body);
  }
  window.addEventListener('resize', reportHeight);
  reportHeight();
  deliver({ type: 'ready' });
})();
</script>
</body>
</html>`;
}

export function createSelectableOutputSetTextCommand(text: string): string {
  const command: SelectableOutputSetTextCommand = { type: 'setText', text };
  return JSON.stringify(command);
}

export function parseSelectableOutputFrameMessage(
  raw: unknown,
): SelectableOutputFrameMessage | null {
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
  if (parsed['type'] === 'height') {
    const height = parsed['height'];
    if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) {
      return null;
    }
    return { type: 'height', height: Math.ceil(height) };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
