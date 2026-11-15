import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';

import { decorativeAccessibilityProps } from '@shared/accessibility';
import { useAppTheme } from '@shared/theme';
import {
  CIRCULAR_TOOLBAR_BUTTON_SIZE,
  CircularToolbarButton,
} from '@shared/ui/CircularToolbarButton';
import { SelectionSheet } from '@shared/ui/SelectionSheet';
import { GlassSurface } from '@shared/ui/glass/GlassSurface';
import type { SceneToolbarItem } from './SceneToolbar';

export interface ToolbarOverflowMenuProps {
  items: readonly SceneToolbarItem[];
}

export function ToolbarOverflowMenu({ items }: ToolbarOverflowMenuProps) {
  const theme = useAppTheme();
  const [openItems, setOpenItems] = useState<readonly SceneToolbarItem[] | null>(null);

  return (
    <>
      {items.length > 0 ? (
        <GlassSurface
          role="capsule"
          isInteractive
          style={{
            width: CIRCULAR_TOOLBAR_BUTTON_SIZE,
            height: CIRCULAR_TOOLBAR_BUTTON_SIZE,
            borderRadius: theme.radius.full,
            overflow: 'hidden',
          }}
          testID="scene-toolbar-button-glass-overflow"
        >
          <CircularToolbarButton accessibilityLabel="More" onPress={() => setOpenItems(items)}>
            <Ionicons
              {...decorativeAccessibilityProps}
              name="ellipsis-horizontal"
              size={20}
              color={theme.colors.textPrimary}
            />
          </CircularToolbarButton>
        </GlassSurface>
      ) : null}
      <SelectionSheet
        visible={openItems !== null}
        title="More"
        onClose={() => setOpenItems(null)}
        options={(openItems ?? []).map((item) => ({
          key: item.key,
          title: item.label,
          icon: item.icon,
          disabled: item.disabled,
          onPress: () => {
            setOpenItems(null);
            item.onPress();
          },
        }))}
      />
    </>
  );
}
