import { NextResponse } from "next/server";
import { applyControls, type Controls } from "@/lib/engine";

// Simulator inputs (stand-ins for CAN-bus / seat-switch sensors). These feed the rules engine;
// they never write alerts or incidents directly.
const ALLOWED = ["engineOn", "seatbelt", "working", "simPersonDistance", "simDrowsy", "weather", "temperatureC"] as const;

export async function POST(req: Request) {
  const body = (await req.json()) as Record<string, unknown>;
  const c: Controls = {};
  for (const k of ALLOWED) if (k in body) (c as Record<string, unknown>)[k] = body[k];
  applyControls(c);
  return NextResponse.json({ ok: true });
}
