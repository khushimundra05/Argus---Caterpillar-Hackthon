import { NextResponse } from "next/server";
import { startSession } from "@/lib/engine";
import { kvSet } from "@/lib/db";

export async function POST(req: Request) {
  const { operatorId, newShift } = (await req.json()) as { operatorId: string; newShift?: boolean };
  if (newShift) kvSet("shift", null);
  const s = startSession(operatorId);
  await s.modelReady; // first ML proficiency score (falls back to the formula if the CV/ML service is down)
  return NextResponse.json({ ok: true, score: s.score });
}
