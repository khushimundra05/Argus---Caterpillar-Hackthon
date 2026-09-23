import { NextResponse } from "next/server";
import { completeTask, sim, startTask } from "@/lib/engine";
import { buildBriefing } from "@/lib/briefing";
import { db } from "@/lib/db";

export async function POST(req: Request) {
  const { action, taskId } = (await req.json()) as { action: "start" | "complete" | "pause"; taskId: number };
  if (action === "start") {
    startTask(taskId);
    // Spoken briefing: safety for everyone, how-to depth by proficiency, optional training nudge
    const briefing = await buildBriefing(taskId);
    return NextResponse.json({ ok: true, briefing });
  }
  if (action === "complete") completeTask(taskId);
  else if (action === "pause") {
    db().prepare("UPDATE tasks SET status='scheduled' WHERE id=? AND status='in_progress'").run(taskId);
    sim().eta = null;
  }
  return NextResponse.json({ ok: true });
}
