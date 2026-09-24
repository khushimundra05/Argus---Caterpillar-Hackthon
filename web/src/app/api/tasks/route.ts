import { NextResponse } from "next/server";
import { completeTask, holdForBriefing, releaseBriefing, sim, startTask } from "@/lib/engine";
import { buildBriefing } from "@/lib/briefing";
import { db } from "@/lib/db";

// Upper bound on how long a briefing can hold the task (~2.3 spoken words/s + margin, max 2.5 min).
// Normally the browser reports the end of speech first via action "briefing_done".
const holdMs = (text: string) => Math.min(150_000, (text.split(/\s+/).length / 2.3) * 1000 + 8000);

export async function POST(req: Request) {
  const { action, taskId } = (await req.json()) as { action: "start" | "complete" | "pause" | "briefing_done"; taskId: number };
  if (action === "start") {
    startTask(taskId); // task is held: no cycles / timer / idle until the briefing has been spoken
    // Spoken briefing: safety for everyone, how-to depth by proficiency, optional training nudge
    const briefing = await buildBriefing(taskId);
    if (briefing) holdForBriefing(taskId, holdMs(briefing.spoken));
    else releaseBriefing(taskId);
    return NextResponse.json({ ok: true, briefing });
  }
  if (action === "briefing_done") releaseBriefing(taskId);
  else if (action === "complete") {
    releaseBriefing(taskId);
    completeTask(taskId);
  } else if (action === "pause") {
    releaseBriefing(taskId);
    db().prepare("UPDATE tasks SET status='scheduled' WHERE id=? AND status='in_progress'").run(taskId);
    sim().eta = null;
  }
  return NextResponse.json({ ok: true });
}
