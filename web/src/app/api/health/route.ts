import { NextResponse } from "next/server";
import { CV_SERVICE_URL } from "@/lib/config";
import { llmStatus } from "@/lib/agent";

export const dynamic = "force-dynamic";

export async function GET() {
  let cv: unknown = null;
  try {
    const r = await fetch(`${CV_SERVICE_URL}/health`, { signal: AbortSignal.timeout(1500) });
    cv = await r.json();
  } catch {
    cv = null;
  }
  const status = llmStatus();
  const active = status.models.find((m) => !m.cooling_down_s)?.model;
  return NextResponse.json({
    cv,
    llm: !status.configured ? "offline (no GEMINI_API_KEY)" : active ? `gemini: ${active}` : "offline (free-tier quota cooling down)",
    llmDetail: status,
  });
}
