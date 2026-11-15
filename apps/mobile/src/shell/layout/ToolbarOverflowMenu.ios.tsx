import { Button, Host, Menu } from '@expo/ui/swift-ui';
import {
  accessibilityIdentifier,
  buttonBorderShape,
  buttonStyle,
  controlSize,
  disabled,
  frame,
  labelStyle,
  menuIndicator,
} from '@expo/ui/swift-ui/modifiers';

import { useAppTheme } from '@shared/theme';
import { CIRCULAR_TOOLBAR_BUTTON_SIZE } from '@shared/ui/CircularToolbarButton';
import type { ToolbarOverflowMenuProps } from './ToolbarOverflowMenu';

export function ToolbarOverflowMenu({ items }: ToolbarOverflowMenuProps) {
  const theme = useAppTheme();
  if (items.length === 0) {
    return null;
  }

  return (
    <Host
      style={{ width: CIRCULAR_TOOLBAR_BUTTON_SIZE, height: CIRCULAR_TOOLBAR_BUTTON_SIZE }}
      colorScheme={theme.mode}
      seedColor={theme.colors.textPrimary}
      ignoreSafeArea="all"
    >
      <Menu
        label="More"
        systemImage="ellipsis"
        modifiers={[
          labelStyle('iconOnly'),
          menuIndicator('hidden'),
          buttonStyle('glass'),
          buttonBorderShape('circle'),
          controlSize('large'),
          frame({
            width: CIRCULAR_TOOLBAR_BUTTON_SIZE,
            height: CIRCULAR_TOOLBAR_BUTTON_SIZE,
          }),
          accessibilityIdentifier('scene-toolbar-button-glass-overflow'),
        ]}
      >
        {items.map((item) => (
          <Button
            key={item.key}
            label={item.label}
            onPress={item.onPress}
            modifiers={[disabled(Boolean(item.disabled))]}
          />
        ))}
      </Menu>
    </Host>
  );
}
