import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.dirname(fs.realpathSync(process.argv[2]));
const { main } = await import(pathToFileURL(path.join(root, 'build/lib/main.js')));
const server = await main({ address: '127.0.0.1', port: 0, logNoColors: true, logLevel: 'error' });
console.log(`NATIVE_APPIUM_PORT=${server.address().port}`);
