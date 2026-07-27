export type AppScreen =
  | 'Main'
  | 'ChatGit'
  | 'Browser'
  | 'Settings'
  | 'Privacy'
  | 'Terms'
  | 'WorkspacePicker'
  | 'GitCheckout';
export type Screen = AppScreen | 'SubAgent' | 'Onboarding';

export const DRAWER_MIN_WIDTH = 260;
export const TABLET_LAYOUT_MIN_WIDTH = 700;
export const TABLET_SIDEBAR_WIDTH = 312;
export const TABLET_SIDEBAR_ANIMATION_MS = 260;
export const EDGE_SWIPE_WIDTH = 24;
export const BACK_SWIPE_DISTANCE = 56;
export const BACK_SWIPE_VELOCITY = 900;
export const DRAWER_SNAP_OPEN_PROGRESS = 0.38;
export const DRAWER_SNAP_VELOCITY = 920;
export const DRAWER_VELOCITY_PROJECTION = 0.08;
export const DRAWER_RUBBER_BAND_STRENGTH = 0.2;
export const CHAT_TRANSITION_MIN_MS = 220;
export const DRAWER_MAX_SHADOW_OPACITY = 0.24;
export const DRAWER_MAX_SHADOW_RADIUS = 26;
export const DRAWER_MAX_ELEVATION = 18;
export const APP_PREFETCH_DELAY_MS = 0;
export const APP_PREFETCH_CHAT_LIMIT = 5;
export const CHAT_SNAPSHOT_PERSIST_DELAY_MS = 250;
export const AUTO_STORE_REVIEW_RETRY_MS = 24 * 60 * 60 * 1000;
