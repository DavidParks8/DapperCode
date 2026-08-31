import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const e2eRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const repoRoot = path.dirname(e2eRoot);
