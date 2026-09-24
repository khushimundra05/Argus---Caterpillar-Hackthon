"use client";
// Push-to-talk speech input via the browser Web Speech API (Chrome / Edge; needs internet).
// Hold to listen, release to submit. Unsupported browsers get supported=false and keep typing.
import { useCallback, useEffect, useRef, useState } from "react";
import { voice } from "./voice";

// Not in TypeScript's DOM lib; only the parts we use.
type RecognitionResultEvent = { results: ArrayLike<ArrayLike<{ transcript: string }>> };
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type RecognitionCtor = new () => Recognition;

const ERRORS: Record<string, string> = {
  "not-allowed": "Microphone blocked. Allow mic access in the browser.",
  "service-not-allowed": "Microphone blocked. Allow mic access in the browser.",
  "audio-capture": "No microphone found.",
  network: "Speech service unreachable (needs internet). Type instead.",
};

export function useSpeechInput(onFinal: (text: string) => void) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const transcript = useRef("");
  const listeningRef = useRef(false);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  useEffect(() => {
    const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = "en-US";
    r.continuous = true; // keep listening until the operator releases
    r.interimResults = true;
    r.onresult = (e) => {
      let s = "";
      for (let i = 0; i < e.results.length; i++) s += e.results[i][0].transcript;
      transcript.current = s;
      setInterim(s);
    };
    r.onerror = (e) => {
      if (ERRORS[e.error]) setError(ERRORS[e.error]);
    };
    r.onend = () => {
      listeningRef.current = false;
      setListening(false);
      voice.hold(false);
      const text = transcript.current.trim();
      transcript.current = "";
      setInterim("");
      if (text) onFinalRef.current(text);
    };
    rec.current = r;
    setSupported(true);
    return () => {
      r.onend = null;
      r.abort();
      voice.hold(false);
    };
  }, []);

  const start = useCallback(() => {
    if (!rec.current || listeningRef.current) return;
    transcript.current = "";
    setError(null);
    voice.hold(true);
    try {
      rec.current.start();
      listeningRef.current = true;
      setListening(true);
    } catch {
      voice.hold(false); // already started / not ready
    }
  }, []);

  const stop = useCallback(() => {
    if (listeningRef.current) rec.current?.stop();
  }, []);

  return { supported, listening, interim, error, start, stop };
}
