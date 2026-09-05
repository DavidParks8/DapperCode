import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const sourcePath = path.resolve(
  import.meta.dirname,
  '../../apps/mobile/modules/composer-paste/ios/ComposerPasteModule.swift',
);

test('ComposerPasteView uses explicit self for recursive Swift closure capture', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /compactMap\s*\{\s*self\.findTextView\(in: \$0\)\s*\}/);
});
