// Tool-calling assistant. The LLM only READS state via tools and narrates it.
// Assistance mode (from the rule-based score) conditions tone + verbosity via the system prompt.
import Anthropic from "@anthropic-ai/sdk";
import { MODEL, type Mode } from "./config";
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
  return `You are Argus, an in-cab AI co-pilot for Caterpillar machine operators. Your replies are shown on the cab display AND read aloud by text-to-speech, so write plain spoken sentences: no markdown, no bullet symbols, no tables, no emoji.

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

Use tools to ground every factual claim about schedule, safety state, behavior, ETA and training. Use the ids above; don't ask the operator for them.`;
}

export type ChatTurn = { role: "user" | "assistant"; content: string };
export type ToolTrace = { name: string; input: unknown; output: unknown };

export async function chat(history: ChatTurn[], mode: Mode): Promise<{ text: string; tools: ToolTrace[]; offline: boolean }> {
  if (!process.env.ANTHROPIC_API_KEY) return offlineAnswer(history[history.length - 1]?.content ?? "", mode);

  const client = new Anthropic();
  const messages: Anthropic.MessageParam[] = history.slice(-12).map((h) => ({ role: h.role, content: h.content }));
  const trace: ToolTrace[] = [];

  try {
    for (let i = 0; i < 6; i++) {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 8000,
        system: systemPrompt(mode),
        tools: TOOLS,
        messages,
        output_config: { effort: "low" },
      });

      if (response.stop_reason === "refusal") return { text: "I can't help with that one. Please contact your supervisor.", tools: trace, offline: false };
      if (response.stop_reason !== "tool_use") {
        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join(" ")
          .trim();
        return { text: text || "Done.", tools: trace, offline: false };
      }

      messages.push({ role: "assistant", content: response.content });
      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const results: Anthropic.ToolResultBlockParam[] = await Promise.all(
        toolUses.map(async (tu) => {
          try {
            const out = await runTool(tu.name, (tu.input ?? {}) as Record<string, unknown>);
            trace.push({ name: tu.name, input: tu.input, output: out });
            return { type: "tool_result" as const, tool_use_id: tu.id, content: JSON.stringify(out) };
          } catch (e) {
            return { type: "tool_result" as const, tool_use_id: tu.id, content: String(e), is_error: true };
          }
        }),
      );
      messages.push({ role: "user", content: results });
    }
    return { text: "Sorry, that took too many steps. Please ask again.", tools: trace, offline: false };
  } catch (e) {
    if (e instanceof Anthropic.APIError) {
      console.error("[argus] Claude API error", e.status, e.message);
      const fb = await offlineAnswer(history[history.length - 1]?.content ?? "", mode);
      return { ...fb, text: `${fb.text}` };
    }
    throw e;
  }
}

// ---------- Offline fallback: same read-only tools, templated narration by mode ----------
async function offlineAnswer(q: string, mode: Mode): Promise<{ text: string; tools: ToolTrace[]; offline: boolean }> {
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
    const next = sch.find((x: { status: string }) => x.status !== "completed");
    text = terse
      ? `${sch.filter((x: { status: string }) => x.status === "completed").length} of ${sch.length} done. Next: ${next?.name ?? "none"}.`
      : `You have ${sch.length} tasks today. ${next ? `Next up is ${next.name} at ${next.scheduled_start}, planned for ${next.planned_minutes} minutes.` : "All tasks are complete, great work."}`;
  } else {
    const hits = await call("search_knowledge_base", { query: q });
    text = hits.length ? `From ${hits[0].source}: ${hits[0].text}${!terse && hits[1] ? ` Also, ${hits[1].text}` : ""}` : "I couldn't find that in the manuals. Please check with your supervisor.";
  }
  return { text: `${text}`, tools: trace, offline: true };
}
