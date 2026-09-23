import { NextResponse } from "next/server";
import { CV_SERVICE_URL, MODEL } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET() {
  let cv: unknown = null;
  try {
    const r = await fetch(`${CV_SERVICE_URL}/health`, { signal: AbortSignal.timeout(1500) });
    cv = await r.json();
  } catch {
    cv = null;
  }
  return NextResponse.json({ cv, llm: process.env.ANTHROPIC_API_KEY ? MODEL : "offline (no ANTHROPIC_API_KEY)" });
}
