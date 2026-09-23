// Keyword / TF-IDF retrieval over local manual text. No vector DB.
import fs from "fs";
import path from "path";

type Chunk = { doc: string; title: string; text: string; tf: Map<string, number> };
const STOP = new Set("the a an and or of to in on for is are be with at by if it as from before this that must any all not".split(" "));
const tokenize = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));

let index: { chunks: Chunk[]; idf: Map<string, number> } | null = null;

function build() {
  const dir = path.join(process.cwd(), "data", "manuals");
  const chunks: Chunk[] = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".md") || f.endsWith(".txt"))) {
    const raw = fs.readFileSync(path.join(dir, f), "utf8").replace(/^﻿/, "");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const title = (lines[0] ?? f).replace(/^#\s*/, "");
    for (const line of lines.slice(1)) {
      const tf = new Map<string, number>();
      for (const w of tokenize(`${title} ${line}`)) tf.set(w, (tf.get(w) ?? 0) + 1);
      chunks.push({ doc: f, title, text: line.trim(), tf });
    }
  }
  const df = new Map<string, number>();
  for (const c of chunks) for (const w of c.tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  const idf = new Map([...df].map(([w, n]) => [w, Math.log(1 + chunks.length / n)]));
  index = { chunks, idf };
}

export function searchKb(query: string, k = 4) {
  if (!index) build();
  const q = tokenize(query);
  return index!.chunks
    .map((c) => ({ c, score: q.reduce((s, w) => s + (c.tf.get(w) ?? 0) * (index!.idf.get(w) ?? 0), 0) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ c, score }) => ({ source: c.title, text: c.text, score: Math.round(score * 100) / 100 }));
}
