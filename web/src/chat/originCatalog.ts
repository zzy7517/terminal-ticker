import type {
  AgentModelRegistry,
  AgentRuntimeId,
  AgentRuntimeStatus,
  AgentConfig,
  ClaudeCodeModelsResponse,
  CursorModelsResponse,
  OriginDraftConfig,
} from '../types';

export interface OriginCatalogInput {
  registry: AgentModelRegistry | null;
  runtimes: AgentRuntimeStatus[];
  claudeModels: ClaudeCodeModelsResponse | null;
  cursorModels: CursorModelsResponse | null;
  agentConfig?: AgentConfig | null;
}

export interface OriginModelOption {
  key: string;
  runtime: AgentRuntimeId;
  provider: string | null;
  model: string | null;
  label: string;
  iconProvider: string | null;
  reasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  recommended: boolean;
  providerAliases: string[];
}

export interface OriginRuntimeFamily {
  runtime: AgentRuntimeId;
  label: string;
  detail: string;
  available: boolean;
  unavailableReason: string | null;
  models: OriginModelOption[];
}

export interface OriginCatalog {
  families: OriginRuntimeFamily[];
  defaultConfig: OriginDraftConfig | null;
}

const FAMILY_META: Record<AgentRuntimeId, Pick<OriginRuntimeFamily, 'label' | 'detail'>> = {
  pi: { label: 'Pi', detail: 'Integrated runtime' },
  'claude-code': { label: 'Claude Code', detail: 'Native local CLI' },
  cursor: { label: 'Cursor', detail: 'Native local CLI' },
};

export function buildOriginCatalog(input: OriginCatalogInput): OriginCatalog {
  const runtimeById = new Map(input.runtimes.map((runtime) => [runtime.id, runtime]));
  const piModels = buildPiModels(input.registry, input.agentConfig ?? null);
  const claudeModels = buildClaudeModels(input.claudeModels);
  const cursorModels = buildCursorModels(input.cursorModels);

  return {
    families: [
      family('pi', piModels, runtimeById.get('pi'), piModels.length > 0),
      family('claude-code', claudeModels, runtimeById.get('claude-code'), true),
      family('cursor', cursorModels, runtimeById.get('cursor'), true),
    ],
    defaultConfig: settingsDefaultConfig(input.agentConfig ?? null),
  };
}

/** Applies a partial draft change while invalidating fields owned by its previous selection. */
export function transitionOriginConfig(
  current: OriginDraftConfig,
  patch: Partial<OriginDraftConfig>,
): OriginDraftConfig {
  const runtime = patch.runtime ?? current.runtime;
  const runtimeChanged = runtime !== current.runtime;
  const providerChanged = patch.provider !== undefined && patch.provider !== current.provider;
  const modelChanged = patch.model !== undefined && patch.model !== current.model;
  const provider = runtime === 'pi'
    ? cleanNullable(patch.provider !== undefined
      ? patch.provider
      : runtimeChanged ? null : current.provider)
    : null;
  const model = cleanNullable(patch.model !== undefined
    ? patch.model
    : runtimeChanged || providerChanged ? null : current.model);
  const reasoningEffort = runtime === 'cursor'
    ? null
    : cleanNullable(patch.reasoningEffort !== undefined
      ? patch.reasoningEffort
      : runtimeChanged || providerChanged || modelChanged ? null : current.reasoningEffort);
  return { runtime, provider, model, reasoningEffort };
}

export function normalizeOriginConfig(
  config: OriginDraftConfig,
  catalog: OriginCatalog,
): OriginDraftConfig {
  const requestedFamily = catalog.families.find((family) => family.runtime === config.runtime);
  if (!requestedFamily?.available) return { ...config };
  const family = requestedFamily;

  const requestedOption = findRequestedModel(family, config);
  const defaultConfig = catalog.defaultConfig?.runtime === family.runtime
    ? catalog.defaultConfig
    : null;
  const defaultOption = defaultConfig ? findRequestedModel(family, defaultConfig) : undefined;
  const option = requestedOption ?? defaultOption ?? family.models[0];
  if (!option) return { runtime: family.runtime, provider: null, model: null, reasoningEffort: null };

  const requestedEffort = family.runtime === config.runtime && requestedOption
    ? validDefaultEffort(config.reasoningEffort, option.reasoningEfforts)
    : null;
  const defaultEffort = !requestedOption && defaultOption && defaultConfig
    ? validDefaultEffort(defaultConfig.reasoningEffort, option.reasoningEfforts)
      ?? option.defaultReasoningEffort
    : null;
  return optionConfig(
    option,
    requestedEffort ?? defaultEffort,
  );
}

export function originReasoningOptions(
  config: OriginDraftConfig,
  catalog: OriginCatalog,
): string[] {
  return originSelectedModel(config, catalog)?.reasoningEfforts ?? [];
}

export function originConfigForModel(option: OriginModelOption): OriginDraftConfig {
  return optionConfig(option, option.defaultReasoningEffort);
}

export function originRuntimeLabel(runtime: AgentRuntimeId): string {
  return FAMILY_META[runtime].label;
}

export function originSelectedModel(
  config: OriginDraftConfig,
  catalog: OriginCatalog,
): OriginModelOption | null {
  const family = catalog.families.find((candidate) => candidate.runtime === config.runtime);
  return findRequestedModel(family, config) ?? null;
}

function family(
  runtime: AgentRuntimeId,
  models: OriginModelOption[],
  status: AgentRuntimeStatus | undefined,
  hasUsableSelection: boolean,
): OriginRuntimeFamily {
  const runtimeAvailable = status?.available ?? true;
  return {
    runtime,
    ...FAMILY_META[runtime],
    available: runtimeAvailable && hasUsableSelection,
    unavailableReason: runtimeAvailable
      ? (hasUsableSelection ? null : 'No configured models')
      : status?.error || 'Runtime unavailable',
    models,
  };
}

function buildPiModels(
  registry: AgentModelRegistry | null,
  agentConfig: AgentConfig | null,
): OriginModelOption[] {
  if (!registry) return [];
  const providerById = new Map(registry.providers.map((provider) => [provider.providerId, provider]));
  return registry.models
    .filter((model) => model.selected && model.runnable)
    .map((model) => {
      const provider = providerById.get(model.providerId);
      const configProviderId = provider?.configProviderId || model.providerId;
      const reasoningEfforts = cleanEfforts(model.supportedReasoningEfforts);
      const isSettingsDefault = Boolean(agentConfig
        && model.id === agentConfig.model
        && [model.providerId, configProviderId].includes(agentConfig.provider));
      const configuredEffort = agentConfig?.providerProfiles[configProviderId]
        ?.modelEfforts[model.id]
        || (isSettingsDefault ? agentConfig?.reasoningEffort : null);
      return {
        key: `pi:${model.providerId}:${model.id}`,
        runtime: 'pi' as const,
        provider: configProviderId,
        model: model.id,
        label: model.name || model.id,
        iconProvider: model.providerId,
        reasoningEfforts,
        defaultReasoningEffort: validDefaultEffort(configuredEffort ?? null, reasoningEfforts),
        recommended: isSettingsDefault,
        providerAliases: cleanAliases([model.providerId, configProviderId]),
      };
    });
}

function settingsDefaultConfig(agentConfig: AgentConfig | null): OriginDraftConfig | null {
  if (!agentConfig) return null;
  return {
    runtime: 'pi',
    provider: agentConfig.provider.trim() || null,
    model: agentConfig.model.trim() || null,
    reasoningEffort: agentConfig.reasoningEffort.trim() || null,
  };
}

function buildClaudeModels(response: ClaudeCodeModelsResponse | null): OriginModelOption[] {
  return [
    nativeDefault('claude-code', 'anthropic'),
    ...(response?.models ?? []).map((model) => ({
      key: `claude-code:${model.id}`,
      runtime: 'claude-code' as const,
      provider: null,
      model: model.id,
      label: model.label || model.id,
      iconProvider: model.provider || 'anthropic',
      reasoningEfforts: cleanEfforts(model.thinking.supportedLevels),
      defaultReasoningEffort: validDefaultEffort(
        model.thinking.defaultLevel,
        model.thinking.supportedLevels,
      ),
      recommended: Boolean(model.default),
      providerAliases: [],
    })),
  ];
}

function buildCursorModels(response: CursorModelsResponse | null): OriginModelOption[] {
  return [
    nativeDefault('cursor', 'cursor'),
    ...(response?.models ?? []).map((model) => ({
      key: `cursor:${model.id}`,
      runtime: 'cursor' as const,
      provider: null,
      model: model.id,
      label: model.label || model.id,
      iconProvider: model.provider || 'cursor',
      reasoningEfforts: [],
      defaultReasoningEffort: null,
      recommended: Boolean(model.default),
      providerAliases: [],
    })),
  ];
}

function nativeDefault(runtime: 'claude-code' | 'cursor', iconProvider: string): OriginModelOption {
  return {
    key: `${runtime}:default`,
    runtime,
    provider: null,
    model: null,
    label: 'Local CLI default',
    iconProvider,
    reasoningEfforts: [],
    defaultReasoningEffort: null,
    recommended: false,
    providerAliases: [],
  };
}

function findRequestedModel(
  family: OriginRuntimeFamily | undefined,
  config: OriginDraftConfig,
): OriginModelOption | undefined {
  if (!family) return undefined;
  if (family.runtime !== 'pi') {
    return family.models.find((model) => model.model === config.model);
  }

  const exact = family.models.find((model) => (
    model.model === config.model
    && model.provider === config.provider
  ));
  if (exact) return exact;

  const alias = family.models.find((model) => (
    model.model === config.model
    && config.provider != null
    && modelProviderAliases(model).includes(config.provider)
  ));
  if (alias) return alias;

  if (config.provider == null) {
    return family.models.find((model) => model.model === config.model);
  }
  return undefined;
}

function optionConfig(
  option: OriginModelOption,
  reasoningEffort: string | null,
): OriginDraftConfig {
  return {
    runtime: option.runtime,
    provider: option.runtime === 'pi' ? option.provider : null,
    model: option.model,
    reasoningEffort,
  };
}

function modelProviderAliases(option: OriginModelOption): string[] {
  return option.providerAliases;
}

function cleanEfforts(efforts: string[]): string[] {
  return [...new Set(efforts.map((effort) => effort.trim()).filter(Boolean))];
}

function cleanAliases(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function validDefaultEffort(value: string | null, supported: string[]): string | null {
  const cleaned = value?.trim() || null;
  return cleaned && cleanEfforts(supported).includes(cleaned) ? cleaned : null;
}

function cleanNullable(value: string | null): string | null {
  return value?.trim() || null;
}
