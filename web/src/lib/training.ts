import modules from "../../data/training-modules.json";
import { db } from "./db";

export type TrainingModule = {
  id: string; title: string; trigger_tag: string; duration_min: number; level: string; summary: string;
  video?: string; sections: { heading: string; body: string }[];
  quiz: { q: string; options: string[]; answer: number }[];
};
export const MODULES = modules as TrainingModule[];

/** Rule-based recommendation: map the operator's recent incidents / behavior flags to module tags. */
export function recommendTraining(operatorId: string) {
  const d = db();
  const since = new Date(Date.now() - 14 * 864e5).toISOString();
  const inc = d
    .prepare("SELECT type, COUNT(*) n FROM incidents WHERE operator_id=? AND timestamp>=? GROUP BY type")
    .all(operatorId, since) as { type: string; n: number }[];
  const beh = d
    .prepare("SELECT event_type, COUNT(*) n FROM behavior_logs WHERE operator_id=? AND timestamp>=? GROUP BY event_type")
    .all(operatorId, since) as { event_type: string; n: number }[];
  const dev = d
    .prepare(
      "SELECT AVG((actual_minutes-estimated_minutes)/estimated_minutes) v FROM tasks WHERE operator_id=? AND status='completed' AND actual_minutes IS NOT NULL",
    )
    .get(operatorId) as { v: number | null };
  const done = new Set(
    (d.prepare("SELECT module_id FROM training_progress WHERE operator_id=?").all(operatorId) as { module_id: string }[]).map(
      (r) => r.module_id,
    ),
  );

  const weight: Record<string, { w: number; reason: string }> = {};
  const add = (tag: string, w: number, reason: string) => {
    if (!weight[tag] || weight[tag].w < w) weight[tag] = { w, reason };
    else weight[tag].w += w / 2;
  };
  for (const r of inc) {
    if (r.type === "SEATBELT") add("SEATBELT", 10 * r.n, `${r.n} seatbelt incident(s) in 14 days`);
    if (r.type === "PROXIMITY") add("PROXIMITY", 10 * r.n, `${r.n} hazard-zone incident(s) in 14 days`);
    if (r.type === "DROWSINESS") add("DROWSINESS", 12 * r.n, `${r.n} drowsiness event(s) in 14 days`);
  }
  for (const b of beh) {
    if (b.event_type === "IDLE_ANOMALY" || b.event_type === "EXCESSIVE_IDLE") add("IDLE", 4 * b.n, `${b.n} idle anomaly flag(s)`);
    if (b.event_type === "REPEATED_SEATBELT") add("SEATBELT", 15, "repeated seatbelt violations this shift");
  }
  if ((dev.v ?? 0) > 0.03) add("CYCLE_TIME", 5, `tasks running ${Math.round((dev.v ?? 0) * 100)}% over plan`);

  return MODULES.map((m) => ({
    id: m.id,
    title: m.title,
    duration_min: m.duration_min,
    trigger_tag: m.trigger_tag,
    completed: done.has(m.id),
    priority: done.has(m.id) ? 0 : weight[m.trigger_tag]?.w ?? 0,
    reason: weight[m.trigger_tag]?.reason ?? null,
  })).sort((a, b) => b.priority - a.priority);
}

export function markComplete(operatorId: string, moduleId: string) {
  db()
    .prepare("INSERT OR REPLACE INTO training_progress (operator_id,module_id,completed_at) VALUES (?,?,?)")
    .run(operatorId, moduleId, new Date().toISOString());
}
