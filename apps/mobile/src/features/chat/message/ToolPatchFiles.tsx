import { useMemo } from 'react';
import { Text, View } from 'react-native';

import { useAppTheme } from '@shared/theme';
import { createToolCardStyles } from './toolCardStyles';
import type { ToolInvocation } from './toolInvocationModel';
import { formatChangedLineCount, resolveToolInvocationFiles } from './toolInvocationPresentation';

export function ToolPatchFiles({ invocation }: { invocation: ToolInvocation }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createToolCardStyles(theme), [theme]);
  const files = useMemo(() => resolveToolInvocationFiles(invocation), [invocation]);
  if (files.length === 0) {
    return null;
  }

  return (
    <View style={styles.patchFiles} testID="tool-patch-files">
      {files.map(({ path, additions, deletions }) => {
        const filename = path.split(/[\\/]/).pop() || path;
        const countsKnown = additions !== null && deletions !== null;
        const countsLabel = countsKnown
          ? `${formatChangedLineCount(additions, 'added')}, ${formatChangedLineCount(deletions, 'removed')}`
          : 'Counts unavailable';
        return (
          <View
            key={path}
            style={styles.patchFile}
            accessible
            accessibilityRole="text"
            accessibilityLabel={`${path}, ${countsLabel}`}
            testID="tool-patch-file"
          >
            <View style={styles.patchFileInfo}>
              <Text style={styles.patchFileName} numberOfLines={1} testID="tool-patch-name">
                {filename}
              </Text>
              <Text
                style={styles.patchFilePath}
                numberOfLines={1}
                ellipsizeMode="middle"
                testID="tool-patch-path"
              >
                {path}
              </Text>
            </View>
            <View style={styles.patchStats} testID="tool-patch-stats">
              {countsKnown ? (
                <>
                  <Text style={[styles.diffStat, styles.diffAddedStat]}>+{String(additions)}</Text>
                  <Text style={[styles.diffStat, styles.diffRemovedStat]}>
                    -{String(deletions)}
                  </Text>
                </>
              ) : (
                <Text style={styles.note}>{countsLabel}</Text>
              )}
            </View>
          </View>
        );
      })}
      {invocation.truncated ? (
        <Text style={styles.note}>Some changes were truncated by the bridge.</Text>
      ) : null}
    </View>
  );
}
