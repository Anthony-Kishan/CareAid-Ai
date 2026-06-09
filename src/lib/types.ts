// Phase 2 — doctor verification & co-sign types.
// Shape is intentionally close to what Firestore documents will look like, so the localStorage
// adapter in `store.ts` can be replaced with the real Firestore SDK with minimal churn.

export type ApprovalStatus = "pending_admin" | "approved" | "rejected";

export interface DoctorProfile {
  id: string;
  fullName: string;
  email?: string;
  bmdcNumber: string;
  specialty: string;
  qualification: string;
  hospital: string;
  district: string;
  yearsExperience: number;
  approvalStatus: ApprovalStatus;
  hasUploadedLicense: boolean;
  appliedAt: string;
  approvedAt?: string;
  rejectedReason?: string;
}

// Triage conversation persisted per user (local + Firestore). Single rolling chat per device.

export type TriageSource = "cloud" | "kb" | "webllm" | "wasm" | "rules";

export interface TriageMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  source?: TriageSource;
  safety?: { verdict: string; matched: string[]; scrubbedLines?: number };
  diagnosticForSymptoms?: string;
}

// ── User accounts + patient history (the "database" layer) ────────────────
// Demo-grade local auth: SHA-256(password + salt) stored in localStorage. NOT secure for
// real production — clearly labelled in the sign-up form. The schema mirrors what a real
// Firestore swap would store.

export interface UserAccount {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  salt: string;
  createdAt: string;
}

export interface SavedPrescription {
  id: string;
  userId: string;
  scannedAt: string;
  doctor: {
    name?: string;
    bmdc?: string;
    hospital?: string;
    specialization?: string;
  };
  medicineCount: number;
  testCount: number;
  diagnosisHint?: string;
  followUp?: string;
  legibilityScore?: number;
  // The original uploaded image, compressed to ~800px JPEG / base64 (data URL).
  imagePreview?: string;
  // The full extracted payload so the patient can review every detail later — medicines with
  // dose grid, tests, nutrition guidelines, etc.
  extraction?: ExtractedPrescription;
}

export interface SubmittedReview {
  id: string;
  userId: string;
  bmdc: string;
  doctorName: string;
  legibleScore: number;
  comment?: string;
  submittedAt: string;
}

// External doctors discovered through prescription scans. Keyed by BMDC. Merged with the
// seeded DOCTORS list when rendering the Doctors page.
export interface ExternalDoctor {
  bmdc: string;
  name: string;
  hospital?: string;
  specialty?: string;
  district?: string;
  scannedAt: string;
  scanCount: number;
}

// AI behaviour samples that MBBS auditors review during a periodic certification.
// Samples are seeded with representative dialogues; in production the server would also push
// real anonymised production outputs into this collection on a sampling cadence.

export type AuditKind = "triage" | "prescription";
export type AuditRating = "unrated" | "accurate" | "needs_revision" | "unsafe";

export interface AuditSample {
  id: string;
  kind: AuditKind;
  patientInput: string;
  aiOutput: string;
  aiSafetyVerdict?: "critical" | "urgent" | "routine";
  rating: AuditRating;
  reviewerNotes?: string;
  ratedByDoctorId?: string;
  ratedByDoctorName?: string;
  ratedByDoctorBmdc?: string;
  ratedAt?: string;
  sampledAt: string;
}

// Prescription extraction — schema returned by /api/scan-prescription.

export interface DoseSchedule {
  morning: number;   // count of units (tablets, ml)
  noon: number;
  night: number;
  before_food?: boolean;
  after_food?: boolean;
  notes?: string;    // e.g. "with warm water" — English (or whatever language Gemini chose)
  notes_bn?: string; // same instruction in plain Bangla
}

export interface ExtractedMedicine {
  name: string;
  generic?: string;
  strength?: string;          // e.g. "500 mg"
  form?: string;              // tablet, syrup, capsule, drops, injection
  schedule: DoseSchedule;
  duration?: string;          // e.g. "5 days"
  duration_bn?: string;       // same duration in Bangla (e.g. "৫ দিন")
  purpose_english?: string;
  purpose_bangla?: string;
  warnings?: string;
  warnings_bn?: string;
}

export interface ExtractedDoctor {
  name?: string;
  bmdc?: string;
  hospital?: string;
  specialization?: string;
}

export interface ExtractedPrescription {
  doctor: ExtractedDoctor;
  patient_age?: string;
  patient_sex?: string;
  chief_complaint?: string;
  diagnosis_hint?: string;
  medicines: ExtractedMedicine[];
  tests?: string[];
  follow_up?: string;
  patient_notes?: string;
  confidence: number;                          // 0–100
  legibility_score: number;                    // 1–5  (1 illegible, 5 perfectly readable)
  legibility_reason: string;
  nutrition_guidelines: string[];              // each item is a short bilingual-or-EN bullet
  nutrition_guidelines_bn?: string[];          // same bullets in Bangla
  provider: "gemini" | "groq" | "tesseract";   // which model produced this
}

// ── Patient profile (used by the diagnostic engine) ────────────────────────
export type ChronicCondition =
  | "diabetes"
  | "hypertension"
  | "heart_disease"
  | "asthma"
  | "kidney_disease"
  | "pregnancy"
  | "tb_history"
  | "immunocompromised";

export interface PatientProfile {
  age?: number;
  sex?: "male" | "female" | "other";
  district?: string;
  conditions: ChronicCondition[];
  allergies?: string[];
  pregnancyWeeks?: number;
  updatedAt: string;
}

// ── Hospitals + regional disease (used by the nearest-hospital + risk uplift) ─
export interface Hospital {
  id: string;
  name_en: string;
  name_bn: string;
  district: string;
  division: string;
  type: "general" | "specialty" | "private" | "community";
  lat: number;
  lng: number;
  phone?: string;
  emergency: boolean;
  obstetric?: boolean;
  cardiac?: boolean;
  stroke_unit?: boolean;
}

export interface DistrictTrend {
  district: string;
  disease: string;
  diseaseTags: string[];   // KB tag aliases (e.g. "dengue", "ডেঙ্গু")
  trendPercent: number;    // weekly change, +ve means rising
  cases: number;
}

export interface RegionalDiseaseSnapshot {
  updatedAt: string;
  source: string;
  trends: DistrictTrend[];
}

// ── Diagnostic engine output ────────────────────────────────────────────────
export type RiskLevel = "low" | "medium" | "high";

export interface DiagnosticFactor {
  label_en: string;
  label_bn: string;
  value_en: string;
  value_bn: string;
  kind: "symptom" | "profile" | "regional" | "guideline";
}

export interface NearestHospital {
  hospital: Hospital;
  distanceKm: number;
  source: "geolocation" | "district" | "fallback";
}

export interface DiagnosticResult {
  riskScore: number;          // 0-100
  riskLevel: RiskLevel;
  severity: "mild" | "urgent" | "critical";
  // True when BM25 confidence is below the abstention threshold — UI should render an
  // "I need more details" state instead of a confident verdict, and ignore riskScore.
  lowConfidence?: boolean;
  // Title of the top matched KB entry (when not abstaining) so the UI can show
  // "Likely: <condition>" — making the verdict explainable rather than a bare percentage.
  matchedTitle?: { en: string; bn: string };
  reason_en: string;          // one-paragraph "why this risk"
  reason_bn: string;
  warning_en?: string;        // time-sensitive flag e.g. "platelet drop in 24h"
  warning_bn?: string;
  factors: DiagnosticFactor[];
  cta_en: string;             // "Go to hospital today"
  cta_bn: string;
  matchedKbIds: string[];
  nearestHospitals: NearestHospital[];
}

// Per-doctor aggregated AI legibility from scans, keyed by BMDC number.
export interface LegibilityRecord {
  bmdc: string;
  doctorName?: string;
  scoreSum: number;
  scoreCount: number;
  avgScore: number;
  worstReason?: string;
  lastUpdated: string;
}

// Per-doctor aggregated patient rating ("how easy was it to read this doctor's prescription").
// Keyed by the same id as the doctor (real BMDC, or synthetic `nb_...` when none).
export interface PatientRatingRecord {
  bmdc: string;
  doctorName?: string;
  scoreSum: number;
  scoreCount: number;
  avgScore: number;
  lastUpdated: string;
}

// A signed periodic certification. One per doctor per month.
export interface Certification {
  id: string;
  doctorId: string;
  doctorName: string;
  doctorBmdc: string;
  doctorSpecialty: string;
  periodMonth: string; // ISO-ish "YYYY-MM"
  signedAt: string;
  validUntil: string;  // signedAt + ~31 days
  sampleScores: {
    total: number;
    accurate: number;
    needs_revision: number;
    unsafe: number;
  };
  summaryNotes?: string;
}
