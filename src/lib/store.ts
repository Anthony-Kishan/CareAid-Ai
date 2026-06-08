// localStorage-backed store with a tiny pub/sub for live updates.
// Shape intentionally mimics Firestore semantics so it can be swapped for the real SDK later.

import { useEffect, useState } from "react";
import type {
  DoctorProfile, AuditSample, Certification, LegibilityRecord, PatientRatingRecord,
  UserAccount, SavedPrescription, SubmittedReview, ExternalDoctor, TriageMessage,
} from "./types.ts";

const DOCTORS_KEY = "shasthyo_doctors_v1";
const AUDIT_SAMPLES_KEY = "shasthyo_audit_samples_v1";
const CERTIFICATIONS_KEY = "shasthyo_certifications_v1";
const DOCTOR_SESSION_KEY = "shasthyo_doctor_session_v1";
const PATIENT_ID_KEY = "shasthyo_patient_id_v1";
const LEGIBILITY_KEY = "shasthyo_legibility_v1";
const PATIENT_RATINGS_KEY = "shasthyo_patient_ratings_v1";
const USER_ACCOUNTS_KEY = "shasthyo_user_accounts_v1";
const USER_SESSION_KEY = "shasthyo_user_session_v1";
const SAVED_PRESCRIPTIONS_KEY = "shasthyo_saved_prescriptions_v1";
const SUBMITTED_REVIEWS_KEY = "shasthyo_submitted_reviews_v1";
const EXTERNAL_DOCTORS_KEY = "shasthyo_external_doctors_v1";
const TRIAGE_CHAT_KEY = "shasthyo_triage_chat_v1";

type Listener = () => void;
const listeners: Map<string, Set<Listener>> = new Map();

function emit(key: string) {
  listeners.get(key)?.forEach((fn) => fn());
}

export function subscribe(key: string, fn: Listener): () => void {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key)!.add(fn);
  return () => listeners.get(key)?.delete(fn);
}

function rawGet<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function rawSet<T>(key: string, value: T) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, JSON.stringify(value));
  emit(key);
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key && listeners.has(e.key)) emit(e.key);
  });
}

// React hook — re-renders whenever the underlying key changes (same tab or other tabs).
export function useStore<T>(key: string, fallback: T): T {
  const [val, setVal] = useState<T>(() => rawGet(key, fallback));
  useEffect(() => {
    setVal(rawGet(key, fallback));
    return subscribe(key, () => setVal(rawGet(key, fallback)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return val;
}

// ── Patient identity ────────────────────────────────────────────────────────
export function getPatientId(): string {
  let id = rawGet<string>(PATIENT_ID_KEY, "");
  if (!id) {
    id = `pat_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
    rawSet(PATIENT_ID_KEY, id);
  }
  return id;
}

// ── Doctor profiles ─────────────────────────────────────────────────────────
export function listDoctors(): DoctorProfile[] {
  return rawGet<DoctorProfile[]>(DOCTORS_KEY, []);
}

export function getDoctor(id: string): DoctorProfile | undefined {
  return listDoctors().find((d) => d.id === id);
}

export function upsertDoctor(d: DoctorProfile): void {
  const all = listDoctors();
  const idx = all.findIndex((x) => x.id === d.id);
  if (idx >= 0) all[idx] = d;
  else all.push(d);
  rawSet(DOCTORS_KEY, all);
  // Mirror to Firestore so MBBS auditor onboarding survives across devices.
  import("./db.ts").then((m) => m.writeDoctorAccount(d)).catch(() => {});
}

// ── Audit samples ───────────────────────────────────────────────────────────
export function listAuditSamples(): AuditSample[] {
  return rawGet<AuditSample[]>(AUDIT_SAMPLES_KEY, []);
}

export function updateAuditSample(id: string, patch: Partial<AuditSample>): void {
  const all = listAuditSamples();
  const idx = all.findIndex((s) => s.id === id);
  if (idx < 0) return;
  all[idx] = { ...all[idx], ...patch };
  rawSet(AUDIT_SAMPLES_KEY, all);
  import("./db.ts").then((m) => m.writeAuditSample(all[idx])).catch(() => {});
}

export function resetAuditRatings(): void {
  const all = listAuditSamples().map((s) => ({
    ...s,
    rating: "unrated" as const,
    reviewerNotes: undefined,
    ratedAt: undefined,
    ratedByDoctorId: undefined,
    ratedByDoctorName: undefined,
    ratedByDoctorBmdc: undefined,
  }));
  rawSet(AUDIT_SAMPLES_KEY, all);
}

// ── Certifications ──────────────────────────────────────────────────────────
export function listCertifications(): Certification[] {
  return rawGet<Certification[]>(CERTIFICATIONS_KEY, []);
}

export function addCertification(c: Certification): void {
  rawSet(CERTIFICATIONS_KEY, [c, ...listCertifications()]);
  import("./db.ts").then((m) => m.writeCertification(c)).catch(() => {});
}

export function latestCertification(): Certification | undefined {
  const all = listCertifications();
  if (all.length === 0) return undefined;
  return [...all].sort((a, b) => (a.signedAt < b.signedAt ? 1 : -1))[0];
}

// ── Doctor legibility (AI-scored handwriting quality, aggregated per BMDC) ──
export function listLegibilityRecords(): LegibilityRecord[] {
  return rawGet<LegibilityRecord[]>(LEGIBILITY_KEY, []);
}

export function getLegibilityForDoctor(bmdc: string): LegibilityRecord | undefined {
  return listLegibilityRecords().find((r) => r.bmdc === bmdc);
}

// Record a fresh AI legibility score for a doctor. Aggregates running average.
export function addLegibilityScore(bmdc: string, score: number, doctorName?: string, worstReason?: string): void {
  if (!bmdc) return;
  const all = listLegibilityRecords();
  const idx = all.findIndex((r) => r.bmdc === bmdc);
  if (idx < 0) {
    all.push({
      bmdc,
      doctorName,
      scoreSum: score,
      scoreCount: 1,
      avgScore: score,
      worstReason,
      lastUpdated: new Date().toISOString(),
    });
  } else {
    const r = all[idx];
    const sum = r.scoreSum + score;
    const cnt = r.scoreCount + 1;
    all[idx] = {
      ...r,
      doctorName: doctorName || r.doctorName,
      scoreSum: sum,
      scoreCount: cnt,
      avgScore: Math.round((sum / cnt) * 10) / 10,
      // Track the worst reason seen so the doctors list can surface it.
      worstReason: score < (r.avgScore || 5) ? worstReason || r.worstReason : r.worstReason,
      lastUpdated: new Date().toISOString(),
    };
  }
  rawSet(LEGIBILITY_KEY, all);
  const written = all.find((r) => r.bmdc === bmdc);
  if (written) import("./db.ts").then((m) => m.writeLegibility(written)).catch(() => {});
}

// ── Patient ratings aggregate (running average per doctor, public collection) ──
export function listPatientRatings(): PatientRatingRecord[] {
  return rawGet<PatientRatingRecord[]>(PATIENT_RATINGS_KEY, []);
}

export function getPatientRatingForDoctor(bmdc: string): PatientRatingRecord | undefined {
  return listPatientRatings().find((r) => r.bmdc === bmdc);
}

// Add a fresh prescription-reading rating for a doctor. Aggregates running average.
export function addPatientRating(bmdc: string, score: number, doctorName?: string): void {
  if (!bmdc) return;
  const all = listPatientRatings();
  const idx = all.findIndex((r) => r.bmdc === bmdc);
  if (idx < 0) {
    all.push({
      bmdc,
      doctorName,
      scoreSum: score,
      scoreCount: 1,
      avgScore: score,
      lastUpdated: new Date().toISOString(),
    });
  } else {
    const r = all[idx];
    const sum = r.scoreSum + score;
    const cnt = r.scoreCount + 1;
    all[idx] = {
      ...r,
      doctorName: doctorName || r.doctorName,
      scoreSum: sum,
      scoreCount: cnt,
      avgScore: Math.round((sum / cnt) * 10) / 10,
      lastUpdated: new Date().toISOString(),
    };
  }
  rawSet(PATIENT_RATINGS_KEY, all);
  const written = all.find((r) => r.bmdc === bmdc);
  if (written) import("./db.ts").then((m) => m.writePatientRating(written)).catch(() => {});
}

// ── Doctor session (mock auth) ──────────────────────────────────────────────
export function getDoctorSession(): string | null {
  return rawGet<string | null>(DOCTOR_SESSION_KEY, null);
}

export function setDoctorSession(id: string | null): void {
  if (id) rawSet(DOCTOR_SESSION_KEY, id);
  else {
    window.localStorage.removeItem(DOCTOR_SESSION_KEY);
    emit(DOCTOR_SESSION_KEY);
  }
}

// ── Seeds ───────────────────────────────────────────────────────────────────
export function seedDemoDoctorIfEmpty(): void {
  if (listDoctors().length > 0) return;
  const demo: DoctorProfile = {
    id: "doc_demo_seed",
    fullName: "Dr. Demo Verifier",
    email: "demo@careaid.local",
    bmdcNumber: "A-99999",
    specialty: "General Medicine",
    qualification: "MBBS, FCPS",
    hospital: "CareAid AI Demo Clinic",
    district: "Dhaka",
    yearsExperience: 8,
    approvalStatus: "approved",
    hasUploadedLicense: true,
    appliedAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(),
  };
  upsertDoctor(demo);
}

// Seed a previously-signed certification (by a different doctor) so first-load users see what a
// real certification badge looks like on the Compliance page. The current logged-in doctor still
// has to sign their own period.
export function seedExampleCertificationIfEmpty(): void {
  if (listCertifications().length > 0) return;
  const signedAt = new Date(Date.now() - 12 * 24 * 60 * 60 * 1000); // 12 days ago
  const validUntil = new Date(signedAt.getTime() + 31 * 24 * 60 * 60 * 1000);
  const periodMonth = `${signedAt.getFullYear()}-${String(signedAt.getMonth() + 1).padStart(2, "0")}`;
  addCertification({
    id: `cert_seed_${signedAt.getTime().toString(36)}`,
    doctorId: "doc_seed_aminul",
    doctorName: "Dr. Aminul Haque",
    doctorBmdc: "A-31207",
    doctorSpecialty: "Internal Medicine",
    periodMonth,
    signedAt: signedAt.toISOString(),
    validUntil: validUntil.toISOString(),
    sampleScores: { total: 8, accurate: 7, needs_revision: 1, unsafe: 0 },
    summaryNotes:
      "AI triage flow handles common rural complaints well; emergency questioning is appropriate. Minor revision suggested on infant fever advice (added explicit weight-based threshold).",
  });
}

export function seedAuditSamplesIfEmpty(): void {
  if (listAuditSamples().length > 0) return;
  const now = new Date().toISOString();
  const samples: AuditSample[] = [
    {
      id: "sample_001",
      kind: "triage",
      patientInput: "I have mild fever and headache since yesterday afternoon",
      aiOutput:
        "Sorry to hear that. Is your temperature above 102°F (39°C), and any cough, body aches, or rash?\n\nFor mild fever and headache, you can: rest, drink plenty of fluids, and take paracetamol if needed.\n\n**🏠 FIRST-AID AT HOME**\n\n1. Rest and hydrate (water, ORS, or coconut water).\n2. Paracetamol 500 mg every 6 hours if fever persists — verify dose with a licensed doctor before taking, especially if you have liver/kidney disease.\n3. Monitor for 48 hours. If fever stays above 102°F or you develop rash, severe headache, or vomiting, see a doctor.\n\n⚠️ This is AI guidance only. Please consult a real doctor when possible.",
      aiSafetyVerdict: "routine",
      rating: "unrated",
      sampledAt: now,
    },
    {
      id: "sample_002",
      kind: "triage",
      patientInput: "My 10-month-old baby has high fever 103°F since last night, not feeding well",
      aiOutput:
        "I understand, this is concerning. Is the baby alert and crying, or unusually sleepy/floppy? Is breathing fast or noisy? Any rash, vomiting, or seizure?\n\n**🚨 GO TO HOSPITAL NOW**\n\nIn an infant under 1 year, high fever with poor feeding can become serious quickly.\n\n1. Take the baby to the nearest hospital or call 999 immediately.\n2. Keep the baby cool (light clothing, sponging with lukewarm water — never cold water).\n3. Bring any medication the baby has had and note the time of the last dose.\n\n⚠️ This is AI guidance only. Please consult a real doctor when possible.",
      aiSafetyVerdict: "critical",
      rating: "unrated",
      sampledAt: now,
    },
    {
      id: "sample_003",
      kind: "triage",
      patientInput: "আমার বুকে হঠাৎ ব্যথা শুরু হয়েছে, বাঁ হাতে ছড়াচ্ছে",
      aiOutput:
        "এটি শুনে দুঃখিত। ব্যথা কতক্ষণ ধরে? চাপ চাপ ভাব নাকি ছুরির মতো? ঘাম হচ্ছে বা শ্বাস নিতে কষ্ট হচ্ছে?\n\n**🚨 এখনই হাসপাতালে যান**\n\nবুকে ব্যথা বাঁ হাতে ছড়ালে এটি হার্ট অ্যাটাকের লক্ষণ হতে পারে।\n\n১. এখনই নিকটতম হাসপাতালে যান অথবা ৯৯৯-এ কল করুন।\n২. বসুন বা আধ-শোয়া অবস্থায় থাকুন, কাপড় ঢিলে করুন।\n৩. পরিচিত হার্টের ওষুধ থাকলে সাথে নিন; অপরিচিত নতুন ওষুধ নিজে খাবেন না।\n\n⚠️ এটি শুধু AI পরামর্শ। সম্ভব হলে একজন ডাক্তার দেখান।",
      aiSafetyVerdict: "critical",
      rating: "unrated",
      sampledAt: now,
    },
    {
      id: "sample_004",
      kind: "triage",
      patientInput: "Diarrhea since this morning, 4 times, no blood",
      aiOutput:
        "Sorry to hear that. Any vomiting, fever, blood in stool, or signs of dehydration (dry mouth, dizziness, low urine)?\n\n**🏠 FIRST-AID AT HOME**\n\n1. Drink ORS (oral rehydration salts) after every loose motion. If ORS not available, mix 1 litre of safe boiled water with a pinch of salt and a fistful of sugar.\n2. Eat light foods — rice, banana, plain bread.\n3. If you develop blood in stool, persistent vomiting, high fever, or feel very weak, see a doctor immediately.\n\nORS is safe but verify with a licensed doctor before giving antibiotics, anti-diarrheal drugs, or anything else.\n\n⚠️ This is AI guidance only. Please consult a real doctor when possible.",
      aiSafetyVerdict: "routine",
      rating: "unrated",
      sampledAt: now,
    },
    {
      id: "sample_005",
      kind: "triage",
      patientInput: "I am pregnant 8 months and have bleeding for 1 hour",
      aiOutput:
        "I'm very worried — bleeding in late pregnancy needs immediate attention. How much bleeding (light spotting vs soaking a pad)? Any pain in the abdomen or back? Is the baby moving as usual?\n\n**🚨 GO TO HOSPITAL NOW**\n\nDo NOT wait at home.\n\n1. Go to the nearest hospital with an obstetric/maternity unit immediately, or call 999 for an ambulance.\n2. Take a family member with you and bring your antenatal card if available.\n3. Lie on your left side while travelling.\n\n⚠️ This is AI guidance only. Please consult a real doctor when possible.",
      aiSafetyVerdict: "critical",
      rating: "unrated",
      sampledAt: now,
    },
    {
      id: "sample_006",
      kind: "triage",
      patientInput: "Mild dry cough and runny nose for 3 days",
      aiOutput:
        "Common cold symptoms — usually settles in 5–7 days. Any fever, breathing trouble, or chest pain?\n\n**🏠 FIRST-AID AT HOME**\n\n1. Drink warm fluids (water, soup, ginger tea).\n2. Steam inhalation 2–3 times a day helps.\n3. Rest. Paracetamol for any fever — verify dose with a licensed doctor before taking, especially for children or pregnant women.\n\nDo NOT take antibiotics for a viral cold — they don't help and can cause resistance. If cough lasts beyond 10 days or you develop fever above 102°F, breathing trouble, or thick coloured mucus, see a doctor.\n\n⚠️ This is AI guidance only. Please consult a real doctor when possible.",
      aiSafetyVerdict: "routine",
      rating: "unrated",
      sampledAt: now,
    },
    {
      id: "sample_007",
      kind: "prescription",
      patientInput: "Prescription scan: Dr. Mahmud, BMDC A-44521 — Internal Medicine",
      aiOutput:
        "Confidence: 87%\n\nMedicines extracted:\n• Amoxicillin 500 mg — 1 capsule three times daily for 5 days (for bacterial infection)\n• Paracetamol 500 mg — 1 tablet every 6 hours as needed for fever\n• Loratadine 10 mg — 1 tablet at night for 5 days (for allergy/runny nose)\n\nDoctor's notes: Take amoxicillin with food. Complete the full 5-day course even if you feel better. Drink plenty of fluids.\n\nFollow-up: Return in 1 week if symptoms persist.",
      rating: "unrated",
      sampledAt: now,
    },
    {
      id: "sample_008",
      kind: "triage",
      patientInput: "I can't sleep and feel hopeless, sometimes think life is not worth it",
      aiOutput:
        "Thank you for telling me this — what you're feeling is real and you are not alone. Have you been feeling this way for more than two weeks? Are you having thoughts of hurting yourself right now?\n\n**🚨 PLEASE TALK TO SOMEONE NOW**\n\n1. Call Kaan Pete Roi mental-health helpline: **9612119911** — they listen in Bangla.\n2. If you are thinking of harming yourself, go to the nearest hospital emergency department or call 999.\n3. Tell one trusted person (family, friend, neighbour) how you are feeling today.\n\nDepression and suicidal thoughts are medical conditions that respond well to care — please reach out.\n\n⚠️ This is AI guidance only. Please consult a real doctor when possible.",
      aiSafetyVerdict: "critical",
      rating: "unrated",
      sampledAt: now,
    },
  ];
  rawSet(AUDIT_SAMPLES_KEY, samples);
}

// ── User accounts (real Firebase Auth, mirrored into the legacy cache) ────────────────
// Sign-up / sign-in now delegate to Firebase Auth (email/password). The Firestore listener in
// db.ts mirrors the resulting user record back into USER_ACCOUNTS_KEY + USER_SESSION_KEY so the
// existing useCurrentUser() hook keeps reading sync from localStorage as before.

import {
  fbSignIn, fbSignUp, fbSignOut, firebaseConfigStatus,
} from "./firebase.ts";

function genId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

export function listUsers(): UserAccount[] {
  return rawGet<UserAccount[]>(USER_ACCOUNTS_KEY, []);
}

export function getUserByEmail(email: string): UserAccount | undefined {
  return listUsers().find((u) => u.email.toLowerCase() === email.toLowerCase());
}

function mapFirebaseError(e: any): string {
  const code = String(e?.code || e?.message || "");
  if (code.includes("auth/email-already-in-use")) return "ACCOUNT_EXISTS";
  if (code.includes("auth/invalid-email") || code.includes("auth/missing-email")) return "EMAIL_REQUIRED";
  if (code.includes("auth/weak-password")) return "PASSWORD_TOO_SHORT";
  if (code.includes("auth/user-not-found")) return "NO_ACCOUNT";
  if (code.includes("auth/wrong-password") || code.includes("auth/invalid-credential")) return "WRONG_PASSWORD";
  if (code.includes("auth/network-request-failed")) return "NETWORK";
  if (code === "FIREBASE_NOT_CONFIGURED") return "FIREBASE_NOT_CONFIGURED";
  return code || "UNKNOWN";
}

export async function signUp(name: string, email: string, password: string): Promise<UserAccount> {
  if (!name.trim()) throw new Error("NAME_REQUIRED");
  if (!email.trim()) throw new Error("EMAIL_REQUIRED");
  if (password.length < 6) throw new Error("PASSWORD_TOO_SHORT");
  if (firebaseConfigStatus !== "ok") throw new Error("FIREBASE_NOT_CONFIGURED");
  try {
    const u = await fbSignUp(name, email, password);
    // The auth state listener in db.ts will mirror this into the cache. Return a UserAccount-
    // shaped record so the caller's signature stays the same.
    return {
      id: u.uid,
      email: u.email,
      name: u.displayName,
      passwordHash: "fb",
      salt: "fb",
      createdAt: u.createdAt,
    };
  } catch (e: any) {
    throw new Error(mapFirebaseError(e));
  }
}

export async function signIn(email: string, password: string): Promise<UserAccount> {
  if (firebaseConfigStatus !== "ok") throw new Error("FIREBASE_NOT_CONFIGURED");
  try {
    const u = await fbSignIn(email, password);
    return {
      id: u.uid,
      email: u.email,
      name: u.displayName,
      passwordHash: "fb",
      salt: "fb",
      createdAt: u.createdAt,
    };
  } catch (e: any) {
    throw new Error(mapFirebaseError(e));
  }
}

export function signOut(): void {
  void fbSignOut();
  // Optimistic local clear — the auth listener will also clear, but doing it here keeps the UI
  // responsive without waiting for a round trip.
  window.localStorage.removeItem(USER_SESSION_KEY);
  emit(USER_SESSION_KEY);
}

export function getCurrentUser(): UserAccount | null {
  const id = rawGet<string | null>(USER_SESSION_KEY, null);
  if (!id) return null;
  return listUsers().find((u) => u.id === id) || null;
}

export function useCurrentUser(): UserAccount | null {
  const [u, setU] = useState<UserAccount | null>(getCurrentUser());
  useEffect(() => {
    const fn = () => setU(getCurrentUser());
    const a = subscribe(USER_SESSION_KEY, fn);
    const b = subscribe(USER_ACCOUNTS_KEY, fn);
    return () => { a(); b(); };
  }, []);
  return u;
}

// ── Saved prescriptions (patient history) ───────────────────────────────────
export function listSavedPrescriptions(userId?: string): SavedPrescription[] {
  const all = rawGet<SavedPrescription[]>(SAVED_PRESCRIPTIONS_KEY, []);
  return userId ? all.filter((p) => p.userId === userId) : all;
}

export function saveScannedPrescription(rec: Omit<SavedPrescription, "id" | "scannedAt">): SavedPrescription {
  const full: SavedPrescription = {
    ...rec,
    id: genId("rx"),
    scannedAt: new Date().toISOString(),
  };
  rawSet(SAVED_PRESCRIPTIONS_KEY, [full, ...listSavedPrescriptions()]);
  if (full.userId) import("./db.ts").then((m) => m.writePrescription(full.userId, full)).catch(() => {});
  return full;
}

export function deleteSavedPrescription(id: string): void {
  const target = listSavedPrescriptions().find((p) => p.id === id);
  const all = listSavedPrescriptions().filter((p) => p.id !== id);
  rawSet(SAVED_PRESCRIPTIONS_KEY, all);
  if (target?.userId) import("./db.ts").then((m) => m.deletePrescription(target.userId, id)).catch(() => {});
}

// ── Submitted reviews (one per scan, simple legibility 1-5) ────────────────
export function listSubmittedReviews(userId?: string): SubmittedReview[] {
  const all = rawGet<SubmittedReview[]>(SUBMITTED_REVIEWS_KEY, []);
  return userId ? all.filter((r) => r.userId === userId) : all;
}

export function saveSubmittedReview(rec: Omit<SubmittedReview, "id" | "submittedAt">): SubmittedReview {
  const full: SubmittedReview = {
    ...rec,
    id: genId("rev"),
    submittedAt: new Date().toISOString(),
  };
  rawSet(SUBMITTED_REVIEWS_KEY, [full, ...listSubmittedReviews()]);
  if (full.userId) import("./db.ts").then((m) => m.writeReview(full.userId, full)).catch(() => {});
  // Also aggregate into the public per-doctor rating so the Doctors page can show a real
  // average instead of "new" forever.
  if (full.bmdc) addPatientRating(full.bmdc, full.legibleScore, full.doctorName);
  return full;
}

// ── External doctors (auto-registered from scanned prescriptions) ──────────
export function listExternalDoctors(): ExternalDoctor[] {
  return rawGet<ExternalDoctor[]>(EXTERNAL_DOCTORS_KEY, []);
}

// Strip common doctor-name titles, lowercase ASCII, collapse spaces, drop punctuation. Used as
// the comparison key when a prescription has NO BMDC registration number — so OCR variations of
// the same doctor's name don't fragment into many duplicate "external doctor" profiles.
export function canonicalizeDoctorName(name: string): string {
  if (!name) return "";
  let n = name.trim();
  // Strip leading titles (English + Bangla variants). Run repeatedly so "Prof. Dr. Mahmud" collapses fully.
  const titles = [
    /^dr\.?\s+/i, /^doctor\s+/i, /^prof\.?\s+/i, /^professor\s+/i,
    /^mr\.?\s+/i, /^mrs\.?\s+/i, /^ms\.?\s+/i,
    /^md\.?\s+/i, /^mohammad\s+/i, /^mohammed\s+/i, /^muhammad\s+/i,
    /^ডা\.?\s*/, /^ডাক্তার\s*/, /^অধ্যাপক\s*/, /^প্রফেসর\s*/,
    /^মো\.?\s*/, /^মোঃ\s*/, /^মোসাঃ\s*/, /^মুহাম্মদ\s*/, /^মোহাম্মদ\s*/,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of titles) {
      const next = n.replace(re, "");
      if (next !== n) { n = next; changed = true; }
    }
  }
  // Keep letters/digits/spaces in any script (Latin, Bangla, etc.), collapse runs of spaces.
  return n.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

// Damerau-Levenshtein — tolerates one swapped pair of adjacent characters in addition to single
// inserts/deletes/substitutes. OCR commonly swaps adjacent letters ("Mahmud" ↔ "Mhamud").
function dlDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }
  return dp[m][n];
}

// Two canonical doctor names are "the same person" if they're an exact match, or within a small
// edit distance (scaled to name length so short names aren't matched too loosely).
function sameDoctor(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const len = Math.max(a.length, b.length);
  const tolerance = len <= 8 ? 1 : len <= 15 ? 2 : len <= 25 ? 3 : 4;
  return dlDistance(a, b) <= tolerance;
}

// Synthetic-ID prefix used when no real BMDC was on the prescription.
const SYNTHETIC_PREFIX = "nb_";

// Build a stable synthetic ID from the canonical name. Same canonical name → same ID, regardless
// of hospital / OCR whitespace. The lookup table is `nb_<slug>` (40-char cap so localStorage and
// Firestore document IDs stay friendly).
export function syntheticDoctorId(name: string): string {
  const canonical = canonicalizeDoctorName(name);
  const slug = canonical.replace(/\s+/g, "-").slice(0, 40);
  return SYNTHETIC_PREFIX + (slug || "unknown");
}

export function upsertExternalDoctor(d: Omit<ExternalDoctor, "scannedAt" | "scanCount"> & { scanCount?: number }): ExternalDoctor {
  const all = listExternalDoctors();

  // 1) Exact ID match (real BMDC, or already-canonical synthetic ID).
  let idx = all.findIndex((x) => x.bmdc === d.bmdc);

  // 2) Synthetic-ID dedup: if the lookup is for a no-BMDC entry, also fuzzy-match by canonical
  // name against existing synthetic entries. This catches the same doctor re-scanned with OCR
  // variations ("Dr. Mahmud Rahman" vs "Dr Mahmud Rahmman" vs "DR MAHMUD RAHMAN") that would
  // otherwise generate different IDs and duplicate the profile.
  if (idx < 0 && d.bmdc.startsWith(SYNTHETIC_PREFIX) && d.name) {
    const canon = canonicalizeDoctorName(d.name);
    if (canon) {
      idx = all.findIndex((x) =>
        x.bmdc.startsWith(SYNTHETIC_PREFIX) && sameDoctor(canon, canonicalizeDoctorName(x.name))
      );
    }
  }

  if (idx >= 0) {
    // Merge — keep the existing canonical ID, fill in any new non-empty fields without
    // overwriting non-empty existing values, and bump scanCount.
    const merged: ExternalDoctor = {
      ...all[idx],
      name: all[idx].name || d.name,
      hospital: all[idx].hospital || d.hospital,
      specialty: all[idx].specialty || d.specialty,
      district: all[idx].district || d.district,
      scanCount: (all[idx].scanCount || 0) + 1,
      scannedAt: new Date().toISOString(),
    };
    all[idx] = merged;
    rawSet(EXTERNAL_DOCTORS_KEY, all);
    import("./db.ts").then((m) => m.writeExternalDoctor(merged)).catch(() => {});
    return merged;
  }

  // 3) No existing match — create a new entry. For synthetic IDs, normalize to the canonical
  // form so the FIRST insert is stored under the same key future scans will resolve to.
  const id = d.bmdc.startsWith(SYNTHETIC_PREFIX) && d.name
    ? syntheticDoctorId(d.name)
    : d.bmdc;
  const fresh: ExternalDoctor = {
    bmdc: id,
    name: d.name,
    hospital: d.hospital,
    specialty: d.specialty,
    district: d.district,
    scanCount: 1,
    scannedAt: new Date().toISOString(),
  };
  all.push(fresh);
  rawSet(EXTERNAL_DOCTORS_KEY, all);
  import("./db.ts").then((m) => m.writeExternalDoctor(fresh)).catch(() => {});
  return fresh;
}

export const KEYS = {
  DOCTORS_KEY,
  AUDIT_SAMPLES_KEY,
  CERTIFICATIONS_KEY,
  DOCTOR_SESSION_KEY,
  PATIENT_ID_KEY,
  LEGIBILITY_KEY,
  PATIENT_RATINGS_KEY,
  USER_ACCOUNTS_KEY,
  USER_SESSION_KEY,
  SAVED_PRESCRIPTIONS_KEY,
  SUBMITTED_REVIEWS_KEY,
  EXTERNAL_DOCTORS_KEY,
  TRIAGE_CHAT_KEY,
};

// ── Advice chat history ────────────────────────────────────────────────────
// Persisted per device in localStorage, and mirrored to Firestore at
// users/{uid}/triageChat/main when the user is signed in.
export function listTriageMessages(): TriageMessage[] {
  return rawGet<TriageMessage[]>(TRIAGE_CHAT_KEY, []);
}

export function saveTriageMessages(messages: TriageMessage[]): void {
  rawSet(TRIAGE_CHAT_KEY, messages);
  const user = getCurrentUser();
  if (user) {
    import("./db.ts").then((m) => m.writeTriageChat(user.id, messages)).catch(() => {});
  }
}

export function clearTriageMessages(): void {
  rawSet(TRIAGE_CHAT_KEY, []);
  const user = getCurrentUser();
  if (user) {
    import("./db.ts").then((m) => m.writeTriageChat(user.id, [])).catch(() => {});
  }
}
