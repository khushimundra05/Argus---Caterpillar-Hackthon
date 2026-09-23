import { NextResponse } from "next/server";
import { MODULES, markComplete, recommendTraining } from "@/lib/training";
import { recomputeScore, sim } from "@/lib/engine";

export const dynamic = "force-dynamic";

export async function GET() {
  const s = sim();
  return NextResponse.json({ modules: MODULES, recommendations: recommendTraining(s.operatorId) });
}

export async function POST(req: Request) {
  const { moduleId } = (await req.json()) as { moduleId: string };
  const s = sim();
  markComplete(s.operatorId, moduleId);
  recomputeScore(s); // completing training earns credit and halves the matching incident penalty
  return NextResponse.json({ ok: true, score: s.score });
}
