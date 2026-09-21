import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

export const name = 'managed-worktrees';
export const contract = {
  requiredPhases: ['setup', 'create', 'restart', 'chat', 'remove', 'confirmation'],
};

export default async function scenario(e2e) {
  let binary;
  let host;
  let socket;
  let serial = 0;
  let boot = 0;
  let checkout;
  const token = e2e.createSecret();
  const id = randomUUID();
  const request = { id, cwd: e2e.workspaceDir, branch: 'feature/isolated', baseRef: 'main' };
  const git = (args, cwd = e2e.workspaceDir) =>
    e2e.run('git', ['-C', cwd, ...args], { timeoutMs: 15000 });
  const rpc = async (method, params = {}, error = false) => {
    const id = ++serial;
    socket.sendJson({ jsonrpc: '2.0', id, method, params });
    const response = await socket.nextJson({
      predicate: (message) => message.id === id,
      timeoutMs: 20000,
    });
    if (error) {
      assert.ok(response.error, `${method} must fail`);
      return response.error;
    }
    assert.equal(response.error, undefined, `${method}: ${JSON.stringify(response.error)}`);
    return response.result;
  };
  const start = async () => {
    const label = `bridge-${++boot}`;
    host = await e2e.start(binary, [], {
      label,
      cwd: e2e.workspaceDir,
      env: {
        BRIDGE_HOST: '127.0.0.1',
        BRIDGE_PORT: '0',
        BRIDGE_DISABLE_BROWSER_PREVIEW: 'true',
        BRIDGE_PREVIEW_PORT: '1',
        BRIDGE_WORKDIR: e2e.workspaceDir,
        BRIDGE_STATE_DIR: path.join(e2e.dataDir, 'state'),
        BRIDGE_ATTACHMENTS_DIR: path.join(e2e.dataDir, 'attachments'),
        BRIDGE_AUTH_TOKEN: token,
        BRIDGE_ALLOW_QUERY_TOKEN_AUTH: 'false',
        BRIDGE_ALLOW_OUTSIDE_ROOT_CWD: 'false',
        BRIDGE_SHOW_PAIRING_QR: 'false',
        BRIDGE_OWNER_PID: String(process.pid),
        ACP_AGENT_MANIFEST: path.join(e2e.dataDir, 'agents.json'),
        ACP_AGENT_ROOTS: e2e.runtimeDir,
      },
    });
    const match = await e2e.waitForLog(label, /rust-bridge listening on (127\.0\.0\.1:\d+)/, {
      timeoutMs: 30000,
    });
    socket = await e2e.openWebSocket(`client-${boot}`, `ws://${match[1]}/rpc`, {
      headers: { Authorization: `Bearer ${token}` },
      timeoutMs: 15000,
    });
  };

  await e2e.phase('setup', async () => {
    const target = (
      await e2e.run('node', ['scripts/run-cargo.mjs', '--print-target-dir'])
    ).stdout.trim();
    binary = e2e.copyIntoRun(
      path.join(target, 'debug/dappercode-bridge'),
      'runtime/dappercode-bridge',
    );
    const agent = e2e.copyIntoRun(
      path.join(target, 'debug/dappercode-e2e-agent'),
      'runtime/dappercode-e2e-agent',
    );
    e2e.writeFile('data/scenario.json', JSON.stringify({ chats: [] }));
    const digest = `sha256:${createHash('sha256').update(e2e.readFile('runtime/dappercode-e2e-agent', null)).digest('hex')}`;
    e2e.writeFile(
      'data/agents.json',
      JSON.stringify({
        preferredAgentId: 'fixture',
        agents: [
          {
            enabled: true,
            displayName: 'Fixture',
            icon: null,
            agentId: 'fixture',
            executable: agent,
            argv: [],
            environment: {
              DAPPERCODE_E2E_SCENARIO_PATH: {
                kind: 'literal',
                value: path.join(e2e.dataDir, 'scenario.json'),
              },
              DAPPERCODE_E2E_CONTROL_PATH: {
                kind: 'literal',
                value: path.join(e2e.dataDir, 'control.json'),
              },
            },
            resolvedVersion: 'e2e',
            provenance: 'deterministic ACP fixture',
            verifiedDigest: digest,
            integrity: { kind: 'executable' },
          },
        ],
      }),
    );
    await git(['init', '-b', 'main']);
    e2e.writeFile('workspace/tracked.txt', 'original\n');
    e2e.writeFile('workspace/.gitignore', 'ignored\n');
    await git(['add', '.']);
    await git([
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '-m',
      'Initial',
    ]);
    await start();
    await e2e.check('capability and empty registry', async () => {
      assert.equal((await rpc('bridge/capabilities/read')).supports.managedWorktrees, true);
      assert.deepEqual((await rpc('bridge/worktrees/list')).worktrees, []);
    });
  });
  await e2e.phase('create', async () => {
    e2e.writeFile('workspace/tracked.txt', 'source changes\n');
    checkout = (await rpc('bridge/worktrees/create', request)).worktree;
    await e2e.check('isolated checkout and idempotent retry', async () => {
      assert.equal(checkout.status, 'ready');
      assert.ok(checkout.path.startsWith(e2e.dataDir));
      assert.equal(e2e.readFile(path.join(checkout.path, 'tracked.txt'), 'utf8'), 'original\n');
      assert.equal(e2e.readFile('workspace/tracked.txt', 'utf8'), 'source changes\n');
      assert.equal((await rpc('bridge/worktrees/create', request)).worktree.path, checkout.path);
      assert.equal((await rpc('bridge/worktrees/list')).worktrees.length, 1);
      assert.equal((await rpc('bridge/git/status', { cwd: checkout.path })).clean, true);
      const denied = await rpc('bridge/fs/list', { path: e2e.dataDir }, true);
      assert.match(denied.message, /within BRIDGE_WORKDIR/);
    });
  });
  await e2e.phase('restart', async () => {
    await socket.close();
    await host.stop();
    await start();
    await e2e.check('checkout survives worker restart and replayed create', async () => {
      assert.equal((await rpc('bridge/worktrees/list')).worktrees[0].path, checkout.path);
      assert.equal((await rpc('bridge/worktrees/create', request)).worktree.path, checkout.path);
    });
  });
  await e2e.phase('chat', async () => {
    await e2e.check('automatic checkout and chat creation share durable idempotency', async () => {
      const create = {
        submissionId: 'automatic-chat',
        workspace: { mode: 'worktree', branch: 'main' },
        threadStart: { cwd: e2e.workspaceDir, agentId: 'fixture' },
      };
      const first = await rpc('bridge/thread/create', create);
      assert.notEqual(first.thread.cwd, e2e.workspaceDir);
      const second = await rpc('bridge/thread/create', create);
      assert.equal(first.thread.id, second.thread.id);
      assert.equal(first.thread.cwd, second.thread.cwd);
      await socket.close();
      await host.stop();
      await start();
      assert.equal((await rpc('bridge/thread/create', create)).thread.id, first.thread.id);
      const managed = (await rpc('bridge/worktrees/list')).worktrees.find(
        (entry) => entry.path === first.thread.cwd,
      );
      assert.ok(managed);
      assert.equal(managed.baseRef, 'main');
      // The fixture's sessions are process-local; the durable index still protects the checkout.
      assert.match(
        (await rpc('bridge/worktrees/remove', { id: managed.id }, true)).message,
        /Delete the chats/,
      );
    });
    const created = await rpc('thread/start', { agentId: 'fixture', cwd: checkout.path });
    const threadId = created.thread.id;
    await e2e.check('ACP chat uses checkout and blocks removal', async () => {
      assert.equal(created.thread.cwd, checkout.path);
      const blocked = await rpc('bridge/worktrees/remove', { id }, true);
      assert.match(blocked.message, /Delete the chats/);
      const thread = await rpc('thread/read', { threadId });
      assert.ok(thread);
    });
    await rpc('thread/delete', { threadId });
  });
  await e2e.phase('remove', async () => {
    for (const file of ['untracked', 'ignored']) {
      e2e.writeFile(path.join(checkout.path, file), 'preserve me');
      await e2e.check(`refuses-${file}`, async () => {
        assert.match((await rpc('bridge/worktrees/remove', { id }, true)).message, /files/);
        assert.equal(e2e.readFile(path.join(checkout.path, file), 'utf8'), 'preserve me');
      });
      e2e.remove(path.join(checkout.path, file));
    }
    await e2e.check('removal succeeds and branch stays', async () => {
      assert.equal((await rpc('bridge/worktrees/remove', { id })).removed, true);
      assert.equal((await rpc('bridge/worktrees/remove', { id })).removed, true);
      assert.equal(
        (await rpc('bridge/worktrees/list')).worktrees.some((entry) => entry.id === id),
        false,
      );
      assert.match(
        (await git(['branch', '--list', 'feature/isolated'])).stdout,
        /feature\/isolated/,
      );
    });
  });
  await e2e.phase('confirmation', async () => {
    await socket.close();
    await host.stop();
    await start();
    await e2e.check('removal remains durable and old creation cannot resurrect it', async () => {
      assert.equal(
        (await rpc('bridge/worktrees/list')).worktrees.some((entry) => entry.id === id),
        false,
      );
      assert.match((await rpc('bridge/worktrees/create', request, true)).message, /removed/);
      assert.equal(e2e.readFile('workspace/tracked.txt', 'utf8'), 'source changes\n');
    });
    await socket.close();
    await host.stop();
  });
}
