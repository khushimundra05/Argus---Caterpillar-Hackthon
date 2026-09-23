// Minimal shadcn-style primitives (hand-written to avoid the shadcn CLI during the hackathon).
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

export const cn = (...c: ClassValue[]) => twMerge(clsx(c));

export function Card({ className, ...p }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-xl border border-zinc-800 bg-zinc-900/70 p-4", className)} {...p} />;
}

export function CardTitle({ children, right, icon }: { children: ReactNode; right?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">
        {icon}
        {children}
      </h2>
      {right}
    </div>
  );
}

const badgeTones = {
  default: "bg-zinc-800 text-zinc-200 border-zinc-700",
  yellow: "bg-cat-yellow text-black border-cat-yellow",
  red: "bg-red-600/20 text-red-300 border-red-600/50",
  amber: "bg-amber-500/20 text-amber-300 border-amber-500/50",
  green: "bg-emerald-600/20 text-emerald-300 border-emerald-600/50",
  blue: "bg-sky-600/20 text-sky-300 border-sky-600/50",
};
export function Badge({ tone = "default", className, ...p }: HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof badgeTones }) {
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium", badgeTones[tone], className)}
      {...p}
    />
  );
}

const btnTones = {
  default: "bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border-zinc-700",
  primary: "bg-cat-yellow hover:bg-yellow-300 text-black border-cat-yellow font-semibold",
  danger: "bg-red-600/80 hover:bg-red-600 text-white border-red-500",
  ghost: "bg-transparent hover:bg-zinc-800 text-zinc-300 border-transparent",
  active: "bg-zinc-100 text-black border-zinc-100",
};
export function Button({
  tone = "default",
  size = "md",
  className,
  ...p
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: keyof typeof btnTones; size?: "sm" | "md" }) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-lg border transition-colors disabled:opacity-40",
        size === "sm" ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm",
        btnTones[tone],
        className,
      )}
      {...p}
    />
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "red" | "amber" | "green" }) {
  return (
    <div
      className={cn(
        "rounded-lg border border-zinc-800 bg-zinc-950/60 p-3",
        tone === "red" && "border-red-600/60 bg-red-950/40",
        tone === "amber" && "border-amber-500/60 bg-amber-950/30",
        tone === "green" && "border-emerald-700/50",
      )}
    >
      <div className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums text-zinc-100">{value}</div>
      {sub && <div className="text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}
