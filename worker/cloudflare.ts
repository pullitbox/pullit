// The few Cloudflare Workers runtime types this worker uses, so the repo needs no extra type package.

export interface KVNamespace {
  get(key: string): Promise<string | null>;
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts: { prefix: string; cursor?: string; limit?: number }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

export interface ScheduledEvent {
  cron: string;
  scheduledTime: number;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}
export interface DurableObjectState {
  storage: DurableObjectStorage;
}
export interface DurableObjectStub {
  fetch(url: string): Promise<Response>;
}
export interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}
