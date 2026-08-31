import type { ComponentProps, PropsWithChildren } from 'react';
import { GestureDetector } from 'react-native-gesture-handler';

import { MermaidRenderProvider } from '../message/mermaid/MermaidRenderProvider';

export function TranscriptRenderRoot({
  gesture,
  children,
}: PropsWithChildren<{ gesture: ComponentProps<typeof GestureDetector>['gesture'] }>) {
  return (
    <MermaidRenderProvider>
      <GestureDetector gesture={gesture}>{children}</GestureDetector>
    </MermaidRenderProvider>
  );
}
