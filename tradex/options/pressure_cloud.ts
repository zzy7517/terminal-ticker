/**
 * Pressure Cloud
 *
 * Translates the raw Hedge Impulse Curve into actionable trading zones:
 *
 * - Stability Zones: Positive impulse peaks → price decelerates (bounce/rejection)
 * - Acceleration Zones: Negative impulse troughs → price accelerates (momentum/breakout)
 * - Regime Edges: Zero crossings → behavior mode transitions
 *
 * All zones are weighted by reachability — how likely the market is to
 * actually reach that price level within the current session.
 *
 * Reference: FullStackCraft/floe hedgeflow/pressurecloud.ts
 */

import type {
  HedgeImpulseCurve,
  HedgeImpulsePoint,
  ImpulseExtremum,
  ZeroCrossing,
} from "./hedge_impulse.js";
import type { RegimeParams } from "./iv_surface.js";

// ============================================================================
// Types
// ============================================================================

export interface PressureZone {
  /** Center price of the zone */
  center: number;
  /** Lower bound */
  lower: number;
  /** Upper bound */
  upper: number;
  /** Normalized strength 0-1 (relative to strongest zone, weighted by proximity) */
  strength: number;
  /** Whether this zone is above or below current spot */
  side: "above-spot" | "below-spot";
  /**
   * Trade type this zone favors:
   * - Stability below spot → long (buy the bounce)
   * - Stability above spot → short (sell the rejection)
   * - Acceleration below spot → short (momentum downside)
   * - Acceleration above spot → long (momentum upside / squeeze)
   */
  tradeType: "long" | "short";
  /** Dealer hedge execution type */
  hedgeType: "passive" | "aggressive";
}

export interface RegimeEdge {
  /** Price at which impulse crosses zero */
  price: number;
  /** Transition direction for a downward price move */
  transitionType: "stable-to-unstable" | "unstable-to-stable";
}

export interface PressureLevel {
  price: number;
  stabilityScore: number;
  accelerationScore: number;
  hedgeType: "passive" | "aggressive";
}

export interface PressureCloudConfig {
  /** How many expected-daily-moves to consider "reachable" (default: 2.0) */
  reachabilityMultiple?: number;
  /** Minimum impulse fraction to qualify as a zone (default: 0.15) */
  zoneThreshold?: number;
}

export interface PressureCloud {
  spot: number;
  computedAt: number;
  /** Stability zones: positive impulse → mean-reversion */
  stabilityZones: PressureZone[];
  /** Acceleration zones: negative impulse → trend-amplification */
  accelerationZones: PressureZone[];
  /** Regime edges: zero crossings */
  regimeEdges: RegimeEdge[];
  /** Per-price-level detail */
  priceLevels: PressureLevel[];
}

// ============================================================================
// Main Computation
// ============================================================================

/**
 * Compute a pressure cloud from an existing hedge impulse curve.
 */
export function computePressureCloud(
  impulseCurve: HedgeImpulseCurve,
  regimeParams: RegimeParams,
  config: PressureCloudConfig = {},
): PressureCloud {
  const {
    reachabilityMultiple = 2.0,
    zoneThreshold = 0.15,
  } = config;

  const { spot, curve, extrema, zeroCrossings } = impulseCurve;
  const expectedMove = regimeParams.expectedDailySpotMove * spot;

  // Per-price-level detail
  const priceLevels = computePriceLevels(curve, spot, expectedMove, reachabilityMultiple);

  // Extract stability zones (positive impulse peaks)
  const stabilityZones = extractStabilityZones(
    extrema, curve, spot, expectedMove, reachabilityMultiple, zoneThreshold
  );

  // Extract acceleration zones (negative impulse troughs)
  const accelerationZones = extractAccelerationZones(
    extrema, curve, spot, expectedMove, reachabilityMultiple, zoneThreshold
  );

  // Convert zero crossings to regime edges
  const regimeEdges = convertToRegimeEdges(zeroCrossings, spot);

  return {
    spot,
    computedAt: Date.now(),
    stabilityZones,
    accelerationZones,
    regimeEdges,
    priceLevels,
  };
}

// ============================================================================
// Price Levels
// ============================================================================

function computePriceLevels(
  curve: HedgeImpulsePoint[],
  spot: number,
  expectedMove: number,
  reachabilityMultiple: number,
): PressureLevel[] {
  const reachRange = expectedMove * reachabilityMultiple;

  return curve.map((point) => {
    const distance = Math.abs(point.price - spot);
    const proximity = Math.exp(-((distance / reachRange) ** 2));

    return {
      price: point.price,
      stabilityScore: point.impulse > 0 ? point.impulse * proximity : 0,
      accelerationScore: point.impulse < 0 ? Math.abs(point.impulse) * proximity : 0,
      hedgeType: point.impulse >= 0 ? "passive" as const : "aggressive" as const,
    };
  });
}

// ============================================================================
// Zone Extraction
// ============================================================================

function extractStabilityZones(
  extrema: ImpulseExtremum[],
  curve: HedgeImpulsePoint[],
  spot: number,
  expectedMove: number,
  reachabilityMultiple: number,
  zoneThreshold: number,
): PressureZone[] {
  const basins = extrema.filter(e => e.type === "basin");
  if (basins.length === 0) return [];

  const reachRange = expectedMove * reachabilityMultiple;
  const maxImpulse = Math.max(...basins.map(b => Math.abs(b.impulse)), 1e-10);

  const significant = basins.filter(b => Math.abs(b.impulse) / maxImpulse >= zoneThreshold);

  const zones: PressureZone[] = significant.map(basin => {
    const proximity = Math.exp(-((Math.abs(basin.price - spot) / reachRange) ** 2));
    const rawStrength = (Math.abs(basin.impulse) / maxImpulse) * proximity;
    const { lower, upper } = findZoneBounds(curve, basin.price, basin.impulse * 0.5);

    const side: PressureZone["side"] = basin.price >= spot ? "above-spot" : "below-spot";
    const tradeType: PressureZone["tradeType"] = side === "below-spot" ? "long" : "short";

    return {
      center: basin.price,
      lower,
      upper,
      strength: Math.min(1, rawStrength),
      side,
      tradeType,
      hedgeType: "passive" as const,
    };
  });

  return zones.sort((a, b) => b.strength - a.strength);
}

function extractAccelerationZones(
  extrema: ImpulseExtremum[],
  curve: HedgeImpulsePoint[],
  spot: number,
  expectedMove: number,
  reachabilityMultiple: number,
  zoneThreshold: number,
): PressureZone[] {
  const peaks = extrema.filter(e => e.type === "peak");
  if (peaks.length === 0) return [];

  const reachRange = expectedMove * reachabilityMultiple;
  const maxImpulse = Math.max(...peaks.map(p => Math.abs(p.impulse)), 1e-10);

  const significant = peaks.filter(p => Math.abs(p.impulse) / maxImpulse >= zoneThreshold);

  const zones: PressureZone[] = significant.map(peak => {
    const proximity = Math.exp(-((Math.abs(peak.price - spot) / reachRange) ** 2));
    const rawStrength = (Math.abs(peak.impulse) / maxImpulse) * proximity;
    const { lower, upper } = findZoneBounds(curve, peak.price, peak.impulse * 0.5);

    const side: PressureZone["side"] = peak.price >= spot ? "above-spot" : "below-spot";
    // Acceleration below = momentum short; above = momentum long (squeeze)
    const tradeType: PressureZone["tradeType"] = side === "below-spot" ? "short" : "long";

    return {
      center: peak.price,
      lower,
      upper,
      strength: Math.min(1, rawStrength),
      side,
      tradeType,
      hedgeType: "aggressive" as const,
    };
  });

  return zones.sort((a, b) => b.strength - a.strength);
}

// ============================================================================
// Helpers
// ============================================================================

function findZoneBounds(
  curve: HedgeImpulsePoint[],
  centerPrice: number,
  thresholdImpulse: number,
): { lower: number; upper: number } {
  let centerIdx = 0;
  let minDist = Infinity;
  for (let i = 0; i < curve.length; i++) {
    const d = Math.abs(curve[i].price - centerPrice);
    if (d < minDist) { minDist = d; centerIdx = i; }
  }

  const isPositive = thresholdImpulse > 0;

  // Scan left
  let lowerIdx = centerIdx;
  for (let i = centerIdx - 1; i >= 0; i--) {
    if (isPositive ? curve[i].impulse < thresholdImpulse : curve[i].impulse > thresholdImpulse) {
      lowerIdx = i;
      break;
    }
    lowerIdx = i;
  }

  // Scan right
  let upperIdx = centerIdx;
  for (let i = centerIdx + 1; i < curve.length; i++) {
    if (isPositive ? curve[i].impulse < thresholdImpulse : curve[i].impulse > thresholdImpulse) {
      upperIdx = i;
      break;
    }
    upperIdx = i;
  }

  return { lower: curve[lowerIdx].price, upper: curve[upperIdx].price };
}

function convertToRegimeEdges(crossings: ZeroCrossing[], spot: number): RegimeEdge[] {
  return crossings.map(crossing => {
    const isBelow = crossing.price < spot;
    let transitionType: RegimeEdge["transitionType"];
    if (crossing.direction === "falling") {
      transitionType = isBelow ? "stable-to-unstable" : "unstable-to-stable";
    } else {
      transitionType = isBelow ? "unstable-to-stable" : "stable-to-unstable";
    }
    return { price: crossing.price, transitionType };
  });
}
