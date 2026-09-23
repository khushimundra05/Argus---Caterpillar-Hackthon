"use client";
import { useEffect, useRef } from "react";
import Link from "next/link";
import {
  Activity, AlertTriangle, BookOpen, CheckCircle2, CircleDot, Clock, CloudRain, Flag, Fuel, Gauge, History,
  Pause, Play, Power, ShieldCheck, Sliders, Timer,
} from "lucide-react";
import { Badge, Button, Card, CardTitle, Stat, cn } from "./ui";
import { TopBar } from "./TopBar";
import { CameraPanel } from "./CameraPanel";
import { AssistantPanel } from "./AssistantPanel";
import { useArgus } from "./useArgus";
import { alertPhrase, voice, type Mode } from "./voice";

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const fmtDur = (s: number) => (s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);

export default function Dashboard() {
  const { state: S, operatorId, switchOperator, health, voiceOn, toggleVoice, post } = useArgus(1000);
  useAlertVoice(S);

  if (!S) return <div className="grid min-h-screen place-items-center text-zinc-500">Connecting to Argus…</div>;

  const mode: Mode = S.score.mode;
  const ms = S.machineState;
  const alerts = [...S.alerts].sort((a: { severity: string }, b: { severity: string }) => rank(b.severity) - rank(a.severity));
  const current = S.tasks.find((t: { status: string }) => t.status === "in_progress");

  return (
    <div className="min-h-screen">
      <TopBar
        operators={S.operators}
        operatorId={operatorId ?? S.operator.id}
        onOperator={(id) => switchOperator(id)}
        machineLabel={`${S.machine.model} · ${S.machine.id}`}
        mode={mode}
        score={S.score.score}
        voiceOn={voiceOn}
        onVoice={toggleVoice}
        health={health}
      />

      {/* ALERT BANNER */}
      <div className="mx-auto max-w-[1600px] px-4 pt-3">
        {alerts.length ? (
          <div className="space-y-2">
            {alerts.map((a: { type: string; severity: string; message: string; source: string; since: number }) => (
              <div
                key={a.type}
                className={cn(
                  "flex items-center gap-3 rounded-xl border px-4 py-3",
                  a.severity === "critical" && "animate-flash border-red-500 bg-red-600/25 text-red-100",
                  a.severity === "warning" && "border-amber-500 bg-amber-500/15 text-amber-100",
                  a.severity === "info" && "border-sky-600 bg-sky-600/10 text-sky-100",
                )}
              >
                {a.type === "IDLE" ? <Fuel className="h-6 w-6 shrink-0" /> : <AlertTriangle className="h-6 w-6 shrink-0" />}
                <div className="flex-1">
                  <div className="text-base font-bold">
                    {a.type === "IDLE" ? "IDLE COST" : a.type} · {a.severity.toUpperCase()}
                  </div>
                  <div className="text-sm opacity-90">{a.message}</div>
                </div>
                <div className="text-right text-[11px] opacity-70">
                  <div>source: {a.source}</div>
                  <div>active {fmtDur((S.now - a.since) / 1000)}</div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-3 rounded-xl border border-emerald-800/60 bg-emerald-950/30 px-4 py-2.5 text-emerald-200">
            <ShieldCheck className="h-5 w-5" />
            <span className="text-sm font-medium">All clear — no active safety alerts</span>
            <span className="ml-auto text-xs text-emerald-400/80">
              Safe streak: <b className="tabular-nums">{fmtDur(S.safeStreakSec)}</b> since last incident
            </span>
          </div>
        )}
      </div>

      <main className="mx-auto grid max-w-[1600px] gap-4 p-4 lg:grid-cols-12">
        {/* LEFT: plan */}
        <section className="space-y-4 lg:col-span-4">
          <Card>
            <CardTitle icon={<Clock className="h-4 w-4" />} right={<span className="text-xs text-zinc-500">{S.operator.name}</span>}>
              Today&apos;s tasks
            </CardTitle>
            <div className="space-y-2">
              {S.tasks.map((t: Task) => (
                <TaskRow key={t.id} t={t} post={post} anyActive={!!current} />
              ))}
            </div>
          </Card>

          <ScoreCard score={S.score} />

          <Card>
            <CardTitle icon={<BookOpen className="h-4 w-4" />} right={<Link href="/training" className="text-xs text-cat-yellow hover:underline">Open hub →</Link>}>
              Recommended training
            </CardTitle>
            <div className="space-y-2">
              {S.training.filter((m: { priority: number }) => m.priority > 0).slice(0, 2).map((m: TrainingRec) => (
                <Link key={m.id} href={`/training?m=${m.id}`} className="block rounded-lg border border-zinc-800 p-2.5 hover:border-cat-yellow/60">
                  <div className="text-sm font-medium text-zinc-100">{m.title}</div>
                  <div className="text-xs text-zinc-500">{m.reason} · {m.duration_min} min</div>
                </Link>
              ))}
              {!S.training.some((m: { priority: number }) => m.priority > 0) && <div className="text-xs text-zinc-500">Nothing urgent — great record.</div>}
            </div>
          </Card>
        </section>

        {/* MIDDLE: protect */}
        <section className="space-y-4 lg:col-span-5">
          <Card>
            <CardTitle icon={<Gauge className="h-4 w-4" />} right={<Badge tone={ms.engineOn ? "green" : "default"}>{ms.engineOn ? "ENGINE ON" : "ENGINE OFF"}</Badge>}>
              Live machine status
            </CardTitle>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Stat label="Seatbelt" value={ms.seatbelt ? "Fastened" : "OPEN"} tone={ms.seatbelt ? "green" : "red"} />
              <Stat
                label="Nearest person"
                value={nearest(S) != null ? `${nearest(S)} m` : "—"}
                tone={nearest(S) == null ? undefined : nearest(S)! < 3 ? "red" : nearest(S)! < 6 ? "amber" : undefined}
                sub={S.cv.zone ? "zone camera + sensor" : "sensor"}
              />
              <Stat
                label="Driver alertness"
                value={S.cv.driver ? (S.cv.driver.drowsy ? "DROWSY" : S.cv.driver.faceFound ? "Alert" : "No face") : S.conditions.simDrowsy ? "DROWSY" : "cam off"}
                tone={S.alerts.some((a: { type: string }) => a.type === "DROWSINESS") ? "red" : S.cv.driver?.faceFound ? "green" : undefined}
                sub={S.cv.driver?.ear != null ? `EAR ${S.cv.driver.ear.toFixed(2)}` : undefined}
              />
              <Stat label="Fuel used" value={`${ms.fuelUsed.toFixed(2)} L`} sub={`engine ${fmtDur(ms.engineSec)}`} />
              <Stat label="Load cycles" value={ms.loadCycles} sub={current ? `${current.cycles_done}/${current.target_cycles} this task` : "no active task"} />
              <Stat
                label="Idle now"
                value={fmtDur(ms.idleContinuousSec)}
                tone={ms.idleContinuousSec >= 60 ? "amber" : undefined}
                sub={ms.idleContinuousSec > 0 ? `${ms.idleLitres.toFixed(2)} L · $${ms.idleCostPerHour.toFixed(2)}/h` : `total ${fmtDur(ms.idleTotalSec)}`}
              />
            </div>
            <div className="mt-2 flex items-center gap-2 text-[11px] text-zinc-500">
              <Activity className="h-3.5 w-3.5" />
              Rolling idle ratio {Math.round(ms.idleRatio * 100)}% · z-score{" "}
              <span className={cn("font-semibold", ms.idleZ > 2 ? "text-amber-400" : "text-zinc-300")}>{ms.idleZ}</span> vs personal baseline
            </div>
          </Card>

          <CameraPanel />

          <SimulatorCard S={S} post={post} onNewShift={() => switchOperator(S.operator.id, true)} />
        </section>

        {/* RIGHT: improve */}
        <section className="space-y-4 lg:col-span-3">
          <AssistantPanel mode={mode} operatorId={S.operator.id} />

          <Card>
            <CardTitle icon={<Flag className="h-4 w-4" />}>Behavior flags</CardTitle>
            <div className="max-h-44 space-y-1.5 overflow-y-auto">
              {S.flags.length === 0 && <div className="text-xs text-zinc-500">No flags.</div>}
              {S.flags.map((f: { id: number; event_type: string; timestamp: string; detail: string }) => (
                <div key={f.id} className="flex items-start justify-between gap-2 text-xs">
                  <div>
                    <Badge tone={f.event_type === "IDLE_ANOMALY" ? "amber" : f.event_type === "REPEATED_SEATBELT" ? "red" : "default"}>{f.event_type}</Badge>
                    <span className="ml-1.5 text-zinc-500">{flagDetail(f.detail)}</span>
                  </div>
                  <span className="shrink-0 text-zinc-600">{relDay(f.timestamp)}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardTitle icon={<History className="h-4 w-4" />} right={<span className="text-[10px] text-zinc-500">auto-logged by rules engine</span>}>
              Incident log
            </CardTitle>
            <div className="max-h-44 space-y-1.5 overflow-y-auto">
              {S.incidents.length === 0 && <div className="text-xs text-zinc-500">No incidents.</div>}
              {S.incidents.map((i: { id: number; type: string; severity: string; timestamp: string; resolved: number; source: string }) => (
                <div key={i.id} className="flex items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-1.5">
                    <Badge tone={i.resolved ? "default" : "red"}>{i.type}</Badge>
                    <span className="text-zinc-500">{i.source === "history" ? "historical" : i.source}</span>
                  </div>
                  <span className="shrink-0 text-zinc-600">
                    {relDay(i.timestamp)} {i.resolved ? "✓" : "open"}
                  </span>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardTitle icon={<CircleDot className="h-4 w-4" />}>Intelligence loop</CardTitle>
            <div className="max-h-56 space-y-1 overflow-y-auto">
              {S.events.map((e: { ts: number; kind: string; text: string }, k: number) => (
                <div key={k} className="flex gap-2 text-xs">
                  <span className="shrink-0 tabular-nums text-zinc-600">{new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                  <span className={cn("text-zinc-300", e.kind === "incident" && "text-red-300", e.kind === "anomaly" && "text-amber-300", e.kind === "mode" && "text-cat-yellow", e.kind === "eta" && "text-sky-300")}>
                    {e.text}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </section>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
type Task = {
  id: number; name: string; status: string; scheduled_start: string; estimated_minutes: number; actual_minutes: number | null;
  cycles_done: number; target_cycles: number;
  eta: { total_minutes: number; remaining_minutes: number; progress: number; source: string } | null;
};
type TrainingRec = { id: string; title: string; reason: string | null; duration_min: number; priority: number };

function TaskRow({ t, post, anyActive }: { t: Task; post: (u: string, b: unknown) => Promise<void>; anyActive: boolean }) {
  const pct = Math.round((t.cycles_done / t.target_cycles) * 100);
  const active = t.status === "in_progress";
  const done = t.status === "completed";
  return (
    <div className={cn("rounded-lg border p-2.5", active ? "border-cat-yellow/70 bg-cat-yellow/5" : "border-zinc-800", done && "opacity-60")}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5 text-sm font-medium text-zinc-100">
            {done && <CheckCircle2 className="h-4 w-4 text-emerald-400" />}
            {t.name}
          </div>
          <div className="text-xs text-zinc-500">
            {fmtTime(t.scheduled_start)} · plan {t.estimated_minutes} min
            {done && t.actual_minutes != null && ` · actual ${t.actual_minutes} min`}
          </div>
        </div>
        {!done &&
          (active ? (
            <div className="flex gap-1">
              <Button size="sm" onClick={() => post("/api/tasks", { action: "pause", taskId: t.id })} title="Pause">
                <Pause className="h-3.5 w-3.5" />
              </Button>
              <Button size="sm" tone="primary" onClick={() => post("/api/tasks", { action: "complete", taskId: t.id })}>
                Done
              </Button>
            </div>
          ) : (
            <Button size="sm" disabled={anyActive} onClick={() => post("/api/tasks", { action: "start", taskId: t.id })}>
              <Play className="h-3.5 w-3.5" /> Start
            </Button>
          ))}
      </div>
      {(active || pct > 0) && !done && (
        <div className="mt-2">
          <div className="h-1.5 overflow-hidden rounded bg-zinc-800">
            <div className="h-full bg-cat-yellow transition-all" style={{ width: `${pct}%` }} />
          </div>
          {t.eta && (
            <div className="mt-1.5 flex items-center justify-between text-xs">
              <span className="flex items-center gap-1 text-zinc-300">
                <Timer className="h-3.5 w-3.5 text-cat-yellow" />
                <b className="tabular-nums text-cat-yellow">{t.eta.remaining_minutes} min</b> remaining
              </span>
              <span className="text-zinc-500">
                total {t.eta.total_minutes}m · {t.eta.source === "random_forest" ? "RandomForest (live)" : t.eta.source}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ScoreCard({ score }: { score: { score: number; mode: string; terms: { label: string; delta: number }[] } }) {
  const bands = [
    ["Instructor", 0, 40, "bg-red-500"],
    ["Coaching", 40, 66, "bg-amber-500"],
    ["Assist", 66, 86, "bg-sky-500"],
    ["Silent Guardian", 86, 101, "bg-emerald-500"],
  ] as const;
  return (
    <Card>
      <CardTitle icon={<Gauge className="h-4 w-4" />} right={<span className="text-xs text-zinc-500">rule-based, recomputed on every event</span>}>
        Adaptive assistance
      </CardTitle>
      <div className="flex items-end gap-3">
        <div className="text-4xl font-bold tabular-nums text-zinc-100">{score.score}</div>
        <div className="pb-1 text-sm font-semibold text-cat-yellow">{score.mode}</div>
      </div>
      <div className="relative mt-2 flex h-2 overflow-hidden rounded">
        {bands.map(([n, a, b, c]) => (
          <div key={n} className={cn(c, score.mode === n ? "opacity-100" : "opacity-25")} style={{ width: `${b - a}%` }} />
        ))}
        <div className="absolute top-[-3px] h-3.5 w-1 rounded bg-white" style={{ left: `calc(${score.score}% - 2px)` }} />
      </div>
      <div className="mt-3 space-y-1 text-xs">
        <div className="flex justify-between text-zinc-500">
          <span>base</span>
          <span>100</span>
        </div>
        {score.terms.map((t) => (
          <div key={t.label} className="flex justify-between">
            <span className="text-zinc-400">{t.label}</span>
            <span className={cn("tabular-nums", t.delta < 0 ? "text-red-300" : t.delta > 0 ? "text-emerald-300" : "text-zinc-500")}>
              {t.delta > 0 ? "+" : ""}
              {t.delta}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function SimulatorCard({ S, post, onNewShift }: { S: ArgusS; post: (u: string, b: unknown) => Promise<void>; onNewShift: () => void }) {
  const ms = S.machineState;
  const c = S.conditions;
  const ctl = (b: Record<string, unknown>) => post("/api/control", b);
  return (
    <Card>
      <CardTitle icon={<Sliders className="h-4 w-4" />} right={<span className="text-[10px] text-zinc-500">stand-ins for CAN bus / seat switch / radar</span>}>
        Sensor simulator
      </CardTitle>
      <div className="flex flex-wrap gap-2">
        <Button tone={ms.engineOn ? "active" : "default"} onClick={() => ctl({ engineOn: !ms.engineOn })}>
          <Power className="h-4 w-4" /> Engine {ms.engineOn ? "on" : "off"}
        </Button>
        <Button tone={ms.seatbelt ? "default" : "danger"} onClick={() => ctl({ seatbelt: !ms.seatbelt })}>
          Seatbelt: {ms.seatbelt ? "fastened" : "UNFASTENED"}
        </Button>
        <Button tone={ms.working ? "default" : "active"} onClick={() => ctl({ working: !ms.working })}>
          {ms.working ? "Operator working" : "Operator waiting (idle)"}
        </Button>
        <Button tone={c.simDrowsy ? "danger" : "default"} onClick={() => ctl({ simDrowsy: !c.simDrowsy })}>
          Sim drowsy {c.simDrowsy ? "ON" : "off"}
        </Button>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-zinc-400">
          Proximity sensor: {c.simPersonDistance == null ? "clear" : `${c.simPersonDistance} m`}
          <div className="mt-1 flex gap-1">
            {[null, 8, 5, 2].map((d) => (
              <Button key={String(d)} size="sm" tone={c.simPersonDistance === d ? "active" : "default"} onClick={() => ctl({ simPersonDistance: d })}>
                {d == null ? "clear" : `${d} m`}
              </Button>
            ))}
          </div>
        </label>
        <label className="text-xs text-zinc-400">
          <span className="flex items-center gap-1">
            <CloudRain className="h-3.5 w-3.5" /> Conditions (re-predicts ETA)
          </span>
          <div className="mt-1 flex gap-1">
            <select
              value={c.weather}
              onChange={(e) => ctl({ weather: e.target.value })}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
            >
              {["clear", "rain", "heavy_rain", "dust", "snow"].map((w) => (
                <option key={w}>{w}</option>
              ))}
            </select>
            <select
              value={c.temperatureC}
              onChange={(e) => ctl({ temperatureC: Number(e.target.value) })}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
            >
              {[-5, 10, 24, 38].map((t) => (
                <option key={t} value={t}>
                  {t}°C
                </option>
              ))}
            </select>
          </div>
        </label>
      </div>
      <div className="mt-3 flex justify-end">
        <Button size="sm" tone="ghost" onClick={onNewShift}>
          Start new shift (resets shift counters)
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ArgusS = any;
const rank = (s: string) => (s === "critical" ? 3 : s === "warning" ? 2 : 1);
function nearest(S: ArgusS): number | null {
  const v = [S.cv.zone?.minDistance, S.conditions.simPersonDistance].filter((x) => x != null) as number[];
  return v.length ? Math.min(...v) : null;
}
function flagDetail(d: string) {
  try {
    const j = JSON.parse(d);
    if (j.z != null) return `z=${j.z}, idle ${Math.round(j.idle_ratio * 100)}%`;
    if (j.seconds != null) return `${j.seconds}s continuous`;
    if (j.count != null) return `${j.count}× this shift`;
  } catch {
    /* ignore */
  }
  return "";
}
function relDay(iso: string) {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 864e5);
  return days <= 0 && d.toDateString() === new Date().toDateString() ? fmtTime(iso) : `${Math.max(days, 1)}d ago`;
}

/** Speak alerts on rising edge / escalation; repeat critical alerts; announce mode changes. */
function useAlertVoice(S: ArgusS | null) {
  const spoken = useRef<Record<string, { sev: string; at: number; step?: number }>>({});
  const lastMode = useRef<string | null>(null);
  useEffect(() => {
    if (!S) return;
    const mode: Mode = S.score.mode;
    const now = Date.now();
    const active = new Set<string>();
    for (const a of S.alerts as { type: string; severity: string; message: string; value?: number }[]) {
      active.add(a.type);
      const prev = spoken.current[a.type];
      const escalated = !prev || rank(a.severity) > rank(prev.sev);
      const repeatCritical = prev && a.severity === "critical" && now - prev.at > 12000;
      // Idle: speak on first nudge and once when escalated to warning
      if (escalated || repeatCritical) {
        const phrase = alertPhrase(a, mode, S.machineState.idleCostPerHour);
        if (phrase) voice.speak(phrase, a.severity === "info" ? "normal" : "alert");
        spoken.current[a.type] = { sev: a.severity, at: now };
      }
    }
    for (const k of Object.keys(spoken.current)) if (!active.has(k)) delete spoken.current[k];
    if (lastMode.current && lastMode.current !== mode) voice.speak(`Assistance mode changed to ${mode}.`, "normal");
    lastMode.current = mode;
  }, [S]);
}
