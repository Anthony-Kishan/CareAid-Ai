// KB-FIRST router. Tier 2 (WebGPU WebLLM) was removed — too heavy for the rural low-end
// Android devices we target. The single offline model tier is now Tier 1 (Transformers.js,
// SmolLM2 / small Qwen on WASM-CPU).
//
// Strategy:
//   1. If online and cloud is allowed, use Groq — best quality, fast.
//   2. Otherwise: prefer the local LLM (Tier 1) when loaded. The KB provides grounding (RAG).
//   3. If no local LLM: answer directly from the curated decision tree (sub-10ms, vetted).
//   4. Last resort: best-effort tree answer + apology.

import { getTfSettings, getTfState, chatTf, type TfChatMessage } from "./transformersEngine.ts";
import { retrieveWithScore, snippetForPrompt } from "./rag.ts";
import { answerFromTree } from "./decisionTree.ts";
import { classifySymptoms, buildSafetyPromptHint } from "./safety.ts";

export type ChatSource = "cloud" | "kb" | "wasm" | "rules";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatResult {
  text: string;
  source: ChatSource;
  safety?: { verdict: string; matched: string[] };
  ragHits?: string[];
  kbScore?: number;
}

interface ChatOptions {
  onChunk?: (chunk: string, full: string, source: ChatSource) => void;
  lang: "en" | "bn";
}

// BM25 score threshold above which we trust the KB to answer directly. Tuned for 42 entries +
// short patient inputs. Numbers below this go to the LLM (if available) for free-form handling.
const KB_CONFIDENCE_THRESHOLD = 1.5;

function pickLang(text: string, current: "en" | "bn"): "en" | "bn" {
  if (/[ঀ-৿]/.test(text)) return "bn";
  return /^[\x00-\x7F]+$/.test(text) ? "en" : current;
}

function buildSystemFromRag(snippet: string, lang: "en" | "bn"): string {
  const base = `You are CareAid AI, a calm Bangla/English health-TRIAGE nurse for rural Bangladesh.
You are NOT a doctor and you do NOT diagnose diseases. Your job is to assess URGENCY and recommend
an ACTION. Follow BMDC and DGHS Telemedicine Guideline 2020 rules:
1. Reply ONLY in ${lang === "bn" ? "Bangla" : "English"}.
2. NEVER name prescription-only medicines (antibiotics, steroids, anti-hypertensives, opioids).
3. For RED-FLAG symptoms (chest pain, breathing trouble, unconsciousness, severe bleeding, infant
   fever, pregnancy bleeding, stroke signs) ask ONE focused question, then issue **GO TO HOSPITAL
   NOW** / **এখনই হাসপাতালে যান** and remind them to call 999.
4. DON'T name a disease unless the description is unambiguous. When unsure, say "this could be a few
   things" and focus on what to DO and how urgent it is. Better to be honestly uncertain than
   confidently wrong.
5. ACCEPT CORRECTIONS: if the patient says you're wrong or corrects you, immediately drop your
   previous guess and re-assess from their new words. Never repeat a rejected assessment.
6. Mention OTC supports (ORS, paracetamol) only for mild cases, paired with "verify dose with a
   licensed doctor".
7. PEDIATRIC: For DIARRHEA or VOMITING in CHILDREN UNDER 5, always recommend ORS (খাবার
   স্যালাইন) + continued breastfeeding (under-6-month). Do NOT recommend plain water alone —
   it worsens electrolyte loss. WHO IMCI standard.
8. End with: "⚠️ This is AI guidance only. Please consult a real doctor when possible." /
   "⚠️ এটি শুধু AI পরামর্শ। সম্ভব হলে একজন ডাক্তার দেখান।"
9. Keep replies under 120 words. Warm, brief.`;
  return snippet ? `${base}\n\n${snippet}` : base;
}

export async function chat(
  history: ChatTurn[],
  userMessage: string,
  opts: ChatOptions
): Promise<ChatResult> {
  const lang = pickLang(userMessage, opts.lang);
  const safety = classifySymptoms(userMessage);

  const settings = getTfSettings();
  const online = typeof navigator !== "undefined" ? navigator.onLine : true;
  const tf = getTfState();
  const hasLocalLLM = tf.status === "ready";

  // Always run RAG so KB snippets are available as grounding for whichever tier answers.
  const scored = await retrieveWithScore(userMessage, 3);
  const topScore = scored[0]?.score ?? 0;
  const ragIds = scored.map((s) => s.entry.id);
  const ragSnippet = snippetForPrompt(scored.map((s) => s.entry), lang);

  // ── Cloud (online preferred) ─────────────────────────────────────────────
  if (online) {
    try {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMessage, history }),
      });
      if (res.ok) {
        const data = await res.json();
        opts.onChunk?.(data.text, data.text, "cloud");
        return { text: data.text, source: "cloud", safety: data.safety };
      }
    } catch (e) {
      console.warn("[router] cloud failed, falling back to offline tiers", e);
    }
  }

  // ── Offline preference: if a local LLM is loaded, prefer it over the KB. ──
  // The user explicitly asked for this: when they're offline the downloaded LLM should answer
  // free-form, with the KB as grounding (RAG). KB-direct is only used when no local LLM is
  // available (or as a last-resort low-confidence fallback below).
  if (!hasLocalLLM && topScore >= KB_CONFIDENCE_THRESHOLD) {
    const isFirstTurn = history.filter((m) => m.role === "user").length === 0;
    const tree = await answerFromTree(userMessage, lang, { isFirstTurn });
    opts.onChunk?.(tree.text, tree.text, "kb");
    return {
      text: tree.text,
      source: "kb",
      safety: { verdict: safety.verdict, matched: safety.matched },
      ragHits: tree.matchedEntryIds,
      kbScore: topScore,
    };
  }

  if (tf.status === "ready") {
    try {
      const sys = buildSystemFromRag(ragSnippet, lang);
      const safetyHint = buildSafetyPromptHint(safety);
      const seed: TfChatMessage[] = [{ role: "system", content: sys }];
      if (safetyHint) seed.push({ role: "system", content: safetyHint });
      for (const m of history) seed.push({ role: m.role, content: m.content });
      seed.push({ role: "user", content: userMessage });
      const text = await chatTf(seed, (chunk, full) => opts.onChunk?.(chunk, full, "wasm"));
      return {
        text,
        source: "wasm",
        safety: { verdict: safety.verdict, matched: safety.matched },
        ragHits: ragIds,
        kbScore: topScore,
      };
    } catch (e) {
      console.warn("[router] transformers.js failed, falling back", e);
    }
  }

  // ── Last resort: best-effort KB answer even at low confidence + apology ─
  const isFirstTurn = history.filter((m) => m.role === "user").length === 0;
  const tree = await answerFromTree(userMessage, lang, { isFirstTurn });
  opts.onChunk?.(tree.text, tree.text, "rules");
  return {
    text: tree.text,
    source: "rules",
    safety: { verdict: safety.verdict, matched: safety.matched },
    ragHits: tree.matchedEntryIds,
    kbScore: topScore,
  };
}
