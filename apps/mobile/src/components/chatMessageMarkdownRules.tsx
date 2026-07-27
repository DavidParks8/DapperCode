import { ScrollView, View } from 'react-native';
import type { RenderRules } from '@believer/react-native-markdown-display';

import { toMarkdownImageSource } from './chatImageSource';
import { openMarkdownLink, toLocalFileReferenceLabel } from './chatMessageContentHelpers';
import { MarkdownImage, SelectableMessageText } from './chatMessagePrimitives';

function readMarkdownAttr(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function createMarkdownRules(
  bridgeUrl: string | null,
  bridgeToken: string | null,
  onOpenLocalPreview?: (targetUrl: string) => void,
): RenderRules {
  return {
    text: (node, _children, _parent, styles, inheritedStyles = {}) => (
      <SelectableMessageText key={node.key} style={[inheritedStyles, styles.text]}>
        {node.content}
      </SelectableMessageText>
    ),
    textgroup: (node, children, _parent, styles) => (
      <SelectableMessageText key={node.key} style={styles.textgroup}>
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
    code_block: (node, _children, _parent, styles, inheritedStyles = {}) => {
      const content =
        typeof node.content === 'string' && node.content.endsWith('\n')
          ? node.content.substring(0, node.content.length - 1)
          : node.content;
      return (
        <SelectableMessageText key={node.key} style={[inheritedStyles, styles.code_block]}>
          {content}
        </SelectableMessageText>
      );
    },
    fence: (node, _children, _parent, styles, inheritedStyles = {}) => {
      const content =
        typeof node.content === 'string' && node.content.endsWith('\n')
          ? node.content.substring(0, node.content.length - 1)
          : node.content;
      return (
        <SelectableMessageText key={node.key} style={[inheritedStyles, styles.fence]}>
          {content}
        </SelectableMessageText>
      );
    },
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
      if (!href)
        return (
          <SelectableMessageText key={node.key} style={styles.link}>
            {children}
          </SelectableMessageText>
        );
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
      if (!src) return null;
      const source = toMarkdownImageSource(src, bridgeUrl, bridgeToken);
      if (!source) return null;
      const alt = readMarkdownAttr(node.attributes.alt);
      return <MarkdownImage key={node.key} source={source} accessibilityLabel={alt ?? undefined} />;
    },
  };
}
