import { registerRootComponent } from 'expo';
import { File, Paths } from 'expo-file-system';
import { initLlama, type LlamaContext } from 'llama.rn';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import { getOnDeviceNativeServices } from '../../../src/features/on-device/native/services';
import { LOCAL_TOOL_DEFINITIONS } from '../../../src/features/on-device/runtime/localTools';
import { localAgentSystemPrompt } from '../../../src/features/on-device/runtime/systemPrompt';
import { localModelHistory } from '../../../src/features/on-device/runtime/modelHistory';
import {
  advertisedLocalTools,
  localToolAdvertised,
} from '../../../src/features/on-device/runtime/toolDefinition';
import type { LocalMessage } from '../../../src/features/on-device/runtime/types';
import { executeFileTool } from '../../../src/features/on-device/workspaces/fileTools';
import { localModelDefinition } from '../../../src/features/on-device/models/catalog';
import { promptFits } from '../../../src/features/on-device/models/contextWindow';
import {
  modelContextTokens,
  requireModelMemory,
} from '../../../src/features/on-device/models/memory';
import { completionParams } from '../../../src/features/on-device/models/session';
import { STOPPED_BEFORE_APPROVAL } from '../../../src/features/on-device/runtime/toolRunner';
import type {
  LocalModelDefinition,
  LocalModelFile,
} from '../../../src/features/on-device/models/types';
import {
  nativeContextParams,
  type LocalModelMessage,
} from '../../../src/features/on-device/models/engine';

const checks: Record<string, boolean> = {};
const metrics: Record<string, number> = {};
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
  file: LocalModelFile,
  run: (context: LlamaContext, contextTokens: number) => Promise<void>,
) {
  const memory = getOnDeviceNativeServices().getMemoryInfo();
  requireModelMemory(model, memory);
  check(true, 'nativeMemoryAdmission');
  // The production context parameters: admitted context size, threads, batch, one sequence, and
  // prompt-state reuse.
  const contextTokens = modelContextTokens(model, memory);
  const context = await initLlama(nativeContextParams(model, file, { contextTokens, memory }));
  try {
    await run(context, contextTokens);
  } finally {
    await context.release();
  }
}

/** Production reasoning setting, plus output room so a gate budget never truncates reasoning. */
function thinking(modelId: string) {
  const on = localModelDefinition(modelId).thinking === true;
  return { enable_thinking: on, extraTokens: on ? 1024 : 0 };
}

/** The tools and system prompt a production round advertises at this context size. */
function productionPrefix(modelId: string, contextTokens: number) {
  return {
    tools: advertisedLocalTools(LOCAL_TOOL_DEFINITIONS, contextTokens),
    system: localAgentSystemPrompt(
      modelId,
      new Date(),
      undefined,
      '',
      localToolAdvertised('web_search', contextTokens),
    ),
  };
}

/** Real-tokenizer prompt sizes for every context tier, independent of the loaded context. */
async function measureToolTiers(modelId: string, context: LlamaContext) {
  const user = { role: 'user', content: 'Read hello.txt.' };
  const measure = async (system: string, tools: object[]) => {
    const formatted = await context.getFormattedChat(
      [{ role: 'system', content: system }, user],
      null,
      {
        tools,
        tool_choice: 'auto',
        enable_thinking: thinking(modelId).enable_thinking,
        reasoning_format: 'auto',
      },
    );
    return (await context.tokenize(formatted.prompt)).tokens.length;
  };
  metrics['allToolsPromptTokens'] = await measure(
    localAgentSystemPrompt(modelId, new Date()),
    LOCAL_TOOL_DEFINITIONS,
  );
  for (const tier of [4096, 8192, 16_384]) {
    const { system, tools } = productionPrefix(modelId, tier);
    metrics[`toolCount${tier}`] = tools.length;
    metrics[`promptTokens${tier}`] = await measure(system, tools);
  }
  // A default 3 KiB file read must still fit beside the smallest context's fixed prompt.
  check(
    promptFits((metrics['promptTokens4096'] ?? Infinity) + 1024, 4096),
    'smallContextLeavesRoom',
    JSON.stringify(metrics),
  );
}

async function checkPostCancellationContinuation(
  modelId: string,
  context: LlamaContext,
  contextTokens: number,
  result: string,
) {
  const { tools, system } = productionPrefix(modelId, contextTokens);
  const at = new Date().toISOString();
  const history: LocalMessage[] = [
    {
      id: 'push-request',
      role: 'user',
      content:
        'Call git_push now. The tool itself will request approval. Do not ask in prose or wait before calling it. Do not inspect anything first or call any other tool.',
      createdAt: at,
    },
    {
      id: 'push-call',
      role: 'assistant',
      content: '',
      createdAt: at,
      toolCalls: [
        { id: 'stopped-push', type: 'function', function: { name: 'git_push', arguments: '{}' } },
      ],
    },
    {
      id: 'push-result',
      role: 'tool',
      content: JSON.stringify({
        error: STOPPED_BEFORE_APPROVAL,
      }),
      createdAt: at,
      tool: {
        callId: 'stopped-push',
        name: 'git_push',
        status: 'interrupted',
        startedAt: at,
        completedAt: at,
      },
    },
    {
      id: 'read-request',
      role: 'user',
      content: 'Read hello.txt with read_file. Do not change files.',
      createdAt: at,
    },
    {
      id: 'read-call',
      role: 'assistant',
      content: '',
      createdAt: at,
      toolCalls: [
        {
          id: 'resumed-read',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"hello.txt"}' },
        },
      ],
    },
    {
      id: 'read-result',
      role: 'tool',
      content: result,
      createdAt: at,
      tool: {
        callId: 'resumed-read',
        name: 'read_file',
        status: 'completed',
        startedAt: at,
        completedAt: at,
      },
    },
  ];
  const messages: LocalModelMessage[] = [
    { role: 'system', content: system },
    ...localModelHistory(history, 'pending-answer', modelId),
  ];
  const format = (input: LocalModelMessage[]) =>
    context.getFormattedChat(input, null, {
      tools,
      tool_choice: 'auto',
      enable_thinking: thinking(modelId).enable_thinking,
      reasoning_format: 'auto',
    });
  const formatted = await format(messages);
  const promptTokens = (await context.tokenize(formatted.prompt)).tokens.length;
  check(
    promptFits(promptTokens, contextTokens),
    'postCancelledToolBudget',
    `${promptTokens} prompt tokens in ${contextTokens}`,
  );
  const { enable_thinking, extraTokens } = thinking(modelId);
  const reply = await context.completion(
    completionParams(formatted, 512 + extraTokens, enable_thinking),
  );
  check(
    reply.content?.includes('OFFLINE_TOOL_OK') === true,
    'postCancelledToolContinuation',
    JSON.stringify({
      contextTokens,
      promptTokens,
      suffix: formatted.prompt.slice(-200),
      reply,
    }),
  );
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
  await withModel(model, verified, async (context, contextTokens) => {
    check(Number.isFinite(context.id), 'nativeModelLoaded');
    metrics['contextTokens'] = contextTokens;
    await measureToolTiers(model.id, context);
    const { tools, system } = productionPrefix(model.id, contextTokens);
    const { enable_thinking, extraTokens } = thinking(model.id);
    const messages = [
      { role: 'system', content: system },
      {
        role: 'user',
        content: 'Call read_file with the exact path hello.txt. Do not guess its contents.',
      },
    ];
    // Production rounds format once and complete from that formatted prompt.
    const fullPrompt = await context.getFormattedChat(messages, null, {
      tools,
      tool_choice: 'required',
      enable_thinking,
      reasoning_format: 'auto',
    });
    const promptTokens = (await context.tokenize(fullPrompt.prompt)).tokens.length;
    metrics['promptTokens'] = promptTokens;
    check(
      promptFits(promptTokens, contextTokens),
      'fullProductionToolBudget',
      `${promptTokens} prompt tokens do not leave the generation reserve in ${contextTokens}`,
    );
    const first = await context.completion({
      ...completionParams(fullPrompt, 128 + extraTokens, enable_thinking),
      temperature: 0,
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
      enable_thinking,
    });
    check(formatted.prompt.includes('OFFLINE_TOOL_OK'), 'toolResultInPrompt');
    let chunks = 0;
    const second = await context.completion(
      { ...completionParams(formatted, 128 + extraTokens, enable_thinking), temperature: 0 },
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
    metrics['secondRoundCachedTokens'] = second.timings.cache_n;
    metrics['secondRoundPromptTokens'] = second.timings.prompt_n;
    await checkPostCancellationContinuation(model.id, context, contextTokens, JSON.stringify(file));
    if (model.family === 'LFM3') {
      // Web research is a measured rate (about 9 in 10 host seeds), so it needs a majority; keeping
      // project symbols out of web_search is a privacy rule and must hold on every seed.
      let webPasses = 0;
      for (const seed of [1, 42, 123]) {
        for (const [scope, request] of [
          ['web', 'How do I configure the latest llama.cpp release to use LFM3?'],
          ['workspace', 'Find the implementation of privateWorkspaceSentinel in this workspace.'],
        ] as const) {
          const research = await context.getFormattedChat(
            [
              { role: 'system', content: system },
              { role: 'user', content: request },
            ],
            null,
            { tools, tool_choice: 'auto', enable_thinking, reasoning_format: 'auto' },
          );
          const reply = await context.completion({
            ...completionParams(research, 256 + extraTokens, enable_thinking),
            seed,
          });
          const names = (reply.tool_calls ?? []).map((item) => item.function.name);
          if (scope === 'web') {
            webPasses += names.includes('web_search') ? 1 : 0;
            metrics[`researchWeb${seed}`] = names.includes('web_search') ? 1 : 0;
            continue;
          }
          check(
            names.length > 0 &&
              names.every((name) =>
                ['search_files', 'glob_files', 'list_files', 'read_file', 'code_symbols'].includes(
                  name,
                ),
              ),
            `research-workspace-${seed}`,
            JSON.stringify({ names, content: reply.content }),
          );
        }
      }
      metrics['researchWebPasses'] = webPasses;
      check(webPasses >= 2, 'research-web-majority', `${webPasses} of 3 seeds called web_search`);
    }
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
  await withModel(model, verified, async (context) => {
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
        outcome.write(JSON.stringify({ status: 'pass', checks, metrics, memory }));
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
