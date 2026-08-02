import { selectApprovalModeWithConfirmation } from './approvalMode';

describe('selectApprovalModeWithConfirmation', () => {
  it('applies normal approvals without confirmation', () => {
    const onChange = jest.fn();
    const showAlert = jest.fn();

    selectApprovalModeWithConfirmation('normal', onChange, showAlert);

    expect(onChange).toHaveBeenCalledWith('normal');
    expect(showAlert).not.toHaveBeenCalled();
  });

  it('retains the prior mode when YOLO confirmation is cancelled', () => {
    const onChange = jest.fn();
    const showAlert = jest.fn();

    selectApprovalModeWithConfirmation('yolo', onChange, showAlert);

    const buttons = showAlert.mock.calls[0]?.[2];
    buttons?.[0]?.onPress?.();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('applies YOLO only after explicit destructive confirmation', () => {
    const onChange = jest.fn();
    const showAlert = jest.fn();

    selectApprovalModeWithConfirmation('yolo', onChange, showAlert);

    const buttons = showAlert.mock.calls[0]?.[2];
    expect(buttons?.[1]).toMatchObject({ text: 'Enable YOLO', style: 'destructive' });
    buttons?.[1]?.onPress?.();
    expect(onChange).toHaveBeenCalledWith('yolo');
  });
});
