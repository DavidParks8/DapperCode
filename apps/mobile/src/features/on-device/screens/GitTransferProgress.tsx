import { useEffect, useState } from 'react';
import { useOnDeviceRuntime } from '../runtime/OnDeviceProvider';
import { LocalAction, LocalText } from './ui';

export function GitTransferProgress({ watch }: { watch: boolean }) {
  const runtime = useOnDeviceRuntime();
  const [progress, setProgress] = useState(() => runtime.native.getGitTransferProgress());
  useEffect(() => {
    if (!watch) {
      return;
    }
    const timer = setInterval(() => setProgress(runtime.native.getGitTransferProgress()), 500);
    return () => clearInterval(timer);
  }, [runtime, watch]);
  if (!watch || !progress.active) {
    return null;
  }
  return (
    <>
      <LocalText>
        {progress.cancelled
          ? 'Stopping Git transfer; waiting for transport to settle.'
          : progress.total > 0
            ? `Git transfer · ${progress.completed}/${progress.total} objects`
            : 'Connecting to Git origin…'}
      </LocalText>
      <LocalText>
        Cancellation is cooperative. An unresponsive connection may take up to 15 seconds to time
        out. A push may already have reached the remote.
      </LocalText>
      <LocalAction
        title="Cancel Git transfer"
        disabled={progress.cancelled}
        onPress={() => runtime.native.cancelGitTransfer()}
      />
    </>
  );
}
