export type AgentRuntimeId = "pi" | "claude-code";

export interface RuntimeCapabilities {
  streaming: boolean;
  abort: boolean;
  steer: boolean;
  resume: boolean;
  forkFromMessage: boolean;
  cloneFromMessage: boolean;
  imageInput: boolean;
}

export type RuntimeEvent =
  | { type: "run-start"; nativeSessionId?: string }
  | { type: "text-delta"; delta: string }
  | { type: "tool-start"; callId: string; name: string; args: Record<string, unknown> }
  | { type: "tool-end"; callId: string; output: string; isError: boolean }
  | { type: "usage"; model: string; input: number; output: number; cacheRead: number; cacheWrite: number }
  | { type: "runtime-error"; code: string; message: string }
  | { type: "run-end"; nativeSessionId?: string; result: string; isError: boolean };

export interface RuntimeRunResult {
  output: string;
  nativeSessionId?: string;
  error: string | null;
  errorCode?: string | null;
}

export interface ActiveRuntimeRun {
  readonly runtime: AgentRuntimeId;
  readonly capabilities: RuntimeCapabilities;
  readonly nativeSessionId?: string;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
  readonly result: Promise<RuntimeRunResult>;
  abort(): void | Promise<void>;
}

/** Minimal Runtime-neutral control surface retained by the API while a run is active. */
export interface ActiveRunHandle {
  abort(): void | Promise<void>;
  steer?(message: unknown): void | Promise<void>;
}

export const PI_SDK_CAPABILITIES: RuntimeCapabilities = {
  streaming: true,
  abort: true,
  steer: true,
  resume: true,
  forkFromMessage: true,
  cloneFromMessage: true,
  imageInput: true,
};
