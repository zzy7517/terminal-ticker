import { useEffect, useMemo, useRef, useState } from 'react';
import { BrainCircuit, Check, ChevronDown, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import {
  normalizeOriginConfig,
  originConfigForModel,
  originReasoningOptions,
  originRuntimeLabel,
  originSelectedModel,
  type OriginCatalog,
  type OriginModelOption,
} from '../../chat/originCatalog';
import { useAgentStore } from '../../stores/agentStore';
import { useMarketStore } from '../../stores/marketStore';
import {
  currentOriginCatalog,
  originCatalogReadyForConfig,
  useOriginCatalogStore,
} from '../../stores/origin/catalog';
import type {
  AgentRuntimeId,
  OriginDraftConfig,
} from '../../types';
import { ProviderIcon } from '../ProviderIcon';
import './OriginModelPicker.css';

interface OriginModelPickerProps {
  config: OriginDraftConfig;
  disabled?: boolean;
  onChange(config: OriginDraftConfig): void;
}

export function OriginModelPicker({ config, disabled = false, onChange }: OriginModelPickerProps) {
  const registry = useAgentStore((state) => state.modelRegistry);
  const registryLoading = useAgentStore((state) => state.modelRegistryLoading);
  const agentConfig = useMarketStore((state) => state.state?.config.agent ?? null);
  const catalogGeneration = useOriginCatalogStore((state) => state.generation);
  const catalogLoaded = useOriginCatalogStore((state) => state.loaded);
  const catalogLoading = useOriginCatalogStore((state) => state.loading);
  const [open, setOpen] = useState(false);
  const [familyView, setFamilyView] = useState<AgentRuntimeId | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!registry && !registryLoading) void useAgentStore.getState().refreshModelRegistry();
  }, [registry, registryLoading]);

  useEffect(() => {
    void useOriginCatalogStore.getState().ensureLoaded();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeMenu();
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const catalog = useMemo(
    () => currentOriginCatalog(),
    [agentConfig, catalogGeneration, registry],
  );
  const ready = Boolean(agentConfig && originCatalogReadyForConfig(config));
  const normalized = useMemo(
    () => ready ? normalizeOriginConfig(config, catalog) : config,
    [catalog, config, ready],
  );
  const selected = originSelectedModel(normalized, catalog);
  const reasoningOptions = originReasoningOptions(normalized, catalog);

  useEffect(() => {
    if (ready && !sameConfig(config, normalized)) onChange(normalized);
  }, [config, normalized, onChange, ready]);

  function closeMenu() {
    setOpen(false);
    setFamilyView(null);
  }

  return (
    <div className="origin-config-controls" ref={rootRef}>
      <div className="origin-model-picker">
        <button
          aria-expanded={open}
          aria-haspopup="menu"
          className="origin-config-trigger"
          disabled={disabled}
          onClick={() => {
            setOpen((value) => !value);
            setFamilyView(null);
          }}
          type="button"
        >
          <RuntimeIcon runtime={normalized.runtime} provider={selected?.iconProvider ?? normalized.provider} />
          <span>{selected?.label ?? originRuntimeLabel(normalized.runtime)}</span>
          {registryLoading || catalogLoading || !catalogLoaded || !ready
            ? <Loader2 className="spin" size={14} />
            : <ChevronDown size={14} />}
        </button>

        {open ? (
          <div
            aria-label={familyView ? `${originRuntimeLabel(familyView)} models` : 'Origin runtimes'}
            className="origin-model-menu"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                closeMenu();
              }
            }}
            role="menu"
          >
            {familyView ? (
              <ModelMenu
                catalog={catalog}
                config={normalized}
                runtime={familyView}
                onBack={() => setFamilyView(null)}
                onSelect={(option) => {
                  onChange(originConfigForModel(option));
                  closeMenu();
                }}
              />
            ) : (
              <FamilyMenu
                catalog={catalog}
                config={normalized}
                onSelect={setFamilyView}
              />
            )}
          </div>
        ) : null}
      </div>

      {reasoningOptions.length > 0 ? (
        <label className="origin-reasoning-control" title="Reasoning effort">
          <BrainCircuit aria-hidden="true" size={15} />
          <select
            aria-label="Reasoning effort"
            disabled={disabled}
            onChange={(event) => onChange({
              ...normalized,
              reasoningEffort: event.target.value || null,
            })}
            value={normalized.reasoningEffort ?? ''}
          >
            <option value="">Default</option>
            {reasoningOptions.map((effort) => (
              <option key={effort} value={effort}>{effortLabel(effort)}</option>
            ))}
          </select>
          <ChevronDown aria-hidden="true" size={13} />
        </label>
      ) : null}
    </div>
  );
}

function FamilyMenu({
  catalog,
  config,
  onSelect,
}: {
  catalog: OriginCatalog;
  config: OriginDraftConfig;
  onSelect(runtime: AgentRuntimeId): void;
}) {
  return <>
    <div className="origin-model-menu-title">Runtime</div>
    {catalog.families.map((family) => (
      <button
        className={`origin-model-menu-row${family.runtime === config.runtime ? ' active' : ''}`}
        disabled={!family.available}
        key={family.runtime}
        onClick={() => onSelect(family.runtime)}
        role="menuitem"
        title={family.unavailableReason ?? family.detail}
        type="button"
      >
        <RuntimeIcon runtime={family.runtime} />
        <span className="origin-model-menu-copy">
          <strong>{family.label}</strong>
          <small>{family.available ? `${family.models.length} models` : family.unavailableReason}</small>
        </span>
        <ChevronRight aria-hidden="true" size={15} />
      </button>
    ))}
  </>;
}

function ModelMenu({
  catalog,
  config,
  runtime,
  onBack,
  onSelect,
}: {
  catalog: OriginCatalog;
  config: OriginDraftConfig;
  runtime: AgentRuntimeId;
  onBack(): void;
  onSelect(option: OriginModelOption): void;
}) {
  const family = catalog.families.find((entry) => entry.runtime === runtime);
  const selected = originSelectedModel(config, catalog);
  return <>
    <button className="origin-model-menu-back" onClick={onBack} role="menuitem" type="button">
      <ChevronLeft aria-hidden="true" size={15} />
      {family?.label ?? originRuntimeLabel(runtime)}
    </button>
    <div className="origin-model-menu-list">
      {family?.models.map((model) => {
        const active = model.key === selected?.key;
        return (
          <button
            className={`origin-model-menu-row origin-model-option${active ? ' active' : ''}`}
            key={model.key}
            onClick={() => onSelect(model)}
            role="menuitemradio"
            aria-checked={active}
            type="button"
          >
            <RuntimeIcon runtime={model.runtime} provider={model.iconProvider} />
            <span className="origin-model-menu-copy">
              <strong>{model.label}</strong>
              <small>{model.model ?? 'Uses the local CLI default'}</small>
            </span>
            {active ? <Check aria-hidden="true" size={15} /> : null}
          </button>
        );
      })}
    </div>
  </>;
}

function RuntimeIcon({ runtime, provider }: { runtime: AgentRuntimeId; provider?: string | null }) {
  const iconProvider = provider || (runtime === 'claude-code' ? 'anthropic' : runtime);
  return <span className="origin-runtime-icon" aria-hidden="true"><ProviderIcon provider={iconProvider} size={16} /></span>;
}

function effortLabel(value: string): string {
  return value === 'xhigh' ? 'Extra high' : value.charAt(0).toUpperCase() + value.slice(1);
}

function sameConfig(left: OriginDraftConfig, right: OriginDraftConfig): boolean {
  return left.runtime === right.runtime
    && left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort;
}
