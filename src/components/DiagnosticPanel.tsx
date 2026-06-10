import { useEffect, useState } from "react";
import { AlertTriangle, MapPin, Loader2, ShieldAlert, Phone, HelpCircle } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { useLanguage } from "../lib/LanguageContext.tsx";
import { runDiagnostic, getDiagnosticCandidates } from "../lib/diagnostic.ts";
import { usePatientProfile } from "../lib/profile.ts";
import type { DiagnosticResult } from "../lib/types.ts";

interface DiagnosticPanelProps {
  symptoms: string;
}

// The "analyzing → verdict" panel. Renders alongside the chat reply. Fully offline.
//
// Flow: we call getDiagnosticCandidates to narrow down the patient's condition (BM25 over the
// medical KB), then automatically lock onto the strongest candidate and run the full diagnostic.
// No confirmation step — rural users often can't read disease names, so we don't ask them to
// pick. The diagnostic engine uses the top candidate's id and weights the verdict with the
// patient profile + regional disease trend + safety classifier.
export function DiagnosticPanel({ symptoms }: DiagnosticPanelProps) {
  const { t, lang } = useLanguage();
  const profile = usePatientProfile();
  const [phase, setPhase] = useState<"analyzing" | "ready" | "error">("analyzing");
  const [result, setResult] = useState<DiagnosticResult | null>(null);

  useEffect(() => {
    let mounted = true;
    setPhase("analyzing");
    setResult(null);

    (async () => {
      try {
        // Step 1 — narrow down: fetch the top-3 candidate conditions from the KB.
        const { candidates, forceImmediate } = await getDiagnosticCandidates(symptoms, lang as "en" | "bn");
        if (!mounted) return;
        // Step 2 — pick the strongest candidate (or no force when it's a clear emergency / no
        // candidates — runDiagnostic falls back to its own top-BM25 match in that case).
        const top = candidates[0]?.id;
        const forcedEntryId = !forceImmediate && top ? top : undefined;
        // Step 3 — run the full diagnostic locked onto that entry, factoring in patient profile
        // + regional disease trend + safety verdict.
        const r = await runDiagnostic({ symptoms, profile, lang: lang as "en" | "bn", forcedEntryId });
        if (!mounted) return;
        setResult(r);
        setPhase("ready");
      } catch {
        if (mounted) setPhase("error");
      }
    })();

    return () => { mounted = false; };
  }, [symptoms, profile.updatedAt, lang]);

  if (phase === "error") return null;

  return (
    <div className="w-full space-y-3">
      <AnimatePresence mode="wait">
        {phase === "analyzing" && (
          <motion.div
            key="analyzing"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="rounded-2xl border border-emerald-100 bg-emerald-50/60 px-4 py-3 flex items-center gap-3"
          >
            <Loader2 size={16} className="animate-spin text-emerald-700 shrink-0" />
            <p className="text-xs font-bold text-emerald-800 uppercase tracking-widest">
              {t("diag.running")}
            </p>
          </motion.div>
        )}

        {phase === "ready" && result && result.lowConfidence && (
          <motion.div
            key="low-confidence"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <LowConfidenceCard reason={lang === "bn" ? result.reason_bn : result.reason_en} symptoms={symptoms} lang={lang as "en" | "bn"} />
          </motion.div>
        )}

        {phase === "ready" && result && !result.lowConfidence && (
          <motion.div
            key="ready"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <RiskVerdictCard result={result} t={t} lang={lang as "en" | "bn"} symptoms={symptoms} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Honest "I don't have enough to commit to a verdict" card. Rendered when BM25 confidence is
// below the abstention threshold (off-topic follow-ups, very vague descriptions, topic change
// to something not yet detailed enough). No percentage, no fabricated condition name.
function LowConfidenceCard({ reason, symptoms, lang }: { reason: string; symptoms: string; lang: "en" | "bn" }) {
  const heardLabel = lang === "bn" ? "আপনি লিখেছেন" : "What I heard";
  const reported = symptoms.trim().replace(/\s+/g, " ").slice(0, 140);
  const ellipsis = symptoms.trim().length > 140 ? "…" : "";
  return (
    <div className="rounded-3xl border border-amber-100 bg-amber-50 p-5 shadow-sm">
      <header className="flex items-start gap-3 mb-3">
        <div className="w-10 h-10 rounded-2xl border border-amber-100 bg-white/70 flex items-center justify-center shrink-0 text-amber-700">
          <HelpCircle size={22} />
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-amber-700/80">
            {lang === "bn" ? "তথ্য আরো দরকার" : "More info needed"}
          </p>
          <p className="text-sm text-amber-900 mt-1 leading-relaxed">{reason}</p>
        </div>
      </header>
      {reported && (
        <div className="rounded-xl bg-white/70 border border-amber-100 p-3">
          <p className="text-[10px] font-bold uppercase tracking-widest text-amber-700/80">{heardLabel}</p>
          <p className="text-xs text-amber-900 mt-1 italic">{`"${reported}${ellipsis}"`}</p>
        </div>
      )}
    </div>
  );
}

function RiskVerdictCard({
  result,
  t,
  lang,
  symptoms,
}: {
  result: DiagnosticResult;
  t: (k: string) => string;
  lang: "en" | "bn";
  symptoms: string;
}) {
  const tone =
    result.riskLevel === "high"
      ? { bg: "bg-red-50", border: "border-red-100", chip: "bg-red-500/10 text-red-700 border-red-200", text: "text-red-900", muted: "text-red-700/70" }
      : result.riskLevel === "medium"
      ? { bg: "bg-amber-50", border: "border-amber-100", chip: "bg-amber-500/10 text-amber-700 border-amber-200", text: "text-amber-900", muted: "text-amber-700/70" }
      : { bg: "bg-emerald-50", border: "border-emerald-100", chip: "bg-emerald-500/10 text-emerald-700 border-emerald-200", text: "text-emerald-900", muted: "text-emerald-700/70" };

  const ctaTone =
    result.riskLevel === "high"
      ? "bg-red-600 hover:bg-red-500"
      : result.riskLevel === "medium"
      ? "bg-amber-600 hover:bg-amber-500"
      : "bg-emerald-600 hover:bg-emerald-500";

  const riskLabel =
    result.riskLevel === "high"
      ? lang === "bn" ? "উচ্চ ঝুঁকি" : "High risk"
      : result.riskLevel === "medium"
      ? lang === "bn" ? "মধ্যম ঝুঁকি" : "Medium risk"
      : lang === "bn" ? "কম ঝুঁকি" : "Low risk";

  // Sanity-check helpers so the verdict is auditable instead of a bare percentage.
  // 1) "What I heard" — echo the patient's own words so they can confirm we read them right.
  // 2) "Likely" — name the matched KB condition in their language. Bare numbers are scary;
  //    a named condition tied to a tier ("Likely: <name>, Low risk") is honest and explainable.
  const reported = symptoms.trim().replace(/\s+/g, " ").slice(0, 140);
  const ellipsis = symptoms.trim().length > 140 ? "…" : "";
  const matchedTitle = result.matchedTitle
    ? lang === "bn" ? result.matchedTitle.bn : result.matchedTitle.en
    : null;

  return (
    <div className={`rounded-3xl border ${tone.border} ${tone.bg} p-5 shadow-sm`}>
      <header className="flex items-start justify-between gap-3 mb-3">
        <div>
          <p className={`text-3xl font-black ${tone.text}`}>
            {result.riskScore}% <span className="text-lg font-bold">— {riskLabel}</span>
          </p>
          {matchedTitle && (
            <p className={`text-xs font-medium mt-1 ${tone.muted}`}>
              {(lang === "bn" ? "সম্ভাব্য: " : "Likely: ") + matchedTitle}
            </p>
          )}
        </div>
        <div className={`w-12 h-12 rounded-2xl border ${tone.border} ${tone.bg} flex items-center justify-center shrink-0`}>
          <AlertTriangle className={tone.text} size={26} />
        </div>
      </header>

      {/* What I heard — echoes the patient's own words so they can verify what we matched. */}
      {reported && (
        <div className={`rounded-xl bg-white/60 border ${tone.border} p-3 mb-3`}>
          <p className={`text-[10px] font-bold uppercase tracking-widest ${tone.muted}`}>
            {lang === "bn" ? "আপনি লিখেছেন" : "What I heard"}
          </p>
          <p className={`text-xs ${tone.text} mt-1 italic`}>{`"${reported}${ellipsis}"`}</p>
        </div>
      )}

      {/* Warning */}
      {(result.warning_en || result.warning_bn) && (
        <div className="mt-3 rounded-xl bg-red-600 text-white p-4">
          <p className="text-xs font-bold flex items-start gap-2">
            <ShieldAlert size={14} className="shrink-0 mt-0.5" />
            <span>
              <span className="opacity-80">{t("diag.warning")}: </span>
              {lang === "bn" ? result.warning_bn : result.warning_en}
            </span>
          </p>
          <p className="text-xl font-black mt-2">
            {lang === "bn" ? result.cta_bn : result.cta_en}
          </p>
        </div>
      )}
      {!(result.warning_en || result.warning_bn) && (
        <button
          className={`mt-3 w-full ${ctaTone} text-white rounded-xl py-3 font-bold text-sm transition-colors`}
        >
          {lang === "bn" ? result.cta_bn : result.cta_en}
        </button>
      )}

      {/* Nearest hospitals */}
      {result.nearestHospitals.length > 0 && (
        <div className="mt-3 space-y-2">
          <p className={`text-[10px] font-bold uppercase tracking-widest ${tone.muted}`}>
            {t("diag.nearestHospitals")}
          </p>
          {result.nearestHospitals.map((nh) => (
            <div
              key={nh.hospital.id}
              className="bg-white border border-gray-100 rounded-xl p-3 flex items-center gap-3"
            >
              <div className="w-10 h-10 bg-white border border-gray-100 rounded-xl flex items-center justify-center text-gray-500 shrink-0">
                <MapPin size={18} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                  {t("diag.nearestHospital")}
                </p>
                <p className="text-sm font-bold text-gray-900 truncate">
                  {lang === "bn" ? nh.hospital.name_bn : nh.hospital.name_en}
                </p>
                <p className="text-[11px] text-gray-500">
                  {nh.distanceKm} {lang === "bn" ? "কিমি" : "km"} · {nh.hospital.district}
                  {nh.source !== "geolocation" && (
                    <span className="opacity-60"> · {nh.source === "district" ? (lang === "bn" ? "জেলা অনুমান" : "by district") : (lang === "bn" ? "আনুমানিক" : "approx.")}</span>
                  )}
                </p>
                {/* Visible contact number — tappable to dial. */}
                {nh.hospital.phone ? (
                  <a
                    href={`tel:${nh.hospital.phone}`}
                    className="mt-1 inline-flex items-center gap-1.5 text-xs font-bold text-emerald-700 hover:text-emerald-800"
                  >
                    <Phone size={12} /> {nh.hospital.phone}
                  </a>
                ) : (
                  <p className="mt-1 text-[11px] text-gray-400">
                    {lang === "bn" ? "ফোন নম্বর নেই · জরুরি হলে ৯৯৯" : "No phone listed · call 999 for emergencies"}
                  </p>
                )}
              </div>
              {nh.hospital.phone && (
                <a
                  href={`tel:${nh.hospital.phone}`}
                  className="shrink-0 inline-flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-lg px-3 py-2"
                  aria-label={lang === "bn" ? "কল করুন" : "Call"}
                >
                  <Phone size={14} /> {lang === "bn" ? "কল" : "Call"}
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
