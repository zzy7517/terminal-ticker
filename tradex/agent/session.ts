export interface AgentAnalysisResult {
  summary: string;
  bias: string;
  confidence: number;
  keyLevels: string[];
  watchPlan: string;
  invalidation: string;
  riskNotes: string;
}

export function defaultAnalysisResult(summary = ""): AgentAnalysisResult {
  return {
    summary,
    bias: "neutral",
    confidence: 0,
    keyLevels: [],
    watchPlan: "",
    invalidation: "",
    riskNotes: "",
  };
}
