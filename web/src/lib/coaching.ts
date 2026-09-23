// Proactive coaching AFTER a critical alert has cleared. Never in the safety path: the alert itself was
// already raised and spoken deterministically. Gemini only words a short coaching message from approved SOP
// text; if it's unavailable, a template is used.
import { db } from "./db";
import type { Mode } from "./config";
import { modeOf, sim } from "./engine";
import { searchKb } from "./kb";
import { MODULES } from "./training";
import { composeJson } from "./agent";

const KB_QUERY: Record<string, string> = {
  SEATBELT: "seatbelt fastened engine running stop parking brake",
  PROXIMITY: "person detected within 3 metres stop motion exclusion zone",
  DROWSINESS: "drowsiness park safely break supervisor",
};
const LENGTH: Record<Mode, string> = {
  Instructor: "Up to 4 sentences: acknowledge it's cleared, explain why it matters, give the SOP action, and encourage them.",
  Coaching: "2 to 3 sentences: acknowledge it's cleared and give one practical point from the SOP.",
  Assist: "1 to 2 short sentences.",
  "Silent Guardian": "One short sentence, max about 15 words.",
};

export type Coaching = { text: string; mode: Mode; source: "gemini" | "template"; model?: string; training: { id: string; title: string } | null };

export async function buildCoaching(type: string): Promise<Coaching | null> {
  if (!KB_QUERY[type]) return null;
  const s = sim();
  const mode = modeOf(s);
  const inc = db()
    .prepare("SELECT timestamp, resolved_at FROM incidents WHERE operator_id=? AND type=? ORDER BY id DESC LIMIT 1")
    .get(s.operatorId, type) as { timestamp: string; resolved_at: string | null } | undefined;
  const count14d = (db()
    .prepare("SELECT COUNT(*) n FROM incidents WHERE operator_id=? AND type=? AND timestamp>=?")
    .get(s.operatorId, type, new Date(Date.now() - 14 * 864e5).toISOString()) as { n: number }).n;
  const seconds = inc?.resolved_at ? Math.round((Date.parse(inc.resolved_at) - Date.parse(inc.timestamp)) / 1000) : null;
  const sop = searchKb(KB_QUERY[type], 2);
  const mod = MODULES.find((m) => m.trigger_tag === type);
  const done = mod ? !!db().prepare("SELECT 1 FROM training_progress WHERE operator_id=? AND module_id=?").get(s.operatorId, mod.id) : true;
  const training = mod && !done && (mode === "Instructor" || mode === "Coaching") ? { id: mod.id, title: mod.title } : null;

  const label = type.toLowerCase();
  const template: Coaching = {
    text:
      mode === "Silent Guardian" || mode === "Assist"
        ? `${type === "SEATBELT" ? "Seatbelt" : type === "PROXIMITY" ? "Proximity" : "Drowsiness"} alert cleared. ${sop[0]?.text ?? ""}`.trim()
        : `The ${label} alert is cleared${seconds != null ? ` after ${seconds} seconds` : ""}. ${sop[0]?.text ?? ""}${training ? ` When you have time, the ${training.title} module covers this. It's optional.` : ""}`,
    mode,
    source: "template",
    training,
  };

  const ai = await composeJson<{ message: string }>(
    `You are Argus, an in-cab co-pilot. A safety alert has just CLEARED. Write one short spoken coaching message for the operator (read aloud by text-to-speech: plain sentences, no markdown, no emoji).
STRICT RULES: use only the approved SOP text provided; never add rules, numbers or procedures; never blame; never say the alert was false or unimportant. ${LENGTH[mode]}${training ? " End by suggesting the training module as optional, only if they have time." : ""}`,
    JSON.stringify({
      alert_type: label,
      seconds_until_corrected: seconds,
      same_alert_count_last_14_days: count14d,
      proficiency_mode: mode,
      approved_sop_text: sop.map((x) => x.text),
      optional_training: training?.title ?? null,
    }),
    { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
  );
  const msg = ai?.data?.message?.replace(/[*#`_]/g, "").trim();
  if (!ai || !msg) return template;
  return { text: msg, mode, source: "gemini", model: ai.model, training };
}
