// Telemetry simulator + DETERMINISTIC safety engine.
// This module is the ONLY writer of safety state and incidents. The LLM never touches it.
import { db, getMachine, getOperator, kvGet, kvSet, type Task } from "./db";
import { ANOMALY, SAFETY, SCORE, type Mode } from "./config";
import { computeScore, idleBaseline, rollingIdleRatio, type ScoreBreakdown } from "./stats";
import { predictMinutes, type EtaResult } from "./eta";

export type AlertType = "SEATBELT" | "PROXIMITY" | "DROWSINESS" | "IDLE";
export type Alert = {
  type: AlertType;
  severity: "critical" | "warning" | "info";
  message: string;
  since: number;
  source: string; // which sensor produced it
  value?: number;
};

type DriverCv = { ts: number; faceFound: boolean; ear: number | null; closedSec: number; drowsy: boolean; method: string };
type ZoneCv = { ts: number; persons: number; minDistance: number | null };

export type SimState = {
  operatorId: string;
  machineId: string;
  shiftStart: string;
  engineOn: boolean;
  seatbelt: boolean;
  working: boolean; // actively cycling vs. paused
  simPersonDistance: number | null;
  simDrowsy: boolean;
  weather: string;
  temperatureC: number;
  fuelUsed: number;
  loadCycles: number;
  idleContinuousSec: number;
  idleTotalSec: number;
  engineSec: number;
  cycleAccum: number;
  lastTickMs: number;
  lastIncidentAt: number;
  alerts: Partial<Record<AlertType, Alert>>;
  openIncidents: Partial<Record<AlertType, number>>;
  idleAnomalyActive: boolean;
  idleEpisodeLogged: boolean;
  idleNudged: boolean; // reached the idle-cost nudge in the current idle period
  safeStreakSec: number; // incident-free engine time toward the next safe-streak reward
  lastZ: number;
  lastIdleRatio: number;
  cv: { driver: DriverCv | null; zone: ZoneCv | null };
  eta: (EtaResult & { taskId: number; key: string; at: number }) | null;
  etaPending: string | null;
  score: ScoreBreakdown | null;
  events: { ts: number; kind: string; text: string }[];
};

const g = globalThis as unknown as { __argusSim?: SimState };

function fresh(operatorId: string): SimState {
  const op = getOperator(operatorId);
  if (!op) throw new Error("unknown operator");
  const now = Date.now();
  return {
    operatorId,
    machineId: op.machine_id,
    shiftStart: new Date(now).toISOString(),
    engineOn: false,
    seatbelt: true,
    working: true,
    simPersonDistance: null,
    simDrowsy: false,
    weather: "clear",
    temperatureC: 24,
    fuelUsed: 0,
    loadCycles: 0,
    idleContinuousSec: 0,
    idleTotalSec: 0,
    engineSec: 0,
    cycleAccum: 0,
    lastTickMs: now,
    lastIncidentAt: now,
    alerts: {},
    openIncidents: {},
    idleAnomalyActive: false,
    idleEpisodeLogged: false,
    idleNudged: false,
    safeStreakSec: 0,
    lastZ: 0,
    lastIdleRatio: 0,
    cv: { driver: null, zone: null },
    eta: null,
    etaPending: null,
    score: null,
    events: [],
  };
}

/** Session start: select operator, recompute score. */
export function startSession(operatorId: string): SimState {
  const s = fresh(operatorId);
  // shift start persists across page reloads for the same operator
  const saved = kvGet<{ op: string; start: string } | null>("shift", null);
  if (saved && saved.op === operatorId) s.shiftStart = saved.start;
  else kvSet("shift", { op: operatorId, start: s.shiftStart });
  g.__argusSim = s;
  s.score = computeScore(operatorId, s.shiftStart);
  pushEvent(s, "session", `Session started — ${s.score.mode} mode (score ${s.score.score})`);
  return s;
}

/** Current session. `operatorId` is only used to initialise when no session exists (e.g. after a server
 *  restart). Switching operators goes exclusively through startSession() via POST /api/session, so a poll
 *  from another tab with a stale operator id can never reset the running machine state. */
export function sim(operatorId?: string): SimState {
  if (!g.__argusSim) {
    const saved = kvGet<{ op: string; start: string } | null>("shift", null);
    return startSession(operatorId ?? saved?.op ?? "OP-101");
  }
  return g.__argusSim;
}

function pushEvent(s: SimState, kind: string, text: string) {
  s.events.unshift({ ts: Date.now(), kind, text });
  s.events = s.events.slice(0, 40);
}

export function currentTask(operatorId: string): Task | undefined {
  return db()
    .prepare("SELECT * FROM tasks WHERE operator_id=? AND status='in_progress' ORDER BY id LIMIT 1")
    .get(operatorId) as Task | undefined;
}

// ---------------- CV ingestion (called by /api/cv after Python responds) ----------------
export function ingestDriverCv(r: Omit<DriverCv, "ts">) {
  sim().cv.driver = { ...r, ts: Date.now() };
}
export function ingestZoneCv(r: Omit<ZoneCv, "ts">) {
  sim().cv.zone = { ...r, ts: Date.now() };
}

// ---------------- Tick: advance simulator, then evaluate rules ----------------
export function tick(): SimState {
  const s = sim();
  const d = db();
  const now = Date.now();
  const dt = Math.min((now - s.lastTickMs) / 1000, 5);
  if (dt < 0.25) return s; // several clients polling — don't double-advance
  s.lastTickMs = now;

  const machine = getMachine(s.machineId)!;
  const op = getOperator(s.operatorId)!;
  const task = currentTask(s.operatorId);
  const cycling = s.engineOn && !!task && s.working;
  const idle = s.engineOn && !cycling;

  if (s.engineOn) {
    s.engineSec += dt;
    s.fuelUsed += ((cycling ? machine.work_burn_lph : machine.idle_burn_lph) * dt) / 3600;
  }
  if (idle) {
    s.idleContinuousSec += dt;
    s.idleTotalSec += dt;
  } else s.idleContinuousSec = 0;

  if (cycling && task) {
    // Compressed demo time: ~4 s per load cycle, slower in bad weather / for novices
    const weatherF = { clear: 1, rain: 1.2, heavy_rain: 1.45, dust: 1.1, snow: 1.35 }[s.weather] ?? 1;
    const skillF = 1.25 - 0.25 * Math.min(op.experience_years / 10, 1);
    s.cycleAccum += dt / (4 * weatherF * skillF);
    while (s.cycleAccum >= 1) {
      s.cycleAccum -= 1;
      s.loadCycles += 1;
      task.cycles_done += 1;
    }
    d.prepare("UPDATE tasks SET cycles_done=? WHERE id=?").run(task.cycles_done, task.id);
    if (task.cycles_done >= task.target_cycles) completeTask(task.id);
  }

  const rpm = !s.engineOn ? 0 : cycling ? 1650 + Math.round(Math.random() * 150) : 820 + Math.round(Math.random() * 40);

  evaluateSafety(s, rpm);
  evaluateBehavior(s, dt);

  d.prepare(
    `INSERT INTO telemetry (machine_id,operator_id,timestamp,fuel_used,load_cycles,idling_seconds,is_idle,seatbelt_on,proximity_m,rpm,safety_alert)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    s.machineId, s.operatorId, new Date(now).toISOString(), Math.round(s.fuelUsed * 1000) / 1000, s.loadCycles,
    Math.round(s.idleTotalSec), idle ? 1 : 0, s.seatbelt ? 1 : 0, proximity(s).distance, rpm,
    Object.keys(s.alerts).join(",") || null,
  );

  refreshEta(s);
  return s;
}

function proximity(s: SimState): { distance: number | null; source: string } {
  const cvZone = s.cv.zone && Date.now() - s.cv.zone.ts < SAFETY.cvStaleMs ? s.cv.zone.minDistance : null;
  const cands: [number, string][] = [];
  if (cvZone != null) cands.push([cvZone, "zone camera (HOG)"]);
  if (s.simPersonDistance != null) cands.push([s.simPersonDistance, "proximity sensor (sim)"]);
  if (!cands.length) return { distance: null, source: "" };
  cands.sort((a, b) => a[0] - b[0]);
  return { distance: Math.round(cands[0][0] * 10) / 10, source: cands[0][1] };
}

function evaluateSafety(s: SimState, rpm: number) {
  const next: Partial<Record<AlertType, Alert>> = {};
  const keep = (a: Omit<Alert, "since">) => {
    next[a.type] = { ...a, since: s.alerts[a.type]?.since ?? Date.now() };
  };

  // 1. Seatbelt — machine running without belt
  if (s.engineOn && rpm > 0 && !s.seatbelt)
    keep({ type: "SEATBELT", severity: "critical", message: "Seatbelt not fastened while machine is running", source: "seat switch" });

  // 2. Proximity — person inside hazard zone
  const p = proximity(s);
  if (p.distance != null && p.distance < SAFETY.proximityWarningM) {
    const crit = p.distance < SAFETY.proximityCriticalM;
    keep({
      type: "PROXIMITY",
      severity: crit ? "critical" : "warning",
      message: `Person detected ${p.distance} m from machine`,
      source: p.source,
      value: p.distance,
    });
  }

  // 3. Drowsiness — sustained eye closure from driver camera (EAR)
  const dcv = s.cv.driver && Date.now() - s.cv.driver.ts < SAFETY.cvStaleMs ? s.cv.driver : null;
  if ((dcv && dcv.drowsy) || s.simDrowsy)
    keep({
      type: "DROWSINESS",
      severity: "critical",
      message: dcv?.drowsy ? `Eyes closed ${dcv.closedSec.toFixed(1)} s (EAR ${dcv.ear?.toFixed(2)})` : "Drowsiness detected",
      source: dcv?.drowsy ? `driver camera (${dcv.method})` : "driver camera (sim)",
      value: dcv?.ear ?? undefined,
    });

  // 4. Idle — live fuel-burn nudge
  if (s.idleContinuousSec >= SAFETY.idleNudgeSec) {
    const m = getMachine(s.machineId)!;
    const litres = (m.idle_burn_lph * s.idleContinuousSec) / 3600;
    const perHour = m.idle_burn_lph * SAFETY.fuelPricePerL;
    keep({
      type: "IDLE",
      severity: s.idleContinuousSec >= SAFETY.idleAlertSec ? "warning" : "info",
      message: `Idling ${Math.round(s.idleContinuousSec)} s — ${litres.toFixed(2)} L burned, costing $${perHour.toFixed(2)}/h`,
      source: "engine ECU",
      value: s.idleContinuousSec,
    });
  }

  // Rising edges -> auto incident logging (critical only) ; falling edges -> resolve
  let changed = false;
  for (const [type, a] of Object.entries(next) as [AlertType, Alert][]) {
    if (a.severity === "critical" && s.alerts[type]?.severity !== "critical" && type !== "IDLE") {
      const task = currentTask(s.operatorId);
      const snap = JSON.stringify({
        fuel_used: s.fuelUsed, load_cycles: s.loadCycles, idle_s: s.idleTotalSec, seatbelt: s.seatbelt,
        proximity_m: p.distance, rpm, weather: s.weather, cv_driver: s.cv.driver, cv_zone: s.cv.zone,
      });
      const r = db()
        .prepare(
          "INSERT INTO incidents (operator_id,machine_id,task_id,type,severity,timestamp,telemetry_snapshot,source) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(s.operatorId, s.machineId, task?.id ?? null, type, "critical", new Date().toISOString(), snap, a.source);
      s.openIncidents[type] = Number(r.lastInsertRowid);
      s.lastIncidentAt = Date.now();
      pushEvent(s, "incident", `Incident logged: ${type} — ${a.message}`);
      changed = true;
    }
  }
  for (const type of Object.keys(s.openIncidents) as AlertType[]) {
    if (!next[type] || next[type]!.severity !== "critical") {
      db().prepare("UPDATE incidents SET resolved=1, resolved_at=? WHERE id=?").run(new Date().toISOString(), s.openIncidents[type]!);
      delete s.openIncidents[type];
      pushEvent(s, "resolved", `${type} cleared`);
      changed = true; // resolution time feeds the fast-correction credit
    }
  }
  s.alerts = next;
  if (changed) recomputeScore(s);
}

function logBehavior(s: SimState, type: string, detail: unknown) {
  db().prepare("INSERT INTO behavior_logs (operator_id,timestamp,event_type,detail) VALUES (?,?,?,?)").run(
    s.operatorId, new Date().toISOString(), type, JSON.stringify(detail),
  );
}

function evaluateBehavior(s: SimState, dt: number) {
  const d = db();
  let rescore = false;

  // Positive: incident-free engine time -> safe-streak reward
  const critical = Object.values(s.alerts).some((a) => a?.severity === "critical");
  if (critical) s.safeStreakSec = 0;
  else if (s.engineOn) s.safeStreakSec += dt;
  if (s.safeStreakSec >= SCORE.safeStreakBlockSec) {
    s.safeStreakSec = 0;
    logBehavior(s, "SAFE_STREAK", { seconds: SCORE.safeStreakBlockSec });
    pushEvent(s, "reward", `Safe streak: ${Math.round(SCORE.safeStreakBlockSec / 60)} incident-free minutes — well done.`);
    rescore = true;
  }
  // Idle z-score vs this operator's historical baseline
  const { ratio, n } = rollingIdleRatio(s.operatorId, s.shiftStart, ANOMALY.windowTicks);
  const base = idleBaseline(s.operatorId);
  const z = (ratio - base.mean) / base.std;
  s.lastZ = Math.round(z * 100) / 100;
  s.lastIdleRatio = Math.round(ratio * 100) / 100;
  if (n >= ANOMALY.minWindowTicks && z > ANOMALY.zThreshold && !s.idleAnomalyActive) {
    s.idleAnomalyActive = true;
    d.prepare("INSERT INTO behavior_logs (operator_id,timestamp,event_type,detail) VALUES (?,?,?,?)").run(
      s.operatorId, new Date().toISOString(), "IDLE_ANOMALY",
      JSON.stringify({ z: s.lastZ, idle_ratio: s.lastIdleRatio, baseline_mean: +base.mean.toFixed(3), baseline_std: +base.std.toFixed(3) }),
    );
    pushEvent(s, "anomaly", `Idle anomaly: ${Math.round(ratio * 100)}% idle vs ${Math.round(base.mean * 100)}% baseline (z=${s.lastZ})`);
    recomputeScore(s);
  } else if (s.idleAnomalyActive && z < ANOMALY.zThreshold - 0.5) s.idleAnomalyActive = false;

  // Unsafe pattern: repeated seatbelt violations in one shift
  const belts = (d
    .prepare("SELECT COUNT(*) n FROM incidents WHERE operator_id=? AND type='SEATBELT' AND timestamp>=?")
    .get(s.operatorId, s.shiftStart) as { n: number }).n;
  const flagged = (d
    .prepare("SELECT COUNT(*) n FROM behavior_logs WHERE operator_id=? AND event_type='REPEATED_SEATBELT' AND timestamp>=?")
    .get(s.operatorId, s.shiftStart) as { n: number }).n;
  if (belts >= 2 && !flagged) {
    d.prepare("INSERT INTO behavior_logs (operator_id,timestamp,event_type,detail) VALUES (?,?,?,?)").run(
      s.operatorId, new Date().toISOString(), "REPEATED_SEATBELT", JSON.stringify({ count: belts }),
    );
    pushEvent(s, "anomaly", `Unsafe pattern: ${belts} seatbelt violations this shift`);
    rescore = true;
  }
  // Positive: idle period ended after the cost nudge but before it became excessive
  if (s.idleContinuousSec >= SAFETY.idleNudgeSec) s.idleNudged = true;
  if (s.idleContinuousSec === 0 && s.idleNudged) {
    if (!s.idleEpisodeLogged) {
      logBehavior(s, "NUDGE_RESPONDED", {});
      pushEvent(s, "reward", "Thanks for acting on the idle nudge — fuel saved.");
      rescore = true;
    }
    s.idleNudged = false;
  }
  // Excessive idle episode (logged once per continuous idle period)
  if (s.idleContinuousSec === 0) s.idleEpisodeLogged = false;
  if (s.idleContinuousSec >= SAFETY.idleAlertSec && !s.idleEpisodeLogged) {
    s.idleEpisodeLogged = true;
    d.prepare("INSERT INTO behavior_logs (operator_id,timestamp,event_type,detail) VALUES (?,?,?,?)").run(
      s.operatorId, new Date().toISOString(), "EXCESSIVE_IDLE", JSON.stringify({ seconds: Math.round(s.idleContinuousSec) }),
    );
    pushEvent(s, "anomaly", `Excessive idling (${Math.round(s.idleContinuousSec)} s continuous)`);
    rescore = true;
  }
  if (rescore) recomputeScore(s);
}

export function recomputeScore(s: SimState) {
  const prev = s.score?.mode;
  s.score = computeScore(s.operatorId, s.shiftStart, prev ?? null);
  if (prev && prev !== s.score.mode) pushEvent(s, "mode", `Assistance mode → ${s.score.mode} (score ${s.score.score})`);
}

// ---------------- ETA (non-blocking; re-predicts when conditions change) ----------------
export function etaFeaturesFor(taskId: number, s: SimState) {
  const task = db().prepare("SELECT * FROM tasks WHERE id=?").get(taskId) as Task | undefined;
  if (!task) return null;
  const op = getOperator(task.operator_id)!;
  const m = getMachine(task.machine_id)!;
  return {
    task,
    features: {
      task_type: task.task_type,
      target_cycles: task.target_cycles,
      experience_years: op.experience_years,
      assistance_score: s.score?.score ?? op.assistance_score,
      machine_age_years: m.age_years,
      machine_type: m.type,
      weather: s.weather,
      temperature_c: s.temperatureC,
    },
  };
}

function refreshEta(s: SimState) {
  const task = currentTask(s.operatorId);
  if (!task) return;
  const ef = etaFeaturesFor(task.id, s)!;
  const key = JSON.stringify(ef.features);
  if ((s.eta?.key === key && s.eta.taskId === task.id) || s.etaPending === key) return;
  s.etaPending = key;
  const prevMinutes = s.eta?.taskId === task.id ? s.eta.minutes : null;
  predictMinutes(ef.features).then((r) => {
    s.eta = { ...r, taskId: task.id, key, at: Date.now() };
    s.etaPending = null;
    if (prevMinutes != null && Math.abs(prevMinutes - r.minutes) >= 0.5)
      pushEvent(s, "eta", `ETA re-predicted: ${prevMinutes} → ${r.minutes} min (${s.weather}, score ${s.score?.score})`);
  });
}

export function liveEta(s: SimState, task: Task) {
  const total = s.eta && s.eta.taskId === task.id ? s.eta.minutes : task.estimated_minutes;
  const progress = Math.min(task.cycles_done / task.target_cycles, 1);
  return {
    total_minutes: total,
    remaining_minutes: Math.round(total * (1 - progress) * 10) / 10,
    progress,
    source: s.eta && s.eta.taskId === task.id ? s.eta.source : "schedule",
  };
}

// ---------------- Operator actions (non-safety) ----------------
export function startTask(taskId: number) {
  const s = sim();
  const d = db();
  d.prepare("UPDATE tasks SET status='scheduled' WHERE operator_id=? AND status='in_progress'").run(s.operatorId);
  d.prepare("UPDATE tasks SET status='in_progress', started_at=COALESCE(started_at, ?) WHERE id=?").run(new Date().toISOString(), taskId);
  s.engineOn = true;
  s.working = true;
  s.eta = null;
  pushEvent(s, "task", `Task started #${taskId}`);
}

export function completeTask(taskId: number) {
  const s = sim();
  const d = db();
  const t = d.prepare("SELECT * FROM tasks WHERE id=?").get(taskId) as Task;
  if (!t || t.status === "completed") return;
  // Map compressed demo time back to real-world minutes relative to plan
  const elapsed = t.started_at ? (Date.now() - Date.parse(t.started_at)) / 1000 : 0;
  const nominal = t.target_cycles * 4;
  const actual = Math.round(t.estimated_minutes * (elapsed / Math.max(nominal, 1)) * 10) / 10;
  d.prepare("UPDATE tasks SET status='completed', completed_at=?, actual_minutes=? WHERE id=?").run(
    new Date().toISOString(), Math.max(actual, 1), taskId,
  );
  pushEvent(s, "task", `Task completed: ${t.name} (${Math.max(actual, 1)} min vs ${t.estimated_minutes} planned)`);
  recomputeScore(s);
}

export type Controls = Partial<
  Pick<SimState, "engineOn" | "seatbelt" | "working" | "simPersonDistance" | "simDrowsy" | "weather" | "temperatureC">
>;
export function applyControls(c: Controls) {
  const s = sim();
  Object.assign(s, c);
  if (c.weather) pushEvent(s, "conditions", `Weather changed → ${c.weather}`);
  return s;
}

export function modeOf(s: SimState): Mode {
  return s.score?.mode ?? "Assist";
}
