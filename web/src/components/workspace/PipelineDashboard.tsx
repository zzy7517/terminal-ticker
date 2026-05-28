/**
 * PipelineDashboard — shows recent pipeline runs and expanded detail.
 */

import { useState, useEffect } from "react";
import { usePipelineStore } from "../../stores/pipelineStore";
import { useMarketStore } from "../../stores/marketStore";
import { useUiStore } from "../../stores/uiStore";
import type { PipelineRunSummary } from "../../types";
import "./PipelinePanels.css";

const ACTION_ICONS: Record<string, string> = {
  OPEN_LONG: "✅ LONG",
  OPEN_SHORT: "✅ SHORT",
  CLOSE: "🔄 CLOSE",
  HOLD: "⏸ HOLD",
  PASS: "⏸ PASS",
};

const SIGNAL_CLASSES: Record<string, string> = {
  LONG: "pipeline-signal--long",
  SHORT: "pipeline-signal--short",
  NEUTRAL: "pipeline-signal--neutral",
};

function ConvictionBar({ value, signal }: { value: number; signal: string }) {
  const tone = signal === "LONG" ? "long" : signal === "SHORT" ? "short" : "neutral";
  return (
    <span className="pipeline-meter" aria-label={`conviction ${value}%`}>
      <span className={`pipeline-meter-fill pipeline-meter-fill--${tone}`} style={{ width: `${value}%` }} />
    </span>
  );
}

function RunCard({ run, onClick }: { run: PipelineRunSummary; onClick: () => void }) {
  const time = new Date(run.startedAt).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
  const action = run.decision?.action ?? "PASS";
  const label = ACTION_ICONS[action] ?? action;
  const duration = (run.durationMs / 1000).toFixed(1);

  return (
    <button className="pipeline-row" type="button" onClick={onClick}>
      <span className="pipeline-row-cell-time">{time}</span>
      <span className="pipeline-row-cell-symbol">{run.instrumentKey.split(":").pop()}</span>
      <span className="pipeline-row-cell-trigger">{run.triggeredBy}</span>
      <span className="pipeline-row-cell-action">{label}</span>
      {run.decision && (
        <span className="pipeline-row-cell-count">{run.decision.modulesAgreeing}/{run.decision.modulesTotal}</span>
      )}
      <span className="pipeline-row-cell-duration">{duration}s</span>
    </button>
  );
}

function RunDetail({ run }: { run: PipelineRunSummary }) {
  return (
    <div className="pipeline-detail">
      <div className="pipeline-muted">
        L1 Regime: {run.regime.market} │ Vol:{run.regime.volatility} │ {run.regime.trend}
      </div>

      <div className="pipeline-module-list">
        <div className="pipeline-muted pipeline-strong">L2 Modules</div>
        {run.moduleResults.map((m) => {
          const signal = m.output.signal;
          return (
            <div key={m.moduleId} className="pipeline-module-row">
              <span className="pipeline-module-name">{m.moduleId}</span>
              <span className={`pipeline-module-signal ${SIGNAL_CLASSES[signal]}`}>
                {signal === "LONG" ? "▶" : signal === "SHORT" ? "◀" : "•"} {signal}
              </span>
              <ConvictionBar value={m.output.conviction} signal={signal} />
              <span className="pipeline-module-conviction">{m.output.conviction}%</span>
              <span className="pipeline-module-weight">w={m.darwinWeight.toFixed(1)}</span>
            </div>
          );
        })}
      </div>

      {run.decision && (
        <div className="pipeline-decision">
          <div className="pipeline-decision-head">
            <span className="pipeline-strong">{run.decision.action}</span>
            {run.decision.survivedCRO ? (
              <span className="pipeline-status--ok">CRO ✓</span>
            ) : (
              <span className="pipeline-status--bad">CRO ✗</span>
            )}
          </div>
          {run.decision.croObjections.length > 0 && (
            <div className="pipeline-warning">⚠ {run.decision.croObjections[0]}</div>
          )}
          <div className="pipeline-muted">{run.decision.reasoning}</div>
        </div>
      )}
    </div>
  );
}

export function PipelineDashboard() {
  const recentRuns = usePipelineStore((s) => s.recentRuns);
  const marketState = useMarketStore((s) => s.state);
  const selectedKey = useUiStore((s) => s.selectedKey);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRuns = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/pipeline/runs?limit=20");
      if (!response.ok) throw new Error(`Load failed (${response.status})`);
      const data = await response.json();
      usePipelineStore.getState().setRecentRuns(data.runs ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load pipeline runs");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadRuns();
  }, []);

  const selectedRun = recentRuns.find((r) => r.id === selectedId);
  const triggerInstrumentKey = selectedKey && marketState?.quotes[selectedKey]
    ? selectedKey
    : marketState?.instruments.find((instrument) => instrument.analysable)?.key;

  const handleTrigger = async () => {
    if (!triggerInstrumentKey || triggering) return;
    setTriggering(true);
    setError(null);
    try {
      const response = await fetch("/api/pipeline/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instrumentKey: triggerInstrumentKey }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(data.error ?? `Trigger failed (${response.status})`));
      if (data.run?.id) setSelectedId(data.run.id);
      await loadRuns();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Trigger failed");
    } finally {
      setTriggering(false);
    }
  };

  return (
    <div className="pipeline-panel">
      <div className="pipeline-panel-header">
        <span className="pipeline-panel-title">Pipeline Runs</span>
        <div className="pipeline-panel-actions">
          {triggerInstrumentKey && <span className="pipeline-trigger-target">{triggerInstrumentKey}</span>}
          <button type="button" onClick={handleTrigger} className="pipeline-panel-action" disabled={!triggerInstrumentKey || triggering}>
            {triggering ? "Running…" : "Trigger ▶"}
          </button>
        </div>
      </div>

      <div className="pipeline-list">
        {error && <div className="pipeline-error">⚠ {error}</div>}
        {loading && <div className="pipeline-loading">Loading...</div>}
        {recentRuns.map((run) => (
          <RunCard key={run.id} run={run} onClick={() => setSelectedId(run.id === selectedId ? null : run.id)} />
        ))}
        {!loading && recentRuns.length === 0 && (
          <div className="pipeline-empty">No pipeline runs yet. Trigger one or wait for cron.</div>
        )}
      </div>

      {selectedRun && (
        <div className="pipeline-detail-wrap">
          <RunDetail run={selectedRun} />
        </div>
      )}
    </div>
  );
}
