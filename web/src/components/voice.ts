// Client-side TTS via Web Speech API. Alert-priority speech interrupts normal speech;
// normal speech waits behind alerts. Safety alerts are identical for every operator; only
// assistant replies adapt their rate / length to the assistance mode.
// Only ONE browser tab speaks at a time (cross-tab lock), so open tabs never talk over each other.
"use client";

export type Mode = "Instructor" | "Coaching" | "Assist" | "Silent Guardian";
// normal = assistant reply (trimmed by mode) · full = briefings and nudges, never trimmed · alert = safety, interrupts
type Priority = "alert" | "normal" | "full";

const RATE: Record<Mode, number> = { Instructor: 0.92, Coaching: 1.0, Assist: 1.08, "Silent Guardian": 1.15 };
const ALERT_RATE = 1.0;

const LOCK_KEY = "argus-speaker";
const LOCK_STALE_MS = 4000;
const TAB_ID = Math.random().toString(36).slice(2);

class VoiceManager {
  enabled = true;
  mode: Mode = "Assist";
  private current: SpeechSynthesisUtterance | null = null;
  private currentIsAlert = false;
  private queue: string[] = [];
  private held = false;
  private voice: SpeechSynthesisVoice | null = null;
  private primary = false;

  constructor() {
    if (typeof window === "undefined") return;
    // Heartbeat while we hold the lock; the dashboard tab you're looking at claims it.
    setInterval(() => {
      if (this.readLock()?.id === TAB_ID) this.writeLock();
    }, 1500);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.primary) this.writeLock();
    });
    window.addEventListener("storage", (e) => {
      if (e.key === LOCK_KEY && this.readLock()?.id !== TAB_ID) this.stop(); // another tab took over
    });
    window.addEventListener("pagehide", () => {
      try {
        if (this.readLock()?.id === TAB_ID) localStorage.removeItem(LOCK_KEY);
      } catch {
        /* ignore */
      }
    });
  }

  /** Dashboard pages are primary speakers (they carry safety alerts) and claim the lock when visible. */
  setPrimary(on: boolean) {
    this.primary = on;
    if (on && typeof document !== "undefined" && document.visibilityState === "visible") this.writeLock();
  }

  private readLock(): { id: string; at: number } | null {
    try {
      return JSON.parse(localStorage.getItem(LOCK_KEY) ?? "null");
    } catch {
      return null;
    }
  }
  private writeLock() {
    try {
      localStorage.setItem(LOCK_KEY, JSON.stringify({ id: TAB_ID, at: Date.now() }));
    } catch {
      /* storage unavailable: every tab may speak */
    }
  }
  /** True if this tab currently holds the speaker lock (used to avoid duplicate work across tabs). */
  holdsLock() {
    const lock = this.readLock();
    return !lock || lock.id === TAB_ID || Date.now() - lock.at > LOCK_STALE_MS;
  }

  /** True if this tab may speak: it holds the lock, or the lock is free/stale (then it claims it). */
  private isSpeaker() {
    const lock = this.readLock();
    if (!lock || lock.id === TAB_ID || Date.now() - lock.at > LOCK_STALE_MS) {
      this.writeLock();
      return true;
    }
    return false;
  }

  private get synth() {
    return typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
  }

  private pickVoice() {
    if (this.voice || !this.synth) return;
    const vs = this.synth.getVoices();
    this.voice = vs.find((v) => /en-(US|GB|IN|AU)/i.test(v.lang) && /natural|online|google/i.test(v.name)) ?? vs.find((v) => v.lang.startsWith("en")) ?? null;
  }

  /** Mode-dependent trimming for normal (non-alert) speech. */
  private shape(text: string) {
    const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [text];
    if (this.mode === "Silent Guardian") return sentences.slice(0, 1).join(" ");
    if (this.mode === "Assist") return sentences.slice(0, 2).join(" ");
    return text;
  }

  speak(text: string, priority: Priority = "normal") {
    const synth = this.synth;
    if (!synth || !this.enabled || !text || !this.isSpeaker()) return;
    this.pickVoice();
    if (priority === "alert") {
      // Interrupt anything that isn't an alert; drop the stale normal queue
      this.queue = [];
      this.current = null;
      synth.cancel();
      this.utter(text, true);
      return;
    }
    if (this.held) return; // operator is talking; don't let the mic hear us
    const shaped = priority === "normal" ? this.shape(text) : text;
    if (this.current || synth.speaking || synth.pending) this.queue.push(shaped);
    else this.utter(shaped, false);
  }

  private utter(text: string, isAlert: boolean) {
    const synth = this.synth!;
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) u.voice = this.voice;
    u.rate = isAlert ? ALERT_RATE : RATE[this.mode];
    u.pitch = isAlert ? 1.1 : 1.0;
    u.volume = 1;
    this.current = u;
    this.currentIsAlert = isAlert;
    const done = () => {
      if (this.current !== u) return; // a cancelled/replaced utterance finishing late must not advance the queue
      this.current = null;
      const next = this.queue.shift();
      if (next) this.utter(next, false);
    };
    u.onend = done;
    u.onerror = done;
    synth.speak(u);
  }

  /** Push-to-talk: silence normal speech while the mic is open. Alerts still interrupt. */
  hold(on: boolean) {
    this.held = on;
    if (!on) return;
    this.queue = [];
    if (this.current && !this.currentIsAlert) {
      this.current = null;
      this.synth?.cancel();
    }
  }

  stop() {
    this.queue = [];
    this.current = null;
    this.synth?.cancel();
  }
}

export const voice = new VoiceManager();

// ---- Safety alert phrasing: the SAME full wording for every operator, regardless of proficiency ----
type AlertLike = { type: string; severity: string; message: string; value?: number };

export function alertPhrase(a: AlertLike, idleCostPerHour?: number): string {
  const m = a.value != null ? Math.round(a.value * 10) / 10 : null;
  switch (a.type) {
    case "SEATBELT":
      return "Warning. Your seatbelt is not fastened while the machine is running. Stop, apply the parking brake, lower the attachment, and fasten your seatbelt before continuing.";
    case "PROXIMITY":
      return a.severity === "critical"
        ? `Stop all motion now. A person is ${m} metres from the machine, inside the hazard zone. Lower the bucket and wait until they are clear.`
        : `Caution. Person detected ${m} metres away. Slow down and sound the horn.`;
    case "DROWSINESS":
      return "Drowsiness detected. Your eyes have been closed for too long. Park safely, lower the attachment, and take a fifteen minute break. Notify your supervisor.";
    case "IDLE": {
      const secs = Math.round(a.value ?? 0);
      const cost = idleCostPerHour ? `$${idleCostPerHour.toFixed(2)}` : "fuel";
      return a.severity === "info"
        ? `You've been idling for ${secs} seconds. That burns about ${cost} an hour in fuel. Consider shutting down if you're waiting.`
        : `Excessive idling: ${secs} seconds so far, costing ${cost} an hour. Shut down the engine if waiting more than five minutes.`;
    }
  }
  return a.message;
}
