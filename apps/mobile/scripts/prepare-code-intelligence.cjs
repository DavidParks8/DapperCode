const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const compiler = require.resolve('typescript', { paths: [root] });
const libraries = {};
function includeLibrary(name) {
  if (Object.hasOwn(libraries, name)) return;
  const content = readFileSync(path.join(path.dirname(compiler), name), 'utf8');
  libraries[name] = content;
  for (const match of content.matchAll(/<reference lib="([^"]+)"/gu)) {
    includeLibrary(`lib.${match[1]}.d.ts`);
  }
}
includeLibrary('lib.es2022.d.ts');

// Remove the optional Node host at build time: even unreachable dynamic requires are rejected by
// Metro. Use the compiler's AST, fail on upstream layout changes, and never modify vendor files.
const compilerSource = readFileSync(compiler, 'utf8');
const parsed = ts.createSourceFile(
  'typescript.js',
  compilerSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const nodeHosts = [];
function findNodeHost(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'getNodeSystem') {
    nodeHosts.push(node.body);
  }
  ts.forEachChild(node, findNodeHost);
}
findNodeHost(parsed);
if (nodeHosts.length !== 1 || !nodeHosts[0]) {
  throw new Error('Review the TypeScript browser adapter for this compiler version.');
}
const host = nodeHosts[0];
const browserSource =
  compilerSource.slice(0, host.getStart(parsed)) +
  '{ throw new Error("The Node compiler host is unavailable on device."); }' +
  compilerSource.slice(host.end);

void build({
  stdin: {
    contents: `import ts from "typescript"; export default ts; export const libraries = ${JSON.stringify(libraries)};`,
    resolveDir: root,
    sourcefile: 'local-typescript-browser.js',
  },
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  define: { process: 'undefined' },
  plugins: [
    {
      name: 'typescript-memory-only',
      setup(builder) {
        builder.onLoad({ filter: /[/\\]typescript[/\\]lib[/\\]typescript\.js$/ }, () => ({
          contents: browserSource,
          loader: 'js',
          resolveDir: path.dirname(compiler),
        }));
      },
    },
  ],
  minify: true,
  legalComments: 'inline',
  metafile: true,
  write: false,
})
  .then((result) => {
    if (Object.values(result.metafile.outputs).some((output) => output.imports.length !== 0)) {
      throw new Error('The local compiler must be a self-contained browser bundle.');
    }
    const destination = path.join(
      root,
      'src/features/on-device/code-intelligence/generated/compiler.js',
    );
    mkdirSync(path.dirname(destination), { recursive: true });
    const output = result.outputFiles[0].text;
    let previous;
    try {
      previous = readFileSync(destination, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (previous !== output) writeFileSync(destination, output);
    console.log(`Prepared local TypeScript browser runtime (${Buffer.byteLength(output)} bytes).`);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
