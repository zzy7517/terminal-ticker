/**
 * EvolutionPanel — Darwin evolution monitor.
 * Shows module weights, performance, and autoresearch history.
 */

import { useState, useEffect } from "react";
import { usePipelineStore } from "../../stores/pipelineStore";
import type { DarwinWeightEntry } from "../../types";

function WeightBar({ weight }: { weight: number }) {
  // Map 0.3-2.5 to 0-100%
  const pct = Math.round(((weight - 0.3) / (2.5 - 0.3)) * 100);
  const color = weight >= 2.0 ? "bg-green-500" : weight >= 1.5 ? "bg-blue-500" : weight >= 1.0 ? "bg-zinc-500" : "bg-red-500";
  return (
    <div className="w-16 h-2 bg-zinc-800 rounded overflow-hidden">
      <div className={`h-full ${color} rounded`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function ModuleRow({ entry }: { entry: DarwinWeightEntry }) {
  const sharpe = entry.sharpe30d !== null ? entry.sharpe30d.toFixed(2) : "—";
  const hitRate = entry.hitRate30d !== null ? `${(entry.hitRate30d * 100).toFixed(0)}%` : "—";

  return (
    <div className="flex items-center gap-2 px-2 py-1 text-xs">
      <span className="w-32 text-zinc-300">{entry.moduleId}</span>
      <WeightBar weight={entry.weight} />
      <span className="w-10 text-right text-zinc-400">{entry.weight.toFixed(2)}</span>
      <span className="w-14 text-right text-zinc-500">S:{sharpe}</span>
      <span className="w-10 text-right text-zinc-500">{hitRate}</span>
    </div>
  );
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
    // Fetch scorecard
    fetch("/api/evolution/scorecard")
      .then((r) => r.json())
      .then((data) => {
        if (data.modules) {
          usePipelineStore.getState().setDarwinWeights(data.modules);
        }
      })
      .catch(() => {});

    // Fetch modifications
    fetch("/api/evolution/modifications?limit=10")
      .then((r) => r.json())
      .then((data) => setModifications(data.modifications ?? []))
      .catch(() => {});
  }, []);

  // Sort by weight descending
  const sorted = [...darwinWeights].sort((a, b) => b.weight - a.weight);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-2 border-b border-zinc-800">
        <span className="text-sm font-medium text-zinc-300">Darwin Evolution</span>
      </div>

      {/* Module weights */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-2 py-1 text-[10px] text-zinc-600 flex items-center gap-2">
          <span className="w-32">Module</span>
          <span className="w-16">Weight</span>
          <span className="w-10"></span>
          <span className="w-14 text-right">Sharpe</span>
          <span className="w-10 text-right">Hit%</span>
        </div>
        {sorted.map((entry) => (
          <ModuleRow key={entry.moduleId} entry={entry} />
        ))}
        {sorted.length === 0 && (
          <div className="text-xs text-zinc-600 px-3 py-4 text-center">
            No evolution data yet. Run the pipeline to start collecting.
          </div>
        )}

        {/* Autoresearch log */}
        {modifications.length > 0 && (
          <div className="mt-3 border-t border-zinc-800 pt-2 px-2">
            <div className="text-[10px] text-zinc-500 font-medium mb-1">Autoresearch Log</div>
            {modifications.map((mod) => (
              <div key={mod.id} className="flex items-center gap-1 text-[10px] py-0.5">
                <span className="text-zinc-600 w-14">
                  {new Date(mod.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </span>
                <span className="text-zinc-400 w-28">{mod.moduleId}</span>
                <span className="text-zinc-500 flex-1 truncate">{mod.description}</span>
                <span className={mod.status === "kept" ? "text-green-500" : mod.status === "reverted" ? "text-red-400" : "text-yellow-500"}>
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
