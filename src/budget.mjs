/** Conservative reservation estimator; ignores all included Workers Paid usage. */
export const SIZES = Object.freeze({
  'standard-1': Object.freeze({ vcpu: 0.5, memoryGiB: 4, diskGB: 8 }),
  'standard-2': Object.freeze({ vcpu: 1, memoryGiB: 6, diskGB: 12 }),
});
export const RATES_USD_PER_HOUR = Object.freeze({
  memoryGiB: 0.009, // $0.0000025 / GiB-second
  vcpu: 0.072,      // $0.000020 / vCPU-second
  diskGB: 0.000252, // $0.00000007 / GB-second
});
export function reserveUsd(size, minutes) {
  const resources = SIZES[size];
  if (!resources || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 120) {
    throw new Error('Unsupported instance size or lease duration');
  }
  const hourCost = resources.memoryGiB * RATES_USD_PER_HOUR.memoryGiB
    + resources.vcpu * RATES_USD_PER_HOUR.vcpu
    + resources.diskGB * RATES_USD_PER_HOUR.diskGB;
  return Math.ceil(hourCost * (minutes / 60) * 1_000_000) / 1_000_000;
}
export function monthKey(date = new Date()) {
  return `budget:${date.toISOString().slice(0, 7)}`;
}
// Used and reservation must be finite and non-negative: a negative "used"
// would otherwise bypass the cap (e.g. used=-100, reservation=50, budget=4).
export function budgetAllows(used, reservation, budget) {
  return Number.isFinite(used) && Number.isFinite(reservation)
    && Number.isFinite(budget) && budget > 0
    && used >= 0 && reservation >= 0
    && used + reservation <= budget + 1e-9;
}
