// In-browser RAG over the embedded medical knowledge base.
// No external embedding model — uses a simple BM25-style scorer over a bilingual tokenizer.
// Good enough for ~50 entries; rebuild the index on first use and cache in memory.

export interface KbEntry {
  id: string;
  tags_en: string[];
  tags_bn: string[];
  severity: "mild" | "urgent" | "critical";
  title: { en: string; bn: string };
  summary: { en: string; bn: string };
  advice: { en: string; bn: string };
  seeDoctor: { en: string; bn: string };
}

export interface KbDocument {
  version: number;
  updatedAt: string;
  source: string;
  entries: KbEntry[];
}

let cached: KbDocument | null = null;
let cachedIndex: BM25Index | null = null;

export async function loadKb(): Promise<KbDocument> {
  if (cached) return cached;
  const res = await fetch("/medical-kb.json", { cache: "force-cache" });
  if (!res.ok) throw new Error("KB unreachable");
  cached = (await res.json()) as KbDocument;
  return cached;
}

// ── Tokenizer ──────────────────────────────────────────────────────────────
// Handles EN + BN. Lower-cases ASCII, strips ASCII punctuation, splits on whitespace.
// For Bangla we just split on whitespace — Bangla doesn't need lower-casing.
//
// We filter STOPWORDS (pronouns, question words, conjunctions, modal/auxiliary verbs) before
// scoring. Without this filter, an off-topic patient follow-up like "হাসপাতালে যাওয়ার আগে আমি
// আর কী করতে পারি?" (= "what can I do before going to hospital?") was matching `heat-cramps`
// with score 7.04 because the connective "আর" happened to appear in only one KB entry, giving
// it artificially high IDF. Stopwords carry no symptom signal but can dominate BM25 when their
// document frequency is low. The list is intentionally conservative — no medical terms.
const STOPWORDS = new Set<string>([
  // English pronouns / aux verbs / modals
  "me", "my", "mine", "we", "us", "our",
  "you", "your", "yours", "he", "she", "him", "her", "it", "its", "they", "them", "their",
  "is", "am", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "done", "doing",
  "have", "has", "had", "having",
  "can", "could", "should", "would", "will", "shall", "may", "might", "must",
  "what", "why", "how", "where", "when", "who", "which", "whose",
  "and", "or", "but", "so", "if", "because", "than", "then",
  "the", "an", "this", "that", "these", "those",
  "with", "from", "into", "onto", "by", "for", "of", "on", "at", "in", "to", "as",
  "also", "just", "very", "more", "much", "many", "some", "any", "no", "not",
  "before", "after", "now", "still",
  // Bangla pronouns
  "আমি", "আমার", "আমাকে", "আমরা", "আমাদের", "আপনি", "আপনার", "আপনাকে",
  "সে", "তার", "তাকে", "তারা", "তাদের", "এ", "এই", "ওই", "সেই", "ইনি", "উনি",
  // Bangla question words
  "কী", "কি", "কেন", "কীভাবে", "কোথায়", "কখন", "কে", "কারা", "কোন", "কত", "কতটা", "কেমন",
  // Bangla conjunctions / particles
  "আর", "এবং", "অথবা", "কিন্তু", "তবে", "কারণ", "যে", "যা", "যদি", "তাহলে", "তো", "ই",
  // Bangla modal / auxiliary verbs (common forms)
  "করতে", "করব", "করছি", "করেছি", "করেছেন", "করুন", "পারি", "পারে", "পারছি", "পারব", "পারবে",
  "হবে", "হয়", "হচ্ছে", "হয়েছে", "ছিল", "ছিলাম", "থাকবে", "থাকে", "থাকি", "ছিলেন",
  "যাওয়া", "যাওয়ার", "যাচ্ছি", "যাবে", "যাব", "যান",
  "আছি", "আছে", "আছেন", "নেই",
  // Bangla time/position words
  "আগে", "পরে", "এখন", "তখন", "প্রথম", "পর", "শুরু",
  // Bangla quantifiers / qualifiers
  "একটু", "অনেক", "সব", "সবাই", "শুধু", "মাত্র", "প্রায়", "বেশ", "খুব",
  // Bangla connectives
  "জন্য", "সাথে", "থেকে", "পর্যন্ত", "মতো", "মতন",
]);

export function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[.,;:!?()"'`\-_/\\]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

// ── BM25 index ─────────────────────────────────────────────────────────────
interface BM25Doc {
  id: string;
  text: string;
  tokens: string[];
  termFreq: Map<string, number>;
  length: number;
}

class BM25Index {
  docs: BM25Doc[] = [];
  docFreq: Map<string, number> = new Map();
  avgLen = 0;
  k1 = 1.5;
  b = 0.75;

  constructor(docs: { id: string; text: string }[]) {
    for (const d of docs) this.add(d);
    this.avgLen = this.docs.reduce((a, x) => a + x.length, 0) / Math.max(1, this.docs.length);
  }

  add(d: { id: string; text: string }) {
    const tokens = tokenize(d.text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    const seen = new Set(tokens);
    for (const t of seen) this.docFreq.set(t, (this.docFreq.get(t) || 0) + 1);
    this.docs.push({ id: d.id, text: d.text, tokens, termFreq: tf, length: tokens.length });
  }

  search(query: string, top = 3): { id: string; score: number }[] {
    const qTokens = tokenize(query);
    if (qTokens.length === 0) return [];
    const N = this.docs.length;
    const scores: { id: string; score: number }[] = [];
    for (const doc of this.docs) {
      let s = 0;
      for (const q of qTokens) {
        const df = this.docFreq.get(q) || 0;
        if (df === 0) continue;
        const tf = doc.termFreq.get(q) || 0;
        if (tf === 0) continue;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        const norm = tf * (this.k1 + 1);
        const denom = tf + this.k1 * (1 - this.b + this.b * (doc.length / Math.max(1, this.avgLen)));
        s += idf * (norm / denom);
      }
      if (s > 0) scores.push({ id: doc.id, score: s });
    }
    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, top);
  }
}

function buildIndex(kb: KbDocument): BM25Index {
  const docs = kb.entries.map((e) => ({
    id: e.id,
    text: [
      e.title.en,
      e.title.bn,
      e.summary.en,
      e.summary.bn,
      e.advice.en,
      e.advice.bn,
      e.seeDoctor.en,
      e.seeDoctor.bn,
      ...e.tags_en,
      ...e.tags_bn,
    ].join(" "),
  }));
  return new BM25Index(docs);
}

export async function retrieve(query: string, top = 3): Promise<KbEntry[]> {
  const kb = await loadKb();
  if (!cachedIndex) cachedIndex = buildIndex(kb);
  const hits = cachedIndex.search(query, top);
  const byId = new Map(kb.entries.map((e) => [e.id, e]));
  return hits.map((h) => byId.get(h.id)!).filter(Boolean);
}

// Same as `retrieve` but also returns the BM25 score so the caller can threshold confidence.
export async function retrieveWithScore(query: string, top = 3): Promise<{ entry: KbEntry; score: number }[]> {
  const kb = await loadKb();
  if (!cachedIndex) cachedIndex = buildIndex(kb);
  const hits = cachedIndex.search(query, top);
  const byId = new Map(kb.entries.map((e) => [e.id, e]));
  return hits
    .map((h) => ({ entry: byId.get(h.id)!, score: h.score }))
    .filter((x) => x.entry);
}

// Build a compact retrieval snippet to inject into an LLM prompt.
export function snippetForPrompt(entries: KbEntry[], lang: "en" | "bn"): string {
  if (entries.length === 0) return "";
  const blocks = entries.map((e, i) => {
    const t = e.title[lang];
    const s = e.summary[lang];
    const a = e.advice[lang];
    const d = e.seeDoctor[lang];
    return `[${i + 1}] ${t} (severity: ${e.severity})\nSummary: ${s}\nAdvice: ${a}\nWhen to see a doctor: ${d}`;
  });
  return `RELEVANT MEDICAL KB ENTRIES (use these facts; do not invent dosages or numbers):\n${blocks.join("\n\n")}`;
}
