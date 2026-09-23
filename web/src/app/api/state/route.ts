import { NextResponse } from "next/server";
import { db, getMachine, getOperator, listOperators, type Incident, type Task } from "@/lib/db";
import { liveEta, sim, tick } from "@/lib/engine";
import { recommendTraining } from "@/lib/training";
import { SAFETY } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const opId = new URL(req.url).searchParams.get("op") ?? undefined;
  sim(opId);
  const s = tick();
  const d = db();
  const op = getOperator(s.operatorId)!;
  const m = getMachine(s.machineId)!;
  const tasks = (d
    .prepare("SELECT * FROM tasks WHERE operator_id=? AND kind='shift' ORDER BY scheduled_start")
    .all(s.operatorId) as Task[]).map((t) => ({ ...t, eta: t.status === "in_progress" ? liveEta(s, t) : null }));
  const incidents = d
    .prepare("SELECT * FROM incidents WHERE operator_id=? ORDER BY id DESC LIMIT 12")
    .all(s.operatorId) as Incident[];
  const flags = d
    .prepare("SELECT * FROM behavior_logs WHERE operator_id=? ORDER BY id DESC LIMIT 10")
    .all(s.operatorId);
  const now = Date.now();
  const fresh = (ts?: number) => !!ts && now - ts < SAFETY.cvStaleMs;

  return NextResponse.json({
    now,
    operators: listOperators().map((o) => ({ id: o.id, name: o.name })),
    operator: op,
    machine: m,
    score: s.score,
    alerts: Object.values(s.alerts),
    machineState: {
      engineOn: s.engineOn, seatbelt: s.seatbelt, working: s.working,
      fuelUsed: s.fuelUsed, loadCycles: s.loadCycles, idleContinuousSec: s.idleContinuousSec,
      idleTotalSec: s.idleTotalSec, engineSec: s.engineSec,
      idleCostPerHour: m.idle_burn_lph * SAFETY.fuelPricePerL,
      idleLitres: (m.idle_burn_lph * s.idleContinuousSec) / 3600,
      idleRatio: s.lastIdleRatio, idleZ: s.lastZ,
    },
    conditions: { weather: s.weather, temperatureC: s.temperatureC, simPersonDistance: s.simPersonDistance, simDrowsy: s.simDrowsy },
    cv: {
      driver: s.cv.driver && fresh(s.cv.driver.ts) ? s.cv.driver : null,
      zone: s.cv.zone && fresh(s.cv.zone.ts) ? s.cv.zone : null,
    },
    tasks,
    incidents,
    flags,
    events: s.events,
    safeStreakSec: Math.round((now - s.lastIncidentAt) / 1000),
    training: recommendTraining(s.operatorId).slice(0, 3),
  });
}
