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

export function modeForScore(score: number): Mode {
  if (score < 40) return "Instructor";
  if (score <= 65) return "Coaching";
  if (score <= 85) return "Assist";
  return "Silent Guardian";
}

const MODE_ORDER: Mode[] = ["Instructor", "Coaching", "Assist", "Silent Guardian"];
const BAND_LOW: Record<Mode, number> = { Instructor: 0, Coaching: 40, Assist: 66, "Silent Guardian": 86 };

/** Like modeForScore, but only leaves the previous mode once the score is `hysteresis` points past the boundary. */
export function modeWithHysteresis(score: number, prev: Mode | null): Mode {
  const raw = modeForScore(score);
  if (!prev || raw === prev) return raw;
  const up = MODE_ORDER.indexOf(raw) > MODE_ORDER.indexOf(prev);
  const boundary = up ? BAND_LOW[MODE_ORDER[MODE_ORDER.indexOf(prev) + 1]] : BAND_LOW[prev];
  const clear = up ? score >= boundary + SCORE.hysteresis : score <= boundary - 1 - SCORE.hysteresis;
  return clear ? raw : prev;
}
