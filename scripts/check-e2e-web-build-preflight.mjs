import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Guards against the "Fixture "site" timeout of 60000ms exceeded during setup" cold-build race
 * (GitHub Actions job 99960912845, run 33539193818): the Expo web bundle must be built once,
 * unbounded, in e2e/globalSetup.ts before Playwright forks any worker. If that pre-build call ever
 * disappears -- or is reintroduced without an `await` -- the "site" worker fixture goes back to
 * racing a cold `expo export` against its own per-test timeout, and CI intermittently fails again.
 *
 * The check isolates the exact statement list of the exported `globalSetup` function by counting
 * brace depth from its opening `{`, rather than matching greedily to the end of the file. Matching
 * greedily would report success for an `await ensureWebBuild()` call that lives in a comment, a
 * dead branch, or an unrelated function declared later in the same file, even though `globalSetup`
 * itself never builds the web bundle -- which is exactly the silent regression this guard exists to
 * catch. Comments are stripped before any of this so a call mentioned only in prose cannot satisfy
 * the check either; string literal *contents* are only blanked out for brace counting, and only
 * after comments are gone, so the import's own module-specifier string survives for the import check.
 *
 * Usage: node scripts/check-e2e-web-build-preflight.mjs [repoRoot]
 */

const root = path.resolve(process.argv[2] ?? process.cwd());
const globalSetupPath = path.join(root, 'e2e', 'globalSetup.ts');

let source;
try {
  source = readFileSync(globalSetupPath, 'utf8');
} catch (error) {
  throw new Error(`could not read ${globalSetupPath}: ${error.message}`);
}

/**
 * Removes `//` and `/* *\/` comments while leaving every other character, including string and
 * template literal contents, at its original position (comments are blanked with spaces rather
 * than deleted so downstream indices still line up with `source`).
 */
function stripComments(text) {
  let output = '';
  let index = 0;
  let inString = null;
  while (index < text.length) {
    if (inString) {
      const character = text[index];
      if (character === '\\' && index + 1 < text.length) {
        output += text.slice(index, index + 2);
        index += 2;
        continue;
      }
      output += character;
      index += 1;
      if (character === inString) {
        inString = null;
      }
      continue;
    }
    const character = text[index];
    if (character === '"' || character === "'" || character === '`') {
      inString = character;
      output += character;
      index += 1;
      continue;
    }
    const twoChars = text.slice(index, index + 2);
    if (twoChars === '//') {
      const lineEnd = text.indexOf('\n', index);
      const end = lineEnd === -1 ? text.length : lineEnd;
      output += ' '.repeat(end - index);
      index = end;
      continue;
    }
    if (twoChars === '/*') {
      const blockEnd = text.indexOf('*/', index + 2);
      const end = blockEnd === -1 ? text.length : blockEnd + 2;
      output += text.slice(index, end).replace(/[^\n]/g, ' ');
      index = end;
      continue;
    }
    output += character;
    index += 1;
  }
  return output;
}

/**
 * Blanks out string and template literal *contents* (keeping the quote characters and overall
 * length) so brace counting cannot be thrown off by a `{` or `}` that only appears inside a string.
 * Must run after `stripComments`, since it does not itself understand comments.
 */
function blankStringContents(text) {
  let output = '';
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '"' || character === "'" || character === '`') {
      output += character;
      let cursor = index + 1;
      while (cursor < text.length && text[cursor] !== character) {
        const escaped = text[cursor] === '\\';
        output += escaped ? '  ' : text[cursor] === '\n' ? '\n' : ' ';
        cursor += escaped ? 2 : 1;
      }
      if (cursor < text.length) {
        output += text[cursor];
        cursor += 1;
      }
      index = cursor;
      continue;
    }
    output += character;
    index += 1;
  }
  return output;
}

/** Extracts the statement list of a function whose signature ends at `openBraceIndex`. */
function extractBalancedBody(braceSafeText, openBraceIndex) {
  let depth = 0;
  for (let cursor = openBraceIndex; cursor < braceSafeText.length; cursor += 1) {
    if (braceSafeText[cursor] === '{') {
      depth += 1;
    } else if (braceSafeText[cursor] === '}') {
      depth -= 1;
      if (depth === 0) {
        return cursor;
      }
    }
  }
  return -1;
}

const codeNoComments = stripComments(source);

const importsEnsureWebBuild =
  /import\s*\{[^}]*\bensureWebBuild\b[^}]*\}\s*from\s*[^;]*webBuild(?:\.ts)?/.test(codeNoComments);
if (!importsEnsureWebBuild) {
  throw new Error(
    `${globalSetupPath} must import ensureWebBuild from the web build harness so the Expo bundle ` +
      'builds once before Playwright forks workers, instead of racing a per-test fixture timeout.',
  );
}

const braceSafe = blankStringContents(codeNoComments);
const signatureMatch = braceSafe.match(
  /export\s+default\s+async\s+function\s+globalSetup\s*\([^)]*\)[^{]*\{/,
);
if (!signatureMatch) {
  throw new Error(
    `${globalSetupPath} must export an async default globalSetup function so its pre-build step ` +
      'can be awaited before Playwright forks workers.',
  );
}
const openBraceIndex = signatureMatch.index + signatureMatch[0].length - 1;
const closeBraceIndex = extractBalancedBody(braceSafe, openBraceIndex);
if (closeBraceIndex === -1) {
  throw new Error(`${globalSetupPath}'s globalSetup() function body has an unbalanced brace.`);
}
// Sliced from codeNoComments, not braceSafe, so a legitimately awaited call is still visible even
// though the string-blanking pass ran on a copy used only to find these indices.
const body = codeNoComments.slice(openBraceIndex + 1, closeBraceIndex);

if (!/await\s+ensureWebBuild\s*\(/.test(body)) {
  throw new Error(
    `${globalSetupPath}'s globalSetup() must \`await ensureWebBuild()\` directly in its own ` +
      'executed body -- not merely import it, reference it from another function, or mention it ' +
      'in a comment. Anything less reintroduces the cold-build race the "site" fixture used to ' +
      'lose.',
  );
}

process.stdout.write(
  'e2e/globalSetup.ts awaits ensureWebBuild() before Playwright forks workers.\n',
);
