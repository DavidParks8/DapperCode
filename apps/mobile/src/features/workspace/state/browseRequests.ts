import type { HostBridgeApiClient } from '@bridge/client/client';
import type { FileSystemListResponse } from '@bridge/types/types';

const browseRequestsByApi = new WeakMap<
  HostBridgeApiClient,
  Map<string, Promise<FileSystemListResponse>>
>();

/** Single-flights identical directory listings so concurrent callers (e.g. opening the picker
 *  while a background revalidation is in flight) share one network request per bridge client. */
export function sharedBrowseRequest(
  api: HostBridgeApiClient,
  key: string,
  fetcher: () => Promise<FileSystemListResponse>,
): Promise<FileSystemListResponse> {
  let requests = browseRequestsByApi.get(api);
  if (!requests) {
    requests = new Map();
    browseRequestsByApi.set(api, requests);
  }
  const existing = requests.get(key);
  if (existing) {
    return existing;
  }
  const request = fetcher().finally(() => {
    if (requests?.get(key) === request) {
      requests.delete(key);
    }
  });
  requests.set(key, request);
  return request;
}
