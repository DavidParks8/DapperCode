import type { View } from 'react-native';

import type { ResponseUsageAnchor } from '../state/modals';

/**
 * Reads a view's rectangle in window coordinates.
 *
 * Kept in its own module because native measurement is the one part of anchoring a floating
 * surface that no JavaScript test environment can supply: `measureInWindow` is stubbed there and
 * never calls back.
 */
export function measureAnchor(
  node: View | null,
  onMeasured: (anchor: ResponseUsageAnchor) => void,
): void {
  node?.measureInWindow?.((x, y, width, height) => {
    onMeasured({ x, y, width, height });
  });
}
