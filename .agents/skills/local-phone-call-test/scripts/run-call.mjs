#!/usr/bin/env node
// Repeatable, deterministic, fully isolated local phone-call test runner.
// Starts an isolated dappercode-bridge + transparent SIP/RTP recorder + baresip
// softphone, triggers an open-ended conversation call via a deterministic ACP driver,
// auto-approves the local test call, streams live status/transcript to the terminal,
// and saves synchronized audio WAVs plus structured transcript/report artifacts.

import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import {
  buildCallReportBundle,
  extractTranscriptFromCardMarkdown,
  writeCallArtifacts,
} from './report.mjs';
import { startSipRecorder } from './sip-recorder.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../../../..');
const ACP_DRIVER_PATH = path.join(SCRIPT_DIR, 'acp-call-driver.mjs');

export const DEFAULT_OBJECTIVE =
  'Have a natural, open-ended phone conversation with the user about whatever topic they want to talk about. Listen carefully, respond concisely and naturally like a real person on a phone call, and keep the conversation going until they say they are ready to wrap up.';
export const DEFAULT_FIRST_MESSAGE =
  "Hi! We can talk about whatever you want today — what's on your mind?";
export const DEFAULT_CALLEE_NAME = 'User';
export const DEFAULT_PHONE_NUMBER = '+15550000002';
export const DEFAULT_CALLER_ID = '+15550000001';

const DEFAULT_VOICE_BASE_URL = 'http://127.0.0.1:8000/v1';
const DEFAULT_STT_MODEL = 'LiquidAI/LFM3-Audio-2B-GGUF:Q8_0';
export const DEFAULT_LLM_MODEL = 'LiquidAI/LFM3-Audio-2B-GGUF:Q8_0';
const DEFAULT_TTS_MODEL = 'LiquidAI/LFM3-Audio-2B-GGUF:Q8_0';
const DEFAULT_TTS_VOICE = 'female';
const LLAMA_REALTIME_STARTUP_TIMEOUT_MS = 300_000;

export function parseArgs(argv) {
  const opts = {
    out: null,
    objective: DEFAULT_OBJECTIVE,
    firstMessage: DEFAULT_FIRST_MESSAGE,
    calleeName: DEFAULT_CALLEE_NAME,
    context: null,
    phoneNumber: DEFAULT_PHONE_NUMBER,
    callerId: DEFAULT_CALLER_ID,
    displayName: null,
    sttBaseUrl: null,
    sttModel: null,
    llmBaseUrl: null,
    llmModel: null,
    ttsBaseUrl: null,
    ttsModel: null,
    ttsVoice: null,
    useSavedVoice: false,
    startLlamaServer: true,
    answerDelay: 1,
    maxDurationSec: 900,
    noInteractive: false,
    bridgeBin: null,
    build: false,
    sipUpstreamPort: null,
    sipPassword: null,
    help: false,
  };

  const valueFlags = new Map([
    ['--out', 'out'],
    ['--objective', 'objective'],
    ['--first-message', 'firstMessage'],
    ['--callee-name', 'calleeName'],
    ['--context', 'context'],
    ['--phone-number', 'phoneNumber'],
    ['--caller-id', 'callerId'],
    ['--display-name', 'displayName'],
    ['--stt-base-url', 'sttBaseUrl'],
    ['--stt-model', 'sttModel'],
    ['--llm-base-url', 'llmBaseUrl'],
    ['--llm-model', 'llmModel'],
    ['--tts-base-url', 'ttsBaseUrl'],
    ['--tts-model', 'ttsModel'],
    ['--tts-voice', 'ttsVoice'],
    ['--bridge-bin', 'bridgeBin'],
    ['--sip-password', 'sipPassword'],
  ]);

  const numericFlags = new Map([
    ['--answer-delay', 'answerDelay'],
    ['--max-duration', 'maxDurationSec'],
    ['--sip-upstream-port', 'sipUpstreamPort'],
  ]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--no-interactive') {
      opts.noInteractive = true;
    } else if (arg === '--build') {
      opts.build = true;
    } else if (arg === '--use-saved-voice') {
      opts.useSavedVoice = true;
    } else if (arg === '--no-start-llama') {
      opts.startLlamaServer = false;
    } else if (valueFlags.has(arg)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      opts[valueFlags.get(arg)] = value;
    } else if (numericFlags.has(arg)) {
      const raw = argv[++i];
      if (raw === undefined) throw new Error(`${arg} requires a numeric value`);
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`${arg} must be a non-negative number (got "${raw}")`);
      }
      opts[numericFlags.get(arg)] = parsed;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`Usage: node .agents/skills/local-phone-call-test/scripts/run-call.mjs [options]

Starts a deterministic, isolated local SIP phone call with the AI ("talk about
whatever you want" by default), auto-starts an isolated local llama.cpp
LFM3-Audio-2B realtime server when needed, records synchronized audio WAVs
(mixed, stereo, ai, user), and saves the full structured transcript + report.

Options:
  --out <dir>              Output directory for recordings & transcript
                           (default: /tmp/dappercode-phone-tests/call-<timestamp>)
  --objective <text>       Call objective passed to start_phone_call
  --first-message <text>   Opening spoken guidance passed to start_phone_call
  --callee-name <name>     Callee display name (default: "${DEFAULT_CALLEE_NAME}")
  --context <text>         Optional background context for the call
  --display-name <name>    User display name (default: desktop config or "Local Tester")
  --use-saved-voice        Read STT/LLM/TTS URLs, models, and voice from desktop config.json
                           instead of using the default LFM3-Audio-2B realtime profile
  --no-start-llama         Do not auto-start llama serve (use an already-running server)
  --stt-base-url <url>     Override STT OpenAI-compatible loopback URL
  --stt-model <model>      Override STT model ID
  --llm-base-url <url>     Override LLM OpenAI-compatible loopback URL
  --llm-model <model>      Override LLM model ID
  --tts-base-url <url>     Override TTS OpenAI-compatible loopback URL
  --tts-model <model>      Override TTS model ID
  --tts-voice <voice>      Override TTS voice name
  --answer-delay <sec>     baresip auto-answer delay in seconds (default: 1)
  --max-duration <sec>     Maximum call duration before automatic hang-up (default: 900)
  --no-interactive         Disable stdin steer/hangup prompt
  --bridge-bin <path>      Explicit path to dappercode-bridge binary
  --build                  Build release dappercode-bridge if binary is missing
  --sip-upstream-port <p>  Skip spawning baresip and proxy SIP to an existing local UDP port
  -h, --help               Show this help text

During an active call (interactive mode):
  <any text> + Enter       Send a private live steer instruction to the AI
  /hangup  (or Ctrl+C)     Hang up cleanly and finalize audio + transcript artifacts
`);
}

function desktopConfigPath() {
  if (process.env.DAPPERCODE_DATA_DIR) {
    return path.join(process.env.DAPPERCODE_DATA_DIR, 'config.json');
  }
  if (process.platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'dev.dappercode.desktop',
      'config.json',
    );
  }
  const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdg, 'dev.dappercode.desktop', 'config.json');
}

export function loadSavedVoiceDefaults(configFile = desktopConfigPath()) {
  try {
    if (!fs.existsSync(configFile)) return null;
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    return parsed?.phoneCall || null;
  } catch {
    return null;
  }
}

export function resolveVoiceConfig(opts, saved = loadSavedVoiceDefaults()) {
  const savedVoice = opts.useSavedVoice ? saved : null;
  return {
    displayName: opts.displayName || saved?.userDisplayName || 'Local Tester',
    sttBaseUrl: opts.sttBaseUrl || savedVoice?.sttBaseUrl || DEFAULT_VOICE_BASE_URL,
    sttModel: opts.sttModel || savedVoice?.sttModel || DEFAULT_STT_MODEL,
    llmBaseUrl: opts.llmBaseUrl || savedVoice?.llmBaseUrl || DEFAULT_VOICE_BASE_URL,
    llmModel: opts.llmModel || savedVoice?.llmModel || DEFAULT_LLM_MODEL,
    ttsBaseUrl: opts.ttsBaseUrl || savedVoice?.ttsBaseUrl || DEFAULT_VOICE_BASE_URL,
    ttsModel: opts.ttsModel || savedVoice?.ttsModel || DEFAULT_TTS_MODEL,
    ttsVoice: opts.ttsVoice || savedVoice?.ttsVoice || DEFAULT_TTS_VOICE,
  };
}

function findBridgeBinary(explicitPath, allowBuild) {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`--bridge-bin does not exist: ${resolved}`);
    }
    return resolved;
  }

  const candidates = [];
  try {
    const targetDir = execFileSync(
      process.execPath,
      [path.join(REPO_ROOT, 'scripts/run-cargo.mjs'), '--print-target-dir'],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (targetDir) {
      candidates.push(path.join(targetDir, 'release', 'dappercode-bridge'));
      candidates.push(path.join(targetDir, 'debug', 'dappercode-bridge'));
    }
  } catch {
    // Fall back to standard target directories below.
  }

  candidates.push(path.join(REPO_ROOT, 'services/rust-bridge/target/release/dappercode-bridge'));
  candidates.push(path.join(REPO_ROOT, 'services/rust-bridge/target/debug/dappercode-bridge'));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  if (allowBuild) {
    console.log('[test-call] Building release dappercode-bridge...');
    execFileSync(
      'pnpm',
      [
        'run',
        'cargo',
        'build',
        '--locked',
        '--release',
        '--manifest-path',
        'services/rust-bridge/Cargo.toml',
      ],
      { cwd: REPO_ROOT, stdio: 'inherit' },
    );
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  throw new Error(
    'dappercode-bridge binary not found. Build it once with:\n' +
      '  pnpm run cargo build --locked --release --manifest-path services/rust-bridge/Cargo.toml\n' +
      'or rerun with --build.',
  );
}

function getFreeTcpPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return `sha256:${hash.digest('hex')}`;
}

function getGitInfo() {
  try {
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return { commit, branch };
  } catch {
    return { commit: null, branch: null };
  }
}

function formatRunStamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

function isLoopbackHost(hostname) {
  const cleaned = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return cleaned === '127.0.0.1' || cleaned === 'localhost' || cleaned === '::1';
}

function isLfm3RealtimeModel(model) {
  return typeof model === 'string' && /lfm3[-_]audio/i.test(model.trim());
}

export function planLlamaRealtimeManagement(voice, opts) {
  if (!opts.startLlamaServer) {
    return { manage: false, targetBaseUrl: null, model: null, explicitTargetUrl: false };
  }
  if (!isLfm3RealtimeModel(voice.llmModel)) {
    return { manage: false, targetBaseUrl: null, model: null, explicitTargetUrl: false };
  }
  const targetBaseUrl = normalizeBaseUrl(voice.llmBaseUrl);
  try {
    const parsed = new URL(targetBaseUrl);
    if (!isLoopbackHost(parsed.hostname)) {
      return { manage: false, targetBaseUrl: null, model: null, explicitTargetUrl: false };
    }
  } catch {
    return { manage: false, targetBaseUrl: null, model: null, explicitTargetUrl: false };
  }
  return {
    manage: true,
    targetBaseUrl,
    model: voice.llmModel.trim(),
    explicitTargetUrl: Boolean(opts.llmBaseUrl || opts.sttBaseUrl || opts.ttsBaseUrl),
  };
}

async function probeModelsEndpoint(baseUrl, fetchImpl = fetch, timeoutMs = 2500) {
  const probeUrl = `${normalizeBaseUrl(baseUrl)}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(probeUrl, { signal: controller.signal });
    return res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function resolveExecutableOnPath(name) {
  try {
    const found = execFileSync('which', [name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return found || null;
  } catch {
    return null;
  }
}

async function waitForLlamaServerReady(baseUrl, timeoutMs, child, logPath, fetchImpl = fetch) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`llama serve exited early with code ${child.exitCode} (inspect ${logPath})`);
    }
    if (await probeModelsEndpoint(baseUrl, fetchImpl, 2000)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for llama serve at ${baseUrl} (inspect ${logPath})`);
}

function findLlamaExecutable() {
  return (
    resolveExecutableOnPath('llama') ||
    resolveExecutableOnPath('llama-server') ||
    (fs.existsSync('/opt/homebrew/bin/llama') ? '/opt/homebrew/bin/llama' : null)
  );
}

export async function ensureLlamaRealtimeServer({
  voice,
  opts,
  outDir,
  appendEvent = () => {},
  fetchImpl = fetch,
  resolveLlama = findLlamaExecutable,
  spawnImpl = spawn,
  getPort = getFreeTcpPort,
}) {
  const plan = planLlamaRealtimeManagement(voice, opts);
  if (!plan.manage) {
    return { child: null, baseUrl: null, reused: false, logPath: null };
  }

  if (await probeModelsEndpoint(plan.targetBaseUrl, fetchImpl)) {
    console.log(`[test-call] Reusing running LFM3-Audio server at ${plan.targetBaseUrl}`);
    appendEvent({ type: 'llama_realtime.reused', baseUrl: plan.targetBaseUrl, model: plan.model });
    return { child: null, baseUrl: plan.targetBaseUrl, reused: true, logPath: null };
  }

  const llamaBin = resolveLlama();
  if (!llamaBin) {
    throw new Error(
      'llama.cpp (`llama` / `llama-server` v0.8.0+) is required for LFM3-Audio realtime calls. ' +
        'Install with: brew install llama.cpp',
    );
  }

  const parsedTarget = new URL(plan.targetBaseUrl);
  const host = parsedTarget.hostname === 'localhost' ? '127.0.0.1' : parsedTarget.hostname;
  const port = plan.explicitTargetUrl
    ? Number(parsedTarget.port || (parsedTarget.protocol === 'https:' ? 443 : 80))
    : await getPort();
  const basePath = parsedTarget.pathname.replace(/\/+$/, '') || '/v1';
  const managedBaseUrl = `http://${host}:${port}${basePath}`;
  const logPath = path.join(outDir, 'llama-server.log');

  const isSubcommandCli = path.basename(llamaBin) === 'llama';
  const args = [
    ...(isSubcommandCli ? ['serve'] : []),
    '-hf',
    plan.model,
    '--host',
    host,
    '--port',
    String(port),
    '--temp',
    '0',
    '-np',
    '2',
  ];

  console.log(
    `[test-call] Starting managed llama.cpp LFM3-Audio server (${plan.model}) on http://${host}:${port} ...`,
  );
  const logFd = fs.openSync(logPath, 'a');
  const child = spawnImpl(llamaBin, args, {
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);

  try {
    await waitForLlamaServerReady(
      managedBaseUrl,
      LLAMA_REALTIME_STARTUP_TIMEOUT_MS,
      child,
      logPath,
      fetchImpl,
    );
    appendEvent({
      type: 'llama_realtime.ready',
      baseUrl: managedBaseUrl,
      port,
      model: plan.model,
      logPath,
    });
  } catch (error) {
    await terminateProcess(child);
    throw error;
  }

  if (normalizeBaseUrl(voice.sttBaseUrl) === plan.targetBaseUrl) voice.sttBaseUrl = managedBaseUrl;
  if (normalizeBaseUrl(voice.llmBaseUrl) === plan.targetBaseUrl) voice.llmBaseUrl = managedBaseUrl;
  if (normalizeBaseUrl(voice.ttsBaseUrl) === plan.targetBaseUrl) voice.ttsBaseUrl = managedBaseUrl;
  return { child, baseUrl: managedBaseUrl, reused: false, logPath };
}

export async function checkVoiceEndpointsReachable(voice, fetchImpl = fetch) {
  const urls = [...new Set([voice.sttBaseUrl, voice.llmBaseUrl, voice.ttsBaseUrl])];
  for (const baseUrl of urls) {
    const normalized = normalizeBaseUrl(baseUrl);
    const probeUrl = `${normalized}/models`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetchImpl(probeUrl, { signal: controller.signal });
      clearTimeout(timer);
      if (res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (error) {
      const hint =
        normalized === DEFAULT_VOICE_BASE_URL
          ? `Start the local LFM3-Audio server first: llama serve -hf ${DEFAULT_LLM_MODEL} --host 127.0.0.1 --port 8000 --temp 0 -np 2 (or omit --no-start-llama to auto-start it).`
          : 'Start your local voice server first.';
      throw new Error(
        `Local voice endpoint ${baseUrl} is not reachable (${error instanceof Error ? error.message : String(error)}). ${hint}`,
      );
    }
  }
}

function findBaresipModulePath() {
  const candidates = [
    '/opt/homebrew/opt/baresip/lib/baresip/modules',
    '/usr/local/opt/baresip/lib/baresip/modules',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
  }
  const cellarBase = '/opt/homebrew/Cellar/baresip';
  if (fs.existsSync(cellarBase)) {
    const versions = fs.readdirSync(cellarBase).sort().reverse();
    for (const version of versions) {
      const modDir = path.join(cellarBase, version, 'lib/baresip/modules');
      if (fs.existsSync(modDir)) return modDir;
    }
  }
  return null;
}

function prepareIsolatedBaresipConfig(baresipDir, sipPort, sipPassword, answerDelay) {
  fs.mkdirSync(baresipDir, { recursive: true, mode: 0o700 });
  const userConfig = path.join(os.homedir(), '.baresip', 'config');
  let configText;
  if (fs.existsSync(userConfig)) {
    configText = fs.readFileSync(userConfig, 'utf8');
    configText = configText.replace(/^sip_listen\s+.+$/m, `sip_listen\t\t127.0.0.1:${sipPort}`);
    // Avoid port conflicts with any other running baresip instance.
    configText = configText.replace(/^(cons_listen|http_listen|ctrl_tcp_listen)\s+/gm, '#$1 ');
    configText = configText.replace(/^module\s+stdio\.so\s*$/gm, '#module\t\t\tstdio.so');
  } else {
    const modulePath = findBaresipModulePath();
    if (!modulePath) {
      throw new Error(
        'Could not locate baresip modules directory. Install baresip via `brew install baresip`.',
      );
    }
    configText = [
      `sip_listen\t\t127.0.0.1:${sipPort}`,
      'sip_transports\t\tudp',
      'call_local_timeout\t120',
      'call_max_calls\t\t1',
      'audio_player\t\tcoreaudio,default',
      'audio_source\t\tcoreaudio,default',
      'audio_alert\t\tcoreaudio,default',
      'audio_level\t\tno',
      'ausrc_format\t\ts16',
      'auplay_format\t\ts16',
      'auenc_format\t\ts16',
      'audec_format\t\ts16',
      'audio_buffer\t\t20-160',
      'audio_telev_pt\t\t101',
      'net_interface\t\t127.0.0.1',
      `module_path\t\t${modulePath}`,
      'module\t\t\tg711.so',
      'module\t\t\tauconv.so',
      'module\t\t\tauresamp.so',
      'module\t\t\tcoreaudio.so',
      'module\t\t\tuuid.so',
      'module_app\t\taccount.so',
      'module_app\t\tmenu.so',
      '',
    ].join('\n');
  }

  fs.writeFileSync(path.join(baresipDir, 'config'), configText, { mode: 0o600 });
  const accountLine = `"Local Test Callee" <sip:local@127.0.0.1>;regint=0;catchall=yes;uas_user=local;uas_pass=${sipPassword};answermode=auto;answerdelay=${answerDelay}\n`;
  fs.writeFileSync(path.join(baresipDir, 'accounts'), accountLine, { mode: 0o600 });
  fs.writeFileSync(path.join(baresipDir, 'contacts'), '', { mode: 0o600 });
  fs.writeFileSync(path.join(baresipDir, 'uuid'), `${crypto.randomUUID()}\n`, { mode: 0o600 });
}

function waitForLogPattern(logPath, pattern, timeoutMs, child) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (child.exitCode !== null) {
        clearInterval(timer);
        reject(new Error(`Process exited early with code ${child.exitCode} (inspect ${logPath})`));
        return;
      }
      if (fs.existsSync(logPath)) {
        const text = fs.readFileSync(logPath, 'utf8');
        if (pattern.test(text)) {
          clearInterval(timer);
          resolve();
          return;
        }
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for readiness pattern in ${logPath}`));
      }
    }, 100);
  });
}

async function waitForHttpHealth(url, authToken, timeoutMs, child, logPath) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(
        `dappercode-bridge exited early with code ${child.exitCode} (inspect ${logPath})`,
      );
    }
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) return;
    } catch {
      // Retry until ready.
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for dappercode-bridge health at ${url}`);
}

async function terminateProcess(child, timeoutMs = 4000) {
  if (!child || child.exitCode !== null) return;
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!exited && child.exitCode === null) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Ignore.
    }
  }
}

function readKvValue(surface, label) {
  const blocks = Array.isArray(surface?.blocks) ? surface.blocks : [];
  for (const block of blocks) {
    if (block?.type === 'keyValue' && Array.isArray(block.items)) {
      const item = block.items.find(
        (entry) =>
          typeof entry?.label === 'string' && entry.label.toLowerCase() === label.toLowerCase(),
      );
      if (item && typeof item.value === 'string') return item.value;
    }
  }
  return null;
}

function readMarkdownBlock(surface) {
  const blocks = Array.isArray(surface?.blocks) ? surface.blocks : [];
  const md = blocks.find(
    (block) => block?.type === 'markdown' && typeof block.markdown === 'string',
  );
  return md ? md.markdown : null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const startedAt = new Date();
  const startedAtMs = Date.now();
  const runId = `call-${formatRunStamp(startedAt)}-${crypto.randomBytes(2).toString('hex')}`;
  const outDir = path.resolve(opts.out || path.join('/tmp', 'dappercode-phone-tests', runId));
  fs.mkdirSync(outDir, { recursive: true });

  const voice = resolveVoiceConfig(opts);
  const bridgeBin = findBridgeBinary(opts.bridgeBin, opts.build);
  const git = getGitInfo();

  if (!opts.sipUpstreamPort) {
    try {
      execFileSync('which', ['baresip'], { stdio: 'ignore' });
    } catch {
      throw new Error(
        'baresip is required for local SIP audio. Install with: brew install baresip',
      );
    }
  }

  const tempRuntimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dappercode-call-test-'));
  const workDir = path.join(tempRuntimeDir, 'workspace');
  fs.mkdirSync(workDir, { recursive: true });

  const bridgePort = await getFreeTcpPort();
  const previewPort = await getFreeTcpPort();
  const sipPassword = opts.sipPassword || crypto.randomBytes(18).toString('hex');
  const bridgeAuthToken = crypto.randomBytes(24).toString('hex');

  const controlPath = path.join(tempRuntimeDir, 'control.ndjson');
  const driverReportPath = path.join(tempRuntimeDir, 'call-report.json');
  const specPath = path.join(tempRuntimeDir, 'call-spec.json');
  const manifestPath = path.join(tempRuntimeDir, 'agents.json');
  const bridgeLogPath = path.join(outDir, 'bridge.log');
  const baresipLogPath = path.join(outDir, 'baresip.log');
  const eventsPath = path.join(outDir, 'events.jsonl');

  const events = [];
  const appendEvent = (event) => {
    const entry = {
      at: new Date().toISOString(),
      elapsedMs: Date.now() - startedAtMs,
      ...event,
    };
    events.push(entry);
    fs.appendFileSync(eventsPath, `${JSON.stringify(entry)}\n`, 'utf8');
  };

  let llamaChild = null;
  let baresipChild = null;
  let bridgeChild = null;
  let recorder = null;
  let ws = null;
  let rl = null;
  let maxDurationTimer = null;

  const timings = {
    approvalMs: null,
    dialToConnectMs: null,
    firstRtpMs: null,
    totalMs: null,
  };
  let approvalRequestedAtMs = null;
  let approvedAtMs = null;
  let lastStatus = null;
  let lastEndReason = null;
  let observedCallId = null;
  let liveSurfaceId = null;
  let threadId = null;
  let hangupRequested = false;
  const observedTranscript = [];

  try {
    const llamaRealtime = await ensureLlamaRealtimeServer({
      voice,
      opts,
      outDir,
      appendEvent,
    });
    llamaChild = llamaRealtime.child;

    await checkVoiceEndpointsReachable(voice);

    let upstreamSipPort = opts.sipUpstreamPort;
    if (!upstreamSipPort) {
      upstreamSipPort = await getFreeTcpPort();
      const baresipDir = path.join(tempRuntimeDir, 'baresip');
      prepareIsolatedBaresipConfig(baresipDir, upstreamSipPort, sipPassword, opts.answerDelay);
      const baresipLogFd = fs.openSync(baresipLogPath, 'a');
      baresipChild = spawn('baresip', ['-4', '-f', baresipDir, '-T', '-c'], {
        stdio: ['ignore', baresipLogFd, baresipLogFd],
      });
      fs.closeSync(baresipLogFd);
      await waitForLogPattern(baresipLogPath, /baresip is ready\./, 10000, baresipChild);
      appendEvent({ type: 'baresip.ready', port: upstreamSipPort });
    }

    recorder = await startSipRecorder({
      listenHost: '127.0.0.1',
      listenPort: 0,
      upstreamHost: '127.0.0.1',
      upstreamPort: upstreamSipPort,
      recordingsDir: outDir,
      filePrefix: '',
      onEvent: (ev) => {
        if (ev.type === 'rtp.started' && timings.firstRtpMs === null) {
          timings.firstRtpMs = Date.now() - startedAtMs;
        }
        appendEvent(ev);
      },
    });
    appendEvent({
      type: 'recorder.ready',
      listenPort: recorder.listenPort,
      upstreamPort: upstreamSipPort,
    });

    const nodeExecutable = fs.realpathSync(process.execPath);
    const manifest = {
      preferredAgentId: 'local-phone-call-driver',
      agents: [
        {
          enabled: true,
          displayName: 'Local Phone Call Driver',
          agentId: 'local-phone-call-driver',
          executable: nodeExecutable,
          argv: [ACP_DRIVER_PATH],
          environment: {
            DAPPERCODE_CALL_TEST_SPEC: {
              kind: 'literal',
              value: specPath,
            },
          },
          resolvedVersion: '1.0.0',
          provenance: 'local-phone-call-test skill',
          verifiedDigest: sha256File(nodeExecutable),
          integrity: { kind: 'executable' },
        },
      ],
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const callSpec = {
      phoneNumber: opts.phoneNumber,
      objective: opts.objective,
      calleeName: opts.calleeName,
      firstMessage: opts.firstMessage,
      context: opts.context,
      controlPath,
      reportPath: driverReportPath,
      pollIntervalMs: 400,
      maxDurationSec: opts.maxDurationSec,
    };
    fs.writeFileSync(specPath, `${JSON.stringify(callSpec, null, 2)}\n`, 'utf8');

    const bridgeLogFd = fs.openSync(bridgeLogPath, 'a');
    bridgeChild = spawn(bridgeBin, [], {
      cwd: workDir,
      stdio: ['ignore', bridgeLogFd, bridgeLogFd],
      env: {
        ...process.env,
        BRIDGE_HOST: '127.0.0.1',
        BRIDGE_PORT: String(bridgePort),
        BRIDGE_PREVIEW_PORT: String(previewPort),
        BRIDGE_AUTH_TOKEN: bridgeAuthToken,
        BRIDGE_WORKDIR: workDir,
        ACP_AGENT_MANIFEST: manifestPath,
        ACP_AGENT_ROOTS: path.dirname(nodeExecutable),
        PHONE_CALL_SIP_SERVER: `127.0.0.1:${recorder.listenPort}`,
        PHONE_CALL_SIP_TRANSPORT: 'udp',
        PHONE_CALL_SIP_USERNAME: 'local',
        PHONE_CALL_SIP_PASSWORD: sipPassword,
        PHONE_CALL_CALLER_ID: opts.callerId,
        PHONE_CALL_USER_DISPLAY_NAME: voice.displayName,
        PHONE_CALL_STT_BASE_URL: voice.sttBaseUrl,
        PHONE_CALL_STT_MODEL: voice.sttModel,
        PHONE_CALL_LLM_BASE_URL: voice.llmBaseUrl,
        PHONE_CALL_LLM_MODEL: voice.llmModel,
        PHONE_CALL_TTS_BASE_URL: voice.ttsBaseUrl,
        PHONE_CALL_TTS_MODEL: voice.ttsModel,
        PHONE_CALL_TTS_VOICE: voice.ttsVoice,
      },
    });
    fs.closeSync(bridgeLogFd);

    await waitForHttpHealth(
      `http://127.0.0.1:${bridgePort}/health`,
      bridgeAuthToken,
      15000,
      bridgeChild,
      bridgeLogPath,
    );
    appendEvent({ type: 'bridge.ready', port: bridgePort });

    console.log(`[test-call] Run ID: ${runId}`);
    console.log(`[test-call] Artifacts: ${outDir}`);
    console.log(
      `[test-call] Voice: STT=${voice.sttModel}, LLM=${voice.llmModel}, TTS=${voice.ttsModel} (${voice.ttsVoice})`,
    );
    if (!opts.sipUpstreamPort) {
      console.log(
        '[test-call] Tip: macOS baresip coreaudio has no built-in AEC; use headphones or moderate speaker volume to minimize acoustic echo.',
      );
    }
    console.log('[test-call] Starting deterministic local call (auto-approving)...');

    ws = new WebSocket(`ws://127.0.0.1:${bridgePort}/rpc`, {
      headers: {
        Authorization: `Bearer ${bridgeAuthToken}`,
        'X-DapperCode-Client-Type': 'local-phone-call-test',
        'X-DapperCode-Client-Name': runId,
      },
    });

    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    let nextRpcId = 1;
    const pendingRpc = new Map();
    const sendRpc = (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextRpcId++;
        pendingRpc.set(id, { resolve, reject, method });
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      });

    let resolveDone;
    const callDone = new Promise((resolve) => {
      resolveDone = resolve;
    });

    const requestHangup = async (reason) => {
      if (hangupRequested) return;
      hangupRequested = true;
      console.log(`\n[test-call] Hanging up (${reason})...`);
      appendEvent({ type: 'call.hangup_requested', reason });
      fs.appendFileSync(controlPath, `${JSON.stringify({ type: 'hangup' })}\n`, 'utf8');
      if (liveSurfaceId && threadId && ws && ws.readyState === WebSocket.OPEN) {
        try {
          await sendRpc('bridge/ui/resolve', {
            id: liveSurfaceId,
            threadId,
            actionId: 'hangup',
          });
        } catch {
          // Best effort; controlPath hangup also runs.
        }
      }
      setTimeout(() => resolveDone('hangup-timeout'), 12000).unref();
    };

    const onSignal = () => {
      requestHangup('signal').catch(() => {});
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }

      if (msg.id !== undefined && pendingRpc.has(msg.id)) {
        const entry = pendingRpc.get(msg.id);
        pendingRpc.delete(msg.id);
        if (msg.error) {
          entry.reject(
            new Error(`${entry.method}: ${msg.error.message || JSON.stringify(msg.error)}`),
          );
        } else {
          entry.resolve(msg.result);
        }
        return;
      }

      const method = msg.method;
      const params = msg.params || {};

      if (method === 'bridge/ui.present' || method === 'bridge/ui.update') {
        const surface = params.surface || params;
        const surfaceId = surface?.id || '';

        if (
          surfaceId.startsWith('phone-call-approval:') ||
          (surface?.kind === 'phone-call' && surface?.presentation === 'modal')
        ) {
          observedCallId = surfaceId.replace(/^phone-call-approval:/, '');
          approvalRequestedAtMs = Date.now();
          appendEvent({ type: 'ui.approval_presented', surfaceId, callId: observedCallId });
          sendRpc('bridge/ui/resolve', {
            id: surfaceId,
            threadId: surface.threadId || threadId,
            actionId: 'approve',
          })
            .then(() => {
              approvedAtMs = Date.now();
              timings.approvalMs = approvedAtMs - approvalRequestedAtMs;
              appendEvent({ type: 'ui.approval_sent', surfaceId, callId: observedCallId });
              console.log('[test-call] Approved call. Warming up local voice models & dialing...');
            })
            .catch((err) => {
              appendEvent({ type: 'ui.approval_error', error: err.message });
              console.error(`[test-call] Failed to approve call: ${err.message}`);
            });
          return;
        }

        if (surface?.kind === 'phone-call' && surface?.presentation === 'workflowCard') {
          liveSurfaceId = surfaceId;
          if (!observedCallId && surfaceId.startsWith('phone-call-live:')) {
            observedCallId = surfaceId.replace(/^phone-call-live:/, '');
          }
          const status = readKvValue(surface, 'Status');
          const details = readKvValue(surface, 'Details');
          const markdown = readMarkdownBlock(surface);
          const actions = Array.isArray(surface.actions) ? surface.actions : [];

          appendEvent({
            type: method,
            surfaceId,
            status,
            subtitle: surface.subtitle || null,
            details,
            actionCount: actions.length,
          });

          if (status && status !== lastStatus) {
            lastStatus = status;
            console.log(
              `[call] Status: ${status}${surface.subtitle ? ` — ${surface.subtitle}` : ''}`,
            );
            if (
              /^(in call|in progress|connected)$/i.test(status) &&
              timings.dialToConnectMs === null &&
              approvedAtMs !== null
            ) {
              timings.dialToConnectMs = Date.now() - approvedAtMs;
              if (process.stdin.isTTY && !opts.noInteractive) {
                console.log(
                  '[test-call] Live! Speak into your Mac mic. Type text + Enter to steer the AI, or /hangup (or Ctrl+C) to finish.',
                );
              }
            }
          }

          if (markdown) {
            const parsed = extractTranscriptFromCardMarkdown(markdown);
            if (parsed.length > observedTranscript.length) {
              for (let i = observedTranscript.length; i < parsed.length; i++) {
                const entry = { ...parsed[i], observedAt: new Date().toISOString() };
                observedTranscript.push(entry);
                console.log(`  [${entry.speakerLabel}] ${entry.text}`);
                appendEvent({ type: 'transcript.line', ...entry });
              }
            }
          }

          const hasHangupAction = actions.some((a) => a?.id === 'hangup');
          if (
            !hasHangupAction &&
            status &&
            !/dialing|ringing|connecting|in call|in progress|on hold/i.test(status)
          ) {
            lastEndReason = surface.subtitle || details || null;
            setTimeout(() => resolveDone('surface-settled'), 1200).unref();
          }
        }
        return;
      }

      if (method === 'turn/completed' || method === 'turn/failed') {
        appendEvent({ type: method, params });
        setTimeout(() => resolveDone(method), 1200).unref();
      }
    });

    ws.on('close', () => {
      resolveDone('ws-closed');
    });

    // Wait for our ACP driver to report ready.
    const readyDeadline = Date.now() + 15000;
    while (Date.now() < readyDeadline) {
      const health = await sendRpc('bridge/health/read', {});
      const driver = (health?.agents || []).find((a) => a.agentId === 'local-phone-call-driver');
      if (driver?.lifecycle === 'ready') break;
      await new Promise((r) => setTimeout(r, 150));
    }

    const threadResp = await sendRpc('thread/start', { agentId: 'local-phone-call-driver' });
    threadId = threadResp?.thread?.id || threadResp?.threadId;
    if (!threadId) {
      throw new Error(`thread/start did not return a thread id: ${JSON.stringify(threadResp)}`);
    }
    appendEvent({ type: 'thread.started', threadId });

    if (process.stdin.isTTY && !opts.noInteractive) {
      rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '' });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (trimmed === '/hangup' || trimmed === '/quit' || trimmed === '/exit') {
          requestHangup('user-command').catch(() => {});
          return;
        }
        fs.appendFileSync(
          controlPath,
          `${JSON.stringify({ type: 'steer', instruction: trimmed })}\n`,
          'utf8',
        );
        appendEvent({ type: 'steer.queued', instruction: trimmed });
        console.log(`[test-call] Sent private steer: "${trimmed}"`);
      });
    }

    maxDurationTimer = setTimeout(
      () => {
        requestHangup('max-duration').catch(() => {});
      },
      (opts.maxDurationSec + 120) * 1000,
    );
    maxDurationTimer.unref();

    await sendRpc('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Start local phone call test.' }],
    });

    await callDone;

    // Wait briefly for the driver to finish polling get_phone_call after hangup.
    const reportWaitEnd = Date.now() + 5000;
    while (Date.now() < reportWaitEnd) {
      if (fs.existsSync(driverReportPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(driverReportPath, 'utf8'));
          if (parsed.settled) break;
        } catch {
          // Wait for atomic rename.
        }
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  } finally {
    if (maxDurationTimer) clearTimeout(maxDurationTimer);
    if (rl) rl.close();
    if (ws) {
      try {
        ws.close();
      } catch {
        // Ignore.
      }
    }
    await terminateProcess(bridgeChild);
    await terminateProcess(baresipChild);
    await terminateProcess(llamaChild);
    const audioSummary = recorder ? recorder.stop() : null;
    timings.totalMs = Date.now() - startedAtMs;

    let driverReport = null;
    if (fs.existsSync(driverReportPath)) {
      try {
        driverReport = JSON.parse(fs.readFileSync(driverReportPath, 'utf8'));
      } catch {
        driverReport = null;
      }
    }

    const bundle = buildCallReportBundle({
      metadata: {
        runId,
        startedAt: startedAt.toISOString(),
        objective: opts.objective,
        firstMessage: opts.firstMessage,
        calleeName: opts.calleeName,
        context: opts.context,
        phoneNumber: opts.phoneNumber,
        callerId: opts.callerId,
        voice,
        gitCommit: git.commit,
        gitBranch: git.branch,
        callId: observedCallId,
        lastStatus,
        lastEndReason,
      },
      timings,
      audioSummary,
      driverReport,
      observedTranscript,
      events,
    });

    const { jsonPath, mdPath } = writeCallArtifacts(outDir, bundle);
    fs.rmSync(tempRuntimeDir, { recursive: true, force: true });

    console.log('\n[test-call] Call finished and artifacts saved:');
    console.log(`  Transcript (Markdown): ${mdPath}`);
    console.log(`  Transcript (JSON):     ${jsonPath}`);
    console.log(`  Events (JSONL):        ${eventsPath}`);
    if (audioSummary) {
      console.log(`  Audio (mixed):         ${audioSummary.files.mixed}`);
      console.log(`  Audio (stereo L=AI):   ${audioSummary.files.stereo}`);
      console.log(`  Audio (AI only):       ${audioSummary.files.ai}`);
      console.log(`  Audio (User only):     ${audioSummary.files.user}`);
    } else {
      console.log('  Audio:                 (no RTP packets captured)');
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`[test-call] Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
