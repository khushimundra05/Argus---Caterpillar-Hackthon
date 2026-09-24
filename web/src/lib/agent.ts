// Tool-calling assistant (Google Gemini, free tier). The LLM only READS state via tools and narrates it.
// Assistance mode (from the rule-based score) conditions tone + verbosity via the system instruction.
import { ApiError, GoogleGenAI, type Content, type FunctionCall, type GenerateContentConfig, type Part } from "@google/genai";
import { GEMINI_MODELS, type Mode } from "./config";
import { TOOLS, runTool, sessionContext } from "./tools";

const MODE_STYLE: Record<Mode, string> = {
  Instructor:
    "INSTRUCTOR mode (novice / recently struggling operator). Be patient and explicit. Give numbered step-by-step instructions, explain WHY each step matters, cite the relevant SOP when you used the knowledge base. Up to 6 short sentences. Warm, encouraging, never condescending.",
  Coaching:
    "COACHING mode. Be supportive and concise: answer in 2-4 sentences and add exactly one practical improvement tip where relevant.",
  Assist:
    "ASSIST mode (competent operator). Be brief and factual: 1-2 sentences, numbers first, no tips unless asked.",
  "Silent Guardian":
    "SILENT GUARDIAN mode (expert operator). Minimal interruption: one short sentence, max ~15 words. Only essentials. No tips, no pleasantries.",
};

function systemPrompt(mode: Mode) {
  const { op, m, t, s } = sessionContext();
  return `You are Argus, an in-cab AI co-pilot for Caterpillar machine operators. Your replies are shown on the cab display AND read aloud by text-to-speech, so write plain spoken sentences: no markdown, no bullet symbols, no asterisks, no tables, no emoji.

Current session:
- Operator: ${op.name} (${op.id}), ${op.experience_years} years experience
- Machine: ${m.model} ${m.type} (${m.id}), ${m.age_years} years old
- Current task: ${t ? `#${t.id} ${t.name}` : "none in progress"}
- Conditions: weather ${s.weather}, ${s.temperatureC} C
- Assistance score ${s.score?.score ?? "?"} → mode ${mode}

Style: ${MODE_STYLE[mode]}

Safety rules (non-negotiable):
- Safety alerts come ONLY from the deterministic safety engine. You can read them with check_safety_status but you cannot create, clear, override or downgrade them.
- Never tell the operator an alert is false, safe to ignore, or that they may continue while a critical alert is active. If a critical alert is active, lead with the required action from the SOP.
- If unsure about a safety procedure, search the knowledge base; if it is not there, tell the operator to contact their supervisor.

Use tools to ground every factual claim about schedule, safety state, behavior, ETA and training. Use the ids above; don't ask the operator for them. Call independent tools in parallel.

When the operator asks for their schedule or tasks, name every task with its start time in one sentence, even in the briefest mode; the mode's length limit applies to everything else.`;
}

export type ChatTurn = { role: "user" | "assistant"; content: string };
export type ToolTrace = { name: string; input: unknown; output: unknown };
export type ChatResult = { text: string; tools: ToolTrace[]; offline: boolean; model?: string; note?: string };

const MAX_STEPS = 5;
const FUNCTION_DECLARATIONS = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  parametersJsonSchema: t.input_schema,
}));

// ---- Free-tier quota handling: each model has its own quota, so rotate through GEMINI_MODELS ----
const apiKey = () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

type LlmStats = { cooldown: Record<string, number>; calls: Record<string, number>; day: string };
const g = globalThis as unknown as { __argusLlm?: LlmStats; __argusGenAI?: GoogleGenAI };

function llmStats(): LlmStats {
  const day = new Date().toDateString();
  if (!g.__argusLlm || g.__argusLlm.day !== day) g.__argusLlm = { cooldown: {}, calls: {}, day };
  return g.__argusLlm;
}

export function llmStatus() {
  const st = llmStats();
  const now = Date.now();
  return {
    provider: "gemini",
    configured: !!apiKey(),
    models: GEMINI_MODELS.map((m) => ({
      model: m,
      calls_today: st.calls[m] ?? 0,
      cooling_down_s: (st.cooldown[m] ?? 0) > now ? Math.round((st.cooldown[m] - now) / 1000) : 0,
    })),
  };
}

const ai = () => (g.__argusGenAI ??= new GoogleGenAI({ apiKey: apiKey() }));

/** One generateContent call, falling through the model list on quota / availability errors. */
async function generate(contents: Content[], config: GenerateContentConfig, preferred: string | null) {
  const st = llmStats();
  const now = Date.now();
  const order = [preferred, ...GEMINI_MODELS].filter((m, i, a): m is string => !!m && a.indexOf(m) === i);
  let lastErr: unknown = null;
  for (const model of order) {
    if ((st.cooldown[model] ?? 0) > now) continue;
    try {
      st.calls[model] = (st.calls[model] ?? 0) + 1;
      const response = await ai().models.generateContent({ model, contents, config });
      return { response, model };
    } catch (e) {
      lastErr = e;
      if (e instanceof ApiError && [404, 429, 500, 503].includes(e.status)) {
        // 429 = free-tier quota. Per-minute limits reset quickly; per-day ones don't.
        const perDay = /per.?day|daily/i.test(e.message);
        const wait = e.status === 429 ? (perDay ? 3600e3 : 65e3) : e.status === 404 ? 86400e3 : 20e3;
        st.cooldown[model] = now + wait;
        console.warn(`[argus] ${model} unavailable (${e.status}); trying next model`);
        continue;
      }
      throw e;
    }
  }
  throw lastErr ?? new Error("all Gemini models are cooling down");
}

/**
 * One-shot structured composition (task briefings, coaching) with the same free-tier model rotation.
 * Returns null when Gemini is unavailable / slow / invalid, so callers always keep a deterministic fallback.
 */
export async function composeJson<T>(system: string, prompt: string, schema: object, timeoutMs = 8000): Promise<{ data: T; model: string } | null> {
  if (!apiKey()) return null;
  try {
    const { response, model } = await generate(
      [{ role: "user", parts: [{ text: prompt }] }],
      {
        systemInstruction: system,
        temperature: 0.4,
        maxOutputTokens: 2048,
        responseMimeType: "application/json",
        responseJsonSchema: schema,
        abortSignal: AbortSignal.timeout(timeoutMs),
      },
      null,
    );
    return { data: JSON.parse(response.text ?? "") as T, model };
  } catch (e) {
    console.warn("[argus] Gemini compose failed; using template", e instanceof Error ? e.message : e);
    return null;
  }
}

export async function chat(history: ChatTurn[], mode: Mode): Promise<ChatResult> {
  if (!apiKey()) return offlineAnswer(history[history.length - 1]?.content ?? "", mode);

  const contents: Content[] = history.slice(-12).map((h) => ({
    role: h.role === "assistant" ? "model" : "user",
    parts: [{ text: h.content }],
  }));
  const trace: ToolTrace[] = [];
  let model: string | null = null;

  try {
    for (let i = 0; i < MAX_STEPS; i++) {
      const r = await generate(
        contents,
        {
          systemInstruction: systemPrompt(mode),
          tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
          temperature: 0.3,
          maxOutputTokens: 2048,
        },
        model,
      );
      model = r.model; // stay on the same model within one answer
      const calls: FunctionCall[] = r.response.functionCalls ?? [];

      if (!calls.length) {
        const text = (r.response.text ?? "").replace(/[*#`_]/g, "").trim();
        const blocked = r.response.promptFeedback?.blockReason;
        return {
          text: text || (blocked ? "I can't help with that one. Please contact your supervisor." : "Done."),
          tools: trace,
          offline: false,
          model,
        };
      }

      // Keep the model's turn verbatim (preserves thought signatures), then answer every call in one turn
      const modelTurn = r.response.candidates?.[0]?.content;
      contents.push(modelTurn ?? { role: "model", parts: calls.map((fc) => ({ functionCall: fc })) });
      const parts: Part[] = await Promise.all(
        calls.map(async (fc) => {
          const name = fc.name ?? "";
          try {
            const out = await runTool(name, (fc.args ?? {}) as Record<string, unknown>);
            trace.push({ name, input: fc.args, output: out });
            return { functionResponse: { id: fc.id, name, response: { output: out } } };
          } catch (e) {
            return { functionResponse: { id: fc.id, name, response: { error: String(e) } } };
          }
        }),
      );
      contents.push({ role: "user", parts });
    }
    return { text: "Sorry, that took too many steps. Please ask again.", tools: trace, offline: false, model: model ?? undefined };
  } catch (e) {
    const status = e instanceof ApiError ? e.status : undefined;
    console.error("[argus] Gemini error", status, e instanceof Error ? e.message : e);
    const fb = await offlineAnswer(history[history.length - 1]?.content ?? "", mode);
    return { ...fb, note: status === 429 || !status ? "free-tier quota reached — offline mode" : `LLM error ${status} — offline mode` };
  }
}

// ---------- Offline fallback: same read-only tools, templated narration by mode ----------
async function offlineAnswer(q: string, mode: Mode): Promise<ChatResult> {
  const { s, op, t } = sessionContext();
  const trace: ToolTrace[] = [];
  const call = async (name: string, input: Record<string, unknown>) => {
    const output = await runTool(name, input);
    trace.push({ name, input, output });
    return output as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const terse = mode === "Silent Guardian" || mode === "Assist";
  const lq = q.toLowerCase();
  let text: string;

  if (/safe|alert|belt|proxim|person|drows|status/.test(lq)) {
    const st = await call("check_safety_status", { machine_id: s.machineId });
    const a = st.active_alerts as { type: string; message: string; severity: string }[];
    text = a.length
      ? `${a.map((x) => `${x.severity} ${x.type.toLowerCase()} alert: ${x.message}`).join(". ")}.` +
        (terse || !a.some((x) => x.severity === "critical") ? "" : " Stop, secure the machine and resolve the alert before continuing.")
      : terse ? "All clear." : `All clear. No active safety alerts. ${st.minutes_since_last_incident} minutes since your last incident, keep it up.`;
  } else if (/eta|how long|finish|time|done/.test(lq) && t) {
    const p = await call("predict_task_time", { task_id: t.id });
    text = terse
      ? `${p.remaining_minutes} minutes remaining.`
      : `${p.task} is ${p.progress_pct} percent done. The model predicts ${p.predicted_total_minutes} minutes in total given ${p.conditions.weather} weather, so about ${p.remaining_minutes} minutes remain.`;
  } else if (/train|learn|course|module/.test(lq)) {
    const r = await call("recommend_training", { operator_id: op.id });
    text = `I recommend ${r[0].title}${r[0].reason ? ` because of ${r[0].reason}` : ""}. It takes ${r[0].duration_min} minutes.`;
  } else if (/idle|fuel|behav|anomal|pattern/.test(lq)) {
    const b = await call("get_behavior_flags", { operator_id: op.id });
    text = `Your live idle ratio is ${Math.round((b.live_idle_ratio ?? 0) * 100)} percent against a baseline of ${Math.round(b.idle_baseline.mean * 100)} percent, z-score ${b.idle_z_score}. ${b.flags_last_7_days.length} behavior flags this week.`;
  } else if (/schedul|task|today|next/.test(lq)) {
    const sch = await call("get_daily_schedule", { operator_id: op.id });
    type Row = { name: string; scheduled_start: string; status: string; planned_minutes: number };
    const next = (sch as Row[]).find((x) => x.status !== "completed");
    // One sentence, so voice trimming in the terse modes still speaks the whole list
    const list = (sch as Row[])
      .map((x) => `${x.name} at ${x.scheduled_start}${terse ? "" : ` for ${x.planned_minutes} minutes`}${x.status === "completed" ? " (done)" : ""}`)
      .join(", ");
    text = !sch.length
      ? "No tasks scheduled today."
      : `${terse ? `${sch.length} tasks today` : `You have ${sch.length} tasks today`}: ${list}; ${next ? `next is ${next.name}.` : "all complete, great work."}`;
  } else {
    const hits = await call("search_knowledge_base", { query: q });
    text = hits.length ? `From ${hits[0].source}: ${hits[0].text}${!terse && hits[1] ? ` Also, ${hits[1].text}` : ""}` : "I couldn't find that in the manuals. Please check with your supervisor.";
  }
  return { text, tools: trace, offline: true };
}
