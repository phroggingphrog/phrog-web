import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The caller behind the current request, so that a run record written deep inside a provider can say who
 * asked for it. AsyncLocalStorage is the right tool: one process serves many concurrent requests and a
 * module-level variable would attribute them to whichever caller set it last.
 */
const store = new AsyncLocalStorage<{ client: string }>();

export function runWithClient<T>(client: string, fn: () => T): T {
  return store.run({ client }, fn);
}

export function enterClient(client: string): void {
  store.enterWith({ client });
}

export function currentClient(): string | undefined {
  return store.getStore()?.client;
}
