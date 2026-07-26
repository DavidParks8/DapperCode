import { Alert } from 'react-native';

import { confirmAction } from './confirm';

describe('confirmAction', () => {
  afterEach(() => jest.restoreAllMocks());

  it('resolves true when the confirm button is pressed', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.style === 'destructive')?.onPress?.();
    });

    await expect(
      confirmAction({
        title: 'Delete workspace?',
        message: 'This cannot be undone.',
        confirmLabel: 'Delete',
        destructive: true,
      })
    ).resolves.toBe(true);
    expect(alert.mock.calls[0]?.[0]).toBe('Delete workspace?');
    expect(alert.mock.calls[0]?.[1]).toBe('This cannot be undone.');
    expect(alert.mock.calls[0]?.[2]).toEqual([
      expect.objectContaining({ text: 'Cancel', style: 'cancel' }),
      expect.objectContaining({ text: 'Delete', style: 'destructive' }),
    ]);
  });

  it('resolves false when cancelled and defaults to a non-destructive confirm', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.style === 'cancel')?.onPress?.();
    });

    await expect(confirmAction({ title: 'Discard draft?' })).resolves.toBe(false);
    expect(alert.mock.calls[0]?.[2]?.[1]).toEqual(
      expect.objectContaining({ text: 'Confirm', style: 'default' })
    );
  });

  it('resolves false when the dialog is dismissed without a choice', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, _buttons, options) => {
      options?.onDismiss?.();
    });

    await expect(confirmAction({ title: 'Leave page?' })).resolves.toBe(false);
  });
});
