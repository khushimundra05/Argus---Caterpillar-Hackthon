// Spoken task briefing, built when a task starts.
//   1. Deterministic layer (source of truth): task-guides.json + live ETA + weather + operator mode decide
//      WHAT is said: the approved safety points (identical for every level), how-to depth, training suggestion.
//   2. Gemini (optional wording layer): turns those approved facts into a natural, personalised briefing.
//      It must return exactly one line per approved safety point, or we fall back to the approved text.
//   3. If Gemini is unavailable/slow/invalid, the deterministic template is spoken instead.
import guides from "../../data/task-guides.json";
import { db, getOperator } from "./db";
import { SCORE, type Mode } from "./config";
import { etaFeaturesFor, modeOf, sim } from "./engine";
import { predictMinutes } from "./eta";
import { MODULES } from "./training";
import { composeJson } from "./agent";

type Step = { do: string; why: string };
type Guide = { safety: string[]; steps: Step[]; tip: string; training: string };
const G = guides as unknown as Record<string, unknown> & {
  _general_safety: string[];
  _weather: Record<string, string>;
  _temperature: { hot: string; cold: string };
};

export type Briefing = {
  taskId: number;
  task: string;
  mode: Mode;
  eta_minutes: number;
  safety: string[];
  steps: string[];
  tip: string | null;
  training: { id: string; title: string; duration_min: number; reason: string | null } | null;
  spoken: string;
  source: "gemini" | "template";
  model?: string;
};

const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

// How much how-to guidance each level gets (the safety block is the same for all)
const DEPTH: Record<Mode, string> = {
  Instructor: "Novice operator. Walk through EVERY provided step in order and briefly say why each matters. Warm and encouraging. Up to 8 sentences.",
  Coaching: "Developing operator. Mention the provided key steps briefly plus the tip. Supportive. Up to 4 sentences.",
  Assist: "Competent operator. No how-to steps. At most one short sentence.",
  "Silent Guardian": "Expert operator. No how-to steps and no tips. Leave guidance empty unless there is a training suggestion.",
};

export async function buildBriefing(taskId: number): Promise<Briefing | null> {
  const s = sim();
  const ef = etaFeaturesFor(taskId, s);
  if (!ef) return null;
  const { task } = ef;
  const mode = modeOf(s);
  const guide = G[task.task_type] as Guide | undefined;
  const eta = Math.round((await predictMinutes(ef.features)).minutes);
  const novice = mode === "Instructor" || mode === "Coaching";

  // 1. Safety: same for everyone
  const safety = [...G._general_safety, ...(guide?.safety ?? [])];
  if (G._weather[s.weather]) safety.push(G._weather[s.weather]);
  if (s.temperatureC >= 35) safety.push(G._temperature.hot);
  else if (s.temperatureC <= 0) safety.push(G._temperature.cold);

  // 2. How-to: depth depends on proficiency
  const all = guide?.steps ?? [];
  const steps =
    mode === "Instructor"
      ? all.map((st, i) => `Step ${i + 1}: ${st.do} This matters because ${lowerFirst(st.why)}`)
      : mode === "Coaching"
        ? all.slice(0, 3).map((st, i) => `${i + 1}: ${st.do}`)
        : [];
  const tip = novice ? guide?.tip ?? null : null;

  // 3. Optional training for Instructor/Coaching: the "how to" module for THIS task, if not done and the shift has room
  let training: Briefing["training"] = null;
  const mod = MODULES.find((m) => m.id === guide?.training);
  if (novice && mod) {
    const done = db().prepare("SELECT 1 FROM training_progress WHERE operator_id=? AND module_id=?").get(s.operatorId, mod.id);
    const remaining = (db()
      .prepare("SELECT COALESCE(SUM(estimated_minutes),0) m FROM tasks WHERE operator_id=? AND kind='shift' AND status='scheduled' AND id<>?")
      .get(s.operatorId, taskId) as { m: number }).m;
    const shiftEnd = Date.parse(s.shiftStart) + SCORE.shiftHours * 3600e3;
    const slack = (shiftEnd - Date.now()) / 60000 - eta - remaining;
    if (!done && slack >= mod.duration_min)
      training = { id: mod.id, title: mod.title, duration_min: mod.duration_min, reason: "it covers how to do this task" };
  }

  // Deterministic template (fallback, and what Gemini is grounded on)
  const intro =
    mode === "Instructor"
      ? `Starting ${task.name}. The target is ${task.target_cycles} load cycles, which should take about ${eta} minutes.`
      : mode === "Silent Guardian"
        ? `Starting ${task.name}, about ${eta} minutes.`
        : `Starting ${task.name}: ${task.target_cycles} cycles, about ${eta} minutes.`;
  const guidanceParts: string[] = [];
  if (steps.length) guidanceParts.push(`${mode === "Instructor" ? "Here is how to do it." : "Key steps."} ${steps.join(" ")}`);
  if (tip) guidanceParts.push(`Tip: ${tip}`);
  if (training)
    guidanceParts.push(
      `If you have ${training.duration_min} minutes, the ${training.title} module ${training.reason ? `is worth a look, because ${training.reason}` : "is recommended"}. It's optional.`,
    );
  const base = { taskId, task: task.name, mode, eta_minutes: eta, safety, steps, tip, training };
  const template: Briefing = {
    ...base,
    spoken: [intro, `Safety first. ${safety.join(" ")}`, ...guidanceParts].join(" "),
    source: "template",
  };

  // Gemini wording layer
  const op = getOperator(s.operatorId)!;
  const recent = (db()
    .prepare("SELECT DISTINCT type FROM incidents WHERE operator_id=? AND timestamp>=?")
    .all(s.operatorId, new Date(Date.now() - 14 * 864e5).toISOString()) as { type: string }[]).map((r) => r.type.toLowerCase());
  const hour = new Date().getHours();
  const facts = {
    operator_first_name: op.name.split(" ")[0],
    time_of_day: hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening",
    experience_years: op.experience_years,
    proficiency_mode: mode,
    task: task.name,
    target_cycles: task.target_cycles,
    eta_minutes: eta,
    weather: s.weather,
    temperature_c: s.temperatureC,
    recent_safety_issues: recent,
    approved_safety_points: safety,
    how_to_steps: mode === "Instructor" ? all : mode === "Coaching" ? all.slice(0, 3).map((x) => ({ do: x.do })) : [],
    tip,
    optional_training: training ? { title: training.title, minutes: training.duration_min, why: training.reason } : null,
  };
  const ai = await composeJson<{ opening: string; safety: string[]; guidance: string }>(
    `You write short spoken briefings for a CAT machine operator at the start of a task. The text is read aloud by text-to-speech: plain sentences, no markdown, no lists, no emoji.
STRICT RULES:
- You only reword facts you are given. Never add safety rules, numbers, thresholds or procedures that are not in the input.
- "safety" must contain EXACTLY one line per item of approved_safety_points, in the same order. Each line keeps the full meaning of that point (reword naturally, never soften, never merge, never drop).
- "opening": one sentence that greets the operator by first name and states the task and the ETA in minutes. You may mention the weather or a recent safety issue in a supportive, non-blaming way.
- "guidance": ${DEPTH[mode]} Use only how_to_steps and tip. If optional_training is given, end by suggesting it as optional, only if they have time; never make it sound mandatory.`,
    JSON.stringify(facts),
    {
      type: "object",
      properties: {
        opening: { type: "string" },
        safety: { type: "array", items: { type: "string" } },
        guidance: { type: "string" },
      },
      required: ["opening", "safety", "guidance"],
    },
  );

  // Guardrail: every approved safety point must be covered one-to-one, otherwise speak the approved text verbatim
  if (!ai || typeof ai.data?.opening !== "string" || !ai.data.opening.trim()) return template;
  const clean = (t: string) => t.replace(/[*#`_]/g, "").trim();
  const safetyOk =
    Array.isArray(ai.data.safety) && ai.data.safety.length === safety.length && ai.data.safety.every((l) => typeof l === "string" && l.trim().length > 8);
  const safetyLines = safetyOk ? ai.data.safety.map(clean) : safety;
  const guidance = typeof ai.data.guidance === "string" ? clean(ai.data.guidance) : "";
  return {
    ...base,
    spoken: [clean(ai.data.opening), `Safety first. ${safetyLines.join(" ")}`, guidance || guidanceParts.join(" ")].filter(Boolean).join(" "),
    source: "gemini",
    model: ai.model,
  };
}
