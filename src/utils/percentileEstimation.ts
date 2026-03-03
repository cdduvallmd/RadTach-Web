// Percentile Estimation — estimate where a value falls within a distribution
// Uses linear interpolation between known quantiles (p25, p50, p75) + normal
// distribution tails for values outside the IQR.

import type { DistributionStats } from '../types/reports';

/**
 * Estimate the percentile rank (0-100) of a value within a distribution.
 * Uses linear interpolation between p25/p50/p75 boundaries, with
 * normal distribution approximation for the tails.
 */
export function estimatePercentile(value: number, dist: DistributionStats): number {
  if (dist.n === 0) return 50;
  if (dist.stdDev === 0) return value >= dist.mean ? 50 : 50;

  // Known points: p25, p50, p75
  // Interpolate between them for the middle 50%
  if (value <= dist.p25) {
    // Below p25: use normal distribution CDF approximation
    const z = (value - dist.mean) / dist.stdDev;
    const cdf = normalCDF(z);
    return Math.max(0, Math.min(25, cdf * 100));
  }

  if (value <= dist.p50) {
    // Between p25 and p50: linear interpolation
    const range = dist.p50 - dist.p25;
    if (range === 0) return 37.5;
    const fraction = (value - dist.p25) / range;
    return 25 + fraction * 25;
  }

  if (value <= dist.p75) {
    // Between p50 and p75: linear interpolation
    const range = dist.p75 - dist.p50;
    if (range === 0) return 62.5;
    const fraction = (value - dist.p50) / range;
    return 50 + fraction * 25;
  }

  // Above p75: use normal distribution CDF approximation
  const z = (value - dist.mean) / dist.stdDev;
  const cdf = normalCDF(z);
  return Math.min(100, Math.max(75, cdf * 100));
}

/**
 * Standard normal CDF approximation (Abramowitz & Stegun 26.2.17)
 * Accurate to ~1.5e-7
 */
function normalCDF(z: number): number {
  if (z < -8) return 0;
  if (z > 8) return 1;

  const negative = z < 0;
  if (negative) z = -z;

  const p = 0.2316419;
  const b1 = 0.319381530;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;

  const t = 1 / (1 + p * z);
  const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const cdf = 1 - pdf * (b1 * t + b2 * t ** 2 + b3 * t ** 3 + b4 * t ** 4 + b5 * t ** 5);

  return negative ? 1 - cdf : cdf;
}

/**
 * Format a percentile as an ordinal string: "68th", "1st", "2nd", "3rd"
 */
export function formatPercentileOrdinal(p: number): string {
  const rounded = Math.round(p);
  const suffix = getOrdinalSuffix(rounded);
  return `${rounded}${suffix}`;
}

function getOrdinalSuffix(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return 'th';
  const mod10 = n % 10;
  if (mod10 === 1) return 'st';
  if (mod10 === 2) return 'nd';
  if (mod10 === 3) return 'rd';
  return 'th';
}
