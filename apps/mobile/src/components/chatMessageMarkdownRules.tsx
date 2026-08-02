import { ScrollView, View } from 'react-native';
import type { RenderRules } from 'react-native-markdown-display';

import { toMarkdownImageSource } from './chatImageSource';
import { openMarkdownLink, toLocalFileReferenceLabel } from './chatMessageContentHelpers';
import { ChatCodeBlock } from './ChatCodeBlock';
import { MarkdownImage, SelectableMessageText } from './chatMessagePrimitives';

function readMarkdownAttr(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readFenceLanguage(node: object): string | null {
  if (!('sourceInfo' in node)) {
    return null;
  }
  return readMarkdownAttr(node.sourceInfo);
}

function trimTrailingParserNewline(content: string): string {
  return content.endsWith('\n') ? content.substring(0, content.length - 1) : content;
}

export function createMarkdownRules(
  bridgeUrl: string | null,
  bridgeToken: string | null,
  onOpenLocalPreview?: (targetUrl: string) => void,
  { selectable = true }: { selectable?: boolean } = {},
): RenderRules {
  // React Native flattens nested `Text` into the block's outermost node, so only these three
  // rules become real paragraph views. Turning `selectable` off on them releases the long press
  // for a caller that wants to offer real selection instead of RN's copy-the-whole-block menu.
  const blockSelectable = selectable ? undefined : false;
  return {
    text: (node, _children, _parent, styles, inheritedStyles = {}) => (
      <SelectableMessageText key={node.key} style={[inheritedStyles, styles.text]}>
        {node.content}
      </SelectableMessageText>
    ),
    textgroup: (node, children, _parent, styles) => (
      <SelectableMessageText key={node.key} selectable={blockSelectable} style={styles.textgroup}>
        {children}
      </SelectableMessageText>
    ),
    strong: (node, children, _parent, styles) => (
      <SelectableMessageText key={node.key} style={styles.strong}>
        {children}
      </SelectableMessageText>
    ),
    em: (node, children, _parent, styles) => (
      <SelectableMessageText key={node.key} style={styles.em}>
        {children}
      </SelectableMessageText>
    ),
    s: (node, children, _parent, styles) => (
      <SelectableMessageText key={node.key} style={styles.s}>
        {children}
      </SelectableMessageText>
    ),
    code_inline: (node, _children, _parent, styles, inheritedStyles = {}) => (
      <SelectableMessageText key={node.key} style={[inheritedStyles, styles.code_inline]}>
        {node.content}
      </SelectableMessageText>
    ),
    code_block: (node) => (
      <ChatCodeBlock
        key={node.key}
        code={trimTrailingParserNewline(node.content)}
        selectable={selectable}
      />
    ),
    fence: (node) => (
      <ChatCodeBlock
        key={node.key}
        code={trimTrailingParserNewline(node.content)}
        language={readFenceLanguage(node)}
        selectable={selectable}
      />
    ),
    table: (node, children, _parent, styles) => (
      <ScrollView
        key={node.key}
        horizontal
        nestedScrollEnabled
        bounces={false}
        showsHorizontalScrollIndicator={false}
        style={styles.table_scroll}
        contentContainerStyle={styles.table_scroll_content}
      >
        <View style={styles._VIEW_SAFE_table}>{children}</View>
      </ScrollView>
    ),
    hardbreak: (node, _children, _parent, styles) => (
      <SelectableMessageText key={node.key} style={styles.hardbreak}>
        {'\n'}
      </SelectableMessageText>
    ),
    softbreak: (node, _children, _parent, styles) => (
      <SelectableMessageText key={node.key} style={styles.softbreak}>
        {'\n'}
      </SelectableMessageText>
    ),
    inline: (node, children, _parent, styles) => (
      <SelectableMessageText key={node.key} style={styles.inline}>
        {children}
      </SelectableMessageText>
    ),
    span: (node, children, _parent, styles) => (
      <SelectableMessageText key={node.key} style={styles.span}>
        {children}
      </SelectableMessageText>
    ),
    link: (node, children, _parent, styles, onLinkPress) => {
      const href = readMarkdownAttr(node.attributes.href);
      if (!href) {
        return (
          <SelectableMessageText key={node.key} style={styles.link}>
            {children}
          </SelectableMessageText>
        );
      }
      const localFileReference = toLocalFileReferenceLabel(href);
      if (localFileReference) {
        return (
          <SelectableMessageText key={node.key} style={styles.code_inline}>
            {localFileReference}
          </SelectableMessageText>
        );
      }
      return (
        <SelectableMessageText
          key={node.key}
          style={styles.link}
          onPress={() => openMarkdownLink(href, onLinkPress, onOpenLocalPreview)}
        >
          {children}
        </SelectableMessageText>
      );
    },
    image: (node) => {
      const src = readMarkdownAttr(node.attributes.src);
      if (!src) {
        return null;
      }
      const source = toMarkdownImageSource(src, bridgeUrl, bridgeToken);
      if (!source) {
        return null;
      }
      const alt = readMarkdownAttr(node.attributes.alt);
      return <MarkdownImage key={node.key} source={source} accessibilityLabel={alt ?? undefined} />;
    },
  };
}
