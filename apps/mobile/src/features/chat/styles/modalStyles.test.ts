import { createAppTheme } from '@shared/theme';
import { createMainScreenModalStyles } from './modalStyles';

it.each([
  'userInputOptionButton',
  'userInputAnswerInput',
  'userInputSecondaryButton',
  'userInputSubmitButton',
] as const)('keeps %s at the platform minimum touch target', (control) => {
  const theme = createAppTheme('dark');
  const minimum = 56;
  const styles = createMainScreenModalStyles({
    ...theme,
    touchTarget: { minimum },
  });
  expect(styles[control].minHeight).toBe(minimum);
});
