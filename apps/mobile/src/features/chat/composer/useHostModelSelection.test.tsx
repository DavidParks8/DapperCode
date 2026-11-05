import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type { ModelHostTransport, SetDefaultModelResult } from '@shared/hostModels';
import { useHostModelSelection } from './useHostModelSelection';

function deferred() {
  let resolve!: (value: SetDefaultModelResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<SetDefaultModelResult>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function mountSelection(transport: ModelHostTransport) {
  let select!: ReturnType<typeof useHostModelSelection>;
  function Harness(props: { transport: ModelHostTransport; scope: string }) {
    select = useHostModelSelection(props.transport, props.scope);
    return null;
  }
  let tree!: ReactTestRenderer;
  act(() => {
    tree = renderer.create(<Harness transport={transport} scope="local:new" />);
  });
  return {
    select: (...args: Parameters<typeof select>) => select(...args),
    update(nextTransport: ModelHostTransport, scope: string) {
      act(() => {
        tree.update(<Harness transport={nextTransport} scope={scope} />);
      });
    },
    unmount() {
      act(() => tree.unmount());
    },
  };
}

test('only an acknowledged default commits, overlapping choices wait, and rejection permits retry', async () => {
  const response = deferred();
  const request = jest
    .fn()
    .mockReturnValueOnce(response.promise)
    .mockResolvedValue({ modelId: 'secondary' });
  const h = mountSelection({ request });
  const apply = jest.fn();
  const error = jest.fn();
  expect(h.select('secondary', apply, error)).toBe(true);
  expect(h.select('third', apply, error)).toBe(false);
  expect(request).toHaveBeenCalledWith('model/default/set', { modelId: 'secondary' });
  expect(apply).not.toHaveBeenCalled();
  const failure = new Error('Persistence failed');
  await act(async () => {
    response.reject(failure);
    await response.promise.catch(() => undefined);
  });
  expect(apply).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith(failure);
  await act(async () => {
    expect(h.select('secondary', apply, error)).toBe(true);
  });
  expect(apply).toHaveBeenCalledTimes(1);
  h.unmount();
});

test.each(['chat', 'profile', 'unmount'])(
  'an old %s completion cannot commit or release a newer selection',
  async (change) => {
    const old = deferred();
    const next = deferred();
    const transport = {
      request: jest.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise),
    };
    const h = mountSelection(transport);
    const oldApply = jest.fn();
    const nextApply = jest.fn();
    const error = jest.fn();
    h.select('secondary', oldApply, error);
    if (change === 'unmount') {
      h.unmount();
    } else {
      h.update(
        change === 'profile' ? { request: jest.fn().mockReturnValue(next.promise) } : transport,
        `${change}:different`,
      );
      h.select('secondary', nextApply, error);
    }
    await act(async () => {
      old.resolve({ modelId: 'secondary' });
      await old.promise;
    });
    expect(oldApply).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    if (change !== 'unmount') {
      expect(h.select('third', jest.fn(), error)).toBe(false);
      await act(async () => {
        next.resolve({ modelId: 'secondary' });
        await next.promise;
      });
      expect(nextApply).toHaveBeenCalledTimes(1);
      h.unmount();
    }
  },
);

test('a mismatched host acknowledgment is a visible failure, never success', async () => {
  const h = mountSelection({ request: jest.fn().mockResolvedValue({ modelId: 'wrong' }) });
  const apply = jest.fn();
  const error = jest.fn();
  await act(async () => {
    h.select('secondary', apply, error);
  });
  expect(apply).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith(new Error('The host did not confirm the selected model.'));
  h.unmount();
});
