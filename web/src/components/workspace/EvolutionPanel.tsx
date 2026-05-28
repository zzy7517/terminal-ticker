/**
 * EvolutionPanel — Darwin evolution monitor.
 * Shows module weights, performance, and autoresearch history.
 */

import { useState, useEffect } from "react";
import { usePipelineStore } from "../../stores/pipelineStore";
import type { DarwinWeightEntry } from "../../types";
import "./PipelinePanels.css";

function WeightBar({ weight }: { weight: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(((weight - 0.3) / (2.5 - 0.3)) * 100)));
  const tone = weight >= 2.0 ? "high" : weight >= 1.5 ? "strong" : weight >= 1.0 ? "mid" : "low";
  return (
    <span className="pipeline-meter" aria-label={`Darwin weight ${weight.toFixed(2)}`}>
      <span className={`pipeline-meter-fill pipeline-meter-fill--${tone}`} style={{ width: `${pct}%` }} />
    </span>
  );
}

function ModuleRow({ entry }: { entry: DarwinWeightEntry }) {
  const sharpe = entry.sharpe30d !== null ? entry.sharpe30d.toFixed(2) : "—";
  const hitRate = entry.hitRate30d !== null ? `${(entry.hitRate30d * 100).toFixed(0)}%` : "—";

  return (
    <div className="evolution-row">
      <span className="evolution-module">{entry.moduleId}</span>
      <WeightBar weight={entry.weight} />
      <span className="evolution-number">{entry.weight.toFixed(2)}</span>
      <span className="evolution-number">S:{sharpe}</span>
      <span className="evolution-number">{hitRate}</span>
    </div>
  );
}

function statusClass(status: string): string {
  if (status === "kept") return "pipeline-tone--up";
  if (status === "reverted") return "pipeline-tone--down";
  return "pipeline-tone--warn";
}

export function EvolutionPanel() {
  const darwinWeights = usePipelineStore((s) => s.darwinWeights);
  const [modifications, setModifications] = useState<Array<{
    id: number;
    moduleId: string;
    description: string;
    status: string;
    createdAt: string;
  }>>([]);

  useEffect(() => {
    fetch("/api/evolution/scorecard")
      .then((r) => r.json())
      .then((data) => {
        if (data.modules) {
          usePipelineStore.getState().setDarwinWeights(data.modules);
        }
      })
      .catch(() => {});

    fetch("/api/evolution/modifications?limit=10")
      .then((r) => r.json())
      .then((data) => setModifications(data.modifications ?? []))
      .catch(() => {});
  }, []);

  const sorted = [...darwinWeights].sort((a, b) => b.weight - a.weight);

  return (
    <div className="pipeline-panel">
      <div className="pipeline-panel-header">
        <span className="pipeline-panel-title">Darwin Evolution</span>
      </div>

      <div className="pipeline-list">
        <div className="evolution-table-head">
          <span>Module</span>
          <span>Weight</span>
          <span></span>
          <span>Sharpe</span>
          <span>Hit%</span>
        </div>
        {sorted.map((entry) => (
          <ModuleRow key={entry.moduleId} entry={entry} />
        ))}
        {sorted.length === 0 && (
          <div className="pipeline-empty">No evolution data yet. Run the pipeline to start collecting.</div>
        )}

        {modifications.length > 0 && (
          <div className="evolution-log">
            <div className="evolution-log-title">Autoresearch Log</div>
            {modifications.map((mod) => (
              <div key={mod.id} className="evolution-log-row">
                <span className="evolution-log-date">
                  {new Date(mod.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </span>
                <span className="evolution-log-module">{mod.moduleId}</span>
                <span className="evolution-log-desc">{mod.description}</span>
                <span className={`evolution-log-status ${statusClass(mod.status)}`}>
                  {mod.status.toUpperCase()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
