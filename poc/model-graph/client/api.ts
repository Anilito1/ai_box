import type { AddProviderRequest, AppState, ClientEvent, DeclareRequest, RunRequest } from '../shared/protocol';

// The page's calls to the POC's local server. Each carries the token the server wrote into the page.

const token = document.querySelector<HTMLMetaElement>('meta[name="poc-token"]')?.content ?? '';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: { 'x-poc-token': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const answer = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !answer) throw new Error(answer?.error ?? `Le serveur du POC a répondu ${res.status}.`);
  return answer;
}

export const getState = () => call<AppState>('GET', '/api/state');
export const addProvider = (p: AddProviderRequest) => call<AppState>('POST', '/api/providers', p);
export const removeProvider = (id: string) => call<AppState>('DELETE', `/api/providers/${id}`);
export const declareModel = (id: string, d: DeclareRequest) => call<AppState>('POST', `/api/providers/${id}/declare`, d);

/** Runs a graph; the events arrive one by one while the server writes its answer. Aborting the signal stops the run. */
export async function runGraph(request: RunRequest, onEvent: (event: ClientEvent) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch('/api/run', { method: 'POST', headers: { 'x-poc-token': token, 'content-type': 'application/json' }, body: JSON.stringify(request), signal });
  if (!res.ok || !res.body) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `Le serveur du POC a répondu ${res.status}.`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += value;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) onEvent(JSON.parse(line) as ClientEvent);
    }
  } finally {
    // Left early (an event the page could not show): the server hears it and stops the run.
    await reader.cancel().catch(() => undefined);
  }
}
