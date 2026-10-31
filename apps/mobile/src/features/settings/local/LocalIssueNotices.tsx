import { useOnDeviceIssues, useOnDeviceRuntime } from '../../on-device/runtime/OnDeviceProvider';
import type { OnDeviceRuntimeSlice } from '../../on-device/runtime/types';
import { SettingsNotice } from '../SettingsList';

const ISSUE_SLICES: readonly OnDeviceRuntimeSlice[] = ['issues'];

/**
 * Every current On this iPhone problem — writes that failed, files set aside at startup, and
 * operations that failed in the background — each with its own action. Failed writes offer a
 * retry and clear once a write succeeds; notices are dismissed explicitly.
 */
export function LocalIssueNotices() {
  const runtime = useOnDeviceRuntime(ISSUE_SLICES);
  const issues = useOnDeviceIssues();
  return issues.map((issue) => (
    <SettingsNotice
      key={issue.id}
      text={issue.message}
      action={issue.retryable ? 'Retry saving' : 'Dismiss'}
      onPress={() =>
        issue.retryable
          ? runtime.retryPersistence().catch(() => undefined)
          : runtime.dismissIssue(issue.id)
      }
    />
  ));
}
