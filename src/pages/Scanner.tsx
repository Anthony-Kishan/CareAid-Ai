import { useEffect, useMemo, useState } from "react";
import { Camera, CheckCircle2, AlertCircle, Loader2, PlayCircle, Pill, ShieldCheck, ShieldAlert, Clock, Bell, ChevronDown, ChevronUp, FileText, Volume2, Square, Apple, Stethoscope, FlaskConical, MapPin } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "@/src/lib/utils";
import { useLanguage } from "../lib/LanguageContext.tsx";
import { User } from "firebase/auth";
import { DoseGrid } from "../components/DoseGrid.tsx";
import {
  addLegibilityScore,
  listDoctors,
  getLegibilityForDoctor,
  useStore,
  KEYS,
  useCurrentUser,
  saveScannedPrescription,
  saveSubmittedReview,
  upsertExternalDoctor,
  syntheticDoctorId,
} from "../lib/store.ts";
import type { ExtractedPrescription, ExtractedMedicine, LegibilityRecord } from "../lib/types.ts";
import { speak, stop as ttsStop, isTtsSupported, warmupVoices } from "../lib/tts.ts";
import { matchTests, type MatchedTest } from "../lib/freeTests.ts";
import { usePatientProfile } from "../lib/profile.ts";
import { compressDataUrl } from "../lib/imageCompress.ts";
import { useTesseract, recognize as ocrRecognize, shapeOcrToPrescriptionSmart } from "../lib/tesseractEngine.ts";

// Hard-coded "known doctors" list mirror — used purely for the BMDC verification check on
// scans. Kept in sync with the Doctors page seed; in production this would query a verified
// BMDC index.
const SEEDED_BMDCS = new Set(["A-54321", "A-98765", "A-12345", "A-67890", "A-23456", "A-34567", "A-99999"]);

export function ScannerPage({ onLoginRequired, user }: { onLoginRequired: () => void; user: User | null }) {
  const { t, lang } = useLanguage();
  const [preview, setPreview] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<ExtractedPrescription | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedMed, setExpandedMed] = useState<number | null>(null);
  const [reminderSet, setReminderSet] = useState<Set<number>>(new Set());
  const [showRatingModal, setShowRatingModal] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  // Default Bangla per spec — most patients are rural BD; user can flip to EN.
  const [speechLang, setSpeechLang] = useState<"en" | "bn">("bn");
  const legibilityRecords = useStore<LegibilityRecord[]>(KEYS.LEGIBILITY_KEY, []);
  const account = useCurrentUser();
  const profile = usePatientProfile();
  const [freeTestMatches, setFreeTestMatches] = useState<MatchedTest[]>([]);
  const ocr = useTesseract();
  // True after we ran the offline OCR fallback — used to show an honest banner above the result.
  const [usedOfflineOcr, setUsedOfflineOcr] = useState(false);

  useEffect(() => { warmupVoices(); }, []);

  // BMDC verification: cross-reference against seeded + onboarded doctors only. We deliberately
  // do NOT add auto-registered external doctors here — those are derived from prescription scans
  // and many carry a SYNTHETIC id (`nb_...`) when the scan had no real BMDC. Adding them would
  // make a doctor falsely show "verified" on the second scan of the same prescription. A doctor
  // is "verified" only if their real BMDC is seeded or an approved onboarded account.
  const verifiedBmdcs = useMemo(() => {
    const set = new Set<string>(SEEDED_BMDCS);
    for (const d of listDoctors()) {
      if (d.bmdcNumber && d.approvalStatus === "approved") set.add(d.bmdcNumber);
    }
    return set;
  }, [result]);

  const extractedBmdc = result?.doctor?.bmdc?.trim() || "";
  const isBmdcKnown = !!extractedBmdc && verifiedBmdcs.has(extractedBmdc);
  const legibilityForThisDoctor = extractedBmdc ? getLegibilityForDoctor(extractedBmdc) : undefined;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setResult(null);
    setError(null);
    setUsedOfflineOcr(false);
    const reader = new FileReader();
    reader.onloadend = () => setPreview(reader.result as string);
    reader.readAsDataURL(file);
  };

  // Tier-3 offline fallback: run Tesseract OCR locally (with image preprocessing), then have
  // the local LLM repair/structure the noisy text into a real ExtractedPrescription. Falls
  // back to a pure-regex shaper if no LLM is loaded. The Scanner UI is unchanged either way —
  // just a clearly-labelled lower-confidence result.
  const runOfflineOcr = async (): Promise<ExtractedPrescription> => {
    const ocrResult = await ocrRecognize(preview!);
    return await shapeOcrToPrescriptionSmart(ocrResult);
  };

  // Shared post-scan persistence — auto-register doctor, aggregate legibility, match free tests,
  // save scan to user's history. Called from both the cloud and the OCR fallback paths so the
  // resulting UX (history, Doctors page enrichment) is identical regardless of provider.
  const persistScanResult = async (data: ExtractedPrescription) => {
    const bmdcRaw = String(data?.doctor?.bmdc || "").trim();
    const name = String(data?.doctor?.name || "").trim();
    const hospital = String(data?.doctor?.hospital || "").trim();
    if (name) {
      // For prescriptions WITHOUT a BMDC, build a canonical synthetic ID from the doctor's name
      // alone (not name+hospital — that fragments the same doctor across hospitals/OCR runs).
      // upsertExternalDoctor will additionally fuzzy-match against existing synthetic entries to
      // dedup OCR variations of the same name. We then use the RETURNED doctor's bmdc for the
      // legibility score so it always aggregates onto the canonical entry, never a duplicate.
      const idLike = bmdcRaw || syntheticDoctorId(name);
      const upserted = upsertExternalDoctor({
        bmdc: idLike,
        name,
        hospital: hospital || undefined,
        specialty: data?.doctor?.specialization || undefined,
      });
      if (typeof data?.legibility_score === "number") {
        addLegibilityScore(upserted.bmdc, Number(data.legibility_score), upserted.name, data.legibility_reason || undefined);
      }
    }

    const tests = Array.isArray(data.tests) ? data.tests : [];
    if (tests.length > 0) {
      matchTests(tests, profile.district).then(setFreeTestMatches).catch(() => setFreeTestMatches([]));
    } else {
      setFreeTestMatches([]);
    }

    if (account) {
      let imagePreview: string | undefined;
      if (preview) {
        try { imagePreview = await compressDataUrl(preview, 800, 0.6); }
        catch { imagePreview = undefined; }
      }
      saveScannedPrescription({
        userId: account.id,
        doctor: {
          name: data?.doctor?.name,
          bmdc: data?.doctor?.bmdc,
          hospital: data?.doctor?.hospital,
          specialization: data?.doctor?.specialization,
        },
        medicineCount: Array.isArray(data.medicines) ? data.medicines.length : 0,
        testCount: Array.isArray(data.tests) ? data.tests.length : 0,
        diagnosisHint: data.diagnosis_hint || undefined,
        followUp: data.follow_up || undefined,
        legibilityScore: typeof data.legibility_score === "number" ? data.legibility_score : undefined,
        imagePreview,
        extraction: data,
      });
    }
  };

  const handleUpload = async () => {
    if (!preview || isLoading) return;
    setIsLoading(true);
    setResult(null);
    setError(null);
    setUsedOfflineOcr(false);
    const base64 = preview.split(",")[1];
    try {
      // If the browser already knows it's offline, skip the network round-trip and go straight
      // to the local OCR. Saves ~10s of waiting for the fetch to time out.
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        throw new Error("OFFLINE");
      }
      const response = await fetch("/api/scan-prescription", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: base64 }),
      });
      if (!response.ok) throw new Error("Server error");
      const data = await response.json();
      if (data.error) throw new Error(data.error);
      setResult(data as ExtractedPrescription);
      await persistScanResult(data as ExtractedPrescription);
    } catch (err: any) {
      // Cloud path failed — fall back to Tesseract OCR running fully in-browser. This is the
      // offline-first promise: even with no network or a dead cloud key, the user still gets a
      // best-effort read of the prescription. The shaped result is clearly labelled (banner +
      // legibility_reason) so users know to treat it with extra care.
      try {
        const data = await runOfflineOcr();
        setResult(data);
        setUsedOfflineOcr(true);
        await persistScanResult(data);
        // Don't show an error — we recovered. Surface the fallback via the banner instead.
        setError(null);
      } catch (ocrErr: any) {
        console.error("Offline OCR fallback also failed", ocrErr);
        // Show the friendlier error: if Tesseract isn't downloaded yet, tell them where to go.
        const ocrMissing = String(ocrErr?.message || "").toLowerCase().includes("network")
          || ocr.status === "idle";
        setError(
          ocrMissing
            ? (lang === "bn"
                ? "অনলাইন স্ক্যান ব্যর্থ। অফলাইন OCR এখনো ডাউনলোড হয়নি — সেটিংসে গিয়ে অফলাইন AI ডাউনলোড করুন।"
                : "Online scan failed. Offline OCR isn't downloaded yet — open Settings and tap 'Download Offline AI'.")
            : (err?.message || "Failed to analyze. Please try with a clearer image.")
        );
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleSetReminder = (idx: number, medName: string) => {
    if (!user) { onLoginRequired(); return; }
    setReminderSet(prev => new Set([...prev, idx]));
    // In production: save to Firestore with notification schedule
  };

  // Build a flat readable script for TTS — medicines and tests only per spec. Doctor name,
  // complaint, diagnosis, and follow-up are kept on screen but not read aloud.
  const buildSpeechText = (lng: "en" | "bn"): string => {
    if (!result) return "";
    const parts: string[] = [];
    const meds = result.medicines || [];
    if (meds.length > 0) {
      parts.push(lng === "bn" ? `মোট ${meds.length}টি ওষুধ।` : `${meds.length} medicines.`);
      meds.forEach((m, i) => {
        const sched = m.schedule || { morning: 0, noon: 0, night: 0 };
        const schedText = lng === "bn"
          ? `সকাল ${sched.morning}, দুপুর ${sched.noon}, রাত ${sched.night}`
          : `morning ${sched.morning}, noon ${sched.noon}, night ${sched.night}`;
        const durRaw = lng === "bn" ? (m.duration_bn || m.duration) : (m.duration || m.duration_bn);
        const dur = durRaw ? (lng === "bn" ? `, ${durRaw} ধরে` : `, for ${durRaw}`) : "";
        const food = sched.before_food ? (lng === "bn" ? ", খাবারের আগে" : ", before food") : sched.after_food ? (lng === "bn" ? ", খাবারের পরে" : ", after food") : "";
        const head = lng === "bn"
          ? `${i + 1} নম্বর ওষুধ ${m.name}${m.strength ? " " + m.strength : ""}`
          : `Medicine ${i + 1}, ${m.name}${m.strength ? " " + m.strength : ""}`;
        parts.push(`${head}. ${schedText}${dur}${food}.`);
      });
    }
    const tests = Array.isArray(result.tests) ? result.tests : [];
    if (tests.length > 0) {
      parts.push(lng === "bn" ? `${tests.length}টি পরীক্ষা করতে বলা হয়েছে:` : `${tests.length} tests recommended:`);
      tests.forEach((tst, i) => parts.push(`${i + 1}. ${tst}.`));
    }
    return parts.join(" ");
  };

  const handleListen = () => {
    if (isSpeaking) { ttsStop(); setIsSpeaking(false); return; }
    const text = buildSpeechText(speechLang);
    if (!text) return;
    setIsSpeaking(true);
    speak(text, {
      lang: speechLang === "bn" ? "bn-BD" : "en-US",
      onEnd: () => setIsSpeaking(false),
      onError: () => setIsSpeaking(false),
    });
  };

  return (
    <div className="p-4 lg:p-8 space-y-5 pb-24 lg:max-w-3xl lg:mx-auto">
      <div className="text-center lg:text-left space-y-1">
        <h2 className="text-xl lg:text-3xl font-bold text-gray-900">{t("scan.title")}</h2>
        <p className="text-sm text-gray-500">{t("scan.subtitle")}</p>
      </div>

      {/* Upload area */}
      {!preview ? (
        <div className="w-full border-2 border-dashed border-emerald-200 rounded-3xl flex flex-col items-center justify-center bg-emerald-50/50 gap-4 py-10 px-6">
          <div className="w-16 h-16 bg-emerald-100 rounded-2xl flex items-center justify-center">
            <Camera size={32} className="text-emerald-500" />
          </div>
          <p className="text-sm font-medium text-gray-600 text-center">
            {lang === "bn" ? "প্রেসক্রিপশন বা টেস্ট রিপোর্ট আপলোড করুন" : "Upload prescription or test report"}
          </p>
          {/* Take photo with camera */}
          <label className="w-full flex items-center justify-center gap-2 bg-emerald-600 text-white py-3.5 rounded-xl font-bold cursor-pointer shadow-lg shadow-emerald-200 active:scale-95 transition-all text-sm">
            <Camera size={16} />
            {lang === "bn" ? "ক্যামেরা দিয়ে তুলুন" : "Take Photo"}
            <input
              type="file"
              className="hidden"
              accept="image/*"
              capture="environment"
              onChange={handleFileChange}
            />
          </label>
          {/* Choose from gallery / storage */}
          <label className="w-full flex items-center justify-center gap-2 bg-white border-2 border-emerald-200 text-emerald-700 py-3.5 rounded-xl font-bold cursor-pointer active:scale-95 transition-all text-sm">
            <FileText size={16} />
            {lang === "bn" ? "গ্যালারি থেকে বেছে নিন" : "Choose from Gallery"}
            <input
              type="file"
              className="hidden"
              accept="image/*,application/pdf"
              onChange={handleFileChange}
            />
          </label>
          <p className="text-[10px] text-gray-400 text-center">
            {lang === "bn" ? "JPG, PNG বা PDF সাপোর্টেড" : "JPG, PNG or PDF supported"}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="relative rounded-2xl overflow-hidden border-2 border-emerald-100 shadow-lg aspect-[4/3] bg-black">
            <img src={preview} alt="Prescription" className="w-full h-full object-contain" />
            <button onClick={() => { setPreview(null); setResult(null); setError(null); }}
              className="absolute top-3 right-3 bg-black/60 text-white p-2 rounded-full backdrop-blur-sm text-xs font-bold">✕</button>
            {result && (
              <div className={cn("absolute top-3 left-3 px-3 py-1.5 rounded-full text-[10px] font-black uppercase flex items-center gap-1",
                result.confidence > 80 ? "bg-emerald-500 text-white" : result.confidence > 50 ? "bg-orange-400 text-white" : "bg-red-500 text-white")}>
                {result.confidence > 80 ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
                {result.confidence}% {t("scan.result.match")}
              </div>
            )}
          </div>
          {!result && !isLoading && (
            <button onClick={handleUpload}
              className="w-full bg-emerald-600 text-white py-4 rounded-xl font-bold flex items-center justify-center gap-2 shadow-lg shadow-emerald-200 active:scale-95 transition-all">
              <PlayCircle size={20} /> {t("scan.btn.extract")}
            </button>
          )}
          {isLoading && (
            <div className="w-full bg-emerald-50 border border-emerald-100 py-4 rounded-xl flex flex-col items-center gap-2">
              <Loader2 size={24} className="animate-spin text-emerald-600" />
              <p className="text-sm font-medium text-emerald-700">{t("scan.btn.analyze")}</p>
              <p className="text-xs text-emerald-500">{lang === "bn" ? "হাতের লেখা পড়া হচ্ছে..." : "Reading handwriting..."}</p>
            </div>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-100 rounded-xl p-4 flex gap-3">
          <AlertCircle size={18} className="text-red-500 shrink-0 mt-0.5" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Results */}
      <AnimatePresence>
        {result && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">

            {/* Offline OCR banner — honest about the lower accuracy when Tesseract produced this
                result instead of the cloud model. */}
            {usedOfflineOcr && (
              <div className="bg-blue-50 border border-blue-200 rounded-2xl p-3 flex items-start gap-3">
                <AlertCircle size={18} className="text-blue-600 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-blue-900">
                    {lang === "bn" ? "অফলাইন OCR দিয়ে স্ক্যান হয়েছে" : "Scanned with offline OCR"}
                  </p>
                  <p className="text-xs text-blue-800 mt-0.5 leading-relaxed">
                    {lang === "bn"
                      ? "ইন্টারনেট না থাকায় Tesseract OCR ব্যবহার করা হয়েছে। এটি ছাপা লেখায় ভালো কাজ করে, হাতের লেখায় কম নির্ভুল। প্রতিটি ওষুধের নাম ও মাত্রা ডাক্তারের সাথে যাচাই করুন।"
                      : "No connection — used Tesseract OCR locally. It's reliable on printed text but less accurate on handwriting. Please verify every medicine name and dose with a doctor."}
                  </p>
                </div>
              </div>
            )}

            {/* Not signed in → this scan is NOT being saved to history. Make that visible. */}
            {!account && (
              <div className="bg-amber-50 border border-amber-200 rounded-2xl p-3 flex items-start gap-3">
                <AlertCircle size={18} className="text-amber-600 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-amber-900">
                    {lang === "bn" ? "এই স্ক্যান প্রোফাইলে সংরক্ষিত হয়নি" : "This scan is not saved to your profile"}
                  </p>
                  <p className="text-xs text-amber-800 mt-0.5 leading-relaxed">
                    {lang === "bn"
                      ? "প্রেসক্রিপশন হিস্ট্রি সংরক্ষণ করতে সাইন ইন করুন। তারপর নতুন স্ক্যানগুলো স্বয়ংক্রিয়ভাবে আপনার প্রোফাইলে যাবে।"
                      : "Sign in to keep a private history of your scans. New scans will then auto-save to your profile."}
                  </p>
                  <button
                    onClick={onLoginRequired}
                    className="mt-2 text-xs font-bold text-amber-700 hover:underline"
                  >
                    {lang === "bn" ? "এখন সাইন ইন করুন →" : "Sign in now →"}
                  </button>
                </div>
              </div>
            )}

            {/* Doctor card with verification + AI legibility */}
            <div className="bg-white border border-gray-100 rounded-2xl p-5 shadow-sm">
              <div className="text-[10px] font-bold text-emerald-600 uppercase tracking-widest mb-3 flex items-center gap-1.5">
                <FileText size={12} /> {t("scan.result.doctor_detected")}
              </div>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-lg font-bold text-gray-900">{result.doctor?.name || (lang === "bn" ? "নাম পাওয়া যায়নি" : "Name not found")}</p>
                  {result.doctor?.specialization && <p className="text-xs text-gray-500 mt-0.5">{result.doctor.specialization}</p>}
                  {result.doctor?.hospital && <p className="text-xs text-gray-500">{result.doctor.hospital}</p>}
                  <div className="flex items-center gap-1.5 mt-2">
                    <ShieldCheck size={14} className={extractedBmdc ? "text-emerald-500" : "text-gray-300"} />
                    <span className="text-xs text-gray-500 font-medium">BMDC: {extractedBmdc || (lang === "bn" ? "দেখা যাচ্ছে না" : "Not visible")}</span>
                  </div>
                </div>
                {/* Verified / Unverified badge */}
                {extractedBmdc && (
                  isBmdcKnown ? (
                    <div className="bg-emerald-50 px-3 py-2 rounded-xl text-center shrink-0 border border-emerald-200">
                      <ShieldCheck size={18} className="text-emerald-500 mx-auto" />
                      <p className="text-[9px] font-bold text-emerald-600 mt-1">{lang === "bn" ? "যাচাইকৃত" : "Verified"}</p>
                    </div>
                  ) : (
                    <div className="bg-red-50 px-3 py-2 rounded-xl text-center shrink-0 border border-red-200">
                      <ShieldAlert size={18} className="text-red-500 mx-auto" />
                      <p className="text-[9px] font-bold text-red-600 mt-1">{lang === "bn" ? "অযাচাইকৃত" : "Unverified"}</p>
                    </div>
                  )
                )}
              </div>

              {/* Unverified BMDC banner */}
              {extractedBmdc && !isBmdcKnown && (
                <div className="mt-3 bg-red-50 border border-red-100 rounded-xl p-3 flex gap-2 text-xs text-red-800">
                  <ShieldAlert size={14} className="shrink-0 mt-0.5" />
                  <span>{lang === "bn"
                    ? `BMDC #${extractedBmdc} আমাদের নিবন্ধিত ডাক্তারের তালিকায় পাওয়া যায়নি। BMDC বা DRMC রেজিস্ট্রিতে যাচাই করুন।`
                    : `BMDC #${extractedBmdc} not found in our verified doctor index. Please cross-check with BMDC or DRMC registry.`}</span>
                </div>
              )}

              {/* Listen Prescription button + EN/BN voice toggle */}
              {isTtsSupported() && result.medicines?.length > 0 && (
                <div className="mt-3 flex items-stretch gap-2">
                  <button
                    onClick={handleListen}
                    className={cn(
                      "flex-1 py-2.5 rounded-xl text-sm font-bold flex items-center justify-center gap-2 transition-colors",
                      isSpeaking ? "bg-red-50 text-red-700 border border-red-200" : "bg-blue-600 text-white hover:bg-blue-500"
                    )}
                  >
                    {isSpeaking
                      ? <><Square size={14} /> {lang === "bn" ? "থামান" : "Stop"}</>
                      : <><Volume2 size={14} /> {lang === "bn" ? "প্রেসক্রিপশন শুনুন" : "Listen to Prescription"}</>}
                  </button>
                  <div className="flex bg-gray-100 rounded-xl p-1 text-[11px] font-bold shrink-0">
                    <button
                      onClick={() => { if (isSpeaking) { ttsStop(); setIsSpeaking(false); } setSpeechLang("bn"); }}
                      className={cn("px-3 rounded-lg transition-colors", speechLang === "bn" ? "bg-white shadow-sm text-blue-700" : "text-gray-500")}
                    >
                      বাংলা
                    </button>
                    <button
                      onClick={() => { if (isSpeaking) { ttsStop(); setIsSpeaking(false); } setSpeechLang("en"); }}
                      className={cn("px-3 rounded-lg transition-colors", speechLang === "en" ? "bg-white shadow-sm text-blue-700" : "text-gray-500")}
                    >
                      EN
                    </button>
                  </div>
                </div>
              )}

              {result.follow_up && (
                <div className="mt-3 bg-blue-50 rounded-xl px-3 py-2">
                  <p className="text-[10px] font-bold text-blue-600 uppercase tracking-wider">{lang === "bn" ? "ফলো-আপ" : "Follow-up"}</p>
                  <p className="text-xs text-blue-800 mt-0.5">{result.follow_up}</p>
                </div>
              )}
              {result.diagnosis_hint && (
                <div className="mt-2 bg-purple-50 rounded-xl px-3 py-2 flex gap-2">
                  <Stethoscope size={12} className="text-purple-600 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-[10px] font-bold text-purple-600 uppercase tracking-wider">{lang === "bn" ? "সম্ভাব্য রোগ" : "Likely diagnosis"}</p>
                    <p className="text-xs text-purple-800 mt-0.5">{result.diagnosis_hint}</p>
                  </div>
                </div>
              )}
            </div>

            {/* Medicines */}
            <div className="space-y-3">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest px-1">
                {t("scan.result.meds_title")} ({result.medicines?.length || 0})
              </p>
              {(() => {
                const meds = result.medicines || [];
                // Long list → compact rows by default, expanded grid only on tap.
                const useCompact = meds.length > 3;
                return meds.map((med: ExtractedMedicine, i: number) => (
                  <motion.div
                    key={i}
                    layout
                    className="group bg-white border border-gray-100 rounded-2xl shadow-sm overflow-hidden hover:border-emerald-200 hover:shadow-md transition-all"
                  >
                    <button
                      onClick={() => setExpandedMed(expandedMed === i ? null : i)}
                      className="w-full flex items-center gap-3 px-3 py-2.5 text-left"
                      aria-expanded={expandedMed === i}
                    >
                      <div className={cn("bg-emerald-50 rounded-lg flex items-center justify-center shrink-0", useCompact ? "w-8 h-8" : "w-10 h-10")}>
                        <Pill size={useCompact ? 14 : 18} className="text-emerald-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-1.5 flex-wrap">
                          <p className={cn("font-bold text-gray-900 truncate", useCompact ? "text-sm" : "text-base")}>{med.name}</p>
                          {med.strength && <span className="text-[10px] font-bold text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded shrink-0">{med.strength}</span>}
                        </div>
                        {(() => {
                          const dur = lang === "bn" ? (med.duration_bn || med.duration) : (med.duration || med.duration_bn);
                          return (
                            <>
                              {!useCompact && dur && (
                                <p className="text-[11px] text-gray-500">
                                  <Clock size={10} className="inline -mt-0.5" /> {dur}
                                </p>
                              )}
                              <div className="flex items-center gap-2 flex-wrap mt-1">
                                <DoseGrid schedule={med.schedule || { morning: 0, noon: 0, night: 0 }} lang={lang as "en" | "bn"} compact />
                                {useCompact && dur && (
                                  <span className="text-[10px] text-gray-500 font-medium">· {dur}</span>
                                )}
                              </div>
                            </>
                          );
                        })()}
                      </div>
                      <span className={cn(
                        "shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold border transition-colors",
                        expandedMed === i
                          ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                          : "bg-blue-50 text-blue-700 border-blue-200 group-hover:bg-blue-100 group-hover:border-blue-300"
                      )}>
                        {expandedMed === i
                          ? <><ChevronUp size={11} /> {lang === "bn" ? "কম দেখুন" : "See less"}</>
                          : <><ChevronDown size={11} /> {lang === "bn" ? "বিস্তারিত দেখুন" : "See details"}</>}
                      </span>
                    </button>

                    <AnimatePresence>
                      {expandedMed === i && (
                        <motion.div initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }} className="overflow-hidden">
                          <div className="px-3 pb-3 space-y-2.5 border-t border-gray-50 pt-2.5">
                            <DoseGrid schedule={med.schedule || { morning: 0, noon: 0, night: 0 }} lang={lang as "en" | "bn"} />
                            {(med.purpose_english || med.purpose_bangla) && (
                              <p className="text-xs text-emerald-700 leading-relaxed bg-emerald-50 border border-emerald-100 rounded-lg p-2">
                                {lang === "bn" ? (med.purpose_bangla || med.purpose_english) : (med.purpose_english || med.purpose_bangla)}
                              </p>
                            )}
                            {(med.warnings || med.warnings_bn) && (
                              <div className="bg-orange-50 rounded-lg p-2 flex gap-2">
                                <AlertCircle size={14} className="text-orange-500 shrink-0 mt-0.5" />
                                <p className="text-xs text-orange-800">
                                  {lang === "bn" ? (med.warnings_bn || med.warnings) : (med.warnings || med.warnings_bn)}
                                </p>
                              </div>
                            )}
                            <button onClick={() => handleSetReminder(i, med.name)}
                              disabled={reminderSet.has(i)}
                              className={cn("w-full py-2 rounded-lg text-xs font-bold flex items-center justify-center gap-2 transition-all",
                                reminderSet.has(i) ? "bg-emerald-50 text-emerald-600 border border-emerald-200" : "bg-gray-900 text-white active:scale-95")}>
                              {reminderSet.has(i) ? <><CheckCircle2 size={14} /> {lang === "bn" ? "রিমাইন্ডার সেট হয়েছে" : "Reminder Set!"}</> : <><Bell size={14} /> {lang === "bn" ? "রিমাইন্ডার সেট করুন" : "Set Reminder"}</>}
                            </button>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                ));
              })()}
            </div>

            {/* Tests */}
            {Array.isArray(result.tests) && result.tests.length > 0 && (
              <div className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm">
                <p className="text-[10px] font-bold text-blue-600 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                  <FlaskConical size={12} /> {lang === "bn" ? "পরীক্ষা সুপারিশ" : "Recommended tests"}
                </p>
                <ul className="space-y-1">
                  {result.tests.map((tst, i) => (
                    <li key={i} className="text-sm text-gray-700 flex gap-2">
                      <span className="text-blue-500">•</span>{tst}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Free / low-cost test locations matched to the recommended tests. Always shown when
                the prescription has tests — falls back to a government-facility pointer when no
                seeded provider matches the patient's district, so the patient is never left
                without guidance on where to get tests affordably. */}
            {Array.isArray(result.tests) && result.tests.length > 0 && (
              <div className="bg-blue-50 border border-blue-100 rounded-2xl p-4 shadow-sm">
                <p className="text-[10px] font-bold text-blue-700 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                  <MapPin size={12} /> {lang === "bn" ? "বিনামূল্যে / কম খরচে পরীক্ষা" : "Free / low-cost test locations"}
                </p>

                {freeTestMatches.length > 0 ? (
                  <div className="space-y-3">
                    {freeTestMatches.map((m, i) => (
                      <div key={i} className="bg-white border border-blue-100 rounded-xl p-3">
                        <p className="text-xs font-bold text-blue-800 mb-1.5">{m.test}</p>
                        <div className="space-y-1.5">
                          {m.providers.slice(0, 3).map((p) => (
                            <div key={p.id} className="text-[12px] text-gray-700">
                              <p className="font-bold text-gray-900">{lang === "bn" ? p.name_bn : p.name_en}</p>
                              <p className="text-[11px] text-gray-500 leading-snug">{lang === "bn" ? p.note_bn : p.note_en}</p>
                              <p className="text-[10px] text-gray-500 mt-0.5 flex items-center gap-2 flex-wrap">
                                <span className="inline-flex items-center gap-1"><Clock size={10} />{lang === "bn" ? p.hours_bn : p.hours_en}</span>
                                {p.phone && (
                                  <a href={`tel:${p.phone}`} className="inline-flex items-center gap-1 text-blue-700 font-bold">
                                    ☎ {p.phone}
                                  </a>
                                )}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  // Fallback — no seeded provider matched, but these tests are still routinely free
                  // or low-cost at the nearest government facility.
                  <div className="bg-white border border-blue-100 rounded-xl p-3 text-[12px] text-gray-700 space-y-1.5">
                    <p className="font-bold text-gray-900">
                      {lang === "bn" ? "নিকটস্থ সরকারি স্বাস্থ্যকেন্দ্র" : "Your nearest government health facility"}
                    </p>
                    <p className="text-[11px] text-gray-500 leading-snug">
                      {lang === "bn"
                        ? "এই পরীক্ষাগুলো সাধারণত উপজেলা স্বাস্থ্য কমপ্লেক্স বা জেলা সদর হাসপাতালে বিনামূল্যে বা খুব কম খরচে করা যায়। সরকারি অ্যাম্বুলেন্স/তথ্যের জন্য ৯৯৯ অথবা স্বাস্থ্য বাতায়ন ১৬২৬৩-এ কল করুন।"
                        : "These tests are usually available free or at very low cost at your Upazila Health Complex or District Sadar Hospital. For directions or info, call 999, or the national health line Shastho Batayon at 16263."}
                    </p>
                    <a href="tel:16263" className="inline-flex items-center gap-1 text-blue-700 font-bold text-[11px]">☎ 16263 · {lang === "bn" ? "স্বাস্থ্য বাতায়ন" : "Shastho Batayon"}</a>
                  </div>
                )}

                <p className="text-[10px] text-blue-700/60 mt-3 italic leading-relaxed">
                  {lang === "bn"
                    ? "যাওয়ার আগে স্থানীয় শাখার সাথে যোগাযোগ করে নিশ্চিত করুন। বিনামূল্যে সেবা সাধারণত সরকারি NID প্রয়োজন।"
                    : "Call the local branch to confirm availability before travelling. Free services usually require a national ID."}
                </p>
              </div>
            )}

            {/* Nutrition guidelines */}
            {Array.isArray(result.nutrition_guidelines) && result.nutrition_guidelines.length > 0 && (
              <div className="bg-emerald-50 border border-emerald-100 rounded-2xl p-4 shadow-sm">
                <p className="text-[10px] font-bold text-emerald-700 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                  <Apple size={12} /> {lang === "bn" ? "পুষ্টি নির্দেশিকা" : "Nutrition guidelines"}
                </p>
                <ul className="space-y-2">
                  {(lang === "bn" && Array.isArray(result.nutrition_guidelines_bn) && result.nutrition_guidelines_bn.length > 0
                    ? result.nutrition_guidelines_bn
                    : result.nutrition_guidelines
                  ).map((tip, i) => (
                    <li key={i} className="text-sm text-emerald-900 leading-relaxed flex gap-2">
                      <span>•</span>{tip}
                    </li>
                  ))}
                </ul>
                <p className="text-[10px] text-emerald-700/60 mt-3 italic">
                  {lang === "bn"
                    ? "এটি AI পরামর্শ। ব্যক্তিগত খাদ্য তালিকার জন্য পুষ্টিবিদ বা ডাক্তারের সাথে যাচাই করুন।"
                    : "AI-generated. Verify personalised diet plans with a doctor or dietitian."}
                </p>
              </div>
            )}

            {/* Patient notes */}
            {result.patient_notes && (
              <div className="bg-blue-50 border border-blue-100 rounded-2xl p-4">
                <p className="text-[10px] font-bold text-blue-600 uppercase tracking-wider mb-1">{lang === "bn" ? "ডাক্তারের নির্দেশনা" : "Doctor's Notes"}</p>
                <p className="text-sm text-blue-800">{result.patient_notes}</p>
              </div>
            )}

            {/* Rate doctor CTA */}
            {result.doctor?.name && (
              <button onClick={() => setShowRatingModal(true)}
                className="w-full py-3 rounded-xl border border-emerald-200 text-emerald-700 text-sm font-bold flex items-center justify-center gap-2 bg-emerald-50 active:scale-95 transition-all">
                ⭐ {lang === "bn" ? "প্রেসক্রিপশন রেটিং দিন" : "Rate the Prescription"}
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Doctor Rating Modal */}
      <AnimatePresence>
        {showRatingModal && result?.doctor && (
          <DoctorRatingModal
            doctor={result.doctor}
            lang={lang}
            onLoginRequired={onLoginRequired}
            onClose={() => setShowRatingModal(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function DoctorRatingModal({ doctor, lang, onLoginRequired, onClose }: any) {
  // Single-question rating: how easy was the prescription to read?
  const [legibleScore, setLegibleScore] = useState(0);
  const [comment, setComment] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Read the locally-mapped account (id = Firebase uid). Avoid the Firebase User prop whose
  // `.id` is `undefined` — that was breaking review persistence.
  const account = useCurrentUser();

  const handleSubmit = async () => {
    if (!account) { onLoginRequired(); return; }
    if (legibleScore === 0) return;
    setSubmitting(true);
    try {
      // Best-effort log to the server endpoint. Abort after 8s so a slow/stalled connection can't
      // hold the request open indefinitely — local + Firestore persistence below is the real
      // source of truth, so timing out here is harmless.
      const rateAbort = new AbortController();
      const rateTimer = setTimeout(() => rateAbort.abort(), 8000);
      fetch("/api/rate-doctor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bmdc: doctor.bmdc,
          doctorName: doctor.name,
          ratings: { legible: legibleScore },
          comment,
        }),
        signal: rateAbort.signal,
      })
        .catch(() => { /* ignore — local + Firestore persistence below is the source of truth */ })
        .finally(() => clearTimeout(rateTimer));
      // Persist to the signed-in user's review history so it shows up on Profile + Firestore.
      saveSubmittedReview({
        userId: account.id,
        bmdc: doctor.bmdc,
        doctorName: doctor.name,
        legibleScore,
        comment: comment || undefined,
      });
      setSubmitted(true);
    } catch { setSubmitted(true); }
    finally { setSubmitting(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm">
      <motion.div initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
        className="w-full max-w-md bg-white rounded-t-3xl p-6 space-y-5 max-h-[85vh] overflow-y-auto">
        {submitted ? (
          <div className="text-center py-8 space-y-4">
            <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto">
              <CheckCircle2 size={32} className="text-emerald-600" />
            </div>
            <h3 className="text-lg font-bold text-gray-900">{lang === "bn" ? "ধন্যবাদ!" : "Thank you!"}</h3>
            <p className="text-sm text-gray-500">{lang === "bn" ? "আপনার বেনামী রেটিং স্বাস্থ্যসেবা উন্নত করতে সাহায্য করবে।" : "Your anonymous rating helps improve healthcare quality."}</p>
            <button onClick={onClose} className="w-full bg-emerald-600 text-white py-3 rounded-xl font-bold">{lang === "bn" ? "বন্ধ করুন" : "Close"}</button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-bold text-gray-900">{lang === "bn" ? "প্রেসক্রিপশন রেটিং" : "Prescription Rating"}</h3>
                <p className="text-xs text-gray-400">{doctor.name} · {lang === "bn" ? "সম্পূর্ণ익명" : "Completely anonymous"}</p>
              </div>
              <button onClick={onClose} className="text-gray-400 text-xl font-bold">✕</button>
            </div>
            <div className="space-y-4">
              <div>
                <p className="text-sm font-medium text-gray-700 mb-2">
                  {lang === "bn" ? "প্রেসক্রিপশন পড়া কতটা সহজ ছিল?" : "How easy was it to read the prescription?"}
                </p>
                <div className="flex gap-2">
                  {[1, 2, 3, 4, 5].map(star => (
                    <button key={star} onClick={() => setLegibleScore(star)}
                      className={cn("flex-1 h-12 rounded-xl text-lg transition-all font-bold",
                        legibleScore >= star ? "bg-amber-400 text-white" : "bg-gray-100 text-gray-300")}>
                      ★
                    </button>
                  ))}
                </div>
                <div className="flex justify-between text-[10px] font-medium text-gray-400 mt-1">
                  <span>{lang === "bn" ? "একদম পড়া যায়নি" : "Couldn't read at all"}</span>
                  <span>{lang === "bn" ? "খুব পরিষ্কার" : "Very clear"}</span>
                </div>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-700 mb-2">{lang === "bn" ? "অতিরিক্ত মন্তব্য (ঐচ্ছিক)" : "Additional comment (optional)"}</p>
                <textarea value={comment} onChange={e => setComment(e.target.value)} rows={3}
                  placeholder={lang === "bn" ? "আপনার অভিজ্ঞতা সংক্ষেপে লিখুন..." : "Briefly share your experience..."}
                  className="w-full bg-gray-50 border border-gray-100 rounded-xl p-3 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-none" />
              </div>
            </div>
            <button onClick={handleSubmit} disabled={submitting || legibleScore === 0}
              className="w-full bg-emerald-600 text-white py-3 rounded-xl font-bold flex items-center justify-center gap-2 disabled:opacity-50">
              {submitting ? <Loader2 size={18} className="animate-spin" /> : null}
              {lang === "bn" ? "বেনামে জমা দিন" : "Submit Anonymously"}
            </button>
            <p className="text-center text-[10px] text-gray-400">{lang === "bn" ? "আপনার পরিচয় কখনই প্রকাশ করা হবে না" : "Your identity will never be revealed"}</p>
          </>
        )}
      </motion.div>
    </div>
  );
}
