// Central thresholds for the deterministic safety engine + statistical layer.
// Tuned for a live demo (short windows); real deployments would lengthen these.

export const CV_SERVICE_URL = process.env.CV_SERVICE_URL ?? "http://127.0.0.1:8001";
export const MODEL = process.env.ARGUS_MODEL ?? "claude-opus-5";

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

export type Mode = "Instructor" | "Coaching" | "Assist" | "Silent Guardian";

export function modeForScore(score: number): Mode {
  if (score < 40) return "Instructor";
  if (score <= 65) return "Coaching";
  if (score <= 85) return "Assist";
  return "Silent Guardian";
}
