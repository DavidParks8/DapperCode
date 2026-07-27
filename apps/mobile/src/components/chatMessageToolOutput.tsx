import { useMemo, type ReactElement } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { useAppTheme } from '../theme';
import { toMarkdownImageSource } from './chatImageSource';
import { MarkdownImage, SelectableMessageText } from './chatMessagePrimitives';
import { createStyles } from './chatMessageStyles';
import type { ToolInvocation, ToolInvocationDiff } from './toolInvocationModel';

/** Past this many lines the body scrolls instead of pushing the transcript around. */
const SCROLL_LINE_THRESHOLD = 24;

export function ToolInvocationOutput({
  invocation,
  bridgeUrl,
  bridgeToken,
}: {
  invocation: ToolInvocation;
  bridgeUrl: string | null;
  bridgeToken: string | null;
}): ReactElement | null {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const lineCount =
    invocation.textLines.length +
    invocation.terminals.reduce((total, terminal) => total + countLines(terminal.output), 0) +
    invocation.diffs.reduce((total, diff) => total + countLines(diff.newText), 0);

  const body = (
    <View testID="tool-output-body" style={styles.toolRowBody}>
      {invocation.locations.length > 0 ? (
        <View style={styles.toolLocationChips}>
          {invocation.locations.map((location, index) => (
            <View key={`${location.path}-${String(index)}`} style={styles.toolLocationChip}>
              <Text style={styles.toolLocationChipText}>
                {location.line === undefined
                  ? location.path
                  : `${location.path}:${String(location.line)}`}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {invocation.diffs.map((diff, index) => (
        <ToolDiffBlock key={`${diff.path}-${String(index)}`} diff={diff} styles={styles} />
      ))}
      {invocation.terminals.map((terminal, index) => (
        <View
          key={`${terminal.terminalId ?? 'terminal'}-${String(index)}`}
          style={[styles.toolOutputSurface, styles.toolConsoleSurface]}
        >
          {splitLines(terminal.output).map((line, lineIndex) => (
            <SelectableMessageText key={`line-${String(lineIndex)}`} style={styles.toolOutputLine}>
              {line}
            </SelectableMessageText>
          ))}
        </View>
      ))}
      {invocation.images.map((image, index) => {
        const source = toMarkdownImageSource(image, bridgeUrl, bridgeToken);
        return source ? <MarkdownImage key={`image-${String(index)}`} source={source} /> : null;
      })}
      {invocation.textLines.length > 0 ? (
        <View style={styles.toolOutputSurface}>
          {invocation.textLines.map((line, index) => (
            <SelectableMessageText key={`text-${String(index)}`} style={styles.toolOutputLine}>
              {line}
            </SelectableMessageText>
          ))}
        </View>
      ) : null}
      {invocation.truncated ? (
        <Text style={styles.toolTruncatedNote}>Output truncated by the bridge.</Text>
      ) : null}
    </View>
  );

  if (invocation.empty && !invocation.truncated) return null;
  if (lineCount <= SCROLL_LINE_THRESHOLD) return body;
  return (
    <ScrollView
      style={styles.toolBodyScroll}
      nestedScrollEnabled
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator
    >
      {body}
    </ScrollView>
  );
}

function ToolDiffBlock({
  diff,
  styles,
}: {
  diff: ToolInvocationDiff;
  styles: ReturnType<typeof createStyles>;
}): ReactElement {
  const removed = diff.oldText === null ? [] : splitLines(diff.oldText);
  const added = splitLines(diff.newText);
  return (
    <View>
      <Text style={styles.toolOutputHeader}>{diff.path}</Text>
      <View style={styles.toolOutputSurface}>
        {removed.map((line, index) => (
          <SelectableMessageText
            key={`removed-${String(index)}`}
            style={[styles.toolOutputLine, styles.toolDiffLineRemoved]}
          >
            {`- ${line}`}
          </SelectableMessageText>
        ))}
        {added.map((line, index) => (
          <SelectableMessageText
            key={`added-${String(index)}`}
            style={[styles.toolOutputLine, styles.toolDiffLineAdded]}
          >
            {`+ ${line}`}
          </SelectableMessageText>
        ))}
      </View>
    </View>
  );
}

function splitLines(value: string): string[] {
  if (!value) return [];
  const lines = value.split('\n');
  // A trailing newline is a terminator, not a blank line worth a row of its own.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function countLines(value: string): number {
  return splitLines(value).length;
}
