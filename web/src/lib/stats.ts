// Statistical layer: adaptive-assistance score + idle anomaly baseline.
// Pure rules / statistics — no ML, no LLM.
import { db, getOperator } from "./db";
import { FORMULA_BANDS, SCORE, modeWithHysteresis, type Bands, type Mode } from "./config";
import { MODULES } from "./training";

const weekAgo = () => new Date(Date.now() - 7 * 864e5).toISOString();

export type ScoreBreakdown = {
  score: number;
  mode: Mode;
  factors: {
    safety_incidents_14d: number;
    idle_anomalies_14d: number;
    drowsiness_events_shift: number;
    cycle_time_deviation_pct: number;
    shifts_completed: number;
    positive_credit_shift: number;
  };
  terms: { label: string; delta: number }[];
  source: "formula" | "model";
  bands: Bands;
  /** Present when the ML model (cv-service /score) produced this score. */
  model?: { version: string; incident_risk: number; formula_score: number; formula_mode: Mode };
};

/**
 * Proficiency score (0-100) for ONE operator. Rule-based and fully explainable: every term is returned.
 *   penalties  - safety incidents (-15), idle anomalies (-5), repeated-seatbelt flag (-5), excessive-idle
 *                episodes (-2): each weighted by recency, 0.5^(age/halfLife), over the last 14 days.
 *                A critical alert corrected within 5 s counts -5 instead of -15. Completing the training
 *                module for that incident type afterwards halves its penalty.
 *              - drowsiness events this shift (-10), task overrun % (-3 per %, capped at -15)
 *   credit     - tenure (up to +10)
 *              - this shift, capped at +20 total: safe-streak blocks (+2), idle nudges acted on (+1),
 *                training modules completed (+3), tasks finished on time (+1)
 * `prevMode` enables hysteresis so the mode doesn't flicker at a band boundary.
 */
export function computeScore(operatorId: string, shiftStart: string, prevMode: Mode | null = null): ScoreBreakdown {
  const d = db();
  const op = getOperator(operatorId);
  if (!op) throw new Error(`unknown operator ${operatorId}`);
  const now = Date.now();
  const lookback = new Date(now - SCORE.lookbackDays * 864e5).toISOString();
  const decay = (iso: string) => Math.pow(0.5, (now - Date.parse(iso)) / 864e5 / SCORE.halfLifeDays);

  // Training completions (for the "trained after the incident" discount and this-shift credit)
  const trained = d.prepare("SELECT module_id, completed_at FROM training_progress WHERE operator_id=?").all(operatorId) as {
    module_id: string; completed_at: string;
  }[];
  const trainedTagAt = (tag: string) =>
    trained.filter((t) => MODULES.find((m) => m.id === t.module_id)?.trigger_tag === tag).map((t) => t.completed_at);

  const incidents = d
    .prepare("SELECT type, timestamp, resolved_at FROM incidents WHERE operator_id=? AND timestamp>=? AND type IN ('SEATBELT','PROXIMITY')")
    .all(operatorId, lookback) as { type: string; timestamp: string; resolved_at: string | null }[];
  let safetyPenalty = 0;
  let fastFixed = 0;
  let trainedOff = 0;
  for (const i of incidents) {
    const fast = !!i.resolved_at && Date.parse(i.resolved_at) - Date.parse(i.timestamp) <= SCORE.fastCorrectionSec * 1000;
    const retrained = trainedTagAt(i.type).some((at) => at > i.timestamp);
    if (fast) fastFixed++;
    if (retrained) trainedOff++;
    safetyPenalty += (fast ? 5 : 15) * (retrained ? 0.5 : 1) * decay(i.timestamp);
  }

  const flags = d
    .prepare("SELECT event_type, timestamp FROM behavior_logs WHERE operator_id=? AND timestamp>=?")
    .all(operatorId, lookback) as { event_type: string; timestamp: string }[];
  const flagSum = (type: string, weight: number) =>
    flags.filter((f) => f.event_type === type).reduce((s, f) => s + weight * decay(f.timestamp), 0);
  const flagCount = (type: string, sinceIso: string) => flags.filter((f) => f.event_type === type && f.timestamp >= sinceIso).length;
  const nFlags = (type: string) => flags.filter((f) => f.event_type === type).length;

  const drowsy = (d
    .prepare("SELECT COUNT(*) n FROM incidents WHERE operator_id=? AND timestamp>=? AND type='DROWSINESS'")
    .get(operatorId, shiftStart) as { n: number }).n;
  const dev = d
    .prepare(
      `SELECT AVG((actual_minutes - estimated_minutes) / estimated_minutes) * 100 AS pct
       FROM tasks WHERE operator_id=? AND status='completed' AND completed_at>=? AND actual_minutes IS NOT NULL`,
    )
    .get(operatorId, weekAgo()) as { pct: number | null };
  const devPct = Math.round((dev.pct ?? 0) * 10) / 10;

  // Positive credit, this shift only
  const streaks = flagCount("SAFE_STREAK", shiftStart);
  const nudges = flagCount("NUDGE_RESPONDED", shiftStart);
  const modulesDone = trained.filter((t) => t.completed_at >= shiftStart).length;
  const onTime = (d
    .prepare(
      "SELECT COUNT(*) n FROM tasks WHERE operator_id=? AND status='completed' AND completed_at>=? AND actual_minutes <= estimated_minutes * 1.05",
    )
    .get(operatorId, shiftStart) as { n: number }).n;
  const positiveRaw = 2 * streaks + nudges + 3 * modulesDone + onTime;
  const positive = Math.min(positiveRaw, SCORE.positiveCap);

  const detail = [fastFixed ? `${fastFixed} corrected fast` : "", trainedOff ? `${trainedOff} retrained` : ""].filter(Boolean).join(", ");
  const terms = [
    { label: `${incidents.length} safety incident(s), 14 d, recency-weighted${detail ? ` (${detail})` : ""}`, delta: -safetyPenalty },
    { label: `${nFlags("IDLE_ANOMALY")} idle anomaly(ies), 14 d, recency-weighted`, delta: -flagSum("IDLE_ANOMALY", 5) },
    { label: `${nFlags("REPEATED_SEATBELT")} repeated-seatbelt flag(s)`, delta: -flagSum("REPEATED_SEATBELT", 5) },
    { label: `${nFlags("EXCESSIVE_IDLE")} excessive-idle episode(s)`, delta: -flagSum("EXCESSIVE_IDLE", 2) },
    { label: `${drowsy} drowsiness event(s) this shift`, delta: -10 * drowsy },
    {
      label: `cycle-time deviation ${devPct}%${3 * devPct > SCORE.overrunCap ? ` (capped at -${SCORE.overrunCap})` : ""}`,
      delta: devPct > 0 ? -Math.min(3 * devPct, SCORE.overrunCap) : 0,
    },
    { label: `tenure (${op.shifts_completed} shifts)`, delta: 10 * Math.min(op.shifts_completed / 20, 1) },
    {
      label: `good actions this shift: ${streaks} safe streak(s), ${nudges} idle nudge(s) acted on, ${modulesDone} module(s), ${onTime} on-time task(s)${positiveRaw > SCORE.positiveCap ? ` (capped at +${SCORE.positiveCap})` : ""}`,
      delta: positive,
    },
  ];
  const raw = 100 + terms.reduce((s, t) => s + t.delta, 0);
  const score = Math.round(Math.max(0, Math.min(100, raw)));
  const mode = modeWithHysteresis(score, prevMode);
  d.prepare("UPDATE operators SET assistance_score=?, mode=? WHERE id=?").run(score, mode, operatorId);
  return {
    score,
    mode,
    factors: {
      safety_incidents_14d: incidents.length,
      idle_anomalies_14d: nFlags("IDLE_ANOMALY"),
      drowsiness_events_shift: drowsy,
      cycle_time_deviation_pct: devPct,
      shifts_completed: op.shifts_completed,
      positive_credit_shift: positive,
    },
    terms: terms.map((t) => ({ ...t, delta: Math.round(t.delta * 10) / 10 })),
    source: "formula",
    bands: FORMULA_BANDS,
  };
}

export function idleBaseline(operatorId: string): { mean: number; std: number; n: number } {
  const rows = db().prepare("SELECT idle_ratio FROM shift_history WHERE operator_id=?").all(operatorId) as {
    idle_ratio: number;
  }[];
  const n = rows.length;
  if (n < 2) return { mean: 0.15, std: 0.05, n };
  const mean = rows.reduce((s, r) => s + r.idle_ratio, 0) / n;
  const std = Math.sqrt(rows.reduce((s, r) => s + (r.idle_ratio - mean) ** 2, 0) / (n - 1));
  return { mean, std: Math.max(std, 0.02), n };
}

/** Live idle ratio over the last `window` telemetry rows for this operator's shift. */
export function rollingIdleRatio(operatorId: string, shiftStart: string, window: number) {
  const rows = db()
    .prepare(
      "SELECT is_idle FROM telemetry WHERE operator_id=? AND timestamp>=? AND rpm>0 ORDER BY id DESC LIMIT ?",
    )
    .all(operatorId, shiftStart, window) as { is_idle: number }[];
  if (!rows.length) return { ratio: 0, n: 0 };
  return { ratio: rows.reduce((s, r) => s + r.is_idle, 0) / rows.length, n: rows.length };
}
