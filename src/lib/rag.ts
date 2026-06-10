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

// ── Negation-aware query preprocessor ───────────────────────────────────────
// BM25 has no understanding of negation. If the patient says "স্বাভাবিকভাবে শ্বাস নিচ্ছে"
// (breathing normally), the token "শ্বাস" still matches the `breathing-difficulty` KB entry —
// the OPPOSITE of what was reported. To stop the panel rendering "Sudden breathing difficulty"
// for a normally-breathing baby, we split the query into clauses and drop any clause that
// describes a NORMAL state or contains a negation marker. Applied only on QUERIES, never on
// the KB docs (those are positive descriptions and should keep their full token coverage).
//
// Patterns are conservative — only unambiguous normalcy/negation phrases. A clause like
// "ভালো আছে" (is good) is stripped; "ভালো না" (not good) survives because it's a real
// abnormal finding. The split-on-punctuation strategy means a sentence with mixed clauses
// like "জ্বর আছে, কিন্তু শ্বাস স্বাভাবিক" correctly keeps "জ্বর আছে" while dropping the
// normalcy half.
const NORMALCY_PATTERNS: RegExp[] = [
  // Bangla normalcy + negation
  /স্বাভাবিকভাবে/,
  /স্বাভাবিক\s+আছে/,
  /স্বাভাবিক\s+রয়েছে/,
  /ভালো\s+আছে/,
  /ভালো\s+রয়েছে/,
  /ভালো\s+বোধ/,
  /ভালোভাবে/,
  /ঠিক\s+আছে/,
  /সুস্থ\s+আছে/,
  /সুস্থ\s+রয়েছে/,
  /জাগ্রত\s+আছে/,
  /জাগ্রত\s+রয়েছে/,
  /সচেতন\s+আছে/,
  // Bangla negation particles — when present, the clause is reporting absence
  /\sনেই(\s|$)/,
  /\sনাই(\s|$)/,
  /\sনয়(\s|$)/,
  /^নেই(\s|$)/,
  // English normalcy + negation
  /\bnormal(ly)?\b/i,
  /\bfine\b/i,
  /\bokay\b/i,
  /\bok\b/i,
  /\bwithout\b/i,
  /\bfeels?\s+(fine|good|okay|normal|well)\b/i,
  /\bno\s+(fever|pain|breath|breathing|symptom|cough|rash|bleeding|vomit|diarr?h?ea|chest|headache)/i,
  /\bnot\s+(having|feeling|with|in|the|a)\b/i,
];

export function stripNormalcyClauses(query: string): string {
  if (!query) return query;
  // Split on Bangla full stop, English period, comma, semicolon — the clause boundaries that
  // typically separate independent symptom statements. Also split on Bangla conjunctions that
  // join contrasting clauses (এবং / কিন্তু / তবে) so "জ্বর আছে এবং স্বাভাবিকভাবে শ্বাস নিচ্ছে"
  // gets split correctly.
  const clauses = query
    .split(/[।.,;]|\s(?:কিন্তু|তবে|এবং|but|however)\s/g)
    .map((c) => c.trim())
    .filter(Boolean);
  const kept = clauses.filter((c) => !NORMALCY_PATTERNS.some((p) => p.test(c)));
  // If we stripped everything, the query was pure normalcy — return empty so BM25 returns no
  // hits and the caller can abstain. Otherwise rejoin the kept clauses.
  return kept.join(", ");
}

// ── Implicit-symptom enrichment ─────────────────────────────────────────────
// Patients in rural BD often describe a temperature reading ("১০২ ডিগ্রী") or an age
// ("৮ মাস বয়সী") without the word "fever" or "শিশু". BM25 then doesn't hit fever-* or
// pediatric-* KB entries even though the case clearly is one. This enrichment derives the
// implicit clinical token from numbers + units in the query and appends them to the BM25
// input. We append (not replace) so explicit symptom mentions are preserved. Critically, the
// derived tokens are SYMPTOM facts (fever, infant) — never disease names, so we don't bias
// the diagnosis.
const BANGLA_DIGITS = "০১২৩৪৫৬৭৮৯";
function normalizeNumerals(s: string): string {
  return s.replace(/[০-৯]/g, (c) => BANGLA_DIGITS.indexOf(c).toString());
}
export function deriveImplicitSymptoms(query: string): string {
  if (!query) return "";
  const normalized = normalizeNumerals(query);
  const extra: string[] = [];
  // High temperature — Fahrenheit ≥100 or Celsius ≥38 → inject "fever" tokens so BM25 hits
  // fever-related entries even when the user only stated a number.
  const fahrMatch = normalized.match(/\b(1[0-1]\d|99)\s*(°|degree|ডিগ্রী|ডিগ্রি|fahrenheit|ফারেনহাইট|f\b)/i);
  const celMatch = normalized.match(/\b(3[89]|4[01])\s*(°c|celsius|সেলসিয়াস|c\b)/i);
  if (fahrMatch || celMatch) {
    extra.push("জ্বর", "fever", "high fever", "উচ্চ জ্বর", "তাপমাত্রা", "temperature");
  }
  // Pediatric age detection — months ≤24 OR years ≤5 OR explicit baby/infant word.
  const monthMatch = normalized.match(/\b(\d{1,2})\s*(মাস|month)/i);
  const yearMatch = normalized.match(/\b(\d{1,2})\s*(বছর|year)/i);
  const infantWord = /\b(শিশু|বাচ্চা|নবজাতক|baby|infant|toddler|newborn)\b/i.test(query);
  const isInfantMonths = monthMatch && parseInt(monthMatch[1]) > 0 && parseInt(monthMatch[1]) <= 24;
  const isChildYears = yearMatch && parseInt(yearMatch[1]) > 0 && parseInt(yearMatch[1]) <= 5;
  if (isInfantMonths || isChildYears || infantWord) {
    extra.push("শিশু", "বাচ্চা", "child", "infant", "pediatric");
    // If both pediatric AND fever signals are present, also seed the explicit IMCI emergency
    // phrase "infant fever" — this lights up `fever-infant` (critical) in the KB and aligns
    // with the safety classifier's `infant fever` / `শিশু জ্বর` pediatric pattern.
    if (fahrMatch || celMatch) extra.push("infant fever", "শিশু জ্বর", "বাচ্চার জ্বর");
  }
  return extra.length ? " " + extra.join(" ") : "";
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
  const hits = cachedIndex.search(stripNormalcyClauses(query) + deriveImplicitSymptoms(query), top);
  const byId = new Map(kb.entries.map((e) => [e.id, e]));
  return hits.map((h) => byId.get(h.id)!).filter(Boolean);
}

// Same as `retrieve` but also returns the BM25 score so the caller can threshold confidence.
export async function retrieveWithScore(query: string, top = 3): Promise<{ entry: KbEntry; score: number }[]> {
  const kb = await loadKb();
  if (!cachedIndex) cachedIndex = buildIndex(kb);
  const hits = cachedIndex.search(stripNormalcyClauses(query) + deriveImplicitSymptoms(query), top);
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
