import { NextResponse } from "next/server";
import { buildShiftReport } from "@/lib/report";

export const dynamic = "force-dynamic";

// End-of-shift report for the current operator (also cached for the PDF export)
export async function GET() {
  return NextResponse.json(await buildShiftReport());
}
