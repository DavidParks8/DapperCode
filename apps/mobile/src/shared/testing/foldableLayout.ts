import { Dimensions } from 'react-native';
import { act, type ReactTestRenderer } from 'react-test-renderer';

import type { WindowTraits } from '@shell/layout/windowLayout';

/**
 * The closed iPhone Duo as the iOS 27.1 simulator reports it: a compact outer display with bars on
 * the trailing edge, below the status column the system reports as an occlusion.
 */
export const CLOSED_DUO_TRAITS: WindowTraits = {
  horizontalSizeClass: 'compact',
  verticalSizeClass: 'regular',
  verticalBarEdge: 'trailing',
  divisions: [],
  occlusions: [
    { x: 399.67, y: 29.33, width: 37, height: 37 },
    { x: 382, y: 0, width: 84, height: 174 },
  ],
  statusBar: { x: 0, y: 0, width: 466, height: 2 },
};

export const CLOSED_DUO_SAFE_AREA = {
  frame: { x: 0, y: 0, width: 466, height: 678 },
  insets: { top: 0, left: 0, right: 84, bottom: 20 },
};

/** Sizes the test window like the closed iPhone Duo; call the result to restore the default. */
export function sizeWindowLikeClosedDuo(): () => void {
  setWindow(466, 678, 3);
  return () => setWindow(750, 1334, 2);
}

function setWindow(width: number, height: number, scale: number): void {
  act(() => {
    Dimensions.set({
      window: { width, height, scale, fontScale: 1 },
      screen: { width, height, scale, fontScale: 1 },
    });
  });
}

/** The subset of the test renderer's instance API the repository's typings omit. */
export interface QueryNode {
  type: unknown;
  props: Record<string, unknown>;
  parent: QueryNode | null;
  children: Array<QueryNode | string>;
  findAll(predicate: (node: QueryNode) => boolean): QueryNode[];
}

export function queryRoot(tree: ReactTestRenderer): QueryNode {
  return tree.root as unknown as QueryNode;
}
