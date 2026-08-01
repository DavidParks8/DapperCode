export type DrawerScreen = 'Main' | 'Browser' | 'Settings';

export interface DrawerContentProps {
  active: boolean;
  onClose?: () => void;
}
