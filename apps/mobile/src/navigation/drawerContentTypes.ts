export type DrawerScreen = 'Main' | 'Browser' | 'Settings' | 'Privacy' | 'Terms';

export interface DrawerContentProps {
  active: boolean;
  onClose?: () => void;
}
