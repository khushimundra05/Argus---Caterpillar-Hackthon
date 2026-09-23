"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { voice } from "./voice";

// Shape of GET /api/state (kept loose on purpose — prototype)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ArgusState = any;

export function useArgus(pollMs = 1000) {
  const [state, setState] = useState<ArgusState | null>(null);
  const [operatorId, setOperatorId] = useState<string | null>(null);
  const [health, setHealth] = useState<{ cv: unknown; llm: string } | null>(null);
  const [voiceOn, setVoiceOn] = useState(true);
  const opRef = useRef<string | null>(null);

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("argus-op");
      setVoiceOn(localStorage.getItem("argus-voice") !== "off");
    } catch {
      /* storage unavailable */
    }
    opRef.current = saved;
    setOperatorId(saved);
  }, []);

  useEffect(() => {
    voice.enabled = voiceOn;
    if (!voiceOn) voice.stop();
  }, [voiceOn]);

  const refresh = useCallback(async () => {
    const q = opRef.current ? `?op=${encodeURIComponent(opRef.current)}` : "";
    try {
      const r = await fetch(`/api/state${q}`, { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      setState(j);
      // The server session is the source of truth; follow it (another tab may have switched operator)
      if (opRef.current !== j.operator.id) {
        opRef.current = j.operator.id;
        setOperatorId(j.operator.id);
        try {
          localStorage.setItem("argus-op", j.operator.id);
        } catch {
          /* ignore */
        }
      }
      if (j.score?.mode) voice.mode = j.score.mode;
    } catch {
      /* server restarting */
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, pollMs);
    return () => clearInterval(t);
  }, [refresh, pollMs]);

  useEffect(() => {
    const h = async () => {
      try {
        setHealth(await (await fetch("/api/health", { cache: "no-store" })).json());
      } catch {
        /* ignore */
      }
    };
    h();
    const t = setInterval(h, 10000);
    return () => clearInterval(t);
  }, []);

  const switchOperator = useCallback(
    async (id: string, newShift = false) => {
      opRef.current = id;
      setOperatorId(id);
      try {
        localStorage.setItem("argus-op", id);
      } catch {
        /* ignore */
      }
      await fetch("/api/session", { method: "POST", body: JSON.stringify({ operatorId: id, newShift }) });
      voice.stop();
      refresh();
    },
    [refresh],
  );

  const toggleVoice = () =>
    setVoiceOn((v) => {
      try {
        localStorage.setItem("argus-voice", v ? "off" : "on");
      } catch {
        /* ignore */
      }
      return !v;
    });

  const post = useCallback(
    async (url: string, body: unknown) => {
      await fetch(url, { method: "POST", body: JSON.stringify(body) });
      refresh();
    },
    [refresh],
  );

  return { state, operatorId, switchOperator, health, voiceOn, toggleVoice, post, refresh };
}
