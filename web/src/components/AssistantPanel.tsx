"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { BookOpen, Bot, ClipboardList, Send, Wrench } from "lucide-react";
import { Badge, Button, Card, CardTitle } from "./ui";
import { voice, type Mode } from "./voice";

type Msg = {
  role: "user" | "assistant"; content: string; tools?: { name: string; input: unknown; output: unknown }[];
  offline?: boolean; mode?: string; model?: string; note?: string;
  kind?: "briefing"; label?: string; training?: { id: string; title: string } | null;
};

const SUGGESTIONS = [
  "What's my schedule today?",
  "Am I safe to continue?",
  "How long until this task is done?",
  "Why is my idle flagged?",
  "What training should I do?",
  "What do I do if someone enters the swing radius?",
];

export function AssistantPanel({ mode, operatorId }: { mode: Mode; operatorId: string }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [openTools, setOpenTools] = useState<number | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMsgs([]);
  }, [operatorId]);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [msgs, busy]);
  // Task briefings (spoken by the dashboard) also appear here as an Argus message
  useEffect(() => {
    const onBriefing = (e: Event) => {
      const b = (e as CustomEvent).detail as {
        spoken: string; mode: string; training: { id: string; title: string } | null; label?: string; source?: string; model?: string;
      };
      setMsgs((m) => [
        ...m,
        { role: "assistant", content: b.spoken, kind: "briefing", label: b.label, mode: b.mode, training: b.training, model: b.source === "gemini" ? b.model : undefined },
      ]);
    };
    window.addEventListener("argus:briefing", onBriefing);
    return () => window.removeEventListener("argus:briefing", onBriefing);
  }, []);

  async function send(text: string) {
    if (!text.trim() || busy) return;
    const next: Msg[] = [...msgs, { role: "user", content: text.trim() }];
    setMsgs(next);
    setInput("");
    setBusy(true);
    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        body: JSON.stringify({ history: next.filter((m) => m.kind !== "briefing").map(({ role, content }) => ({ role, content })) }),
      });
      const j = await r.json();
      setMsgs([...next, { role: "assistant", content: j.text, tools: j.tools, offline: j.offline, mode: j.mode, model: j.model, note: j.note }]);
      voice.speak(j.text, "normal");
    } catch {
      setMsgs([...next, { role: "assistant", content: "Assistant unavailable." }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex min-h-[420px] flex-col">
      <CardTitle icon={<Bot className="h-4 w-4" />} right={<Badge tone="yellow">{mode}</Badge>}>
        Argus Assistant
      </CardTitle>
      <div className="flex-1 space-y-3 overflow-y-auto pr-1" style={{ maxHeight: 420 }}>
        {msgs.length === 0 && (
          <div className="space-y-2">
            <p className="text-xs text-zinc-500">
              Ask anything. Answers are grounded in live machine state via read-only tools and spoken aloud. Tone adapts to your assistance mode.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)} className="rounded-full border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
            <div
              className={
                m.role === "user"
                  ? "max-w-[85%] rounded-lg bg-cat-yellow px-3 py-2 text-sm text-black"
                  : "max-w-[95%] rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-100"
              }
            >
              {m.kind === "briefing" && (
                <div className="mb-1">
                  <Badge tone="yellow">
                    <ClipboardList className="h-3 w-3" /> {m.label ?? "Task briefing"} · {m.mode}
                  </Badge>
                </div>
              )}
              {m.content}
              {m.training && (
                <Link href={`/training?m=${m.training.id}`} className="mt-1.5 flex items-center gap-1 text-xs text-cat-yellow hover:underline">
                  <BookOpen className="h-3 w-3" /> Optional: open {m.training.title}
                </Link>
              )}
              {m.role === "assistant" && (m.tools?.length || m.offline || (m.kind === "briefing" && m.model)) ? (
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  {m.tools?.map((t, k) => (
                    <button key={k} onClick={() => setOpenTools(openTools === i ? null : i)}>
                      <Badge tone="blue">
                        <Wrench className="h-3 w-3" /> {t.name}
                      </Badge>
                    </button>
                  ))}
                  {m.offline && <Badge tone="amber">{m.note ?? "offline mode"}</Badge>}
                  {m.model && <Badge>{m.model}</Badge>}
                </div>
              ) : null}
              {openTools === i && (
                <pre className="mt-2 max-h-48 overflow-auto rounded bg-black/60 p-2 text-[10px] text-zinc-400">
                  {JSON.stringify(m.tools, null, 1)}
                </pre>
              )}
            </div>
          </div>
        ))}
        {busy && <div className="text-xs text-zinc-500">Argus is checking live data…</div>}
        <div ref={end} />
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask Argus…"
          className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-cat-yellow"
        />
        <Button type="submit" tone="primary" disabled={busy || !input.trim()}>
          <Send className="h-4 w-4" />
        </Button>
      </form>
    </Card>
  );
}
