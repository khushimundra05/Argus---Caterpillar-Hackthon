// Central thresholds for the deterministic safety engine + statistical layer.
// Tuned for a live demo (short windows); real deployments would lengthen these.

export const CV_SERVICE_URL = process.env.CV_SERVICE_URL ?? "http://127.0.0.1:8001";
// Gemini free tier: each model has its own quota, so the agent rotates through this list on 429s.
// Flash-Lite first (highest free limits, lowest latency). Override with GEMINI_MODELS=a,b,c in .env.local.
export const GEMINI_MODELS = (
  process.env.GEMINI_MODELS ??
  "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-2.5-flash-lite,gemini-3.5-flash,gemini-2.5-flash"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

export const SAFETY = {
  proximityCriticalM: 3,
  proximityWarningM: 6,
  // CV readings older than this are ignored (camera turned off / service down)
  cvStaleMs: 4000,
  // Idle: continuous idle seconds before we nudge / flag
  idleNudgeSec: 20,
  idleAlertSec: 60,
  fuelPricePerL: 1.1, // USD
};

export const ANOMALY = {
  zThreshold: 2.0,
  windowTicks: 30, // rolling window of telemetry rows used for the live idle ratio
  minWindowTicks: 10,
};

// Proficiency score tuning (see stats.ts computeScore)
export const SCORE = {
  halfLifeDays: 7, // incident / anomaly penalties fade: weight = 0.5 ^ (age_days / halfLifeDays)
  lookbackDays: 14,
  fastCorrectionSec: 5, // critical alert resolved within this → reduced penalty
  safeStreakBlockSec: 120, // incident-free engine time per +2 reward (short for the demo)
  positiveCap: 20, // max positive credit per shift, so safety incidents always dominate
  overrunCap: 15, // max penalty from task overruns, so one slow/paused task can't zero the score
  hysteresis: 3, // points past a band boundary before the mode changes
  shiftHours: 10, // used to decide whether a novice has time for a suggested training module
};

export type Mode = "Instructor" | "Coaching" | "Assist" | "Silent Guardian";

/** Lower bound of each mode's score band. The formula uses 40/66/86; the ML model ships its own
 *  (re-tuned to its compressed 100*(1-p) scale, see cv-service/train_proficiency.py). */
export type Bands = { coaching: number; assist: number; silent_guardian: number };
export const FORMULA_BANDS: Bands = { coaching: 40, assist: 66, silent_guardian: 86 };

export function modeForScore(score: number, bands: Bands = FORMULA_BANDS): Mode {
  if (score < bands.coaching) return "Instructor";
  if (score < bands.assist) return "Coaching";
  if (score < bands.silent_guardian) return "Assist";
  return "Silent Guardian";
}

const MODE_ORDER: Mode[] = ["Instructor", "Coaching", "Assist", "Silent Guardian"];
const bandLow = (m: Mode, b: Bands) => ({ Instructor: 0, Coaching: b.coaching, Assist: b.assist, "Silent Guardian": b.silent_guardian })[m];

/** Like modeForScore, but only leaves the previous mode once the score is `hysteresis` points past the boundary. */
export function modeWithHysteresis(score: number, prev: Mode | null, bands: Bands = FORMULA_BANDS): Mode {
  const raw = modeForScore(score, bands);
  if (!prev || raw === prev) return raw;
  const up = MODE_ORDER.indexOf(raw) > MODE_ORDER.indexOf(prev);
  const boundary = up ? bandLow(MODE_ORDER[MODE_ORDER.indexOf(prev) + 1], bands) : bandLow(prev, bands);
  const clear = up ? score >= boundary + SCORE.hysteresis : score < boundary - SCORE.hysteresis;
  return clear ? raw : prev;
}
