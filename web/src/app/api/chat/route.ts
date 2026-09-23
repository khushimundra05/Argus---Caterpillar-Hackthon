import { NextResponse } from "next/server";
import { chat, type ChatTurn } from "@/lib/agent";
import { modeOf, sim } from "@/lib/engine";

export async function POST(req: Request) {
  const { history } = (await req.json()) as { history: ChatTurn[] };
  const mode = modeOf(sim());
  try {
    const r = await chat(history, mode);
    return NextResponse.json({ ...r, mode });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ text: "Assistant unavailable right now.", tools: [], mode, offline: true }, { status: 500 });
  }
}
