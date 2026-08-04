import { forwardRef } from 'react';
import { View, type ViewProps } from 'react-native';

export type MockGlassEffectStyle =
  | 'clear'
  | 'none'
  | 'regular'
  | { style: 'clear' | 'none' | 'regular'; animate?: boolean; animationDuration?: number };

export interface MockGlassViewProps extends ViewProps {
  colorScheme?: 'auto' | 'dark' | 'light';
  glassEffectStyle?: MockGlassEffectStyle;
  isInteractive?: boolean;
  tintColor?: string;
}

export interface MockGlassContainerProps extends ViewProps {
  spacing?: number;
}

let mockLiquidGlassAvailable = false;
let mockGlassEffectAPIAvailable = false;
const renderedGlassViewProps: MockGlassViewProps[] = [];
const renderedGlassContainerProps: MockGlassContainerProps[] = [];

export function resetMockGlassEffect(): void {
  mockLiquidGlassAvailable = false;
  mockGlassEffectAPIAvailable = false;
  renderedGlassViewProps.length = 0;
  renderedGlassContainerProps.length = 0;
}

export function setMockLiquidGlassAvailable(value: boolean): void {
  mockLiquidGlassAvailable = value;
}

export function setMockGlassEffectAPIAvailable(value: boolean): void {
  mockGlassEffectAPIAvailable = value;
}

export function getRenderedGlassViewProps(): readonly MockGlassViewProps[] {
  return renderedGlassViewProps;
}

export function getRenderedGlassContainerProps(): readonly MockGlassContainerProps[] {
  return renderedGlassContainerProps;
}

export function isLiquidGlassAvailable(): boolean {
  return mockLiquidGlassAvailable;
}

export function isGlassEffectAPIAvailable(): boolean {
  return mockGlassEffectAPIAvailable;
}

export const GlassView = forwardRef<View, MockGlassViewProps>(function MockGlassView(
  {
    colorScheme: _colorScheme,
    glassEffectStyle: _glassEffectStyle,
    isInteractive: _isInteractive,
    tintColor: _tintColor,
    ...viewProps
  },
  ref,
) {
  renderedGlassViewProps.push({
    ...viewProps,
    colorScheme: _colorScheme,
    glassEffectStyle: _glassEffectStyle,
    isInteractive: _isInteractive,
    tintColor: _tintColor,
  });
  return <View ref={ref} {...viewProps} />;
});

export const GlassContainer = forwardRef<View, MockGlassContainerProps>(function MockGlassContainer(
  { spacing, ...viewProps },
  ref,
) {
  renderedGlassContainerProps.push({ ...viewProps, spacing });
  return <View ref={ref} {...viewProps} />;
});
