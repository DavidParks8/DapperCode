import type { DownloadEntries, DownloadEntry } from './downloadEntries';
import {
  errorMessage,
  NO_RATE,
  RESET_PROGRESS,
  restingPatch,
  validateModelFile,
} from './downloadState';
import type { ModelFilePort, NativeModelTransfer } from './downloadState';

/**
 * Runs native verification for an entry already marked `verifying` and publishes its outcome.
 * Returns `'cancel'` when a cancel request stopped it, so the caller can discard the files.
 */
export async function settleVerification(
  entry: DownloadEntry,
  native: Pick<ModelFilePort, 'finalizeModelDownload' | 'getModelFilePaths'>,
  entries: DownloadEntries,
): Promise<'ready' | 'cancel' | 'stopped'> {
  const { model } = entry;
  try {
    const file = validateModelFile(
      model,
      await native.finalizeModelDownload(model.id, model.sha256, model.bytes),
    );
    entry.job = null;
    entry.request = null;
    entries.publish(entry, {
      ...RESET_PROGRESS,
      phase: 'ready',
      file,
      bytesWritten: model.bytes,
      error: null,
    });
    return 'ready';
  } catch (error) {
    const request = entry.request;
    entry.request = null;
    if (request === 'cancel') {
      return 'cancel';
    }
    // A checksum mismatch discards the staged file natively, so it is not re-verified later.
    const staged = await native.getModelFilePaths(model.id).then(
      (paths) => paths.verificationBytes !== null,
      () => true,
    );
    entry.job = null;
    entries.publish(entry, {
      phase: request === 'pause' ? 'paused' : 'error',
      verifiedBytes: 0,
      ...NO_RATE,
      verificationPending: staged,
      bytesWritten: staged ? model.bytes : 0,
      error: request === 'pause' ? null : errorMessage(error),
    });
    return 'stopped';
  }
}

/**
 * Settles a failed native pause. The slot and disk reservation stay held only if the transfer is
 * verifiably still running; otherwise the model rests in its native state with the error.
 */
export function settlePauseFailure(
  entry: DownloadEntry,
  native: Pick<ModelFilePort, 'getModelDownload'>,
  entries: DownloadEntries,
  error: unknown,
): void {
  let transfer: NativeModelTransfer | null = null;
  try {
    transfer = native.getModelDownload(entry.model.id);
  } catch {
    transfer = null;
  }
  if (transfer?.state === 'running') {
    entry.job = 'transferring';
    entries.publish(entry, { error: errorMessage(error) });
    return;
  }
  entry.job = null;
  const resting = transfer
    ? restingPatch(entry.model, transfer, null, true)
    : { ...RESET_PROGRESS, phase: 'error' as const };
  entries.publish(entry, { ...resting, error: errorMessage(error) });
}
