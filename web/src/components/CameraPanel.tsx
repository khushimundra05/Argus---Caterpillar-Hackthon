"use client";
// Driver-facing (drowsiness) + zone (hazard) cameras. Frames go browser -> /api/cv -> Python;
// the rules engine ingests the result server-side.
import { useEffect, useRef, useState } from "react";
import { Camera, CameraOff, Eye, ScanEye, Users } from "lucide-react";
import { Badge, Button, Card, CardTitle, cn } from "./ui";

type DriverRes = {
  face_found: boolean; ear: number | null; threshold: number; eyes_closed: boolean; closed_seconds: number;
  drowsy: boolean; face_box: number[] | null; method: string; error?: string;
};
type ZoneRes = { persons: { box: number[]; distance_m: number; detector: string }[]; min_distance_m: number | null; error?: string };

function useDevices() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const refresh = async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter((d) => d.kind === "videoinput"));
    } catch {
      /* no permission yet */
    }
  };
  useEffect(() => {
    refresh();
  }, []);
  return { devices, refresh };
}

function Feed({
  kind, deviceId, intervalMs, width, onResult, draw, mirrored,
}: {
  kind: "driver" | "zone"; deviceId: string; intervalMs: number; width: number;
  onResult: (r: unknown) => void; draw: (ctx: CanvasRenderingContext2D, w: number, h: number, r: unknown) => void; mirrored?: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let busy = false;
    let stopped = false;
    const grab = document.createElement("canvas");

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: deviceId ? { deviceId: { exact: deviceId }, width: 640, height: 480 } : { width: 640, height: 480 },
          audio: false,
        });
        if (stopped) return stream.getTracks().forEach((t) => t.stop());
        video.current!.srcObject = stream;
        await video.current!.play();
        setErr(null);
      } catch (e) {
        setErr(String((e as Error).message ?? e));
        return;
      }
      timer = setInterval(async () => {
        const v = video.current;
        if (busy || !v || v.readyState < 2) return;
        busy = true;
        grab.width = width;
        grab.height = Math.round((v.videoHeight / v.videoWidth) * width);
        grab.getContext("2d")!.drawImage(v, 0, 0, grab.width, grab.height);
        const image = grab.toDataURL("image/jpeg", 0.7);
        try {
          const r = await fetch("/api/cv", { method: "POST", body: JSON.stringify({ camera: kind, image }) });
          const j = await r.json();
          onResult(j);
          const c = overlay.current;
          if (c) {
            c.width = c.clientWidth;
            c.height = c.clientHeight;
            const ctx = c.getContext("2d")!;
            ctx.clearRect(0, 0, c.width, c.height);
            if (!j.error) draw(ctx, c.width, c.height, j);
          }
        } catch {
          onResult({ error: "network" });
        } finally {
          busy = false;
        }
      }, intervalMs);
    })();

    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, kind]);

  return (
    <div className="relative aspect-video overflow-hidden rounded-lg bg-black">
      <video ref={video} muted playsInline className={cn("h-full w-full object-cover", mirrored && "-scale-x-100")} />
      <canvas ref={overlay} className={cn("pointer-events-none absolute inset-0 h-full w-full", mirrored && "-scale-x-100")} />
      {err && <div className="absolute inset-0 grid place-items-center p-3 text-center text-xs text-red-300">Camera error: {err}</div>}
    </div>
  );
}

export function CameraPanel() {
  const { devices, refresh } = useDevices();
  const [driverOn, setDriverOn] = useState(false);
  const [zoneOn, setZoneOn] = useState(false);
  const [driverDev, setDriverDev] = useState("");
  const [zoneDev, setZoneDev] = useState("");
  const [driver, setDriver] = useState<DriverRes | null>(null);
  const [zone, setZone] = useState<ZoneRes | null>(null);

  const select = (value: string, set: (v: string) => void) => (
    <select
      value={value}
      onChange={(e) => set(e.target.value)}
      onFocus={refresh}
      className="max-w-[9rem] truncate rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-300"
    >
      <option value="">Default camera</option>
      {devices.map((d, i) => (
        <option key={d.deviceId || i} value={d.deviceId}>
          {d.label || `Camera ${i + 1}`}
        </option>
      ))}
    </select>
  );

  return (
    <Card>
      <CardTitle icon={<Camera className="h-4 w-4" />} right={<span className="text-[11px] text-zinc-500">MediaPipe EAR · OpenCV HOG</span>}>
        Cameras
      </CardTitle>
      <div className="grid gap-3 sm:grid-cols-2">
        {/* Driver camera */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1 text-xs font-medium text-zinc-300">
              <Eye className="h-3.5 w-3.5" /> Driver (drowsiness)
            </span>
            <div className="flex items-center gap-1">
              {select(driverDev, setDriverDev)}
              <Button size="sm" tone={driverOn ? "active" : "default"} onClick={() => { setDriverOn(!driverOn); setDriver(null); }}>
                {driverOn ? <CameraOff className="h-3.5 w-3.5" /> : <Camera className="h-3.5 w-3.5" />}
              </Button>
            </div>
          </div>
          {driverOn ? (
            <Feed
              kind="driver"
              deviceId={driverDev}
              intervalMs={220}
              width={480}
              mirrored
              onResult={(r) => setDriver(r as DriverRes)}
              draw={(ctx, w, h, r) => {
                const d = r as DriverRes;
                if (!d.face_box) return;
                const [x, y, bw, bh] = d.face_box;
                ctx.strokeStyle = d.drowsy ? "#ef4444" : d.eyes_closed ? "#f59e0b" : "#22c55e";
                ctx.lineWidth = 3;
                ctx.strokeRect(x * w, y * h, bw * w, bh * h);
              }}
            />
          ) : (
            <Placeholder text="Driver camera off" />
          )}
          <div className="flex flex-wrap gap-1.5 text-xs">
            {driver?.error ? (
              <Badge tone="red">CV service offline</Badge>
            ) : driver ? (
              <>
                <Badge tone={driver.face_found ? "green" : "amber"}>{driver.face_found ? "Face locked" : "No face"}</Badge>
                <Badge tone={driver.eyes_closed ? "amber" : "default"}>
                  EAR {driver.ear?.toFixed(2) ?? "–"} / {driver.threshold?.toFixed(2)}
                </Badge>
                {driver.closed_seconds > 0 && <Badge tone="amber">closed {driver.closed_seconds.toFixed(1)}s</Badge>}
                {driver.drowsy && <Badge tone="red" className="animate-flash">DROWSY</Badge>}
                <Badge>{driver.method}</Badge>
              </>
            ) : null}
          </div>
        </div>

        {/* Zone camera */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1 text-xs font-medium text-zinc-300">
              <ScanEye className="h-3.5 w-3.5" /> Hazard zone (people)
            </span>
            <div className="flex items-center gap-1">
              {select(zoneDev, setZoneDev)}
              <Button size="sm" tone={zoneOn ? "active" : "default"} onClick={() => { setZoneOn(!zoneOn); setZone(null); }}>
                {zoneOn ? <CameraOff className="h-3.5 w-3.5" /> : <Camera className="h-3.5 w-3.5" />}
              </Button>
            </div>
          </div>
          {zoneOn ? (
            <Feed
              kind="zone"
              deviceId={zoneDev}
              intervalMs={500}
              width={640}
              onResult={(r) => setZone(r as ZoneRes)}
              draw={(ctx, w, h, r) => {
                for (const p of (r as ZoneRes).persons) {
                  const [x, y, bw, bh] = p.box;
                  ctx.strokeStyle = p.distance_m < 3 ? "#ef4444" : p.distance_m < 6 ? "#f59e0b" : "#38bdf8";
                  ctx.lineWidth = 3;
                  ctx.strokeRect(x * w, y * h, bw * w, bh * h);
                  ctx.fillStyle = ctx.strokeStyle;
                  ctx.font = "bold 14px sans-serif";
                  ctx.fillText(`${p.distance_m} m`, x * w + 4, y * h + 16);
                }
              }}
            />
          ) : (
            <Placeholder text="Zone camera off" />
          )}
          <div className="flex flex-wrap gap-1.5 text-xs">
            {zone?.error ? (
              <Badge tone="red">CV service offline</Badge>
            ) : zone ? (
              <>
                <Badge tone={zone.persons.length ? "amber" : "green"}>
                  <Users className="h-3 w-3" /> {zone.persons.length} person(s)
                </Badge>
                {zone.min_distance_m != null && (
                  <Badge tone={zone.min_distance_m < 3 ? "red" : zone.min_distance_m < 6 ? "amber" : "default"}>
                    nearest {zone.min_distance_m} m
                  </Badge>
                )}
              </>
            ) : null}
          </div>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-zinc-500">
        One webcam can drive both feeds. Zone detection works best with a full body in frame (step back 2–4 m).
      </p>
    </Card>
  );
}

function Placeholder({ text }: { text: string }) {
  return <div className="grid aspect-video place-items-center rounded-lg border border-dashed border-zinc-800 text-xs text-zinc-600">{text}</div>;
}
