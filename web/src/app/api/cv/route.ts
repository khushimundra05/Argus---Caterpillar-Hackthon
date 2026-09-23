import { NextResponse } from "next/server";
import { CV_SERVICE_URL } from "@/lib/config";
import { ingestDriverCv, ingestZoneCv } from "@/lib/engine";

// Browser -> Next -> Python CV service. The result is ingested server-side by the rules engine,
// so the client can never assert its own safety state.
export async function POST(req: Request) {
  const { camera, image } = (await req.json()) as { camera: "driver" | "zone"; image: string };
  try {
    const r = await fetch(`${CV_SERVICE_URL}/analyze/${camera}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image }),
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return NextResponse.json({ error: `cv service ${r.status}` }, { status: 502 });
    const j = await r.json();
    if (camera === "driver")
      ingestDriverCv({ faceFound: j.face_found, ear: j.ear, closedSec: j.closed_seconds, drowsy: j.drowsy, method: j.method });
    else ingestZoneCv({ persons: j.persons.length, minDistance: j.min_distance_m });
    return NextResponse.json(j);
  } catch (e) {
    return NextResponse.json({ error: `cv service unreachable at ${CV_SERVICE_URL}` }, { status: 503 });
  }
}
