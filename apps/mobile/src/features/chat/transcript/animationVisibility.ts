import { useCallback, useEffect, useRef, useState } from 'react';
import type { ViewToken } from 'react-native';

import type { TranscriptDisplayItem } from './messages';

function sameIds(current: ReadonlySet<string>, next: ReadonlySet<string>): boolean {
  return current.size === next.size && [...current].every((id) => next.has(id));
}

export function useTranscriptAnimationVisibility(resetKey: string) {
  const [activityVisible, setActivityVisible] = useState(true);
  const activityVisibleRef = useRef(true);
  const [visibleItemIds, setVisibleItemIds] = useState<ReadonlySet<string>>(() => new Set());

  const updateActivityVisibility = useCallback((visible: boolean) => {
    if (activityVisibleRef.current === visible) {
      return;
    }
    activityVisibleRef.current = visible;
    setActivityVisible(visible);
  }, []);

  const updateVisibleItems = useCallback(
    (viewableItems: Array<ViewToken<TranscriptDisplayItem>>) => {
      const next = new Set(
        viewableItems.flatMap((token) =>
          token.isViewable && token.item.kind === 'toolInvocation'
            ? [token.item.invocation.id]
            : [],
        ),
      );
      setVisibleItemIds((current) => (sameIds(current, next) ? current : next));
    },
    [],
  );

  useEffect(() => {
    activityVisibleRef.current = true;
    setActivityVisible(true);
    setVisibleItemIds(new Set());
  }, [resetKey]);

  return {
    activityVisible,
    updateActivityVisibility,
    updateVisibleItems,
    visibleItemIds,
  };
}
