import type { CopyStatus } from '../useCopyText';

export interface MermaidCopyPresentation {
  label: string;
  accessibilityLabel: string;
  icon: 'copy-outline' | 'checkmark-outline' | 'alert-circle-outline';
}

export function resolveMermaidCopyPresentation(copyStatus: CopyStatus): MermaidCopyPresentation {
  if (copyStatus === 'copied') {
    return {
      label: 'Copied',
      accessibilityLabel: 'Mermaid source copied',
      icon: 'checkmark-outline',
    };
  }
  if (copyStatus === 'error') {
    return {
      label: 'Retry',
      accessibilityLabel: 'Copy Mermaid source failed. Try again',
      icon: 'alert-circle-outline',
    };
  }
  return {
    label: 'Copy source',
    accessibilityLabel: 'Copy Mermaid source',
    icon: 'copy-outline',
  };
}
