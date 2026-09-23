"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Volume2, VolumeX } from "lucide-react";
import { Badge, Button, cn } from "./ui";

export const MODE_TONE: Record<string, string> = {
  Instructor: "bg-red-500/20 text-red-200 border-red-500/60",
  Coaching: "bg-amber-500/20 text-amber-200 border-amber-500/60",
  Assist: "bg-sky-500/20 text-sky-200 border-sky-500/60",
  "Silent Guardian": "bg-emerald-500/20 text-emerald-200 border-emerald-500/60",
};

export function TopBar({
  operators, operatorId, onOperator, machineLabel, mode, score, voiceOn, onVoice, health,
}: {
  operators: { id: string; name: string }[]; operatorId: string; onOperator: (id: string) => void;
  machineLabel: string; mode: string; score: number; voiceOn: boolean; onVoice: () => void;
  health?: { cv: unknown; llm: string } | null;
}) {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-3 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-md bg-cat-yellow text-lg font-black text-black">A</div>
          <div className="leading-tight">
            <div className="text-sm font-bold tracking-widest text-zinc-100">ARGUS</div>
            <div className="text-[10px] text-zinc-500">Smart Operator Assistant</div>
          </div>
        </div>
        <nav className="ml-2 flex gap-1">
          {[
            ["/", "Dashboard"],
            ["/training", "Training Hub"],
          ].map(([href, label]) => (
            <Link
              key={href}
              href={href}
              className={cn("rounded-md px-3 py-1.5 text-sm", path === href ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-white")}
            >
              {label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select
            value={operatorId}
            onChange={(e) => onOperator(e.target.value)}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
          >
            {operators.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name} ({o.id})
              </option>
            ))}
          </select>
          <Badge>{machineLabel}</Badge>
          <span className={cn("rounded-md border px-2.5 py-1 text-sm font-semibold", MODE_TONE[mode])} title="Adaptive assistance mode">
            {mode} · {score}
          </span>
          {health && (
            <span className="flex items-center gap-2 text-[11px] text-zinc-500">
              <span className="flex items-center gap-1">
                <span className={cn("h-2 w-2 rounded-full", health.cv ? "bg-emerald-500" : "bg-red-500")} /> CV/ML
              </span>
              <span className="flex items-center gap-1" title={health.llm}>
                <span className={cn("h-2 w-2 rounded-full", health.llm.startsWith("offline") ? "bg-amber-500" : "bg-emerald-500")} /> LLM
              </span>
            </span>
          )}
          <Button size="sm" tone={voiceOn ? "primary" : "default"} onClick={onVoice} title="Spoken alerts & replies">
            {voiceOn ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </header>
  );
}
