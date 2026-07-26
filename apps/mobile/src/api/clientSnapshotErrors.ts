export class StaleSnapshotRevisionError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly receivedRevision: number,
  ) {
    super(
      `snapshot revision changed from ${String(expectedRevision)} to ${String(receivedRevision)}`,
    );
    this.name = 'StaleSnapshotRevisionError';
  }
}
