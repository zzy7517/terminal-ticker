import { describe, expect, it } from 'vitest';
import type {
  AgentModelRegistry,
  AgentRuntimeStatus,
  ClaudeCodeModelsResponse,
  CursorModelsResponse,
  OriginDraftConfig,
} from '../types';
import {
  buildOriginCatalog,
  normalizeOriginConfig,
  originReasoningOptions,
  originRuntimeLabel,
  originSelectedModel,
} from './originCatalog';

const registry: AgentModelRegistry = {
  generation: 1,
  providers: [
    provider('openai', 'openai', 'OpenAI'),
    provider('anthropic', 'anthropic', 'Anthropic'),
  ],
  models: [
    model('openai', 'hidden', 'Hidden', { selected: false }),
    model('openai', 'offline', 'Offline', { runnable: false }),
    model('openai', 'gpt-5.4', 'GPT-5.4', {
      efforts: ['low', 'medium', 'high'],
    }),
    model('anthropic', 'claude-sonnet', 'Claude Sonnet'),
  ],
};

const runtimes: AgentRuntimeStatus[] = [
  runtime('pi', true),
  runtime('claude-code', true),
  runtime('cursor', true),
];

const claudeModels: ClaudeCodeModelsResponse = {
  supportsCustomModel: true,
  models: [
    {
      id: 'claude-opus',
      label: 'Claude Opus',
      provider: 'anthropic',
      default: true,
      thinking: {
        supportedLevels: ['low', 'high'],
        defaultLevel: 'high',
      },
    },
  ],
};

const cursorModels: CursorModelsResponse = {
  supportsCustomModel: true,
  models: [
    { id: 'composer-1.5', label: 'Composer 1.5', provider: 'cursor', default: true },
  ],
};

describe('Origin catalog', () => {
  it('builds provider-first families with only selected and runnable Pi models', () => {
    const catalog = buildOriginCatalog({ registry, runtimes, claudeModels, cursorModels });

    expect(catalog.families.map((family) => [family.runtime, family.available])).toEqual([
      ['pi', true],
      ['claude-code', true],
      ['cursor', true],
    ]);
    expect(catalog.families[0]?.models.map((entry) => entry.model)).toEqual([
      'gpt-5.4',
      'claude-sonnet',
    ]);
    expect(catalog.families[1]?.models[0]).toMatchObject({
      model: null,
      label: 'Local CLI default',
    });
    expect(catalog.families[2]?.models[0]).toMatchObject({
      model: null,
      label: 'Local CLI default',
    });
  });

  it('resolves an empty config to the first selected and runnable Pi model', () => {
    const catalog = buildOriginCatalog({ registry, runtimes, claudeModels, cursorModels });

    expect(normalizeOriginConfig(config('pi'), catalog)).toEqual({
      runtime: 'pi',
      provider: 'openai',
      model: 'gpt-5.4',
      reasoningEffort: null,
    });
  });

  it('preserves a remembered valid model and reasoning effort', () => {
    const catalog = buildOriginCatalog({ registry, runtimes, claudeModels, cursorModels });
    const remembered: OriginDraftConfig = {
      runtime: 'claude-code',
      provider: null,
      model: 'claude-opus',
      reasoningEffort: 'low',
    };

    expect(normalizeOriginConfig(remembered, catalog)).toEqual(remembered);
    expect(originReasoningOptions(remembered, catalog)).toEqual(['low', 'high']);
    expect(originSelectedModel(remembered, catalog)?.label).toBe('Claude Opus');
    expect(originRuntimeLabel('claude-code')).toBe('Claude Code');
  });

  it('stores the logical config provider while accepting the Pi wire provider as an alias', () => {
    const codexRegistry: AgentModelRegistry = {
      generation: 2,
      providers: [provider('openai-codex', 'codex', 'Codex')],
      models: [model('openai-codex', 'gpt-5.4-mini', 'GPT-5.4 Mini')],
    };
    const catalog = buildOriginCatalog({
      registry: codexRegistry, runtimes, claudeModels, cursorModels,
    });

    expect(catalog.families[0]?.models[0]).toMatchObject({
      provider: 'codex',
      iconProvider: 'openai-codex',
      providerAliases: ['openai-codex', 'codex'],
    });
    expect(normalizeOriginConfig({
      runtime: 'pi', provider: 'openai-codex', model: 'gpt-5.4-mini', reasoningEffort: null,
    }, catalog)).toEqual({
      runtime: 'pi', provider: 'codex', model: 'gpt-5.4-mini', reasoningEffort: null,
    });
  });

  it('normalizes invalid model and effort values deterministically', () => {
    const catalog = buildOriginCatalog({ registry, runtimes, claudeModels, cursorModels });

    expect(normalizeOriginConfig({
      runtime: 'pi',
      provider: 'legacy-provider',
      model: 'removed-model',
      reasoningEffort: 'ultra',
    }, catalog)).toEqual({
      runtime: 'pi',
      provider: 'openai',
      model: 'gpt-5.4',
      reasoningEffort: null,
    });

    expect(normalizeOriginConfig({
      runtime: 'claude-code',
      provider: 'stale-provider',
      model: 'removed-model',
      reasoningEffort: 'high',
    }, catalog)).toEqual({
      runtime: 'claude-code',
      provider: null,
      model: null,
      reasoningEffort: null,
    });
  });

  it('preserves an unavailable runtime until the user explicitly changes it', () => {
    const catalog = buildOriginCatalog({
      registry,
      runtimes: [runtime('pi', true), runtime('claude-code', false), runtime('cursor', true)],
      claudeModels,
      cursorModels,
    });

    const selected: OriginDraftConfig = {
      runtime: 'claude-code',
      provider: null,
      model: 'claude-opus',
      reasoningEffort: 'high',
    };

    expect(normalizeOriginConfig(selected, catalog)).toEqual(selected);
  });
});

function config(runtimeId: OriginDraftConfig['runtime']): OriginDraftConfig {
  return { runtime: runtimeId, provider: null, model: null, reasoningEffort: null };
}

function provider(
  providerId: string,
  configProviderId: string,
  name: string,
): AgentModelRegistry['providers'][number] {
  return {
    providerId,
    configProviderId,
    name,
    enabled: true,
    api: 'responses',
    requiresAuth: false,
    baseUrlConfigured: true,
    authConfigured: true,
    discoverable: true,
    runnable: true,
  };
}

function model(
  providerId: string,
  id: string,
  name: string,
  overrides: { selected?: boolean; runnable?: boolean; efforts?: string[] } = {},
): AgentModelRegistry['models'][number] {
  return {
    providerId,
    id,
    name,
    api: 'responses',
    reasoning: Boolean(overrides.efforts?.length),
    supportedReasoningEfforts: overrides.efforts ?? [],
    input: ['text'],
    contextWindow: 128_000,
    maxTokens: 16_000,
    selected: overrides.selected ?? true,
    source: 'pi',
    runnable: overrides.runnable ?? true,
  };
}

function runtime(id: AgentRuntimeStatus['id'], available: boolean): AgentRuntimeStatus {
  return {
    id,
    available,
    version: null,
    error: available ? null : 'Unavailable',
    capabilities: {
      streaming: true,
      abort: true,
      resume: true,
      imageInput: true,
      toolProgress: true,
    },
  };
}
