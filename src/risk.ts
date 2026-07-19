import type { Deps } from './app.js';
import type { NewOrder } from './connectors/base.js';
import { ProblemError } from './problem.js';

/**
 * Pre-trade risk gate (SPEC § 5).
 *
 * Phase A: implements the kill-switch + permissive numeric checks
 * reading `cfg.riskLimits`. Phase B: tighter rules (per-instrument
 * position caps, daily loss tracking from `fills`).
 */

export type RiskDecision =
  | { ok: true }
  | { ok: false; reason: string };

export function checkPreTrade(
  deps: Deps,
  order: NewOrder,
): RiskDecision {
  const rl = deps.cfg.riskLimits;
  if (rl.kill_switch_active) {
    return { ok: false, reason: 'kill_switch_active' };
  }
  if (rl.max_position_size > 0 && order.qty > rl.max_position_size) {
    return {
      ok: false,
      reason: `qty ${order.qty} exceeds max_position_size ${rl.max_position_size}`,
    };
  }
  return { ok: true };
}

/** Convenience wrapper that throws FORBIDDEN on reject. */
export function enforcePreTrade(deps: Deps, order: NewOrder): void {
  const d = checkPreTrade(deps, order);
  if (!d.ok) {
    throw new ProblemError({
      status: 409,
      code: 'RISK_BLOCKED',
      title: 'Order rejected by risk engine',
      detail: d.reason,
    });
  }
}
