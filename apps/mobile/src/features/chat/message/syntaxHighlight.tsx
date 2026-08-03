import Prism from 'prismjs';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-csharp';
import 'prismjs/components/prism-dart';
import 'prismjs/components/prism-diff';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-kotlin';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-objectivec';
import 'prismjs/components/prism-php';
import 'prismjs/components/prism-powershell';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-ruby';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-swift';
import 'prismjs/components/prism-toml';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-markup-templating';
import type { ReactNode } from 'react';
import { Text, type TextStyle } from 'react-native';

const MAX_HIGHLIGHT_LENGTH = 20_000;
const COMMENT_TOKEN_TYPES = new Set(['comment', 'prolog', 'doctype', 'cdata']);
const KEYWORD_TOKEN_TYPES = new Set(['keyword', 'atrule', 'important']);
const STRING_TOKEN_TYPES = new Set(['string', 'char', 'attr-value', 'inserted', 'builtin']);
const NUMBER_TOKEN_TYPES = new Set(['number', 'boolean', 'constant', 'symbol']);
const FUNCTION_TOKEN_TYPES = new Set(['function', 'class-name']);
const PROPERTY_TOKEN_TYPES = new Set(['property', 'tag', 'selector', 'attr-name', 'deleted']);
const OPERATOR_TOKEN_TYPES = new Set(['operator', 'entity', 'url', 'regex', 'variable']);
const STYLED_TOKEN_TYPES = new Set([
  ...COMMENT_TOKEN_TYPES,
  ...KEYWORD_TOKEN_TYPES,
  ...STRING_TOKEN_TYPES,
  ...NUMBER_TOKEN_TYPES,
  ...FUNCTION_TOKEN_TYPES,
  ...PROPERTY_TOKEN_TYPES,
  ...OPERATOR_TOKEN_TYPES,
]);

const LANGUAGE_ALIASES: Record<string, string> = {
  csharp: 'csharp',
  'c#': 'csharp',
  cs: 'csharp',
  'c++': 'cpp',
  html: 'markup',
  js: 'javascript',
  md: 'markdown',
  objc: 'objectivec',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  shell: 'bash',
  sh: 'bash',
  ts: 'typescript',
  yml: 'yaml',
};

const LANGUAGE_LABELS: Record<string, string> & { text: string } = {
  bash: 'Shell',
  csharp: 'C#',
  cpp: 'C++',
  css: 'CSS',
  dart: 'Dart',
  javascript: 'JavaScript',
  jsx: 'JSX',
  markdown: 'Markdown',
  markup: 'HTML',
  objectivec: 'Objective-C',
  python: 'Python',
  ruby: 'Ruby',
  rust: 'Rust',
  php: 'PHP',
  powershell: 'PowerShell',
  sql: 'SQL',
  swift: 'Swift',
  text: 'Text',
  toml: 'TOML',
  tsx: 'TSX',
  typescript: 'TypeScript',
  yaml: 'YAML',
};

const EXTENSION_LANGUAGES: Record<string, string> = {
  bash: 'bash',
  c: 'c',
  cjs: 'javascript',
  cc: 'cpp',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  cts: 'typescript',
  dart: 'dart',
  go: 'go',
  h: 'c',
  hpp: 'cpp',
  html: 'markup',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'jsx',
  kt: 'kotlin',
  kts: 'kotlin',
  m: 'objectivec',
  md: 'markdown',
  mjs: 'javascript',
  mts: 'typescript',
  php: 'php',
  ps1: 'powershell',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  sql: 'sql',
  swift: 'swift',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  xml: 'markup',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'bash',
};

export interface SyntaxTokenStyles {
  syntaxComment: TextStyle;
  syntaxKeyword: TextStyle;
  syntaxString: TextStyle;
  syntaxNumber: TextStyle;
  syntaxFunction: TextStyle;
  syntaxProperty: TextStyle;
  syntaxOperator: TextStyle;
}

export interface HighlightedSyntaxSegment {
  content: string;
  type: string | null;
}

export type HighlightedCode = string | HighlightedSyntaxSegment[];

interface DiffCodeLine {
  kind: 'context' | 'add' | 'remove';
  content: string;
}

export function resolveSyntaxLanguage(sourceInfo?: string | null): {
  grammar: Prism.Grammar | null;
  label: string;
} {
  const rawLanguage =
    sourceInfo
      ?.trim()
      .split(/\s+/, 1)[0]
      ?.replace(/^language-/i, '')
      .toLowerCase() ?? '';
  const safeLanguage = rawLanguage.replace(/[^a-z0-9_+.#-]/g, '').slice(0, 24);
  const language = LANGUAGE_ALIASES[safeLanguage] ?? safeLanguage;
  const grammar = language ? (Prism.languages[language] ?? null) : null;
  const label =
    LANGUAGE_LABELS[language] ?? (safeLanguage ? safeLanguage.toUpperCase() : LANGUAGE_LABELS.text);
  return { grammar, label };
}

export function syntaxLanguageFromPath(path: string): string | null {
  const filename = path.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  const extension = filename.includes('.') ? (filename.split('.').pop() ?? '') : '';
  return EXTENSION_LANGUAGES[extension] ?? null;
}

export function highlightCode(code: string, grammar: Prism.Grammar | null): HighlightedCode {
  if (!grammar || code.length > MAX_HIGHLIGHT_LENGTH) {
    return code;
  }
  return flattenTokenStream(Prism.tokenize(code, grammar));
}

export function highlightDiffCodeLines(
  lines: DiffCodeLine[],
  grammar: Prism.Grammar | null,
): HighlightedCode[] {
  const highlighted: HighlightedCode[] = lines.map((line) => line.content || ' ');
  if (!grammar) {
    return highlighted;
  }

  let runStart = 0;
  for (let index = 0; index <= lines.length; index += 1) {
    const line = lines[index];
    if (index === lines.length || (line?.kind === 'context' && line.content === '...')) {
      highlightDiffRun(lines, highlighted, grammar, runStart, index);
      runStart = index + 1;
    }
  }
  return highlighted;
}

export function renderSyntaxTokens(
  tokens: HighlightedCode,
  styles: SyntaxTokenStyles,
  path = 'token',
): ReactNode {
  if (typeof tokens === 'string') {
    return tokens;
  }
  return tokens.map((token, index) =>
    token.type ? (
      <Text key={`${path}-${String(index)}`} style={tokenStyle(token.type, styles)}>
        {token.content}
      </Text>
    ) : (
      token.content
    ),
  );
}

function tokenStyle(type: string, styles: SyntaxTokenStyles): TextStyle | undefined {
  if (COMMENT_TOKEN_TYPES.has(type)) {
    return styles.syntaxComment;
  }
  if (KEYWORD_TOKEN_TYPES.has(type)) {
    return styles.syntaxKeyword;
  }
  if (STRING_TOKEN_TYPES.has(type)) {
    return styles.syntaxString;
  }
  if (NUMBER_TOKEN_TYPES.has(type)) {
    return styles.syntaxNumber;
  }
  if (FUNCTION_TOKEN_TYPES.has(type)) {
    return styles.syntaxFunction;
  }
  if (PROPERTY_TOKEN_TYPES.has(type)) {
    return styles.syntaxProperty;
  }
  if (OPERATOR_TOKEN_TYPES.has(type)) {
    return styles.syntaxOperator;
  }
  return undefined;
}

function flattenTokenStream(
  tokens: Prism.TokenStream,
  inheritedType: string | null = null,
): HighlightedSyntaxSegment[] {
  if (typeof tokens === 'string') {
    return tokens ? [{ content: tokens, type: inheritedType }] : [];
  }
  if (Array.isArray(tokens)) {
    return tokens.flatMap((token) => flattenTokenStream(token, inheritedType));
  }
  return flattenTokenStream(
    tokens.content,
    STYLED_TOKEN_TYPES.has(tokens.type) ? tokens.type : inheritedType,
  );
}

function highlightDiffRun(
  lines: DiffCodeLine[],
  highlighted: HighlightedCode[],
  grammar: Prism.Grammar,
  start: number,
  end: number,
): void {
  if (start >= end) {
    return;
  }
  const oldIndexes: number[] = [];
  const newIndexes: number[] = [];
  for (let index = start; index < end; index += 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }
    if (line.kind !== 'add') {
      oldIndexes.push(index);
    }
    if (line.kind !== 'remove') {
      newIndexes.push(index);
    }
  }
  assignHighlightedSide(lines, highlighted, grammar, oldIndexes);
  assignHighlightedSide(lines, highlighted, grammar, newIndexes);
}

function assignHighlightedSide(
  lines: DiffCodeLine[],
  highlighted: HighlightedCode[],
  grammar: Prism.Grammar,
  indexes: number[],
): void {
  if (indexes.length === 0) {
    return;
  }
  const code = indexes.map((index) => lines[index]?.content ?? '').join('\n');
  const tokenizedLines = splitHighlightedLines(highlightCode(code, grammar));
  indexes.forEach((lineIndex, index) => {
    highlighted[lineIndex] = tokenizedLines[index] || lines[lineIndex]?.content || ' ';
  });
}

function splitHighlightedLines(highlighted: HighlightedCode): HighlightedCode[] {
  if (typeof highlighted === 'string') {
    return highlighted.split('\n').map((line) => line || ' ');
  }
  const lines: HighlightedSyntaxSegment[][] = [[]];
  for (const segment of highlighted) {
    const parts = segment.content.split('\n');
    parts.forEach((part, index) => {
      if (index > 0) {
        lines.push([]);
      }
      if (part) {
        lines[lines.length - 1]?.push({ content: part, type: segment.type });
      }
    });
  }
  return lines.map((line) => (line.length > 0 ? line : ' '));
}
