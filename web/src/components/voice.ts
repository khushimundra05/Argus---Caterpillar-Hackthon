// Client-side TTS via Web Speech API. Alert-priority speech interrupts normal speech;
// normal speech waits behind alerts. Delivery (rate / length) adapts to assistance mode.
"use client";

export type Mode = "Instructor" | "Coaching" | "Assist" | "Silent Guardian";
type Priority = "alert" | "normal";

const RATE: Record<Mode, number> = { Instructor: 0.92, Coaching: 1.0, Assist: 1.08, "Silent Guardian": 1.15 };

class VoiceManager {
  enabled = true;
  mode: Mode = "Assist";
  private current: Priority | null = null;
  private queue: string[] = [];
  private voice: SpeechSynthesisVoice | null = null;

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
    if (!synth || !this.enabled || !text) return;
    this.pickVoice();
    if (priority === "alert") {
      // Interrupt anything normal; drop stale normal queue
      this.queue = [];
      synth.cancel();
      this.utter(text, "alert");
      return;
    }
    const shaped = this.shape(text);
    if (this.current) this.queue.push(shaped);
    else this.utter(shaped, "normal");
  }

  private utter(text: string, priority: Priority) {
    const synth = this.synth!;
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) u.voice = this.voice;
    u.rate = priority === "alert" ? Math.max(RATE[this.mode], 1.0) : RATE[this.mode];
    u.pitch = priority === "alert" ? 1.1 : 1.0;
    u.volume = 1;
    this.current = priority;
    const done = () => {
      if (this.current !== priority) return;
      this.current = null;
      const next = this.queue.shift();
      if (next) this.utter(next, "normal");
    };
    u.onend = done;
    u.onerror = done;
    synth.speak(u);
  }

  stop() {
    this.queue = [];
    this.current = null;
    this.synth?.cancel();
  }
}

export const voice = new VoiceManager();

// ---- Mode-conditioned alert phrasing (safety content fixed; only verbosity varies) ----
type AlertLike = { type: string; severity: string; message: string; value?: number };

export function alertPhrase(a: AlertLike, mode: Mode, idleCostPerHour?: number): string | null {
  const m = a.value != null ? Math.round(a.value * 10) / 10 : null;
  switch (a.type) {
    case "SEATBELT":
      return {
        Instructor: "Warning. Your seatbelt is not fastened while the machine is running. Stop, apply the parking brake, lower the attachment, and fasten your seatbelt before continuing.",
        Coaching: "Seatbelt not fastened. Please stop and buckle up before you continue.",
        Assist: "Seatbelt not fastened. Buckle up.",
        "Silent Guardian": "Seatbelt.",
      }[mode];
    case "PROXIMITY":
      if (a.severity === "critical")
        return mode === "Silent Guardian" || mode === "Assist"
          ? `Stop. Person at ${m} metres.`
          : `Stop all motion now. A person is ${m} metres from the machine, inside the hazard zone. Lower the bucket and wait until they are clear.`;
      return mode === "Silent Guardian" ? `Person, ${m} metres.` : `Caution. Person detected ${m} metres away. Slow down and sound the horn.`;
    case "DROWSINESS":
      return {
        Instructor: "Drowsiness detected. Your eyes have been closed for too long. Park safely, lower the attachment, and take a fifteen minute break. Notify your supervisor.",
        Coaching: "Drowsiness detected. Please park safely and take a break.",
        Assist: "Drowsiness alert. Park and take a break.",
        "Silent Guardian": "Drowsiness alert. Take a break.",
      }[mode];
    case "IDLE": {
      const secs = Math.round(a.value ?? 0);
      const cost = idleCostPerHour ? `$${idleCostPerHour.toFixed(2)}` : "fuel";
      if (a.severity === "info") {
        if (mode === "Silent Guardian") return null;
        return mode === "Assist"
          ? `Idling ${secs} seconds, ${cost} an hour.`
          : `You've been idling for ${secs} seconds. That burns about ${cost} an hour in fuel. Consider shutting down if you're waiting.`;
      }
      return mode === "Silent Guardian"
        ? `Excess idle, ${cost} an hour.`
        : `Excessive idling: ${secs} seconds so far, costing ${cost} an hour. Shut down the engine if waiting more than five minutes.`;
    }
  }
  return a.message;
}
