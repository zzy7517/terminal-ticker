/** Agent 定义、Runtime、Session 与流式事件 DTO。 */
import type { MarketState } from './market';

export interface LoopToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LoopToolResult {
  callId: string;
  name: string;
  output: string;
  error: boolean;
}

export interface LoopStep {
  stepType: 'tool_call' | 'tool_result';
  timestamp: number;
  toolCall?: LoopToolCall;
  toolResult?: LoopToolResult;
}

export interface LoopResult {
  content: string;
  steps: LoopStep[];
  messages: Array<{
    role: string;
    content: string;
    metadata: Record<string, unknown> | null;
    error: string | null;
  }>;
  iterations: number;
  totalTokens: number;
  promptTokens?: number;
  finished: boolean;
  error: string | null;
}

export interface AgentResponse {
  available: boolean;
  provider: string;
  model: string;
  updatedAt: string;
  content: string;
  error: string | null;
  loopResult: LoopResult | null;
}

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentMessageMetadata {
  toolCalls?: AgentToolCall[];
  toolCallId?: string;
  toolName?: string;
  error?: boolean;
  [key: string]: unknown;
}

import type { AgentDefinition, AgentRuntimeId } from '../../../tradex/contracts';

export type { AgentDefinition, AgentRuntimeId } from '../../../tradex/contracts';

export interface RuntimeSession {
  id: string;
  title: string;
  provider: string | null;
  model: string;
  createdAt: string;
  updatedAt: string;
  reasoningEffort: string | null;
  runtime: AgentRuntimeId;
  capabilities: AgentRuntimeStatus['capabilities'];
}

export interface AgentSession extends RuntimeSession {
  active: boolean;
  apiMode: string | null;
  agentId: string;
  agentName: string;
}

export interface OriginSession extends RuntimeSession {
  owner: { kind: 'origin' };
  workspace: string;
  systemPrompt: string;
}

export interface ImageAttachment {
  data: string;
  mimeType: string;
}

/** Immutable runtime selection captured when a draft becomes an Origin Session. */
export interface OriginDraftConfig {
  runtime: AgentRuntimeId;
  provider: string | null;
  model: string | null;
  reasoningEffort: string | null;
}

export interface OriginDraft {
  materializationId: string;
  config: OriginDraftConfig;
  message: string;
  images: ImageAttachment[];
  skillNames: string[];
  phase: 'editing' | 'starting';
}

export type OriginSelection =
  | { kind: 'draft'; draft: OriginDraft }
  | { kind: 'session'; sessionId: string };

export interface StartOriginInput {
  materializationId: string;
  config: OriginDraftConfig;
  message: string;
  images?: ImageAttachment[];
  skillNames?: string[];
}

export type StartOriginStreamResult =
  | { kind: 'streamed' }
  | { kind: 'already-materialized'; sessionId: string };

export interface OriginSessionSummary extends OriginSession {
  messageCount: number;
  preview: string;
  run?: AgentSessionRun;
}

export interface OriginSessionResponse {
  session: OriginSession | null;
  messages: AgentMessage[];
  run?: AgentSessionRun;
}

export interface OriginSessionHistoryResponse {
  sessions: OriginSessionSummary[];
}

export interface AgentSkillSummary {
  name: string;
  displayName: string;
  description: string;
}

export type AgentDefinitionInput = Omit<AgentDefinition, 'builtIn'>;

/** Identity-only patch: display name, signature (description), avatar seed. */
export type AgentIdentityPatch = {
  name?: string;
  description?: string;
  avatarSeed?: string | null;
};

export interface AgentRuntimeStatus {
  id: 'pi' | 'claude-code' | 'cursor';
  available: boolean;
  executablePath?: string;
  version: string | null;
  error: string | null;
  capabilities: {
    streaming: boolean;
    abort: boolean;
    resume: boolean;
    imageInput: boolean;
    toolProgress: boolean;
  };
}

export interface ClaudeCodeModelsResponse {
  models: Array<{
    id: string;
    label: string;
    provider: string;
    default?: boolean;
    thinking: { supportedLevels: string[]; defaultLevel: string | null };
  }>;
  supportsCustomModel: boolean;
}

export interface CursorModelsResponse {
  models: Array<{
    id: string;
    label: string;
    provider: string;
    default?: boolean;
  }>;
  supportsCustomModel: boolean;
  available?: boolean;
  error?: string | null;
}

export interface AgentSessionRun {
  sessionId: string;
  runId: string | null;
  status: 'idle' | 'running' | 'error';
  activeFlags: string[];
  lastSeq: number;
  error: string | null;
}

export interface AgentSessionSummary extends AgentSession {
  messageCount: number;
  preview: string;
  run?: AgentSessionRun;
}

export interface AgentMessage {
  id: string | number;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'toolResult';
  content: string;
  createdAt: string;
  metadata: AgentMessageMetadata | null;
  error: string | null;
}

/** A client-side follow-up queued while the Session has an active run. */
export interface QueuedFollowUp {
  /** Stable client-side id for React keys. */
  id: string;
  content: string;
  images: Array<{ data: string; mimeType: string }>;
  createdAt: string;
}

export interface AgentSessionResponse {
  session: AgentSession | null;
  messages: AgentMessage[];
  run?: AgentSessionRun;
}

export interface AgentSessionHistoryResponse {
  sessions: AgentSessionSummary[];
  preloadedSessions?: AgentSessionResponse[];
}

export interface AgentSessionMutationResponse {
  session: AgentSessionResponse;
  history: AgentSessionHistoryResponse;
  state: MarketState;
}

type RuntimeSessionUpdate<SessionResponse, HistoryResponse, State> = {
  type: 'session_update';
  session: SessionResponse;
  history: HistoryResponse;
} & (State extends undefined ? { state?: undefined } : { state: State });

export type RuntimeSessionStreamPayload<SessionResponse, HistoryResponse, State = undefined> =
  | { type: 'agent_start' }
  | { type: 'turn_start'; iteration: number }
  | { type: 'turn_end'; iteration: number }
  | { type: 'message_start' | 'message_update' | 'message_end'; message: Partial<AgentMessage> & { clientId?: string; role: AgentMessage['role']; content: string; metadata?: AgentMessageMetadata | null; error?: string | null }; delta?: string }
  | { type: 'tool_execution_start'; toolCall: AgentToolCall }
  | { type: 'tool_execution_end'; toolCall: AgentToolCall; toolResult: LoopToolResult }
  | { type: 'agent_end'; error: string | null; errorCode?: string | null }
  | { type: 'error'; error: string }
  | RuntimeSessionUpdate<SessionResponse, HistoryResponse, State>;

export type AgentStreamPayload = RuntimeSessionStreamPayload<AgentSessionResponse, AgentSessionHistoryResponse, MarketState>;

export type RuntimeSessionStreamEvent<SessionResponse, HistoryResponse, State = undefined> = {
  sessionId: string;
  runId: string;
  seq: number;
  event: RuntimeSessionStreamPayload<SessionResponse, HistoryResponse, State>;
};

export type AgentStreamEvent = RuntimeSessionStreamEvent<AgentSessionResponse, AgentSessionHistoryResponse, MarketState>;
export type OriginStreamEvent = RuntimeSessionStreamEvent<OriginSessionResponse, OriginSessionHistoryResponse>;

export interface AgentModelOption {
  slug: string;
  displayName: string;
  description: string;
  visibility: string;
  supportedInApi: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: string[];
  contextWindow: number | null;
  preferWebsockets: boolean;
  custom?: boolean;
}

export interface AgentModelsResponse {
  provider: string;
  apiMode: string;
  activeModel: string;
  models: AgentModelOption[];
}

export interface AgentModelRegistryProvider {
  providerId: string;
  configProviderId: string;
  name: string;
  enabled: boolean;
  api: string;
  requiresAuth: boolean;
  baseUrlConfigured: boolean;
  authConfigured: boolean;
  discoverable: boolean;
  runnable: boolean;
}

export interface AgentModelRegistryModel {
  providerId: string;
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  supportedReasoningEfforts: string[];
  input: string[];
  contextWindow: number;
  maxTokens: number;
  selected: boolean;
  source: 'pi' | 'custom' | 'legacy';
  runnable: boolean;
}

export interface AgentModelRegistry {
  generation: number;
  providers: AgentModelRegistryProvider[];
  models: AgentModelRegistryModel[];
}
