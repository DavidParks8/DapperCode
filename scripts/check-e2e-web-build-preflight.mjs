import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * Guards against the "Fixture "site" timeout of 60000ms exceeded during setup" cold-build race
 * (GitHub Actions job 99960912845, run 33539193818): the Expo web bundle must be built once,
 * unbounded, in e2e/globalSetup.ts before Playwright forks any worker. If that pre-build call ever
 * disappears -- or is reintroduced without an `await` -- the "site" worker fixture goes back to
 * racing a cold `expo export` against its own per-test timeout, and CI intermittently fails again.
 *
 * Inspect the parsed import and globalSetup's own statements, not source-text matches that could
 * instead come from comments, literals, conditional branches, or an unrelated function.
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

const parsed = ts.createSourceFile(globalSetupPath, source, ts.ScriptTarget.Latest, true);
const importsEnsureWebBuild = parsed.statements.some((statement) => {
  if (
    !ts.isImportDeclaration(statement) ||
    !ts.isStringLiteral(statement.moduleSpecifier) ||
    !['./harness/webBuild', './harness/webBuild.ts'].includes(statement.moduleSpecifier.text) ||
    statement.importClause?.isTypeOnly
  ) {
    return false;
  }
  const bindings = statement.importClause?.namedBindings;
  return (
    bindings &&
    ts.isNamedImports(bindings) &&
    bindings.elements.some(
      (binding) =>
        !binding.isTypeOnly &&
        binding.name.text === 'ensureWebBuild' &&
        (binding.propertyName ?? binding.name).text === 'ensureWebBuild',
    )
  );
});
if (!importsEnsureWebBuild) {
  throw new Error(
    `${globalSetupPath} must import ensureWebBuild from the web build harness so the Expo bundle ` +
      'builds once before Playwright forks workers, instead of racing a per-test fixture timeout.',
  );
}

const setup = parsed.statements.find(
  (statement) =>
    ts.isFunctionDeclaration(statement) &&
    statement.name?.text === 'globalSetup' &&
    !statement.asteriskToken &&
    [ts.SyntaxKind.ExportKeyword, ts.SyntaxKind.DefaultKeyword, ts.SyntaxKind.AsyncKeyword].every(
      (kind) => statement.modifiers?.some((modifier) => modifier.kind === kind),
    ),
);
if (!setup?.body) {
  throw new Error(
    `${globalSetupPath} must export an async default globalSetup function so its pre-build step ` +
      'can be awaited before Playwright forks workers.',
  );
}
if (parsed.parseDiagnostics.some((diagnostic) => diagnostic.messageText === "'}' expected.")) {
  throw new Error(`${globalSetupPath}'s globalSetup() function body has an unbalanced brace.`);
}
if (parsed.parseDiagnostics.length > 0) {
  throw new Error(
    `${globalSetupPath} contains invalid TypeScript: ${ts.flattenDiagnosticMessageText(parsed.parseDiagnostics[0].messageText, '\n')}`,
  );
}

const awaitsEnsureWebBuild = setup.body.statements.some(
  (statement) =>
    ts.isExpressionStatement(statement) &&
    ts.isAwaitExpression(statement.expression) &&
    ts.isCallExpression(statement.expression.expression) &&
    !statement.expression.expression.questionDotToken &&
    ts.isIdentifier(statement.expression.expression.expression) &&
    statement.expression.expression.expression.text === 'ensureWebBuild',
);
if (!awaitsEnsureWebBuild) {
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
