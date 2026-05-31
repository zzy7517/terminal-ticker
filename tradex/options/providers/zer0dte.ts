/**
 * ZER0DTE Provider — Real-time 0DTE SPX options intelligence via MCP/REST
 *
 * ZER0DTE is an MCP server providing 21 tools for SPX 0DTE analysis.
 * Free beta: 3 sessions/day, no API key required.
 *
 * MCP SSE endpoint: https://mcp.zer0dte.trade/sse
 *
 * This provider wraps the ZER0DTE REST-like interface to fetch
 * pre-computed dealer exposure data. For full MCP tool access,
 * add the SSE endpoint to your .mcp.json config.
 *
 * Available data:
 *   - zer0dte_snapshot: Full situational awareness
 *   - zer0dte_levels: Key price levels (gamma flip, call/put wall, max pain)
 *   - zer0dte_exposure: GEX/DEX/VEX/CHEX by strike
 *   - zer0dte_regime: Regime classification
 *   - zer0dte_flows: Vanna and charm flows
 *   - zer0dte_expected_move: Expected price range
 *   + 15 more tools (history, patterns, entry scoring, etc.)
 *
 * Since ZER0DTE uses MCP protocol (not plain REST), this provider
 * bridges via the existing McpClientManager when available, or
 * provides a static config for the user to add.
 */

import type {
  GammaRegime,
  GexSnapshot,
  KeyLevels,
  OptionChain,
  StrikeGex,
  CharmVannaFlow,
} from "../domain.js";
import { OptionsDataProvider } from "./base.js";

// ============================================================================
// ZER0DTE MCP Config
// ============================================================================

/** MCP server entry for .mcp.json */
export const ZER0DTE_MCP_CONFIG = {
  url: "https://mcp.zer0dte.trade/sse",
  idleTimeout: 0, // Keep alive during market hours
} as const;

/** All 21 ZER0DTE tool names */
export const ZER0DTE_TOOLS = [
  "zer0dte_snapshot",
  "zer0dte_pulse",
  "zer0dte_alert",
  "zer0dte_calendar",
  "zer0dte_entry_score",
  "zer0dte_overnight",
  "zer0dte_levels",
  "zer0dte_exposure",
  "zer0dte_regime",
  "zer0dte_flows",
  "zer0dte_chain",
  "zer0dte_strikes",
  "zer0dte_liquidity",
  "zer0dte_expected_move",
  "zer0dte_accuracy",
  "zer0dte_history",
  "zer0dte_compare",
  "zer0dte_opening_range",
  "zer0dte_regime_history",
  "zer0dte_pattern",
  "zer0dte_session_log",
] as const;

// ============================================================================
// Response Types (from MCP tool calls)
// ============================================================================

interface Zer0dteSnapshotResponse {
  symbol: string;
  price: number;
  timestamp: string;
  regime: string;
  regime_confidence: number;
  gamma_flip: number;
  call_wall: number;
  put_wall: number;
  max_pain: number;
  net_gex: number;
  net_dex: number;
  expected_move_up: number;
  expected_move_down: number;
  atm_iv: number;
  put_call_ratio: number;
  vanna_flow: number;
  charm_flow: number;
}

interface Zer0dteExposureStrike {
  strike: number;
  gex: number;
  dex: number;
  vex: number;
  chex: number;
  call_oi: number;
  put_oi: number;
}

interface Zer0dteExposureResponse {
  symbol: string;
  price: number;
  timestamp: string;
  strikes: Zer0dteExposureStrike[];
  net_gex: number;
  net_dex: number;
  net_vex: number;
  net_chex: number;
}

// ============================================================================
// Provider Implementation
// ============================================================================

/**
 * Interface for calling MCP tools. This is satisfied by McpClientManager
 * or any adapter that can invoke named tools.
 */
export interface McpToolCaller {
  callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown>;
}

export class Zer0dteProvider implements OptionsDataProvider {
  readonly name = "zer0dte";
  readonly providesGreeks = true;
  readonly rateLimit = 10; // Conservative for MCP
  private readonly mcpCaller: McpToolCaller | null;
  private readonly serverName: string;

  constructor(mcpCaller: McpToolCaller | null, serverName = "zer0dte") {
    this.mcpCaller = mcpCaller;
    this.serverName = serverName;
  }

  async getSpotPrice(_symbol: string): Promise<number> {
    throw new Error("ZER0DTE does not provide spot prices directly. Use getGexSnapshot().");
  }

  async getExpirations(_symbol: string): Promise<string[]> {
    return []; // ZER0DTE is 0DTE only
  }

  // ZER0DTE only covers SPX 0DTE — no raw option chains
  async getOptionsChain(_symbol: string, _options?: { expiration?: string; strikeRangePercent?: number }): Promise<OptionChain> {
    return { underlying: "", spotPrice: 0, expiration: "", contracts: [], timestamp: Date.now(), provider: this.name };
  }

  async close(): Promise<void> { /* MCP connection managed externally */ }

  /**
   * Get GEX snapshot via MCP tool call.
   * Only works for SPX (the only symbol ZER0DTE covers).
   */
  async getGexSnapshot(symbol: string): Promise<GexSnapshot | null> {
    if (!this.mcpCaller) {
      console.warn("[zer0dte] No MCP caller configured. Add zer0dte to .mcp.json");
      return null;
    }

    // ZER0DTE only covers SPX
    const effectiveSymbol = symbol.toUpperCase() === "SPX" || symbol.toUpperCase() === "SPY" ? "SPX" : symbol;

    try {
      // Fetch snapshot + exposure in parallel
      const [snapshotRaw, exposureRaw] = await Promise.all([
        this.mcpCaller.callTool(this.serverName, "zer0dte_snapshot", { symbol: effectiveSymbol }),
        this.mcpCaller.callTool(this.serverName, "zer0dte_exposure", {
          symbol: effectiveSymbol,
          strike_range: 20,
          exposure_type: "all",
        }),
      ]);

      const snapshot = snapshotRaw as Zer0dteSnapshotResponse;
      const exposure = exposureRaw as Zer0dteExposureResponse;

      return this.buildSnapshot(snapshot, exposure);
    } catch (err) {
      console.error("[zer0dte] MCP call failed:", err instanceof Error ? err.message : err);
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Build Snapshot from MCP responses
  // --------------------------------------------------------------------------

  private buildSnapshot(
    snap: Zer0dteSnapshotResponse,
    exposure: Zer0dteExposureResponse,
  ): GexSnapshot {
    const spot = snap.price;
    const netGex = snap.net_gex;

    // Map regime string to our type
    const regime: GammaRegime = snap.regime?.toLowerCase().includes("positive") || snap.regime?.toLowerCase().includes("long")
      ? "long_gamma"
      : snap.regime?.toLowerCase().includes("negative") || snap.regime?.toLowerCase().includes("short")
        ? "short_gamma"
        : "neutral";

    const regimeDescription = regime === "long_gamma"
      ? `Dealers long gamma (confidence: ${snap.regime_confidence ?? "N/A"}) — mean-reversion expected (via ZER0DTE)`
      : regime === "short_gamma"
        ? `Dealers short gamma (confidence: ${snap.regime_confidence ?? "N/A"}) — trend acceleration expected (via ZER0DTE)`
        : `Neutral regime (via ZER0DTE)`;

    // Convert exposure strikes to our StrikeGex format
    const gexByStrike: StrikeGex[] = (exposure?.strikes ?? []).map(s => ({
      strike: s.strike,
      callGex: s.gex > 0 ? s.gex : 0, // Approximate split
      putGex: s.gex < 0 ? s.gex : 0,
      netGex: s.gex,
      callOi: s.call_oi,
      putOi: s.put_oi,
    }));

    const keyLevels: KeyLevels = {
      callWall: snap.call_wall ?? spot,
      putWall: snap.put_wall ?? spot,
      maxGammaStrike: gexByStrike.length > 0
        ? gexByStrike.reduce((max, s) => Math.abs(s.netGex) > Math.abs(max.netGex) ? s : max, gexByStrike[0]).strike
        : spot,
      zeroGammaLevel: snap.gamma_flip ?? spot,
      zglCrossingFound: snap.gamma_flip != null,
    };

    // Charm/Vanna from snapshot-level fields
    const charmVanna: CharmVannaFlow | null = (snap.charm_flow != null || snap.vanna_flow != null)
      ? {
          charmFlow: snap.charm_flow ?? 0,
          vannaFlow: snap.vanna_flow ?? 0,
          netHiddenFlow: (snap.charm_flow ?? 0) + (snap.vanna_flow ?? 0),
          charmByStrike: Object.fromEntries((exposure?.strikes ?? []).map(s => [s.strike, s.chex])),
          vannaByStrike: Object.fromEntries((exposure?.strikes ?? []).map(s => [s.strike, s.vex])),
        }
      : null;

    const totalCallGex = gexByStrike.reduce((sum, s) => sum + s.callGex, 0);
    const totalPutGex = gexByStrike.reduce((sum, s) => sum + s.putGex, 0);

    return {
      timestamp: new Date(snap.timestamp).getTime() || Date.now(),
      symbol: snap.symbol ?? "SPX",
      spotPrice: spot,
      netGex,
      netGexBillions: netGex / 1e9,
      totalCallGex,
      totalPutGex,
      zeroGammaLevel: snap.gamma_flip ?? spot,
      regime,
      regimeDescription,
      dominantStrike: keyLevels.maxGammaStrike,
      keyLevels,
      gexByStrike,
      charmVanna,
      provider: "zer0dte",
    };
  }
}

// ============================================================================
// Helper: Generate .mcp.json entry for user guidance
// ============================================================================

/**
 * Returns the MCP config entry users should add to their .mcp.json
 * to get full ZER0DTE tool access (21 tools) in the agent.
 */
export function getZer0dteMcpEntry(): { zer0dte: typeof ZER0DTE_MCP_CONFIG } {
  return { zer0dte: ZER0DTE_MCP_CONFIG };
}
