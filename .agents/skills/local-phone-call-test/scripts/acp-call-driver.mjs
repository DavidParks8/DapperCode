#!/usr/bin/env node
// Deterministic ACP JSON-RPC 2.0 agent used by local-phone-call-test.
// Receives the bridge's Streamable HTTP MCP server in session/new, invokes
// start_phone_call with the exact test specification, processes live steer/hangup
// commands from the control NDJSON file, polls get_phone_call until settled, and
// writes the final structured phone-call report to reportPath.

import crypto from 'node:crypto';
import fs from 'node:fs';
import process from 'node:process';
import readline from 'node:readline';

const TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'declined',
  'cancelled',
  'timed_out',
  'no_answer',
  'busy',
]);

function readSpec() {
  const specPath = process.env.DAPPERCODE_CALL_TEST_SPEC;
  if (!specPath) {
    throw new Error('DAPPERCODE_CALL_TEST_SPEC environment variable is required');
  }
  return JSON.parse(fs.readFileSync(specPath, 'utf8'));
}

function writeJsonRpc(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function parseSseOrJson(text, contentType) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (contentType && contentType.toLowerCase().includes('text/event-stream')) {
    let lastJson = null;
    for (const block of trimmed.split(/\r?\n\r?\n/)) {
      const dataLines = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());
      if (dataLines.length === 0) continue;
      const payload = dataLines.join('\n');
      if (!payload || payload === '[DONE]') continue;
      try {
        lastJson = JSON.parse(payload);
      } catch {
        // Ignore non-JSON keepalive events.
      }
    }
    return lastJson;
  }
  return JSON.parse(trimmed);
}

export class McpHttpClient {
  constructor(url, headers = []) {
    this.url = url;
    this.baseHeaders = {};
    for (const header of headers) {
      if (header && header.name && header.value !== undefined) {
        this.baseHeaders[header.name] = header.value;
      }
    }
    this.sessionId = null;
    this.nextId = 1;
  }

  async rpc(method, params, { notification = false } = {}) {
    const body = notification
      ? { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }
      : {
          jsonrpc: '2.0',
          id: this.nextId++,
          method,
          ...(params !== undefined ? { params } : {}),
        };
    const headers = {
      ...this.baseHeaders,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId;
    }
    const response = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const sessionHeader = response.headers.get('mcp-session-id');
    if (sessionHeader) {
      this.sessionId = sessionHeader;
    }
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`MCP ${method} failed with HTTP ${response.status}: ${errText}`);
    }
    if (notification || response.status === 202) {
      return null;
    }
    const text = await response.text();
    const parsed = parseSseOrJson(text, response.headers.get('content-type') || '');
    if (!parsed) {
      throw new Error(`MCP ${method} returned an empty response`);
    }
    if (parsed.error) {
      throw new Error(`MCP ${method} error (${parsed.error.code}): ${parsed.error.message}`);
    }
    return parsed.result;
  }

  async initialize() {
    await this.rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'local-phone-call-driver', version: '1.0.0' },
    });
    await this.rpc('notifications/initialized', undefined, { notification: true });
  }

  async callTool(name, args) {
    const result = await this.rpc('tools/call', { name, arguments: args });
    const textBlock = Array.isArray(result?.content)
      ? result.content.find((item) => item?.type === 'text' && typeof item.text === 'string')
      : null;
    if (result?.isError) {
      throw new Error(textBlock?.text || `MCP tool ${name} failed`);
    }
    if (textBlock) {
      try {
        return JSON.parse(textBlock.text);
      } catch {
        return { text: textBlock.text };
      }
    }
    return result;
  }
}

function readControlCommands(controlPath, processedLines) {
  if (!controlPath || !fs.existsSync(controlPath)) {
    return { commands: [], processedLines };
  }
  const raw = fs.readFileSync(controlPath, 'utf8');
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length <= processedLines) {
    return { commands: [], processedLines };
  }
  const commands = [];
  for (let i = processedLines; i < lines.length; i++) {
    try {
      commands.push(JSON.parse(lines[i]));
    } catch {
      // Ignore malformed control lines.
    }
  }
  return { commands, processedLines: lines.length };
}

function writeReportAtomically(reportPath, payload) {
  if (!reportPath) return;
  const tmpPath = `${reportPath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, reportPath);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createDriverLoop({ write = writeJsonRpc } = {}) {
  const sendResponse = (id, result) => write({ jsonrpc: '2.0', id, result });
  const sendError = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });
  const sessions = new Map();
  let activeCallId = null;
  let activeMcpClient = null;
  let callCompleted = false;
  let cancelled = false;

  async function runCallTurn(sessionId) {
    const spec = readSpec();
    const session = sessions.get(sessionId);
    if (!session || !session.mcpServer) {
      throw new Error('dappercode-agent-messaging HTTP MCP server was not provided in session/new');
    }

    const mcp = new McpHttpClient(session.mcpServer.url, session.mcpServer.headers || []);
    activeMcpClient = mcp;
    await mcp.initialize();

    const startArgs = {
      phoneNumber: spec.phoneNumber,
      objective: spec.objective,
      ...(spec.calleeName ? { calleeName: spec.calleeName } : {}),
      ...(spec.firstMessage ? { firstMessage: spec.firstMessage } : {}),
      ...(spec.context ? { context: spec.context } : {}),
    };

    const startResult = await mcp.callTool('start_phone_call', startArgs);
    const callId = startResult?.callId || null;
    activeCallId = callId;

    const steered = [];
    let finalReport = startResult;
    let processedControlLines = 0;
    const pollIntervalMs = spec.pollIntervalMs || 500;
    const maxWaitMs = (spec.maxDurationSec || 960) * 1000;
    const startedAtMs = Date.now();

    writeReportAtomically(spec.reportPath, {
      callId,
      startResult,
      steered,
      finalReport,
      settled: Boolean(startResult?.status && TERMINAL_STATUSES.has(startResult.status)),
    });

    while (callId && !cancelled) {
      const currentStatus = finalReport?.status;
      if (currentStatus && TERMINAL_STATUSES.has(currentStatus)) {
        break;
      }

      const control = readControlCommands(spec.controlPath, processedControlLines);
      processedControlLines = control.processedLines;
      for (const cmd of control.commands) {
        if (cmd.type === 'steer' && typeof cmd.instruction === 'string' && cmd.instruction.trim()) {
          try {
            const steerResp = await mcp.callTool('steer_phone_call', {
              callId,
              instruction: cmd.instruction.trim(),
            });
            steered.push({
              at: new Date().toISOString(),
              instruction: cmd.instruction.trim(),
              response: steerResp,
            });
          } catch (error) {
            steered.push({
              at: new Date().toISOString(),
              instruction: cmd.instruction.trim(),
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } else if (cmd.type === 'hangup') {
          try {
            await mcp.callTool('hangup_phone_call', { callId });
          } catch {
            // Best-effort hangup; get_phone_call below will observe terminal status.
          }
        }
      }

      if (Date.now() - startedAtMs >= maxWaitMs) {
        try {
          await mcp.callTool('hangup_phone_call', { callId });
        } catch {
          // Best-effort timeout hangup.
        }
      }

      await sleep(pollIntervalMs);

      try {
        finalReport = await mcp.callTool('get_phone_call', { callId });
        writeReportAtomically(spec.reportPath, {
          callId,
          startResult,
          steered,
          finalReport,
          settled: Boolean(finalReport?.status && TERMINAL_STATUSES.has(finalReport.status)),
        });
      } catch (error) {
        writeReportAtomically(spec.reportPath, {
          callId,
          startResult,
          steered,
          finalReport,
          pollError: error instanceof Error ? error.message : String(error),
          settled: false,
        });
        break;
      }
    }

    activeCallId = null;
    activeMcpClient = null;
    return finalReport;
  }

  return {
    async handleMessage(msg) {
      if (!msg || typeof msg !== 'object') return;
      const { id, method, params } = msg;

      if (method === 'initialize') {
        sendResponse(id, {
          protocolVersion: 1,
          agentCapabilities: {
            mcpCapabilities: {
              http: true,
              sse: false,
            },
          },
          agentInfo: {
            name: 'local-phone-call-driver',
            version: '1.0.0',
          },
        });
        return;
      }

      if (method === 'session/new') {
        const sessionId = `local-call-${crypto.randomUUID()}`;
        const servers = Array.isArray(params?.mcpServers) ? params.mcpServers : [];
        const mcpServer =
          servers.find((s) => s?.name === 'dappercode-agent-messaging' && s?.url) ||
          servers.find((s) => s?.url) ||
          null;
        sessions.set(sessionId, { mcpServer });
        sendResponse(id, { sessionId });
        return;
      }

      if (method === 'session/prompt') {
        if (callCompleted) {
          // Ignore follow-up bridge prompts (e.g. post-call report delivery) once our test call settled.
          sendResponse(id, { stopReason: 'end_turn' });
          return;
        }
        callCompleted = true;
        try {
          await runCallTurn(params?.sessionId);
          sendResponse(id, { stopReason: cancelled ? 'cancelled' : 'end_turn' });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          try {
            const spec = readSpec();
            writeReportAtomically(spec.reportPath, {
              error: message,
              settled: true,
            });
          } catch {
            // Ignore write errors if spec was missing.
          }
          sendError(id, -32000, message);
        }
        return;
      }

      if (method === 'session/cancel') {
        cancelled = true;
        if (activeCallId && activeMcpClient) {
          try {
            await activeMcpClient.callTool('hangup_phone_call', { callId: activeCallId });
          } catch {
            // Ignore best-effort cancel hangup errors.
          }
        }
        if (id !== undefined) {
          sendResponse(id, {});
        }
        return;
      }

      if (id !== undefined) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
    },
  };
}

const isMain =
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);

if (isMain) {
  const driver = createDriverLoop();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    driver.handleMessage(parsed).catch((error) => {
      process.stderr.write(
        `[acp-call-driver] unhandled error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
  });
}
