// Statistical layer: adaptive-assistance score + idle anomaly baseline.
// Pure rules / statistics — no ML, no LLM.
import { db, getOperator } from "./db";
import { modeForScore, type Mode } from "./config";

const weekAgo = () => new Date(Date.now() - 7 * 864e5).toISOString();

export type ScoreBreakdown = {
  score: number;
  mode: Mode;
  factors: {
    safety_incidents_7d: number;
    idle_anomalies_7d: number;
    drowsiness_events_shift: number;
    cycle_time_deviation_pct: number;
    shifts_completed: number;
  };
  terms: { label: string; delta: number }[];
};

export function computeScore(operatorId: string, shiftStart: string): ScoreBreakdown {
  const d = db();
  const op = getOperator(operatorId);
  if (!op) throw new Error(`unknown operator ${operatorId}`);
  const since = weekAgo();

  const safety = (d
    .prepare("SELECT COUNT(*) n FROM incidents WHERE operator_id=? AND timestamp>=? AND type IN ('SEATBELT','PROXIMITY')")
    .get(operatorId, since) as { n: number }).n;
  const idleAnoms = (d
    .prepare("SELECT COUNT(*) n FROM behavior_logs WHERE operator_id=? AND timestamp>=? AND event_type='IDLE_ANOMALY'")
    .get(operatorId, since) as { n: number }).n;
  const drowsy = (d
    .prepare("SELECT COUNT(*) n FROM incidents WHERE operator_id=? AND timestamp>=? AND type='DROWSINESS'")
    .get(operatorId, shiftStart) as { n: number }).n;
  const dev = d
    .prepare(
      `SELECT AVG((actual_minutes - estimated_minutes) / estimated_minutes) * 100 AS pct
       FROM tasks WHERE operator_id=? AND status='completed' AND completed_at>=? AND actual_minutes IS NOT NULL`,
    )
    .get(operatorId, since) as { pct: number | null };
  const devPct = Math.round((dev.pct ?? 0) * 10) / 10;

  const terms = [
    { label: `${safety} safety incident(s), last 7 days`, delta: -15 * safety },
    { label: `${idleAnoms} idle anomaly(ies), last 7 days`, delta: -5 * idleAnoms },
    { label: `${drowsy} drowsiness event(s) this shift`, delta: -10 * drowsy },
    { label: `cycle-time deviation ${devPct}%`, delta: devPct > 0 ? -3 * devPct : 0 },
    { label: `tenure (${op.shifts_completed} shifts)`, delta: 10 * Math.min(op.shifts_completed / 20, 1) },
  ];
  const raw = 100 + terms.reduce((s, t) => s + t.delta, 0);
  const score = Math.round(Math.max(0, Math.min(100, raw)));
  const mode = modeForScore(score);
  d.prepare("UPDATE operators SET assistance_score=?, mode=? WHERE id=?").run(score, mode, operatorId);
  return {
    score,
    mode,
    factors: {
      safety_incidents_7d: safety,
      idle_anomalies_7d: idleAnoms,
      drowsiness_events_shift: drowsy,
      cycle_time_deviation_pct: devPct,
      shifts_completed: op.shifts_completed,
    },
    terms: terms.map((t) => ({ ...t, delta: Math.round(t.delta * 10) / 10 })),
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
