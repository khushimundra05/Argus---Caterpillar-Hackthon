import { NextResponse } from "next/server";
import { CV_SERVICE_URL } from "@/lib/config";
import { latestShiftReport } from "@/lib/report";

export const dynamic = "force-dynamic";

// Downloadable PDF: the report JSON is rendered (with charts) by the Python service
export async function GET() {
  const report = await latestShiftReport();
  try {
    const r = await fetch(`${CV_SERVICE_URL}/report/pdf`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return NextResponse.json({ error: `PDF service returned ${r.status}` }, { status: 502 });
    const date = new Date(report.shift.end).toISOString().slice(0, 10);
    const file = `argus-shift-report_${report.operator.id}_${date}.pdf`;
    return new NextResponse(await r.arrayBuffer(), {
      headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${file}"` },
    });
  } catch {
    return NextResponse.json({ error: `PDF service unreachable at ${CV_SERVICE_URL}` }, { status: 503 });
  }
}
