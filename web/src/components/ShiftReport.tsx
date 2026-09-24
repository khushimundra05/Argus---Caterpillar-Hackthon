"use client";
// End-of-shift report panel: key numbers + supervisor summary, spoken operator summary, downloadable PDF.
import { useEffect, useState } from "react";
import { Download, FileText, Loader2, RefreshCw, Volume2, X } from "lucide-react";
import { Badge, Button, Card, Stat, cn } from "./ui";
import { voice } from "./voice";

// Shape of GET /api/report (web/src/lib/report.ts ShiftReport); loose on purpose
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Report = any;

const hm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function ShiftReport({ onClose }: { onClose: () => void }) {
  const [r, setR] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/report", { cache: "no-store" });
      if (!res.ok) throw new Error(`report failed (${res.status})`);
      const j = await res.json();
      setR(j);
      voice.speak(j.narrative.operator_spoken, "full"); // spoken summary for the operator
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const k = r?.kpis;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <Card className="max-h-[92vh] w-full max-w-3xl overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-bold text-zinc-100">
              <FileText className="h-5 w-5 text-cat-yellow" /> End-of-shift report
            </h2>
            {r && (
              <p className="text-xs text-zinc-500">
                {r.operator.name} · {r.machine.model} · {hm(r.shift.start)}–{hm(r.shift.end)} ({r.shift.duration_min} min)
              </p>
            )}
          </div>
          <Button size="sm" tone="ghost" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>

        {loading && (
          <div className="flex items-center gap-2 py-10 text-sm text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Building the shift report…
          </div>
        )}
        {error && <div className="py-6 text-sm text-red-300">{error}</div>}

        {r && !loading && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Tasks completed" value={`${k.tasks_completed} / ${k.tasks_total}`} sub={`${k.load_cycles} load cycles`} />
              <Stat label="Engine time" value={`${k.engine_min} min`} sub={`${k.working_min} min working`} />
              <Stat label="Idle" value={`${k.idle_pct}%`} tone={k.idle_pct > 30 ? "amber" : undefined} sub={`${k.idle_fuel_l} L · $${k.idle_cost_usd}`} />
              <Stat
                label="Safety incidents"
                value={k.incidents}
                tone={k.incidents ? "red" : "green"}
                sub={k.median_seconds_to_correct != null ? `median ${k.median_seconds_to_correct} s to correct` : "none"}
              />
              <Stat label="Fuel used" value={`${k.fuel_l} L`} />
              <Stat label="Safe streaks" value={k.safe_streaks} tone={k.safe_streaks ? "green" : undefined} />
              <Stat label="Idle nudges acted on" value={k.nudges_acted_on} />
              <Stat
                label="Proficiency"
                value={`${r.proficiency.end.score}`}
                sub={`${r.proficiency.end.mode}${r.proficiency.start ? ` (from ${r.proficiency.start.score})` : ""}`}
              />
            </div>

            <div>
              <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-zinc-200">
                Summary for the supervisor
                <Badge>{r.narrative.source === "gemini" ? r.narrative.model : "template"}</Badge>
              </div>
              <p className="text-sm leading-relaxed text-zinc-300">{r.narrative.supervisor}</p>
            </div>

            {r.incidents.length > 0 && (
              <div>
                <div className="mb-1 text-sm font-semibold text-zinc-200">Incidents</div>
                <div className="space-y-1 text-xs">
                  {r.incidents.map((i: { time: string; type: string; seconds_to_correct: number | null }, n: number) => (
                    <div key={n} className="flex gap-3 text-zinc-400">
                      <span className="tabular-nums text-zinc-500">{hm(i.time)}</span>
                      <span className={cn("font-medium", i.type === "DROWSINESS" ? "text-violet-300" : "text-red-300")}>{i.type}</span>
                      <span>{i.seconds_to_correct != null ? `corrected in ${i.seconds_to_correct} s` : "still open"}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {r.training_recommended.length > 0 && (
              <div className="text-xs text-zinc-400">
                <span className="font-semibold text-zinc-200">Recommended training: </span>
                {r.training_recommended.map((t: { title: string }) => t.title).join(", ")}
              </div>
            )}

            <div className="flex flex-wrap gap-2 border-t border-zinc-800 pt-3">
              <a href="/api/report/pdf" download>
                <Button tone="primary">
                  <Download className="h-4 w-4" /> Download PDF (with charts)
                </Button>
              </a>
              <Button onClick={() => voice.speak(r.narrative.operator_spoken, "full")}>
                <Volume2 className="h-4 w-4" /> Speak summary
              </Button>
              <Button tone="ghost" onClick={load}>
                <RefreshCw className="h-4 w-4" /> Refresh
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
