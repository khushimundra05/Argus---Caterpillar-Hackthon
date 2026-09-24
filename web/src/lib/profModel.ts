// ML proficiency score (prof-v1, cv-service POST /score). Builds the model's 24 features from the live DB,
// calls the Python service, and falls back to the rule-based formula (stats.ts computeScore) on any failure.
// Feature definitions follow cv-service/PROFICIENCY_MODEL.md (1 shift = 1 day for the 7d/14d windows).
import { db, getMachine, getOperator } from "./db";
import { CV_SERVICE_URL, SCORE, type Bands } from "./config";
import { idleBaseline } from "./stats";
import { MODULES } from "./training";

type Ctx = { operatorId: string; machineId: string; shiftStart: string; weather: string };
export type ProfFeatures = Record<string, number | null>;
export type ModelScore = {
  score: number; incident_risk: number; contributions: { feature: string; delta: number }[]; model_version: string; bands?: Bands | null;
};

const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString();

export function buildProfFeatures(c: Ctx): ProfFeatures {
  const d = db();
  const op = getOperator(c.operatorId)!;
  const m = getMachine(c.machineId)!;
  const now = Date.now();
  const d7 = daysAgo(7);
  const d14 = daysAgo(14);

  const inc14 = d
    .prepare("SELECT type, timestamp, resolved_at FROM incidents WHERE operator_id=? AND timestamp>=?")
    .all(c.operatorId, d14) as { type: string; timestamp: string; resolved_at: string | null }[];
  const count = (type: string, since: string) => inc14.filter((i) => i.type === type && i.timestamp >= since).length;
  const secs = inc14
    .filter((i) => i.resolved_at)
    .map((i) => (Date.parse(i.resolved_at!) - Date.parse(i.timestamp)) / 1000)
    .sort((a, b) => a - b);
  const median = secs.length ? (secs.length % 2 ? secs[(secs.length - 1) / 2] : (secs[secs.length / 2 - 1] + secs[secs.length / 2]) / 2) : null;

  const flags = (type: string, since: string) =>
    (d.prepare("SELECT COUNT(*) n FROM behavior_logs WHERE operator_id=? AND event_type=? AND timestamp>=?").get(c.operatorId, type, since) as {
      n: number;
    }).n;

  const idle = d
    .prepare("SELECT AVG(is_idle) r, COUNT(*) n FROM telemetry WHERE operator_id=? AND timestamp>=? AND rpm>0")
    .get(c.operatorId, c.shiftStart) as { r: number | null; n: number };
  const base = idleBaseline(c.operatorId);
  const idleRatio = idle.n ? idle.r : null;

  const tasks7 = d
    .prepare("SELECT estimated_minutes e, actual_minutes a FROM tasks WHERE operator_id=? AND status='completed' AND completed_at>=? AND actual_minutes IS NOT NULL")
    .all(c.operatorId, d7) as { e: number; a: number }[];
  const overruns = tasks7.map((t) => ((t.a - t.e) / t.e) * 100);

  const done = d.prepare("SELECT module_id, completed_at FROM training_progress WHERE operator_id=?").all(c.operatorId) as {
    module_id: string; completed_at: string;
  }[];
  const allInc = d.prepare("SELECT type, timestamp FROM incidents WHERE operator_id=?").all(c.operatorId) as { type: string; timestamp: string }[];
  const afterIncident = done.filter((t) => {
    const tag = MODULES.find((mod) => mod.id === t.module_id)?.trigger_tag;
    return allInc.some((i) => i.type === tag && i.timestamp < t.completed_at);
  }).length;

  return {
    experience_years: op.experience_years,
    shifts_completed: op.shifts_completed,
    seatbelt_incidents_7d: count("SEATBELT", d7),
    proximity_incidents_7d: count("PROXIMITY", d7),
    safety_incidents_14d_weighted: inc14.reduce((s, i) => s + Math.pow(0.5, (now - Date.parse(i.timestamp)) / 864e5 / SCORE.halfLifeDays), 0),
    pct_corrected_fast: secs.length ? secs.filter((x) => x <= SCORE.fastCorrectionSec).length / secs.length : null,
    median_seconds_to_correct: median,
    drowsiness_shift: count("DROWSINESS", c.shiftStart),
    drowsiness_7d: count("DROWSINESS", d7),
    idle_anomalies_7d: flags("IDLE_ANOMALY", d7),
    excessive_idle_7d: flags("EXCESSIVE_IDLE", d7),
    repeated_seatbelt_7d: flags("REPEATED_SEATBELT", d7),
    nudges_acted_on_shift: flags("NUDGE_RESPONDED", c.shiftStart),
    safe_streaks_shift: flags("SAFE_STREAK", c.shiftStart),
    idle_ratio_shift: idleRatio,
    idle_z_shift: idleRatio == null ? null : (idleRatio - base.mean) / base.std,
    // The demo simulator compresses time (~4 s per load cycle), so per-cycle / per-hour rates are far outside the
    // training range. Sent as unknown; both are unconstrained features and the model handles missing values.
    fuel_per_cycle: null,
    cycles_per_engine_hour: null,
    mean_overrun_pct_7d: overruns.length ? overruns.reduce((a, b) => a + b, 0) / overruns.length : null,
    on_time_rate_7d: overruns.length ? overruns.filter((o) => o <= 5).length / overruns.length : null,
    modules_completed: done.length,
    modules_after_incident: afterIncident,
    machine_age_years: m.age_years,
    bad_weather_share: c.weather === "clear" ? 0 : 1, // current conditions (weather isn't logged per telemetry row)
  };
}

export async function fetchModelScore(c: Ctx): Promise<{ result: ModelScore; features: ProfFeatures } | null> {
  const features = buildProfFeatures(c);
  try {
    const r = await fetch(`${CV_SERVICE_URL}/score`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operator_id: c.operatorId, features }),
      signal: AbortSignal.timeout(1500),
    });
    if (!r.ok) return null;
    const result = (await r.json()) as ModelScore;
    if (typeof result.score !== "number") return null;
    return { result, features };
  } catch {
    return null; // service down or slow: the rule-based formula stays in place
  }
}

// Plain-English labels for the score card
export const FEATURE_LABEL: Record<string, string> = {
  experience_years: "experience (years)",
  shifts_completed: "shifts completed",
  seatbelt_incidents_7d: "seatbelt incidents, 7 d",
  proximity_incidents_7d: "proximity incidents, 7 d",
  safety_incidents_14d_weighted: "recent incidents, 14 d weighted",
  pct_corrected_fast: "alerts corrected within 5 s",
  median_seconds_to_correct: "median seconds to correct",
  drowsiness_shift: "drowsiness this shift",
  drowsiness_7d: "drowsiness, 7 d",
  idle_anomalies_7d: "idle anomalies, 7 d",
  excessive_idle_7d: "excessive-idle episodes, 7 d",
  repeated_seatbelt_7d: "repeated-seatbelt flags, 7 d",
  nudges_acted_on_shift: "idle nudges acted on",
  safe_streaks_shift: "safe streaks this shift",
  idle_ratio_shift: "idle ratio this shift",
  idle_z_shift: "idle vs personal baseline",
  fuel_per_cycle: "fuel per cycle",
  cycles_per_engine_hour: "cycles per engine hour",
  mean_overrun_pct_7d: "task overrun, 7 d",
  on_time_rate_7d: "on-time task rate, 7 d",
  modules_completed: "training modules completed",
  modules_after_incident: "training after an incident",
  machine_age_years: "machine age",
  bad_weather_share: "bad weather",
};

const fmt = (f: string, v: number | null | undefined) => {
  if (v == null) return "";
  if (f.startsWith("pct_") || f.endsWith("_rate_7d") || f === "idle_ratio_shift") return ` (${Math.round(v * 100)}%)`;
  return ` (${Math.round(v * 100) / 100})`;
};
export const contributionLabel = (f: string, features: ProfFeatures) => `${FEATURE_LABEL[f] ?? f}${fmt(f, features[f])}`;
