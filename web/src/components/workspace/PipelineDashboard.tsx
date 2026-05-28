/**
 * PipelineDashboard — shows recent pipeline runs and expanded detail.
 */

import { useState, useEffect } from "react";
import { usePipelineStore } from "../../stores/pipelineStore";
import { useMarketStore } from "../../stores/marketStore";
import { useUiStore } from "../../stores/uiStore";
import type { PipelineRunSummary } from "../../types";

const ACTION_ICONS: Record<string, string> = {
  OPEN_LONG: "✅ LONG",
  OPEN_SHORT: "✅ SHORT",
  CLOSE: "🔄 CLOSE",
  HOLD: "⏸ HOLD",
  PASS: "⏸ PASS",
};

const SIGNAL_COLORS: Record<string, string> = {
  LONG: "text-green-400",
  SHORT: "text-red-400",
  NEUTRAL: "text-zinc-500",
};

function ConvictionBar({ value, signal }: { value: number; signal: string }) {
  const color = signal === "LONG" ? "bg-green-500" : signal === "SHORT" ? "bg-red-500" : "bg-zinc-600";
  return (
    <div className="w-20 h-2 bg-zinc-800 rounded overflow-hidden">
      <div className={`h-full ${color} rounded`} style={{ width: `${value}%` }} />
    </div>
  );
}

function RunCard({ run, onClick }: { run: PipelineRunSummary; onClick: () => void }) {
  const time = new Date(run.startedAt).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
  const action = run.decision?.action ?? "PASS";
  const label = ACTION_ICONS[action] ?? action;
  const duration = (run.durationMs / 1000).toFixed(1);

  return (
    <div
      className="flex items-center gap-2 px-2 py-1.5 hover:bg-zinc-800/50 cursor-pointer rounded text-xs"
      onClick={onClick}
    >
      <span className="text-zinc-500 w-12">{time}</span>
      <span className="text-zinc-400 w-10">{run.instrumentKey.split(":").pop()}</span>
      <span className="text-zinc-600 w-10">{run.triggeredBy}</span>
      <span className="flex-1 font-medium">{label}</span>
      {run.decision && (
        <span className="text-zinc-500">{run.decision.modulesAgreeing}/{run.decision.modulesTotal}</span>
      )}
      <span className="text-zinc-600">{duration}s</span>
    </div>
  );
}

function RunDetail({ run }: { run: PipelineRunSummary }) {
  return (
    <div className="px-3 py-2 border border-zinc-800 rounded bg-zinc-900/50 text-xs space-y-2">
      {/* Regime */}
      <div className="text-zinc-500">
        L1 Regime: {run.regime.market} │ Vol:{run.regime.volatility} │ {run.regime.trend}
      </div>

      {/* Modules */}
      <div className="space-y-1">
        <div className="text-zinc-500 font-medium">L2 Modules:</div>
        {run.moduleResults.map((m) => {
          const signal = m.output.signal;
          return (
            <div key={m.moduleId} className="flex items-center gap-2">
              <span className="w-28 text-zinc-400">{m.moduleId}</span>
              <span className={`w-14 ${SIGNAL_COLORS[signal]}`}>
                {signal === "LONG" ? "▶" : signal === "SHORT" ? "◀" : "•"} {signal}
              </span>
              <ConvictionBar value={m.output.conviction} signal={signal} />
              <span className="text-zinc-600">{m.output.conviction}%</span>
              <span className="text-zinc-700">w={m.darwinWeight.toFixed(1)}</span>
            </div>
          );
        })}
      </div>

      {/* Decision */}
      {run.decision && (
        <div className="border-t border-zinc-800 pt-2 space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{run.decision.action}</span>
            {run.decision.survivedCRO ? (
              <span className="text-green-500">CRO ✓</span>
            ) : (
              <span className="text-red-400">CRO ✗</span>
            )}
          </div>
          {run.decision.croObjections.length > 0 && (
            <div className="text-yellow-500/80">
              ⚠️ {run.decision.croObjections[0]}
            </div>
          )}
          <div className="text-zinc-500">{run.decision.reasoning}</div>
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

  // Fetch runs on mount
  useEffect(() => {
    setLoading(true);
    fetch("/api/pipeline/runs?limit=20")
      .then((r) => r.json())
      .then((data) => {
        usePipelineStore.getState().setRecentRuns(data.runs ?? []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const selectedRun = recentRuns.find((r) => r.id === selectedId);

  const handleTrigger = async () => {
    const instrumentKey = selectedKey && marketState?.quotes[selectedKey]
      ? selectedKey
      : marketState?.instruments.find((instrument) => instrument.analysable)?.key;
    if (!instrumentKey) return;
    try {
      await fetch("/api/pipeline/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instrumentKey }),
      });
      // Refresh after a delay
      setTimeout(() => {
        fetch("/api/pipeline/runs?limit=20")
          .then((r) => r.json())
          .then((data) => usePipelineStore.getState().setRecentRuns(data.runs ?? []));
      }, 10000);
    } catch {}
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
        <span className="text-sm font-medium text-zinc-300">Pipeline Runs</span>
        <button
          onClick={handleTrigger}
          className="text-xs px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
        >
          Trigger ▶
        </button>
      </div>

      {/* Run list */}
      <div className="flex-1 overflow-y-auto">
        {loading && <div className="text-xs text-zinc-500 px-3 py-2">Loading...</div>}
        {recentRuns.map((run) => (
          <RunCard key={run.id} run={run} onClick={() => setSelectedId(run.id === selectedId ? null : run.id)} />
        ))}
        {!loading && recentRuns.length === 0 && (
          <div className="text-xs text-zinc-600 px-3 py-4 text-center">
            No pipeline runs yet. Trigger one or wait for cron.
          </div>
        )}
      </div>

      {/* Detail panel */}
      {selectedRun && (
        <div className="border-t border-zinc-800 p-2 max-h-64 overflow-y-auto">
          <RunDetail run={selectedRun} />
        </div>
      )}
    </div>
  );
}
