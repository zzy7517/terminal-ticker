/**
 * Options & GEX Analysis - Black-Scholes Greeks Engine
 *
 * Vectorized calculations with dividend yield support.
 * Ported from 0DTE-dealer-gamma's Python NumPy implementation to TypeScript.
 *
 * All formulas use the Generalized Black-Scholes-Merton model:
 *   d₁ = [ln(S/K) + (r - q + σ²/2)T] / (σ√T)
 *   d₂ = d₁ - σ√T
 *
 * Where q = dividend yield (important for SPX ~1.5%, negligible for crypto).
 */

import { MIN_IV, MAX_IV } from "./domain.js";

// ============================================================================
// Normal Distribution Functions
// ============================================================================

/** Standard normal PDF: N'(x) = (1/√(2π)) × e^(-x²/2) */
export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Standard normal CDF approximation (Abramowitz & Stegun 26.2.17).
 * Maximum error: 7.5e-8.
 */
export function normCdf(x: number): number {
  if (x > 8) return 1;
  if (x < -8) return 0;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);

  const p = 0.2316419;
  const b1 = 0.319381530;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;

  const t = 1 / (1 + p * absX);
  const t2 = t * t;
  const t3 = t2 * t;
  const t4 = t3 * t;
  const t5 = t4 * t;

  const pdf = normPdf(absX);
  const cdf = 1 - pdf * (b1 * t + b2 * t2 + b3 * t3 + b4 * t4 + b5 * t5);

  return sign === 1 ? cdf : 1 - cdf;
}

// ============================================================================
// Black-Scholes Parameters
// ============================================================================

/** Calculate d1 with dividend yield */
export function bsD1(S: number, K: number, T: number, r: number, q: number, sigma: number): number {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return 0;
  const sqrtT = Math.sqrt(T);
  return (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
}

/** Calculate d2 with dividend yield */
export function bsD2(S: number, K: number, T: number, r: number, q: number, sigma: number): number {
  if (T <= 0 || sigma <= 0) return 0;
  return bsD1(S, K, T, r, q, sigma) - sigma * Math.sqrt(T);
}

// ============================================================================
// Individual Greeks
// ============================================================================

/**
 * Gamma (∂²V/∂S²) — same for calls and puts.
 * Formula: Γ = e^(-qT) × N'(d1) / (S × σ × √T)
 */
export function gamma(S: number, K: number, T: number, r: number, q: number, sigma: number): number {
  if (T <= 0 || sigma <= 0 || S <= 0) return 0;
  const d1 = bsD1(S, K, T, r, q, sigma);
  const sqrtT = Math.sqrt(T);
  const discount = Math.exp(-q * T);
  const g = (discount * normPdf(d1)) / (S * sigma * sqrtT);
  return isFinite(g) ? g : 0;
}

/**
 * Delta (∂V/∂S)
 * Call: Δ = e^(-qT) × N(d1)
 * Put:  Δ = e^(-qT) × (N(d1) - 1)
 */
export function delta(S: number, K: number, T: number, r: number, q: number, sigma: number, type: "call" | "put"): number {
  if (T <= 0) {
    // At expiration
    if (type === "call") return S > K ? 1 : 0;
    return S < K ? -1 : 0;
  }
  if (sigma <= 0 || S <= 0) return 0;

  const d1 = bsD1(S, K, T, r, q, sigma);
  const discount = Math.exp(-q * T);

  if (type === "call") return discount * normCdf(d1);
  return discount * (normCdf(d1) - 1);
}

/**
 * Vega (∂V/∂σ) per 1% change — same for calls and puts.
 * Formula: ν = S × e^(-qT) × N'(d1) × √T / 100
 */
export function vega(S: number, K: number, T: number, r: number, q: number, sigma: number): number {
  if (T <= 0 || sigma <= 0 || S <= 0) return 0;
  const d1 = bsD1(S, K, T, r, q, sigma);
  const discount = Math.exp(-q * T);
  const v = (S * discount * normPdf(d1) * Math.sqrt(T)) / 100;
  return isFinite(v) ? v : 0;
}

/**
 * Theta (∂V/∂t) per day.
 * Call: θ = -[S×e^(-qT)×N'(d1)×σ/(2√T)] - r×K×e^(-rT)×N(d2) + q×S×e^(-qT)×N(d1)
 * Put:  θ = -[S×e^(-qT)×N'(d1)×σ/(2√T)] + r×K×e^(-rT)×N(-d2) - q×S×e^(-qT)×N(-d1)
 */
export function theta(S: number, K: number, T: number, r: number, q: number, sigma: number, type: "call" | "put"): number {
  if (T <= 0 || sigma <= 0 || S <= 0) return 0;

  const d1 = bsD1(S, K, T, r, q, sigma);
  const d2 = bsD2(S, K, T, r, q, sigma);
  const sqrtT = Math.sqrt(T);
  const discountQ = Math.exp(-q * T);
  const discountR = Math.exp(-r * T);
  const pdf = normPdf(d1);

  const term1 = -(S * discountQ * pdf * sigma) / (2 * sqrtT);

  let result: number;
  if (type === "call") {
    result = term1 - r * K * discountR * normCdf(d2) + q * S * discountQ * normCdf(d1);
  } else {
    result = term1 + r * K * discountR * normCdf(-d2) - q * S * discountQ * normCdf(-d1);
  }

  // Convert to per-day
  const perDay = result / 365;
  return isFinite(perDay) ? perDay : 0;
}

/**
 * Charm (∂Δ/∂t) — Delta decay over time, per day.
 * Measures how much Delta changes as time passes (dealers must rehedge just from clock ticking).
 * Critical for 0DTE options.
 */
export function charm(S: number, K: number, T: number, r: number, q: number, sigma: number, type: "call" | "put"): number {
  if (T <= 0 || sigma <= 0 || S <= 0) return 0;

  const d1 = bsD1(S, K, T, r, q, sigma);
  const d2 = bsD2(S, K, T, r, q, sigma);
  const sqrtT = Math.sqrt(T);
  const discountQ = Math.exp(-q * T);
  const pdf = normPdf(d1);

  // Common term
  const common = -discountQ * pdf * (
    (2 * (r - q) * T - d2 * sigma * sqrtT) /
    (2 * T * sigma * sqrtT)
  );

  let result: number;
  if (type === "call") {
    result = common + q * discountQ * normCdf(d1);
  } else {
    result = common - q * discountQ * normCdf(-d1);
  }

  // Per day
  const perDay = result / 365;
  return isFinite(perDay) ? perDay : 0;
}

/**
 * Vanna (∂Δ/∂σ = ∂Vega/∂S) — same for calls and puts.
 * Measures how much Delta changes when IV changes.
 * Critical for understanding hedging flows after IV crush/spike.
 *
 * Formula: Vanna = -e^(-qT) × N'(d1) × d2 / σ
 */
export function vanna(S: number, K: number, T: number, r: number, q: number, sigma: number): number {
  if (T <= 0 || sigma <= 0 || S <= 0) return 0;

  const d1 = bsD1(S, K, T, r, q, sigma);
  const d2 = bsD2(S, K, T, r, q, sigma);
  const discountQ = Math.exp(-q * T);

  const v = -discountQ * normPdf(d1) * d2 / sigma;
  return isFinite(v) ? v : 0;
}
