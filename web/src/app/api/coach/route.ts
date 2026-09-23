import { NextResponse } from "next/server";
import { buildCoaching } from "@/lib/coaching";

// Called by the dashboard after a critical alert clears (never while an alert is active)
export async function POST(req: Request) {
  const { type } = (await req.json()) as { type: string };
  const coaching = await buildCoaching(String(type ?? "").toUpperCase());
  return NextResponse.json({ coaching });
}
