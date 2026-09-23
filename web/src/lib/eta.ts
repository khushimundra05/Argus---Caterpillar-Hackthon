// Task-time estimation: calls the Python RandomForest service, falls back to the same
// formula used to generate its synthetic training data if the service is down.
import { CV_SERVICE_URL } from "./config";

export type EtaFeatures = {
  task_type: string;
  target_cycles: number;
  experience_years: number;
  assistance_score: number;
  machine_age_years: number;
  machine_type: string;
  weather: string;
  temperature_c: number;
};

export type EtaResult = { minutes: number; source: "random_forest" | "heuristic"; features: EtaFeatures };

const BASE_MIN_PER_CYCLE: Record<string, number> = {
  trenching: 1.5, truck_loading: 1.25, backfill: 1.3, grading: 1.6, stockpiling: 1.45,
};
const WEATHER_MULT: Record<string, number> = { clear: 1.0, rain: 1.18, heavy_rain: 1.4, dust: 1.12, snow: 1.35 };

export function heuristicMinutes(f: EtaFeatures): number {
  const base = (BASE_MIN_PER_CYCLE[f.task_type] ?? 1.4) * f.target_cycles;
  const skill = 1.35 - 0.3 * Math.min(f.experience_years / 10, 1) - 0.1 * (f.assistance_score / 100);
  const age = 1 + 0.015 * f.machine_age_years;
  const temp = f.temperature_c > 35 || f.temperature_c < 0 ? 1.08 : 1.0;
  return Math.round(base * skill * age * (WEATHER_MULT[f.weather] ?? 1) * temp * 10) / 10;
}

export async function predictMinutes(f: EtaFeatures): Promise<EtaResult> {
  try {
    const r = await fetch(`${CV_SERVICE_URL}/predict`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(f),
      signal: AbortSignal.timeout(1500),
    });
    if (r.ok) {
      const j = (await r.json()) as { minutes: number };
      return { minutes: Math.round(j.minutes * 10) / 10, source: "random_forest", features: f };
    }
  } catch {
    /* fall through */
  }
  return { minutes: heuristicMinutes(f), source: "heuristic", features: f };
}
