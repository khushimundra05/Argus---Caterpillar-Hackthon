// READ-ONLY agent tools. None of these can write safety state, incidents, or telemetry.
// (Incident logging lives exclusively in engine.ts and is triggered by the rules engine.)
import type Anthropic from "@anthropic-ai/sdk";
import { db, getMachine, getOperator, type Incident, type Task } from "./db";
import { currentTask, etaFeaturesFor, liveEta, sim } from "./engine";
import { predictMinutes } from "./eta";
import { searchKb } from "./kb";
import { recommendTraining } from "./training";
import { idleBaseline } from "./stats";

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_daily_schedule",
    description: "Get today's scheduled tasks for an operator, with status, planned minutes, and progress.",
    input_schema: { type: "object", properties: { operator_id: { type: "string" } }, required: ["operator_id"] },
  },
  {
    name: "check_safety_status",
    description:
      "Read the current safety alert state for a machine from the deterministic safety engine (seatbelt, proximity, drowsiness, idle). Read-only.",
    input_schema: { type: "object", properties: { machine_id: { type: "string" } }, required: ["machine_id"] },
  },
  {
    name: "get_behavior_flags",
    description:
      "Get unusual-behavior flags for an operator from the statistical layer (idle z-score anomalies, excessive idling, repeated violations) plus the adaptive assistance score breakdown.",
    input_schema: { type: "object", properties: { operator_id: { type: "string" } }, required: ["operator_id"] },
  },
  {
    name: "predict_task_time",
    description:
      "Predict task completion time using the RandomForest model with live conditions (weather, operator skill, machine age). Returns total and remaining minutes.",
    input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] },
  },
  {
    name: "recommend_training",
    description: "Recommend training modules for an operator based on their recent incidents and behavior flags.",
    input_schema: { type: "object", properties: { operator_id: { type: "string" } }, required: ["operator_id"] },
  },
  {
    name: "search_knowledge_base",
    description: "Keyword search over site SOPs, safety procedures and machine manuals. Use for 'how do I' / procedure questions.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
];

type In = Record<string, unknown>;

export async function runTool(name: string, input: In): Promise<unknown> {
  const s = sim();
  const d = db();
  switch (name) {
    case "get_daily_schedule": {
      const opId = String(input.operator_id ?? s.operatorId);
      const tasks = d
        .prepare("SELECT * FROM tasks WHERE operator_id=? AND date(scheduled_start,'localtime')=date('now','localtime') ORDER BY scheduled_start")
        .all(opId) as Task[];
      return tasks.map((t) => ({
        task_id: t.id,
        name: t.name,
        scheduled_start: new Date(t.scheduled_start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        status: t.status,
        planned_minutes: t.estimated_minutes,
        progress_pct: Math.round((t.cycles_done / t.target_cycles) * 100),
        actual_minutes: t.actual_minutes,
      }));
    }
    case "check_safety_status": {
      const machineId = String(input.machine_id ?? s.machineId);
      if (machineId !== s.machineId) return { machine_id: machineId, status: "no live telemetry for this machine" };
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const inc = d
        .prepare("SELECT type,severity,timestamp,resolved,source FROM incidents WHERE machine_id=? AND timestamp>=? ORDER BY id DESC LIMIT 10")
        .all(machineId, today.toISOString()) as Incident[];
      return {
        machine_id: machineId,
        engine_on: s.engineOn,
        seatbelt_fastened: s.seatbelt,
        active_alerts: Object.values(s.alerts).map((a) => ({
          type: a!.type, severity: a!.severity, message: a!.message, source: a!.source,
          active_for_s: Math.round((Date.now() - a!.since) / 1000),
        })),
        drowsiness_camera: s.cv.driver ? { face_found: s.cv.driver.faceFound, ear: s.cv.driver.ear, method: s.cv.driver.method } : "offline",
        zone_camera: s.cv.zone ? { persons: s.cv.zone.persons, nearest_m: s.cv.zone.minDistance } : "offline",
        incidents_today: inc,
        minutes_since_last_incident: Math.round((Date.now() - s.lastIncidentAt) / 60000),
      };
    }
    case "get_behavior_flags": {
      const opId = String(input.operator_id ?? s.operatorId);
      const since = new Date(Date.now() - 7 * 864e5).toISOString();
      const flags = d
        .prepare("SELECT timestamp,event_type,detail FROM behavior_logs WHERE operator_id=? AND timestamp>=? ORDER BY id DESC LIMIT 12")
        .all(opId, since) as { timestamp: string; event_type: string; detail: string }[];
      const base = idleBaseline(opId);
      return {
        operator_id: opId,
        live_idle_ratio: opId === s.operatorId ? s.lastIdleRatio : null,
        idle_z_score: opId === s.operatorId ? s.lastZ : null,
        idle_baseline: { mean: +base.mean.toFixed(3), std: +base.std.toFixed(3), shifts: base.n },
        flags_last_7_days: flags.map((f) => ({ ...f, detail: JSON.parse(f.detail ?? "{}") })),
        assistance: opId === s.operatorId ? s.score : null,
      };
    }
    case "predict_task_time": {
      const id = Number(input.task_id);
      const ef = etaFeaturesFor(id, s);
      if (!ef) return { error: `task ${id} not found` };
      const r = await predictMinutes(ef.features);
      const cur = currentTask(s.operatorId);
      const live = cur && cur.id === id ? liveEta({ ...s, eta: { ...r, taskId: id, key: "", at: Date.now() } }, cur) : null;
      return {
        task_id: id,
        task: ef.task.name,
        predicted_total_minutes: r.minutes,
        planned_minutes: ef.task.estimated_minutes,
        remaining_minutes: live?.remaining_minutes ?? (ef.task.status === "completed" ? 0 : r.minutes),
        progress_pct: Math.round((ef.task.cycles_done / ef.task.target_cycles) * 100),
        model: r.source,
        conditions: ef.features,
      };
    }
    case "recommend_training":
      return recommendTraining(String(input.operator_id ?? s.operatorId)).slice(0, 3);
    case "search_knowledge_base":
      return searchKb(String(input.query ?? ""));
    default:
      return { error: `unknown tool ${name}` };
  }
}

export function sessionContext() {
  const s = sim();
  const op = getOperator(s.operatorId)!;
  const m = getMachine(s.machineId)!;
  const t = currentTask(s.operatorId);
  return { s, op, m, t };
}
