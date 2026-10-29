import { registerRootComponent } from 'expo';
import { File, Paths } from 'expo-file-system';
import { initLlama, type LlamaContext } from 'llama.rn';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import { getOnDeviceNativeServices } from '../../../src/features/on-device/native/services';
import { FILE_TOOL_DEFINITIONS } from '../../../src/features/on-device/workspaces/fileToolDefinitions';
import { GIT_TOOL_DEFINITIONS } from '../../../src/features/on-device/git/gitTools';
import { LOCAL_AGENT_SYSTEM_PROMPT } from '../../../src/features/on-device/runtime/agentLoop';
import { executeFileTool } from '../../../src/features/on-device/workspaces/fileTools';
import { localModelDefinition } from '../../../src/features/on-device/models/catalog';
import { requireModelMemory } from '../../../src/features/on-device/models/memory';
import type { LocalModelDefinition } from '../../../src/features/on-device/models/types';
import { modelFileSystemPath } from '../../../src/features/on-device/models/engine';

const checks: Record<string, boolean> = {};
const outcome = new File(Paths.document, 'native-inference-result.json');

function check(condition: unknown, name: string, detail = ''): asserts condition {
  if (!condition) {
    throw new Error(`${name}${detail ? `: ${detail}` : ''}`);
  }
  checks[name] = true;
  outcome.write(JSON.stringify({ status: 'running', checks }));
}

async function withModel(
  model: LocalModelDefinition,
  uri: string,
  run: (context: LlamaContext) => Promise<void>,
) {
  requireModelMemory(model, getOnDeviceNativeServices().getMemoryInfo());
  check(true, 'nativeMemoryAdmission');
  const context = await initLlama({
    model: modelFileSystemPath(uri),
    n_ctx: model.contextTokens,
    n_batch: 128,
    n_threads: 2,
    n_gpu_layers: 0,
    cache_type_k: 'f16',
    cache_type_v: 'f16',
    state_cache_budget_mb: 0,
  });
  try {
    await run(context);
  } finally {
    await context.release();
  }
}

async function exerciseInference() {
  const native = getOnDeviceNativeServices();
  const memory = native.getMemoryInfo();
  check(memory.physicalBytes > 0 && memory.availableBytes >= 0, 'nativeMemory');
  const model = localModelDefinition(
    (await new File(Paths.document, 'model-id.txt').text()).trim(),
  );
  const paths = await native.getModelFilePaths(model.id);
  await new File(Paths.document, 'model.gguf').copy(new File(paths.partialUri));
  const verified = await native.finalizeModelDownload(model.id, model.sha256, model.bytes);
  check(verified.bytes === model.bytes && verified.sha256 === model.sha256, 'verifiedModelFile');
  const workspace = await native.createWorkspace('Native tool fixture');
  await native.writeWorkspaceFile(workspace.id, 'hello.txt', 'OFFLINE_TOOL_OK', null);
  const messages = [
    {
      role: 'system',
      content: LOCAL_AGENT_SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: 'Call read_file with the exact path hello.txt. Do not guess its contents.',
    },
  ];
  const tools = [...FILE_TOOL_DEFINITIONS, ...GIT_TOOL_DEFINITIONS];
  await withModel(model, verified.uri, async (context) => {
    check(Number.isFinite(context.id), 'nativeModelLoaded');
    const fullPrompt = await context.getFormattedChat(messages, null, {
      tools,
      tool_choice: 'auto',
      enable_thinking: false,
      reasoning_format: 'auto',
    });
    const promptTokens = (await context.tokenize(fullPrompt.prompt)).tokens.length;
    check(
      promptTokens + 544 <= model.contextTokens,
      'fullProductionToolBudget',
      `${promptTokens} prompt tokens + 544 reserved > ${model.contextTokens}`,
    );
    const first = await context.completion({
      messages,
      tools,
      tool_choice: 'required',
      enable_thinking: false,
      temperature: 0,
      n_predict: 128,
    });
    const calls = first.tool_calls ?? [];
    check(
      calls.length === 1,
      'structuredToolCall',
      JSON.stringify({
        content: first.content,
        text: first.text,
        calls,
        truncated: first.truncated,
        stoppedLimit: first.stopped_limit,
        tokens: first.tokens_predicted,
      }),
    );
    const call = calls[0];
    check(call?.function.name === 'read_file', 'correctToolName');
    const args: unknown = JSON.parse(call.function.arguments);
    check(
      args && typeof args === 'object' && 'path' in args && args.path === 'hello.txt',
      'correctToolArguments',
    );
    const file = await executeFileTool(workspace.id, call.function.name, args, native);
    check(
      file && typeof file === 'object' && 'content' in file && typeof file.content === 'string',
      'nativeFileToolResult',
    );
    const contents = file.content;
    check(contents === 'OFFLINE_TOOL_OK', 'realFileRead');
    const assistant = {
      role: 'assistant',
      content: '',
      tool_calls: calls.map((item) => ({ ...item, id: item.id ?? 'native-gate-tool' })),
    };
    const tool = {
      role: 'tool',
      name: 'read_file',
      tool_call_id: call.id ?? 'native-gate-tool',
      content: JSON.stringify(file),
    };
    const continuation = [
      ...messages,
      assistant,
      tool,
      { role: 'user', content: 'Reply with exactly the content field returned by read_file.' },
    ];
    const formatted = await context.getFormattedChat(continuation, null, {
      tools,
      tool_choice: 'none',
      enable_thinking: false,
    });
    check(formatted.prompt.includes('OFFLINE_TOOL_OK'), 'toolResultInPrompt');
    let chunks = 0;
    const second = await context.completion(
      {
        messages: continuation,
        tools,
        tool_choice: 'none',
        enable_thinking: false,
        temperature: 0,
        n_predict: 128,
      },
      () => {
        chunks += 1;
      },
    );
    check(
      second.content.includes('OFFLINE_TOOL_OK'),
      'toolResultUsed',
      JSON.stringify({ prompt: formatted.prompt, content: second.content, text: second.text }),
    );
    check(chunks > 0, 'nativeStreaming');
    await context.clearCache();
    let stop: Promise<void> | undefined;
    const stopped = await context.completion(
      {
        messages: [
          {
            role: 'user',
            content: 'List the numbers from 1 to 10000, separated by commas. Do not stop early.',
          },
        ],
        enable_thinking: false,
        n_predict: 512,
        temperature: 0,
      },
      () => {
        if (!stop) {
          stop = context.stopCompletion();
        }
      },
    );
    await stop;
    check(stopped.interrupted && stopped.tokens_predicted < 512, 'nativeCancellation');
  });
  check(true, 'modelUnloaded');
  await withModel(model, verified.uri, async (context) => {
    check(Number.isFinite(context.id), 'modelReloaded');
  });
  const reference = await native.storeGitCredential(
    'github.com',
    'native-gate',
    'test-user',
    'test-token-not-a-secret',
  );
  check(typeof reference === 'string' && reference.length > 0, 'opaqueCredential');
  await native.removeGitCredential(reference);
  await native.removeGitCredential(reference);
  check(true, 'credentialRemoval');
  return memory;
}

let started = false;

function NativeInferenceGate() {
  const [status, setStatus] = useState('running');
  useEffect(() => {
    if (started) {
      return;
    }
    started = true;
    outcome.write(JSON.stringify({ status: 'running' }));
    void exerciseInference().then(
      (memory) => {
        outcome.write(JSON.stringify({ status: 'pass', checks, memory }));
        setStatus('pass');
      },
      (error: unknown) => {
        outcome.write(
          JSON.stringify({
            status: 'fail',
            checks,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        setStatus('fail');
      },
    );
  }, []);
  return (
    <View>
      <Text>Native inference gate: {status}</Text>
    </View>
  );
}

registerRootComponent(NativeInferenceGate);
