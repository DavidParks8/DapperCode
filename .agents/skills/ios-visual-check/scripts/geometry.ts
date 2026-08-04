#!/usr/bin/env node

type Options = {
  all: boolean;
  match?: RegExp;
  maxY?: number;
  minY?: number;
};

type GeometryRow = {
  bottom: number;
  height: number;
  label: string;
  left: number;
  right: number;
  top: number;
  type: string;
  width: number;
};

function printUsage(): void {
  console.error(
    'Usage: geometry.ts [--min-y N] [--max-y N] [--match REGEX] [--all]\n' +
      'Reads Appium XCUITest source JSON or raw XML from stdin.',
  );
}

function parseNumber(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${flag} requires a number`);
  }
  return parsed;
}

function parseOptions(args: string[]): Options {
  const options: Options = { all: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case '--all':
        options.all = true;
        break;
      case '--match':
        options.match = new RegExp(args[(index += 1)] ?? '', 'i');
        break;
      case '--max-y':
        options.maxY = parseNumber(args[(index += 1)], '--max-y');
        break;
      case '--min-y':
        options.minY = parseNumber(args[(index += 1)], '--min-y');
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function readSource(raw: string): string {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('{')) {
    return raw;
  }
  const envelope = JSON.parse(raw) as { value?: unknown };
  if (typeof envelope.value !== 'string') {
    throw new Error('Appium source response did not contain a string value');
  }
  return envelope.value;
}

function parseRows(source: string, options: Options): GeometryRow[] {
  const rows: GeometryRow[] = [];
  const elementPattern = /<XCUIElementType(\w+)([^>]*)>/g;
  const attributePattern = /(\w+)="([^"]*)"/g;

  for (const element of source.matchAll(elementPattern)) {
    const attributes = new Map<string, string>();
    for (const attribute of element[2].matchAll(attributePattern)) {
      attributes.set(attribute[1], decodeXmlEntities(attribute[2]));
    }

    const left = Number(attributes.get('x'));
    const top = Number(attributes.get('y'));
    const width = Number(attributes.get('width'));
    const height = Number(attributes.get('height'));
    if (![left, top, width, height].every(Number.isFinite)) {
      continue;
    }
    if (options.minY !== undefined && top < options.minY) {
      continue;
    }
    if (options.maxY !== undefined && top > options.maxY) {
      continue;
    }

    const label = (attributes.get('label') ?? attributes.get('name') ?? '').trim();
    if (!label && !options.all) {
      continue;
    }
    if (options.match && !options.match.test(label)) {
      continue;
    }

    rows.push({
      bottom: top + height,
      height,
      label,
      left,
      right: left + width,
      top,
      type: element[1],
      width,
    });
  }
  return rows;
}

function pad(value: string | number, length: number): string {
  return String(value).padStart(length);
}

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  const chunks: Buffer[] = [];
  process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
  process.stdin.on('end', () => {
    const source = readSource(Buffer.concat(chunks).toString('utf8'));
    const rows = parseRows(source, options).sort(
      (left, right) => left.top - right.top || left.left - right.left,
    );
    const seen = new Set<string>();
    let count = 0;

    for (const row of rows) {
      const key = [
        row.left,
        row.top,
        row.width,
        row.height,
        row.label,
      ].join(':');
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      count += 1;
      console.log(
        `${row.type.padEnd(12)} ${row.label.slice(0, 40).padEnd(40)} ` +
          `x=${pad(row.left, 4)} y=${pad(row.top, 4)} ` +
          `w=${pad(row.width, 4)} h=${pad(row.height, 4)} ` +
          `right=${pad(row.right, 4)} bottom=${pad(row.bottom, 4)}`,
      );
    }

    if (count === 0) {
      console.error('no elements matched');
      process.exitCode = 1;
    }
  });
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  printUsage();
  process.exitCode = 1;
}
