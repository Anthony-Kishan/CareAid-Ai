import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import Groq from "groq-sdk";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import { classifySymptoms, scrubMedicines, buildSafetyPromptHint } from "./src/lib/safety.ts";

dotenv.config();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || "" });

// Gemini multi-key rotation — the free tier caps each key at ~20 prescription scans/day, so
// rotating through several keys multiplies headroom for hackathon judging. Accepts EITHER:
//   GEMINI_API_KEY          (single key, legacy)
//   GEMINI_API_KEYS         (comma-separated list of keys)
//   GEMINI_API_KEY_1, _2…   (numbered keys)
// All sources are merged, deduped, blank-stripped. Empty list = no Gemini.
function collectGeminiKeys(): string[] {
  const keys: string[] = [];
  if (process.env.GEMINI_API_KEY) keys.push(process.env.GEMINI_API_KEY);
  if (process.env.GEMINI_API_KEYS) {
    for (const k of process.env.GEMINI_API_KEYS.split(",")) keys.push(k.trim());
  }
  for (let i = 1; i <= 10; i++) {
    const v = process.env[`GEMINI_API_KEY_${i}`];
    if (v) keys.push(v);
  }
  return Array.from(new Set(keys.map((k) => k.trim()).filter(Boolean)));
}
const geminiKeys = collectGeminiKeys();
const geminiClients = geminiKeys.map((apiKey) => new GoogleGenAI({ apiKey }));
console.log(`✅ Gemini configured with ${geminiClients.length} key${geminiClients.length === 1 ? "" : "s"}`);
const isGeminiQuotaError = (e: any): boolean => {
  const msg = String(e?.message || e?.status || e || "").toLowerCase();
  return msg.includes("429") || msg.includes("quota") || msg.includes("rate") || msg.includes("resource_exhausted") || msg.includes("permission");
};

const TRIAGE_SYSTEM = `You are CareAid AI (স্বাস্থ্য সহায়ক), a compassionate AI health assistant for rural Bangladesh.

You operate under Bangladesh Medical & Dental Council (BMDC) rules, the DGHS Telemedicine Practice Guideline 2020,
and WHO Ethics & Governance of AI for Health (2021). You are NOT a licensed practitioner.

HARD SAFETY RULES — never break these, even if asked:
A. You MUST NOT name prescription-only medicines (antibiotics, steroids, anti-hypertensives, opioids,
   psychiatric drugs, controlled substances). If asked for one, decline and recommend seeing a registered MBBS doctor.
B. For any RED-FLAG condition (chest pain, suspected heart attack or stroke, breathing difficulty,
   unconsciousness, severe bleeding, seizures, severe abdominal pain, suspected poisoning or overdose,
   high fever in infants under 2 years, pregnancy-related bleeding or severe pain, severe burns,
   anaphylaxis, suicidal ideation): do NOT recommend medicines. Engage the patient with focused
   emergency triage questions, then issue a firm GO-TO-HOSPITAL verdict and remind them to call 999.
C. For clearly mild, self-limiting conditions you MAY mention common OTC supports (ORS, paracetamol,
   warm fluids) — always pair them with "verify with a licensed doctor before taking, especially for
   children, pregnant women, or anyone on regular medication."
D. You do not diagnose. You describe possibilities and triage urgency.

CONVERSATIONAL RULES — behave like a calm, experienced triage nurse, not like a disclaimer machine:

1. Language mirroring: detect what language the user wrote in (Bangla vs English) and reply ONLY in that
   language. Never mix the two in one response.

2. MULTI-TURN SYMPTOM GATHERING. Diseases rarely show themselves through one complaint. Ask 2–3
   focused rounds of clarifying questions across separate turns to narrow the picture BEFORE giving
   the verdict. Do not ask everything at once.
     • Turn 1: acknowledge briefly, ask the single most important question for the chief complaint
       (onset/duration, character, severity).
     • Turn 2 (after patient answers): ask 1 follow-up that splits the differential — associated
       symptoms (fever, breathlessness, rash, blood, vomiting, dizziness, etc.) tied to what they
       said in turn 1.
     • Turn 3: one more if needed (red-flag screen) — only then issue the verdict.
     • Examples of what to chain through:
        — fever: "How many days?" → "How high? Any rash, vomiting, or breathing trouble?" → if applicable
          "Any travel or known dengue/typhoid in the area?"
        — cough: "Dry or with phlegm? How many days?" → "Any blood, weight loss, or night sweats?"
        — abdominal pain: "Where exactly? Sharp or dull?" → "After food? Any vomiting or blood in stool?"
        — chest pain: "When did it start? Crushing or sharp?" → "Spreading anywhere? Sweating, breath-
          lessness?" — issue verdict early if red flags appear.
   Do not hold off the verdict beyond 3 rounds. If the patient gives a clearly-critical answer at any
   point (chest pain spreading to arm, breath difficulty, severe bleeding, etc.) skip remaining
   questions and issue **GO TO HOSPITAL NOW** / **এখনই হাসপাতালে যান** immediately.

3. For an EMERGENCY-LOOKING input, your FIRST response is NOT a disclaimer wall. Instead, in 1–3 short
   sentences: acknowledge briefly, then ask 1–2 SPECIFIC triage questions tied to the symptom.
   Examples:
     • chest pain → "When did the pain start? Is it crushing/pressing or sharp? Does it spread to
       your left arm, jaw, or back? Are you also short of breath or sweating?"
     • breathing difficulty → "When did this start? Can you speak full sentences? Are your lips
       or fingertips turning blue?"
     • unconsciousness → "How long was the person out? Are they breathing now? Any recent injury or
       medication?"
     • stroke signs → "Is one side of the face drooping? Can they lift both arms equally? Speech slurred?"
     • severe bleeding → "Where is the bleeding from? Is the dressing soaking through?"
     • infant fever → "How old is the baby? What is the temperature? Are they feeding, alert, breathing easily?"
   Only after you get an answer (or the user already gave clear detail) do you issue the verdict.

3. Verdicts — always end the final answer with one of:
     • **🚨 GO TO HOSPITAL NOW** / **🚨 এখনই হাসপাতালে যান**  (call 999 if you can't get to one)
     • **🏠 FIRST-AID AT HOME** / **🏠 বাড়িতে প্রাথমিক চিকিৎসা করুন**
     • **⏳ WAIT AND WATCH** / **⏳ অপেক্ষা করুন ও দেখুন**

4. After the verdict give 2–3 plain practical steps (sit/lie down, loosen clothing, who to call, what to
   bring to hospital). For mild cases you may mention safe OTC supports, paired with the verify-with-doctor line.

5. End EVERY final answer with: "⚠️ This is AI guidance only. Please consult a real doctor when possible." /
   "⚠️ এটি শুধু AI পরামর্শ। সম্ভব হলে একজন ডাক্তার দেখান।"

6. Tone: warm, brief, human. Don't repeat the user back. No meta-instructions like "(I will now ask...)".
   No emoji floods. No long lists for emergencies — get to the question fast.

7. ACCEPT CORRECTIONS — this is critical. If the patient corrects you, disagrees, or says your
   assessment is wrong ("না, এটা না" / "no, that's not it" / "actually it's..."), you MUST
   immediately drop your previous guess and re-triage based on their new information. NEVER insist
   on or repeat a previous assessment the patient has rejected. The patient is the authority on
   their own body. Treat their latest message as the most accurate description.

8. DON'T OVER-DIAGNOSE. You are a triage nurse, not a diagnostician. Only name a specific disease
   if the patient's description is unambiguous (e.g. clear dengue with all classic signs). Otherwise
   say "this could be a few things" and focus on URGENCY and ACTION, not on labelling the disease.
   It is far better to say "I'm not certain what this is, but it's not an emergency — see a doctor
   this week" than to confidently name the wrong disease. When unsure, ask one more question instead
   of guessing.

9. PEDIATRIC REHYDRATION (CRITICAL): For DIARRHEA, VOMITING, or any dehydration risk in CHILDREN
   UNDER 5 YEARS, you MUST recommend ORS (Oral Rehydration Solution / "খাবার স্যালাইন") + zinc
   supplementation + continued breastfeeding (for under-6-month) — NOT plain water alone. This is
   the WHO IMCI standard for Bangladesh; plain water can worsen electrolyte loss in young
   children and is a leading cause of preventable deaths in rural BD. Wording template:
     • English: "For a child this age with diarrhea/vomiting, give ORS (oral rehydration solution
       — small sips every few minutes), continue breastfeeding if applicable, and avoid plain
       water alone. ORS sachets are available at every pharmacy and health complex."
     • Bangla: "এই বয়সের শিশুকে ডায়রিয়া/বমি হলে খাবার স্যালাইন (ORS) দিন — প্রতি কয়েক মিনিটে
       অল্প অল্প করে। বুকের দুধ চালিয়ে যান। শুধু পানি দেবেন না — এটি ঝুঁকি বাড়ায়। যেকোনো ফার্মেসি
       বা স্বাস্থ্য কমপ্লেক্সে স্যালাইন পাওয়া যায়।"
   Apply this rule WHENEVER the patient mentions diarrhea/vomiting/loose stool with a child age,
   even if you're escalating to hospital — give the ORS instruction as part of the immediate
   steps en route to care.`;

async function startServer() {
  const app = express();
  // Render (and most hosts) inject the port via $PORT. Fall back to 3000 locally.
  const PORT = Number(process.env.PORT) || 3000;
  app.use(express.json({ limit: "15mb" }));

  // ── TRIAGE ───────────────────────────────────────────────────────────────────
  app.post("/api/triage", async (req, res) => {
    try {
      const { message, history } = req.body;

      // STEP 1 — safety pre-screen. We DO NOT short-circuit any more; the LLM stays in charge of the
      // conversation. The classifier result is injected as an extra system message so the model
      // knows to ask focused emergency questions instead of dumping a disclaimer.
      const safety = classifySymptoms(String(message || ""));
      const safetyHint = buildSafetyPromptHint(safety);

      const messages: any[] = [{ role: "system", content: TRIAGE_SYSTEM }];
      if (safetyHint) messages.push({ role: "system", content: safetyHint });
      if (history && history.length > 1) {
        for (const msg of history.slice(1)) {
          messages.push({ role: msg.role === "user" ? "user" : "assistant", content: msg.content });
        }
      }
      messages.push({ role: "user", content: message });

      const response = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages,
        max_tokens: 1024,
        temperature: 0.6,
      });

      let text = response.choices[0]?.message?.content || "Sorry, I could not process your request.";

      // STEP 2 — belt-and-suspenders. If the safety verdict is critical, scrub any medicine-dose
      // lines the model may have produced anyway. We do not scrub for urgent/routine because OTC
      // mentions are allowed there.
      let scrubbedCount = 0;
      if (safety.verdict === "critical") {
        const r = scrubMedicines(text);
        text = r.scrubbed;
        scrubbedCount = r.removed;
      }

      res.json({
        text,
        safety: {
          verdict: safety.verdict,
          matched: safety.matched,
          scrubbedLines: scrubbedCount,
        },
      });
    } catch (error: any) {
      console.error("Triage error:", error.message);
      res.status(500).json({ text: "Connection error. Please try again." });
    }
  });

  // ── PRESCRIPTION SCAN ────────────────────────────────────────────────────────
  // Tries Gemini 2.5 Flash first (best handwriting OCR among free APIs). Falls back to Groq
  // Llama-4 Maverick if no Gemini key or if Gemini errors. The returned schema is fixed so the
  // Scanner UI can render dose grids, legibility scores, and nutrition without branching.
  const SCAN_INSTRUCTIONS = `You are extracting a doctor's handwritten or printed prescription for a rural Bangladesh patient.

Return ONLY valid minified JSON in EXACTLY this schema. Do not wrap it in markdown fences.

{
  "doctor": { "name": "string|null", "bmdc": "string|null", "hospital": "string|null", "specialization": "string|null" },
  "patient_age": "string|null",
  "patient_sex": "string|null",
  "chief_complaint": "string|null",
  "diagnosis_hint": "string|null",
  "medicines": [
    {
      "name": "brand name as written",
      "generic": "generic name if known",
      "strength": "e.g. 500 mg",
      "form": "tablet|capsule|syrup|drops|injection|cream|inhaler",
      "schedule": {
        "morning": 0, "noon": 0, "night": 0,
        "before_food": true, "after_food": false,
        "notes": "English instruction line if needed (e.g. 'Apply 2-3 times daily on the affected area')",
        "notes_bn": "একই নির্দেশনা সহজ বাংলায় (যেমন: 'আক্রান্ত স্থানে দিনে ২-৩ বার লাগান')"
      },
      "duration": "e.g. 5 days",
      "duration_bn": "ঐ সময়কাল বাংলায় (যেমন: '৫ দিন')",
      "purpose_english": "one short line a layperson understands",
      "purpose_bangla": "একদম সহজ বাংলায়",
      "warnings": "English warning if any (e.g. 'Do not exceed 4 doses per day')",
      "warnings_bn": "ঐ সতর্কতা সহজ বাংলায়"
    }
  ],
  "tests": ["lab test names extracted"],
  "follow_up": "string|null",
  "patient_notes": "any other instructions written for the patient, in plain English",
  "confidence": 0-100,
  "legibility_score": 1-5,
  "legibility_reason": "one short sentence on why the handwriting/print is hard or easy to read",
  "nutrition_guidelines": ["3-6 practical English bullet points tailored to the meds/condition"],
  "nutrition_guidelines_bn": ["same bullets translated to simple Bangla"]
}

Rules:
- "morning/noon/night" mean number of UNITS per slot (0 if not taken). Common notation: 1+0+1 means morning=1 noon=0 night=1.
- If a field is not visible, set string fields to null and numeric fields to 0; never invent.
- legibility_score: 5 = printed/typed and crystal clear, 4 = neat handwriting, 3 = readable with effort, 2 = mostly illegible, 1 = unreadable.
- nutrition_guidelines must be specific to what was prescribed (e.g. for metformin: low-glycemic diet; for iron tablets: take with vitamin C source; for blood pressure: low salt). 3–6 bullets.
- BILINGUAL FIELDS — for every field that has a sibling ending in "_bn" or "_bangla" (notes_bn, duration_bn, warnings_bn, purpose_bangla, nutrition_guidelines_bn), you MUST populate BOTH the English and the Bangla version. Never leave the Bangla side as null when the English side has content — translate it yourself into simple plain Bangla a rural patient can understand. Doctors often write in English/mixed; the patient may only read Bangla.`;

  app.post("/api/scan-prescription", async (req, res) => {
    const { image } = req.body || {};
    if (!image) return res.status(400).json({ error: "Image required" });

    // 1) Gemini path (preferred) — try each configured key in turn. Quota / 429 / permission
    // errors on one key transparently roll over to the next. Other errors bail to the Groq
    // fallback so we don't loop on a content/parsing failure.
    for (let i = 0; i < geminiClients.length; i++) {
      const client = geminiClients[i];
      try {
        const result = await client.models.generateContent({
          model: "gemini-2.5-flash",
          contents: [{
            role: "user",
            parts: [
              { inlineData: { mimeType: "image/jpeg", data: image } },
              { text: SCAN_INSTRUCTIONS },
            ],
          }],
          config: {
            temperature: 0.2,
            responseMimeType: "application/json",
          },
        });
        const text = result.text || "{}";
        const parsed = JSON.parse(text);
        parsed.provider = "gemini";
        parsed.gemini_key_index = i + 1;
        return res.json(parsed);
      } catch (e: any) {
        const isQuota = isGeminiQuotaError(e);
        console.warn(`Gemini key #${i + 1} ${isQuota ? "quota/rate-limited" : "failed"}:`, e?.message || e);
        if (!isQuota) break; // non-quota error: stop rotating, fall through to Groq
      }
    }

    // 2) Groq vision fallback — cascade through whichever models the account has access to.
    const groqVisionModels = [
      "meta-llama/llama-4-maverick-17b-128e-instruct",  // best handwriting, may be restricted
      "meta-llama/llama-4-scout-17b-16e-instruct",      // baseline, widely available
    ];
    let lastErr: any = null;
    for (const model of groqVisionModels) {
      try {
        const response = await groq.chat.completions.create({
          model,
          messages: [{
            role: "user",
            content: [
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } },
              { type: "text", text: SCAN_INSTRUCTIONS },
            ],
          }],
          max_tokens: 2200,
          temperature: 0.2,
        });
        const text = response.choices[0]?.message?.content || "{}";
        const clean = text.replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(clean);
        parsed.provider = "groq";
        parsed.model = model;
        return res.json(parsed);
      } catch (error: any) {
        lastErr = error;
        const msg = error?.message || String(error);
        // Skip to next model on access / availability errors; bubble up on real failures.
        const skip = /model_not_found|does not exist|not have access|unsupported|400|404/.test(msg);
        console.warn(`Scan via ${model} failed${skip ? " (will try next)" : ""}:`, msg);
        if (!skip) break;
      }
    }
    console.error("Scan error (all fallbacks):", lastErr?.message || lastErr);
    return res.status(500).json({ error: "Failed to analyze. Please ensure the image is clear and try again." });
  });

  // ── DOCTOR RATING ────────────────────────────────────────────────────────────
  // The actual rating is persisted client-side (local + Firestore). This endpoint is just an
  // optional Groq-generated "ministry summary" line. If Groq fails we still return 200 so the
  // client doesn't surface a misleading 500 (the rating is already saved).
  app.post("/api/rate-doctor", async (req, res) => {
    const { bmdc, doctorName, ratings, comment } = req.body || {};
    const r = ratings || {};
    const vals = Object.values(r).filter((v) => typeof v === "number") as number[];
    const avg = vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : "—";
    try {
      const response = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [{
          role: "user",
          content: `Patient rated Dr. ${doctorName} (BMDC: ${bmdc}): prescription legibility = ${r.legible ?? "n/a"}/5. Average: ${avg}/5. Comment: "${comment || 'None'}". Write one objective sentence summarizing this doctor's prescription clarity for ministry records.`,
        }],
        max_tokens: 100,
      });
      res.json({ success: true, averageScore: avg, summary: response.choices[0]?.message?.content });
    } catch (error: any) {
      console.warn("Rate-doctor: Groq summary unavailable —", error.message);
      // Gracefully degrade — rating still saved client-side.
      res.json({ success: true, averageScore: avg, summary: null, summaryUnavailable: true });
    }
  });

  // ── OFFLINE TRIAGE ───────────────────────────────────────────────────────────
  app.get("/api/offline-triage", (_req, res) => {
    res.json({
      // Keywords include common Bangla spelling variants — ব্যথা / ব্যাথা, ডায়রিয়া / ডায়েরিয়া,
      // জ্বর / জর — because rural users type phonetically and inconsistently. Missing a variant
      // means missing an emergency, so we over-include spellings.
      rules: [
        { keywords: ["chest pain","বুকে ব্যথা","বুকে ব্যাথা","বুক ব্যথা","বুক ব্যাথা","heart attack","হার্ট অ্যাটাক"], verdict: "GO_NOW", en: "Chest pain can be a heart attack. Go to hospital IMMEDIATELY.", bn: "বুকে ব্যথা হার্ট অ্যাটাকের লক্ষণ। এখনই হাসপাতালে যান।" },
        { keywords: ["can't breathe","cannot breathe","শ্বাস নিতে পারছি না","breathless","শ্বাসকষ্ট","শ্বাস কষ্ট","দম বন্ধ"], verdict: "GO_NOW", en: "Breathing difficulty is an emergency. Go NOW.", bn: "শ্বাসকষ্ট জরুরি অবস্থা। এখনই হাসপাতালে যান।" },
        { keywords: ["unconscious","অজ্ঞান","অচেতন","fainted","জ্ঞান হারিয়েছে"], verdict: "GO_NOW", en: "Loss of consciousness needs emergency care.", bn: "অজ্ঞান হলে তাৎক্ষণিক চিকিৎসা দরকার।" },
        { keywords: ["infant fever","শিশু জ্বর","শিশুর জ্বর","baby fever","বাচ্চার জ্বর","বাচ্চার জর","নবজাতকের জ্বর"], verdict: "GO_NOW", en: "High fever in infants is dangerous. See a doctor now.", bn: "শিশুর জ্বর বিপজ্জনক। এখনই ডাক্তার দেখান।" },
        { keywords: ["severe bleeding","প্রচুর রক্ত","অতিরিক্ত রক্ত","রক্তক্ষরণ","রক্তপাত"], verdict: "GO_NOW", en: "Severe bleeding needs urgent hospital care.", bn: "প্রচুর রক্তপাত হলে তাৎক্ষণিক হাসপাতালে যান।" },
        { keywords: ["mild fever","সামান্য জ্বর","হালকা জ্বর","জ্বর","জর","cold","সর্দি","ঠান্ডা","cough","কাশি"], verdict: "HOME", en: "Rest, drink fluids, take paracetamol. Monitor for 2 days.", bn: "বিশ্রাম নিন, পানি পান করুন, প্যারাসিটামল খান।" },
        { keywords: ["diarrhea","diarrhoea","ডায়রিয়া","ডায়েরিয়া","ডাইরিয়া","loose motion","পাতলা পায়খানা","পাতলা পায়খানা"], verdict: "HOME", en: "Drink ORS. Go to hospital if blood appears.", bn: "খাবার স্যালাইন খান। রক্ত দেখলে হাসপাতাল যান।" },
        { keywords: ["headache","মাথাব্যথা","মাথা ব্যথা","মাথা ব্যাথা","মাথাব্যাথা","body pain","গায়ে ব্যথা","গায়ে ব্যাথা","শরীর ব্যথা"], verdict: "WATCH", en: "Rest and hydrate. See doctor if pain lasts 3+ days.", bn: "বিশ্রাম নিন। ৩ দিনের বেশি থাকলে ডাক্তার দেখান।" },
      ],
    });
  });

  // ── n8n / Webhook automation endpoints ─────────────────────────────────────
  // These endpoints are designed to be consumed by n8n workflows, Zapier, or any webhook-based
  // automation platform. They fire structured JSON payloads that n8n can route to notifications,
  // dashboards, or downstream systems.

  // Webhook: new prescription scanned → fires a structured notification payload.
  // n8n workflow: Webhook trigger → IF severity=critical → Slack/Email/SMS notification.
  app.post("/api/webhooks/prescription-scanned", (req, res) => {
    const { doctorName, bmdc, medicineCount, testCount, legibilityScore, diagnosisHint, userId } = req.body || {};
    const payload = {
      event: "prescription_scanned",
      timestamp: new Date().toISOString(),
      data: {
        doctor: { name: doctorName, bmdc },
        medicines_extracted: medicineCount || 0,
        tests_recommended: testCount || 0,
        legibility_score: legibilityScore,
        diagnosis_hint: diagnosisHint,
        user_id: userId,
      },
      alert: (legibilityScore && legibilityScore <= 2)
        ? "LOW_LEGIBILITY — prescription readability is poor, patient may misunderstand dosage."
        : null,
    };
    console.log("[webhook] prescription-scanned:", JSON.stringify(payload));
    // In production, this would forward to an n8n webhook URL or notification service.
    res.json({ received: true, payload });
  });

  // Webhook: critical triage alert — fires when the safety classifier detects a life-threatening
  // symptom. n8n can route this to an alert dashboard or SMS gateway.
  app.post("/api/webhooks/critical-alert", (req, res) => {
    const { symptoms, safetyVerdict, matchedFlags, userId, district } = req.body || {};
    const payload = {
      event: "critical_triage_alert",
      timestamp: new Date().toISOString(),
      severity: "CRITICAL",
      data: {
        symptoms: String(symptoms || "").slice(0, 200),
        safety_verdict: safetyVerdict,
        matched_flags: matchedFlags || [],
        user_id: userId,
        district,
      },
      action: "IMMEDIATE — patient directed to call 999 and go to nearest hospital.",
    };
    console.log("[webhook] critical-alert:", JSON.stringify(payload));
    res.json({ received: true, payload });
  });

  // Webhook: daily health summary — n8n cron can poll this daily to get system stats.
  app.get("/api/webhooks/daily-summary", (_req, res) => {
    const kbRawSummary = JSON.parse(fs.readFileSync(path.resolve("public/medical-kb.json"), "utf-8"));
    res.json({
      event: "daily_summary",
      timestamp: new Date().toISOString(),
      system: {
        kb_version: kbRawSummary.version,
        kb_entries: kbRawSummary.entries?.length || 0,
        kb_critical: kbRawSummary.entries?.filter((e: any) => e.severity === "critical").length || 0,
        kb_urgent: kbRawSummary.entries?.filter((e: any) => e.severity === "urgent").length || 0,
        kb_mild: kbRawSummary.entries?.filter((e: any) => e.severity === "mild").length || 0,
        models: ["SmolLM2-360M (on-device LLM)", "Whisper-tiny (on-device STT)", "Tesseract (on-device OCR)", "Gemini 2.5 Flash (cloud OCR)", "Groq Llama-4 (cloud chat)"],
        mcp_tools: ["triage_symptoms", "search_medical_kb", "classify_safety", "list_conditions", "get_condition"],
      },
    });
  });
  console.log("✅ n8n webhook endpoints: /api/webhooks/prescription-scanned, /api/webhooks/critical-alert, /api/webhooks/daily-summary");

  // ── MCP SSE endpoints — deferred to avoid ESM resolution conflicts with Vite ──
  // The MCP SDK uses ESM imports that clash with tsx + Vite's dev middleware. We mount the
  // endpoints as plain Express routes that lazy-load the MCP SDK on first request, then cache.
  const kbData = JSON.parse(fs.readFileSync(path.resolve("public/medical-kb.json"), "utf-8"));
  let mcpReady = false;
  let McpServerClass: any = null;
  let SSETransportClass: any = null;
  let zod: any = null;
  const mcpTransports = new Map<string, any>();

  const ensureMcp = async () => {
    if (mcpReady) return true;
    try {
      McpServerClass = (await import("@modelcontextprotocol/sdk/server/mcp.js")).McpServer;
      SSETransportClass = (await import("@modelcontextprotocol/sdk/server/sse.js")).SSEServerTransport;
      zod = await import("zod");
      mcpReady = true;
      return true;
    } catch (e) {
      console.warn("⚠️ MCP SDK load failed (non-fatal):", (e as any)?.message);
      return false;
    }
  };

  const createMcpServer = () => {
    const z = zod.z;
    const s = new McpServerClass({ name: "careaid-ai", version: "1.0.0" });
    s.tool("triage_symptoms", "Assess patient symptoms using clinical decision tree", {
      symptoms: z.string(), lang: z.enum(["en", "bn"]).default("en"),
    }, async ({ symptoms }: any) => {
      const safety = classifySymptoms(symptoms);
      return { content: [{ type: "text", text: JSON.stringify({ verdict: safety.verdict, matched: safety.matched, kb_entries: kbData.entries.length }) }] };
    });
    s.tool("search_medical_kb", "Search 82 bilingual clinical protocols", {
      query: z.string(), lang: z.enum(["en", "bn"]).default("en"),
    }, async ({ query, lang }: any) => {
      const lower = query.toLowerCase();
      const hits = kbData.entries.filter((e: any) =>
        [...e.tags_en, ...e.tags_bn, e.title.en, e.title.bn].some((t: string) => t.toLowerCase().includes(lower))
      ).slice(0, 5);
      return { content: [{ type: "text", text: JSON.stringify(hits.map((e: any) => ({ id: e.id, title: e.title[lang], severity: e.severity }))) }] };
    });
    s.tool("classify_safety", "Bilingual safety classifier (30+ red-flag patterns)", {
      text: z.string(),
    }, async ({ text }: any) => {
      return { content: [{ type: "text", text: JSON.stringify(classifySymptoms(text)) }] };
    });
    return s;
  };

  app.get("/mcp/sse", async (req, res) => {
    if (!await ensureMcp()) { res.status(503).json({ error: "MCP not available" }); return; }
    const transport = new SSETransportClass("/mcp/messages", res);
    mcpTransports.set(transport.sessionId, transport);
    res.on("close", () => mcpTransports.delete(transport.sessionId));
    const s = createMcpServer();
    await s.connect(transport);
  });
  app.post("/mcp/messages", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = mcpTransports.get(sessionId);
    if (!transport) { res.status(404).json({ error: "session not found" }); return; }
    const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    await transport.handlePostMessage(req, res, body);
  });
  app.get("/mcp/health", async (_req, res) => {
    const ready = await ensureMcp();
    res.json({ status: ready ? "ok" : "sdk_unavailable", tools: 3, kb_entries: kbData.entries.length, transport: "sse" });
  });
  console.log("✅ MCP endpoints registered at /mcp/sse, /mcp/messages, /mcp/health (lazy-loaded)");

  // Production is the DEFAULT (serve the built dist). Dev mode is opt-in via NODE_ENV=development
  // (set by `npm run dev`). This way the deployed bundle never accidentally tries to start a Vite
  // dev server even if the host leaves NODE_ENV unset.
  if (process.env.NODE_ENV === "development") {
    try {
      const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
      app.use(vite.middlewares);
    } catch (e) {
      // Vite dev middleware fails on some Node/package combos. Fall back to serving public/
      // directly (API + MCP + webhooks still work). Run `npx vite` separately for the frontend.
      console.warn("⚠️ Vite dev middleware failed (run `npx vite` separately for the frontend):", (e as any)?.message);
      app.use(express.static(path.join(process.cwd(), "public")));
    }
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => res.sendFile(path.join(distPath, "index.html")));
  }

  app.listen(PORT, "0.0.0.0", () => console.log(`🚀 CareAid AI running on http://localhost:${PORT}`));
}

startServer();