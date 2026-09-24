// End-of-shift report for the supervisor: aggregates the current operator's shift from the DB,
// adds a Gemini-written narrative (template fallback), and caches the result for the PDF export.
import { db, getMachine, getOperator, type Incident, type Task } from "./db";
import { SAFETY, type Mode } from "./config";
import { sim } from "./engine";
import { recommendTraining } from "./training";
import { composeJson } from "./agent";

type TelRow = { timestamp: string; fuel_used: number; load_cycles: number; is_idle: number; rpm: number };

export type ShiftReport = {
  generated_at: string;
  operator: { id: string; name: string; experience_years: number; shifts_completed: number };
  machine: { id: string; model: string; type: string };
  shift: { start: string; end: string; duration_min: number };
  proficiency: {
    start: { score: number; mode: string } | null;
    end: { score: number; mode: string; source: string; incident_risk: number | null };
    series: { t: string; score: number; mode: string; source: string }[];
    top_factors: { label: string; delta: number }[];
    bands: { coaching: number; assist: number; silent_guardian: number };
  };
  tasks: { name: string; status: string; planned_min: number; actual_min: number | null; cycles_done: number; target_cycles: number }[];
  kpis: {
    engine_min: number; working_min: number; idle_min: number; idle_pct: number;
    fuel_l: number; idle_fuel_l: number; idle_cost_usd: number; load_cycles: number;
    tasks_completed: number; tasks_total: number; incidents: number; median_seconds_to_correct: number | null;
    nudges_acted_on: number; safe_streaks: number; training_completed: number;
  };
  incidents: { time: string; type: string; seconds_to_correct: number | null; source: string | null }[];
  flags: Record<string, number>;
  training_completed: { id: string; at: string }[];
  training_recommended: { title: string; reason: string | null }[];
  timeline: { t: string; idle_pct: number; cycles: number; fuel_l: number }[];
  narrative: { supervisor: string; operator_spoken: string; source: "gemini" | "template"; model?: string };
};

const g = globalThis as unknown as { __argusReports?: Record<string, ShiftReport> };
const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

export async function buildShiftReport(): Promise<ShiftReport> {
  const s = sim();
  const d = db();
  const op = getOperator(s.operatorId)!;
  const m = getMachine(s.machineId)!;
  const start = s.shiftStart;
  const endMs = Date.now();
  const end = new Date(endMs).toISOString();

  // ---- Telemetry: engine / idle time and fuel from per-row deltas (sim counters reset per session) ----
  const tel = d
    .prepare("SELECT timestamp, fuel_used, load_cycles, is_idle, rpm FROM telemetry WHERE operator_id=? AND timestamp>=? ORDER BY id")
    .all(s.operatorId, start) as TelRow[];
  let engineS = 0, idleS = 0, fuel = 0, cycles = 0;
  const bucketMs = Math.max(15_000, (endMs - Date.parse(start)) / 40);
  const buckets = new Map<number, { idle: number; on: number; cycles: number; fuel: number }>();
  for (let i = 1; i < tel.length; i++) {
    const a = tel[i - 1], b = tel[i];
    const dt = Math.min((Date.parse(b.timestamp) - Date.parse(a.timestamp)) / 1000, 5);
    const df = Math.max(0, b.fuel_used - a.fuel_used);
    const dc = Math.max(0, b.load_cycles - a.load_cycles);
    const key = Math.floor((Date.parse(b.timestamp) - Date.parse(start)) / bucketMs);
    const bk = buckets.get(key) ?? { idle: 0, on: 0, cycles: 0, fuel: 0 };
    if (b.rpm > 0) {
      engineS += dt;
      bk.on += dt;
      if (b.is_idle) {
        idleS += dt;
        bk.idle += dt;
      }
    }
    fuel += df;
    cycles += dc;
    bk.fuel += df;
    bk.cycles += dc;
    buckets.set(key, bk);
  }
  const timeline = [...buckets.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([k, v]) => ({
      t: new Date(Date.parse(start) + (k + 1) * bucketMs).toISOString(),
      idle_pct: v.on ? round((v.idle / v.on) * 100, 0) : 0,
      cycles: v.cycles,
      fuel_l: round(v.fuel, 3),
    }));

  // ---- Tasks, incidents, flags, training ----
  const tasks = (d
    .prepare("SELECT * FROM tasks WHERE operator_id=? AND kind='shift' ORDER BY scheduled_start")
    .all(s.operatorId) as Task[]).map((t) => ({
    name: t.name, status: t.status, planned_min: t.estimated_minutes, actual_min: t.actual_minutes,
    cycles_done: t.cycles_done, target_cycles: t.target_cycles,
  }));
  const incidents = (d
    .prepare("SELECT * FROM incidents WHERE operator_id=? AND timestamp>=? ORDER BY id")
    .all(s.operatorId, start) as (Incident & { resolved_at: string | null })[]).map((i) => ({
    time: i.timestamp, type: i.type, source: i.source,
    seconds_to_correct: i.resolved_at ? round((Date.parse(i.resolved_at) - Date.parse(i.timestamp)) / 1000) : null,
  }));
  const secs = incidents.map((i) => i.seconds_to_correct).filter((x): x is number => x != null).sort((a, b) => a - b);
  const flags: Record<string, number> = {};
  for (const r of d
    .prepare("SELECT event_type, COUNT(*) n FROM behavior_logs WHERE operator_id=? AND timestamp>=? GROUP BY event_type")
    .all(s.operatorId, start) as { event_type: string; n: number }[])
    flags[r.event_type] = r.n;
  const trained = (d
    .prepare("SELECT module_id, completed_at FROM training_progress WHERE operator_id=? AND completed_at>=?")
    .all(s.operatorId, start) as { module_id: string; completed_at: string }[]).map((r) => ({ id: r.module_id, at: r.completed_at }));

  // ---- Proficiency over the shift ----
  const series = (d
    .prepare("SELECT timestamp t, score, mode, source FROM score_log WHERE operator_id=? AND timestamp>=? ORDER BY id")
    .all(s.operatorId, start) as { t: string; score: number; mode: string; source: string }[]);
  const cur = s.score!;
  series.push({ t: end, score: cur.score, mode: cur.mode, source: cur.source });

  const report: ShiftReport = {
    generated_at: end,
    operator: { id: op.id, name: op.name, experience_years: op.experience_years, shifts_completed: op.shifts_completed },
    machine: { id: m.id, model: m.model, type: m.type },
    shift: { start, end, duration_min: round((endMs - Date.parse(start)) / 60000) },
    proficiency: {
      start: series.length ? { score: series[0].score, mode: series[0].mode } : null,
      end: { score: cur.score, mode: cur.mode, source: cur.source, incident_risk: cur.model?.incident_risk ?? null },
      series,
      top_factors: cur.terms.slice(0, 6),
      bands: cur.bands,
    },
    tasks,
    kpis: {
      engine_min: round(engineS / 60), working_min: round((engineS - idleS) / 60), idle_min: round(idleS / 60),
      idle_pct: engineS ? round((idleS / engineS) * 100, 0) : 0,
      fuel_l: round(fuel, 2), idle_fuel_l: round((idleS / 3600) * m.idle_burn_lph, 2),
      idle_cost_usd: round((idleS / 3600) * m.idle_burn_lph * SAFETY.fuelPricePerL, 2),
      load_cycles: cycles,
      tasks_completed: tasks.filter((t) => t.status === "completed").length, tasks_total: tasks.length,
      incidents: incidents.length,
      median_seconds_to_correct: secs.length
        ? round(secs.length % 2 ? secs[(secs.length - 1) / 2] : (secs[secs.length / 2 - 1] + secs[secs.length / 2]) / 2)
        : null,
      nudges_acted_on: flags.NUDGE_RESPONDED ?? 0, safe_streaks: flags.SAFE_STREAK ?? 0, training_completed: trained.length,
    },
    incidents,
    flags,
    training_completed: trained,
    training_recommended: recommendTraining(s.operatorId).filter((r) => r.priority > 0 && !r.completed).slice(0, 3)
      .map((r) => ({ title: r.title, reason: r.reason })),
    timeline,
    narrative: { supervisor: "", operator_spoken: "", source: "template" },
  };
  report.narrative = await writeNarrative(report, cur.mode);
  (g.__argusReports ??= {})[op.id] = report;
  return report;
}

/** The most recent report for this operator if it is fresh (reused by the PDF export), else a new one. */
export async function latestShiftReport(maxAgeMs = 5 * 60_000): Promise<ShiftReport> {
  const cached = g.__argusReports?.[sim().operatorId];
  if (cached && Date.now() - Date.parse(cached.generated_at) < maxAgeMs) return cached;
  return buildShiftReport();
}

// ---- Narrative: Gemini writes it from the report's numbers only; template if unavailable ----
const OPERATOR_LENGTH: Record<Mode, string> = {
  Instructor: "4 to 5 short sentences, encouraging, with one clear thing to work on next shift.",
  Coaching: "3 sentences: how it went, one strength, one tip.",
  Assist: "2 short sentences, numbers first.",
  "Silent Guardian": "One short sentence.",
};

async function writeNarrative(r: ShiftReport, mode: Mode): Promise<ShiftReport["narrative"]> {
  const k = r.kpis;
  const first = r.operator.name.split(" ")[0];
  const inc = r.incidents.length
    ? `${r.incidents.length} safety incident(s) (${[...new Set(r.incidents.map((i) => i.type.toLowerCase()))].join(", ")})`
    : "no safety incidents";
  const template = {
    supervisor:
      `${r.operator.name} worked ${r.shift.duration_min} minutes on the ${r.machine.model}, completing ${k.tasks_completed} of ${k.tasks_total} tasks with ${k.load_cycles} load cycles. ` +
      `The shift had ${inc}${k.median_seconds_to_correct != null ? `, median ${k.median_seconds_to_correct} s to correct` : ""}. ` +
      `Idle time was ${k.idle_pct}% of engine time (${k.idle_fuel_l} L, about $${k.idle_cost_usd}). ` +
      `Proficiency ended at ${r.proficiency.end.score} (${r.proficiency.end.mode})` +
      (r.training_recommended.length ? `; recommended training: ${r.training_recommended.map((t) => t.title).join(", ")}.` : "."),
    operator_spoken:
      mode === "Silent Guardian" || mode === "Assist"
        ? `Shift done: ${k.tasks_completed} of ${k.tasks_total} tasks, ${r.incidents.length ? `${r.incidents.length} incidents` : "no incidents"}, ${k.idle_pct} percent idle.`
        : `Good work today, ${first}. You completed ${k.tasks_completed} of ${k.tasks_total} tasks with ${inc}. Your idle time was ${k.idle_pct} percent of engine time.` +
          (r.training_recommended[0] ? ` Next shift, the ${r.training_recommended[0].title} module would help.` : ""),
  };

  const ai = await composeJson<{ supervisor: string; operator_spoken: string }>(
    `You write end-of-shift summaries for CAT machine operators. Use ONLY the numbers and facts in the JSON; never invent or estimate figures, causes or events. Plain sentences, no markdown, no lists.
- "supervisor": 4 to 6 sentences for the operator's supervisor: productivity (tasks, cycles), safety (incidents, correction speed), efficiency (idle %, idle fuel and cost), proficiency change, and 1 or 2 concrete recommended actions (use the recommended training if given). Neutral and factual, no blame.
- "operator_spoken": read aloud to the operator (${mode} mode). ${OPERATOR_LENGTH[mode]} Supportive, addressed by first name.`,
    JSON.stringify({ ...r, timeline: undefined, proficiency: { ...r.proficiency, series: undefined }, narrative: undefined }),
    {
      type: "object",
      properties: { supervisor: { type: "string" }, operator_spoken: { type: "string" } },
      required: ["supervisor", "operator_spoken"],
    },
  );
  const clean = (t: unknown) => (typeof t === "string" ? t.replace(/[*#`_]/g, "").trim() : "");
  if (!ai || !clean(ai.data.supervisor) || !clean(ai.data.operator_spoken)) return { ...template, source: "template" };
  return { supervisor: clean(ai.data.supervisor), operator_spoken: clean(ai.data.operator_spoken), source: "gemini", model: ai.model };
}
