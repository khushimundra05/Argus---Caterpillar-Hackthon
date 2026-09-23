"use client";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { BookOpen, CheckCircle2, Clock, Film, Sparkles, Upload } from "lucide-react";
import { Badge, Button, Card, CardTitle, cn } from "./ui";
import { TopBar } from "./TopBar";
import { useArgus } from "./useArgus";
import { voice } from "./voice";

type Module = {
  id: string; title: string; trigger_tag: string; duration_min: number; level: string; summary: string; video?: string;
  sections: { heading: string; body: string }[]; quiz: { q: string; options: string[]; answer: number }[];
};
type Rec = { id: string; completed: boolean; priority: number; reason: string | null };

export default function TrainingHub() {
  const { state: S, operatorId, switchOperator, health, voiceOn, toggleVoice } = useArgus(3000);
  const params = useSearchParams();
  const [modules, setModules] = useState<Module[]>([]);
  const [recs, setRecs] = useState<Rec[]>([]);
  const [sel, setSel] = useState<string | null>(params.get("m"));

  const load = async () => {
    const j = await (await fetch("/api/training", { cache: "no-store" })).json();
    setModules(j.modules);
    setRecs(j.recommendations);
    setSel((s) => s ?? j.recommendations[0]?.id ?? j.modules[0]?.id);
  };
  useEffect(() => {
    load();
  }, [operatorId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!S) return <div className="grid min-h-screen place-items-center text-zinc-500">Connecting to Argus…</div>;
  const recOf = (id: string) => recs.find((r) => r.id === id);
  const ordered = [...modules].sort((a, b) => {
    if (a.video && !b.video) return -1;
    if (b.video && !a.video) return 1;
    return (recOf(b.id)?.priority ?? 0) - (recOf(a.id)?.priority ?? 0);
  });
  const m = modules.find((x) => x.id === sel);
  const doneCount = recs.filter((r) => r.completed).length;

  return (
    <div className="min-h-screen">
      <TopBar
        operators={S.operators}
        operatorId={operatorId ?? S.operator.id}
        onOperator={(id) => switchOperator(id)}
        machineLabel={`${S.machine.model} · ${S.machine.id}`}
        mode={S.score.mode}
        score={S.score.score}
        voiceOn={voiceOn}
        onVoice={toggleVoice}
        health={health}
      />
      <main className="mx-auto grid max-w-[1400px] gap-4 p-4 lg:grid-cols-12">
        <section className="space-y-3 lg:col-span-4">
          <Card>
            <CardTitle icon={<BookOpen className="h-4 w-4" />} right={<Badge tone="green">{doneCount}/{modules.length} complete</Badge>}>
              Training modules
            </CardTitle>
            <p className="mb-3 text-xs text-zinc-500">
              Ranked for <b className="text-zinc-300">{S.operator.name}</b> from recent incidents, behavior flags and cycle-time deviation.
            </p>
            <div className="space-y-2">
              {ordered.map((x) => {
                const r = recOf(x.id);
                return (
                  <button
                    key={x.id}
                    onClick={() => setSel(x.id)}
                    className={cn(
                      "block w-full rounded-lg border p-3 text-left transition-colors",
                      sel === x.id ? "border-cat-yellow bg-cat-yellow/5" : "border-zinc-800 hover:border-zinc-600",
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-1.5 text-sm font-medium text-zinc-100">
                        {x.video ? <Film className="h-4 w-4 text-cat-yellow" /> : null}
                        {x.title}
                      </div>
                      {r?.completed ? (
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                      ) : r && r.priority > 0 ? (
                        <Badge tone="yellow">
                          <Sparkles className="h-3 w-3" /> For you
                        </Badge>
                      ) : null}
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-zinc-500">
                      <Clock className="h-3 w-3" /> {x.duration_min} min · {x.level}
                    </div>
                    {r?.reason && !r.completed && <div className="mt-1 text-xs text-amber-300/90">Why: {r.reason}</div>}
                  </button>
                );
              })}
            </div>
          </Card>
        </section>

        <section className="lg:col-span-8">{m ? <ModuleView key={m.id} m={m} rec={recOf(m.id)} onDone={load} /> : null}</section>
      </main>
    </div>
  );
}

function ModuleView({ m, rec, onDone }: { m: Module; rec?: Rec; onDone: () => void }) {
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [submitted, setSubmitted] = useState(false);
  const correct = m.quiz.filter((q, i) => answers[i] === q.answer).length;
  const passed = submitted && correct === m.quiz.length;

  const complete = async () => {
    await fetch("/api/training", { method: "POST", body: JSON.stringify({ moduleId: m.id }) });
    voice.speak(`Module complete. Well done.`, "normal");
    onDone();
  };

  return (
    <Card className="space-y-5">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={m.level === "Mandatory" ? "red" : "default"}>{m.level}</Badge>
          <Badge>{m.trigger_tag}</Badge>
          <Badge>
            <Clock className="h-3 w-3" /> {m.duration_min} min
          </Badge>
          {rec?.completed && <Badge tone="green">Completed</Badge>}
        </div>
        <h1 className="mt-2 text-2xl font-bold text-zinc-100">{m.title}</h1>
        <p className="mt-1 text-sm text-zinc-400">{m.summary}</p>
      </div>

      {m.video && <VideoSlot src={m.video} />}

      <div className="space-y-4">
        {m.sections.map((s) => (
          <div key={s.heading}>
            <h3 className="text-sm font-semibold text-cat-yellow">{s.heading}</h3>
            <p className="mt-1 text-sm leading-relaxed text-zinc-300">{s.body}</p>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-zinc-800 p-4">
        <h3 className="mb-3 text-sm font-semibold text-zinc-200">Knowledge check</h3>
        <div className="space-y-4">
          {m.quiz.map((q, i) => (
            <div key={i}>
              <div className="text-sm text-zinc-200">
                {i + 1}. {q.q}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {q.options.map((o, k) => {
                  const chosen = answers[i] === k;
                  const show = submitted && chosen;
                  return (
                    <button
                      key={k}
                      onClick={() => {
                        setSubmitted(false);
                        setAnswers({ ...answers, [i]: k });
                      }}
                      className={cn(
                        "rounded-lg border px-3 py-1.5 text-sm",
                        chosen ? "border-cat-yellow text-zinc-100" : "border-zinc-700 text-zinc-400 hover:bg-zinc-800",
                        show && (k === q.answer ? "border-emerald-500 bg-emerald-600/20" : "border-red-500 bg-red-600/20"),
                      )}
                    >
                      {o}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Button onClick={() => setSubmitted(true)} disabled={Object.keys(answers).length < m.quiz.length}>
            Check answers
          </Button>
          {submitted && (
            <span className={cn("text-sm", passed ? "text-emerald-300" : "text-amber-300")}>
              {correct}/{m.quiz.length} correct{passed ? "" : " — try again"}
            </span>
          )}
          <Button tone="primary" className="ml-auto" disabled={!passed || rec?.completed} onClick={complete}>
            <CheckCircle2 className="h-4 w-4" /> {rec?.completed ? "Completed" : "Mark complete"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

/**
 * Featured-video slot. Plays web/public/training/featured.mp4 if it exists; otherwise shows
 * drop-in instructions plus a local file picker so you can preview any video without restarting.
 */
function VideoSlot({ src }: { src: string }) {
  const [status, setStatus] = useState<"checking" | "ok" | "missing">("checking");
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch(src, { method: "HEAD", cache: "no-store" })
      .then((r) => setStatus(r.ok ? "ok" : "missing"))
      .catch(() => setStatus("missing"));
  }, [src]);
  useEffect(() => () => {
    if (localUrl) URL.revokeObjectURL(localUrl);
  }, [localUrl]);

  const url = localUrl ?? (status === "ok" ? src : null);
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-black">
      {url ? (
        <video src={url} controls className="aspect-video w-full bg-black" />
      ) : (
        <div className="grid aspect-video place-items-center p-6 text-center">
          <div className="space-y-3">
            <Film className="mx-auto h-10 w-10 text-cat-yellow" />
            <div className="text-sm font-medium text-zinc-200">{status === "checking" ? "Loading video…" : "Training video slot"}</div>
            {status === "missing" && (
              <>
                <div className="text-xs text-zinc-500">
                  Place your video at <code className="rounded bg-zinc-800 px-1 text-zinc-300">web/public/training/featured.mp4</code> and reload.
                  <br />
                  (Change the path in <code className="rounded bg-zinc-800 px-1 text-zinc-300">web/data/training-modules.json</code> → <code>video</code>.)
                </div>
                <Button size="sm" onClick={() => input.current?.click()}>
                  <Upload className="h-3.5 w-3.5" /> Preview a local video file
                </Button>
                <input
                  ref={input}
                  type="file"
                  accept="video/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) setLocalUrl(URL.createObjectURL(f));
                  }}
                />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
