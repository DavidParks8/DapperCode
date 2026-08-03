import { StyleSheet, View, type ViewStyle } from 'react-native';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import Markdown from 'react-native-markdown-display';

import { createWorkflowMarkdownStyles } from '../workflow/markdownStyles';
import { createAppTheme } from '@shared/theme';
import { createMarkdownStyles, createReasoningMarkdownStyles } from './markdownStyles';

type MarkdownStyles = ReturnType<typeof createMarkdownStyles>;
type QueryableTestInstance = ReactTestInstance & {
  findAllByType(type: unknown): QueryableTestInstance[];
};
type QueryableRenderer = ReactTestRenderer & { root: QueryableTestInstance };

const LIBRARY_DEFAULT_BLOCKQUOTE_BACKGROUND = '#F5F5F5';
const LIBRARY_DEFAULT_HR_BACKGROUND = '#000000';
const LIBRARY_DEFAULT_BORDER = '#000000';

function flattenViewStyle(node: ReactTestInstance): ViewStyle {
  return StyleSheet.flatten(node.props['style'] as ViewStyle) ?? {};
}

function renderMarkdownViewStyles(styles: object, markdown: string): ViewStyle[] {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(<Markdown style={styles as MarkdownStyles}>{markdown}</Markdown>);
  });
  const created = tree as QueryableRenderer;
  const viewStyles = created.root.findAllByType(View).map(flattenViewStyle);
  act(() => {
    created.unmount();
  });
  return viewStyles;
}

function findBlockquoteStyle(styles: object): ViewStyle {
  const found = renderMarkdownViewStyles(styles, '> example').find(
    (style) => typeof style.borderLeftWidth === 'number' && style.borderLeftWidth > 0,
  );
  if (!found) {
    throw new Error('blockquote view was not rendered');
  }
  return found;
}

function findHorizontalRuleStyle(styles: object): ViewStyle {
  const found = renderMarkdownViewStyles(styles, 'before\n\n---\n\nafter').find(
    (style) => style.height === StyleSheet.hairlineWidth || style.height === 1,
  );
  if (!found) {
    throw new Error('horizontal rule view was not rendered');
  }
  return found;
}

const TABLE_MARKDOWN = ['| a | b |', '| - | - |', '| 1 | 2 |'].join('\n');

function findTableStyles(styles: object): { table: ViewStyle; row: ViewStyle } {
  const rendered = renderMarkdownViewStyles(styles, TABLE_MARKDOWN);
  const table = rendered.find(
    (style) => typeof style.borderWidth === 'number' && style.borderWidth > 0,
  );
  const row = rendered.find(
    (style) => typeof style.borderBottomWidth === 'number' && style.borderBottomWidth > 0,
  );
  if (!table || !row) {
    throw new Error('table views were not rendered');
  }
  return { table, row };
}

describe.each([
  ['chat message markdown', createMarkdownStyles],
  ['reasoning markdown', createReasoningMarkdownStyles],
  ['workflow markdown', createWorkflowMarkdownStyles],
] as const)('%s block styling', (_label, createStyles) => {
  it.each(['dark', 'light'] as const)('stays readable in the %s theme', (mode) => {
    const theme = createAppTheme(mode);
    const blockquote = findBlockquoteStyle(createStyles(theme));

    expect(blockquote.backgroundColor).not.toBe(LIBRARY_DEFAULT_BLOCKQUOTE_BACKGROUND);
    expect(blockquote.backgroundColor).toBe('transparent');
    expect(blockquote.borderLeftColor ?? blockquote.borderColor).toBe(theme.colors.borderHighlight);
  });

  it('does not inherit the library default indentation', () => {
    const blockquote = findBlockquoteStyle(createStyles(createAppTheme('dark')));

    expect(blockquote.marginLeft).toBe(0);
    expect(blockquote.paddingHorizontal).toBe(0);
  });

  it('renders a themed horizontal rule instead of the library default', () => {
    const theme = createAppTheme('dark');
    const rule = findHorizontalRuleStyle(createStyles(theme));

    expect(rule.backgroundColor).not.toBe(LIBRARY_DEFAULT_HR_BACKGROUND);
    expect(rule.backgroundColor).toBe(theme.colors.borderLight);
  });

  it('renders themed table borders instead of the library default black', () => {
    const theme = createAppTheme('dark');
    const { table, row } = findTableStyles(createStyles(theme));

    expect(table.borderColor).not.toBe(LIBRARY_DEFAULT_BORDER);
    expect(table.borderColor).toBe(theme.colors.borderHighlight);
    expect(row.borderColor).not.toBe(LIBRARY_DEFAULT_BORDER);
    expect(row.borderColor).toBe(theme.colors.borderLight);
  });
});
