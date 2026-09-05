import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isThreadNotFoundError } from './clientChatCloneAndRetryInternals';
import type { BridgeThreadNotFoundErrorData } from '@bridge/types/types';
import { RpcRequestError } from '@bridge/ws/errors';

it('recognizes only the authoritative thread/read not-found contract for the requested ID', () => {
  const manifest = JSON.parse(
    readFileSync(
      path.resolve(__dirname, '../../../../../contracts/bridge-rpc/v2/manifest.json'),
      'utf8',
    ),
  ) as {
    fixtures: {
      threadReadNotFound: { code: number; message: string; data: BridgeThreadNotFoundErrorData };
    };
  };
  const { code, message, data } = manifest.fixtures.threadReadNotFound;
  const error = new RpcRequestError('thread/read', code, message, data);
  expect(isThreadNotFoundError(error, data.threadId)).toBe(true);
  expect(isThreadNotFoundError(error, 'other-thread')).toBe(false);
  expect(
    isThreadNotFoundError(
      new RpcRequestError('bridge/thread/queue/read', code, message, data),
      data.threadId,
    ),
  ).toBe(false);
});
