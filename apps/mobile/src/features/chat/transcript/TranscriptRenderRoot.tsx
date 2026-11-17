import type { PropsWithChildren } from 'react';
import { GestureDetector, type useSimultaneousGestures } from 'react-native-gesture-handler';

import { MermaidRenderProvider } from '../message/mermaid/MermaidRenderProvider';

export function TranscriptRenderRoot({
  gesture,
  children,
}: PropsWithChildren<{ gesture: ReturnType<typeof useSimultaneousGestures> }>) {
  return (
    <MermaidRenderProvider>
      <GestureDetector gesture={gesture}>{children}</GestureDetector>
    </MermaidRenderProvider>
  );
}
