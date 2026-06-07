import { useEffect, useState } from "react";
import { Activity, AlertTriangle, MapPin, Loader2, ChevronRight, ShieldAlert, HelpCircle, Phone } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { useLanguage } from "../lib/LanguageContext.tsx";
import { runDiagnostic, getDiagnosticCandidates, type DiagnosticCandidate } from "../lib/diagnostic.ts";
import { usePatientProfile } from "../lib/profile.ts";
import type { DiagnosticResult } from "../lib/types.ts";

interface DiagnosticPanelProps {
  symptoms: string;
  onSetProfile?: () => void;
}

// The "analyzing → confirm → verdict" panel. Renders alongside the chat reply. Fully offline.
//
// Key design: we NEVER silently commit to the top keyword match. We surface the top 2-3 candidate
// conditions and let the patient confirm the closest one — the patient is the authority on their
// own symptoms. This fixes the "patient says X, system understands Y" mismatch. Only for clear
// emergencies (safety classifier = critical) do we skip the confirm step and go straight to the
// verdict.
export function DiagnosticPanel({ symptoms, onSetProfile }: DiagnosticPanelProps) {
  const { t, lang } = useLanguage();
  const profile = usePatientProfile();
  const [phase, setPhase] = useState<"analyzing" | "confirm" | "ready" | "dismissed" | "error">("analyzing");
  const [result, setResult] = useState<DiagnosticResult | null>(null);
  const [candidates, setCandidates] = useState<DiagnosticCandidate[]>([]);

  // Step 1 — fetch candidates. If it's a clear emergency, run the full verdict immediately.
  useEffect(() => {
    let mounted = true;
    setPhase("analyzing");
    setResult(null);
    setCandidates([]);
    getDiagnosticCandidates(symptoms, lang as "en" | "bn")
      .then((c) => {
        if (!mounted) return;
        if (c.forceImmediate || c.candidates.length <= 1) {
          // Emergency or only one plausible match → skip confirmation, go straight to verdict.
          return runDiagnostic({ symptoms, profile, lang: lang as "en" | "bn" }).then((r) => {
            if (!mounted) return;
            setResult(r);
            setPhase("ready");
          });
        }
        // Ambiguous → ask the patient to confirm which condition is closest.
        setCandidates(c.candidates);
        setPhase("confirm");
      })
      .catch(() => { if (mounted) setPhase("error"); });
    return () => { mounted = false; };
  }, [symptoms, profile.updatedAt, lang]);

  // Step 2 — patient confirmed a condition → run the full diagnostic locked to it.
  const confirmCandidate = (entryId: string) => {
    setPhase("analyzing");
    runDiagnostic({ symptoms, profile, lang: lang as "en" | "bn", forcedEntryId: entryId })
      .then((r) => { setResult(r); setPhase("ready"); })
      .catch(() => setPhase("error"));
  };

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
            className="bg-emerald-950 text-white rounded-3xl p-5 shadow-xl"
          >
            <header className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-emerald-800/60 rounded-xl flex items-center justify-center">
                <Activity size={20} className="text-emerald-300" />
              </div>
              <div>
                <p className="text-sm font-bold text-white">{t("diag.title")}</p>
                <p className="text-[10px] text-emerald-300/80">{t("diag.subtitle")}</p>
              </div>
            </header>

            <div className="space-y-2">
              <SkeletonRow label={t("diag.row.profile")} />
              <SkeletonRow label={t("diag.row.regional")} />
              <SkeletonRow label={t("diag.row.who")} />
            </div>

            <div className="mt-4 flex items-center justify-center gap-2 text-[10px] font-bold text-emerald-300 uppercase tracking-widest">
              <Loader2 size={12} className="animate-spin" /> {t("diag.running")}
            </div>
          </motion.div>
        )}

        {phase === "confirm" && (
          <motion.div
            key="confirm"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="bg-emerald-950 text-white rounded-3xl p-5 shadow-xl"
          >
            <header className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 bg-emerald-800/60 rounded-xl flex items-center justify-center">
                <HelpCircle size={20} className="text-emerald-300" />
              </div>
              <div>
                <p className="text-sm font-bold text-white">
                  {lang === "bn"
                    ? "আপনার সমস্যা কোনটির সাথে বেশি মেলে?"
                    : "Which one feels closest to what you have?"}
                </p>
                <p className="text-[10px] text-emerald-300/80">
                  {lang === "bn"
                    ? "রোগের নাম নয় — শুধু লক্ষণ মিলিয়ে দেখুন"
                    : "Not disease names — just match the symptoms"}
                </p>
              </div>
            </header>

            <div className="space-y-2 mt-3">
              {candidates.map((c) => {
                // Subtle severity tinting so the patient gets a colour cue, but no scary disease
                // label. Mild = calm emerald, urgent = amber, critical = red. Order is mild-first
                // by default so the most common explanation appears at the top.
                const sevTone =
                  c.severity === "critical" ? "border-red-400/40 bg-red-500/10"
                  : c.severity === "urgent" ? "border-amber-400/40 bg-amber-500/10"
                  : "border-emerald-400/30 bg-emerald-500/10";
                return (
                  <button
                    key={c.id}
                    onClick={() => confirmCandidate(c.id)}
                    className={`w-full text-left border ${sevTone} rounded-xl px-4 py-3 flex items-start justify-between gap-3 hover:bg-white/10 transition-colors`}
                  >
                    <span className="text-xs text-white leading-relaxed">{lang === "bn" ? c.hint_bn : c.hint_en}</span>
                    <ChevronRight size={16} className="text-white/50 shrink-0 mt-0.5" />
                  </button>
                );
              })}
              {/* "None of these" — never force a wrong pick. Dismiss and ask the patient to add
                  detail in the chat so the AI can re-assess. */}
              <button
                onClick={() => setPhase("dismissed")}
                className="w-full text-left border border-white/10 rounded-xl px-4 py-3 text-xs text-emerald-300/80 hover:bg-white/5 transition-colors"
              >
                {lang === "bn" ? "কোনোটিই না / আরও বর্ণনা করব →" : "None of these / describe more →"}
              </button>
            </div>
          </motion.div>
        )}

        {phase === "dismissed" && (
          <motion.div
            key="dismissed"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="bg-emerald-50 border border-emerald-100 rounded-2xl p-4 flex items-start gap-3"
          >
            <HelpCircle size={18} className="text-emerald-600 shrink-0 mt-0.5" />
            <p className="text-xs text-emerald-900 leading-relaxed">
              {lang === "bn"
                ? "ঠিক আছে। আপনার সমস্যাটি আরও একটু বিস্তারিত লিখুন — কত দিন ধরে, কোথায়, আর কোনো লক্ষণ আছে কিনা। আমি আবার দেখে পরামর্শ দেব।"
                : "No problem. Please describe your symptoms in a bit more detail in the chat — how long, where, and any other signs. I'll reassess and advise you."}
            </p>
          </motion.div>
        )}

        {phase === "ready" && result && (
          <motion.div
            key="ready"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-3"
          >
            {/* Factor breakdown card (dark) */}
            <div className="bg-emerald-950 text-white rounded-3xl p-5 shadow-xl">
              <header className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 bg-emerald-800/60 rounded-xl flex items-center justify-center">
                  <Activity size={20} className="text-emerald-300" />
                </div>
                <div>
                  <p className="text-sm font-bold text-white">{t("diag.title")}</p>
                  <p className="text-[10px] text-emerald-300/80">{t("diag.subtitle")}</p>
                </div>
              </header>

              <div className="space-y-2">
                {result.factors.map((f, i) => (
                  <div key={i} className="bg-white/5 border border-white/10 rounded-xl px-3 py-2 flex items-start gap-3">
                    <p className="text-[11px] text-emerald-300/80 font-medium shrink-0 min-w-[110px]">
                      {lang === "bn" ? f.label_bn : f.label_en}
                    </p>
                    <p className="text-xs text-white/90 text-right ml-auto">
                      {lang === "bn" ? f.value_bn : f.value_en}
                    </p>
                  </div>
                ))}
                {result.factors.length === 0 && (
                  <button
                    onClick={onSetProfile}
                    className="w-full bg-amber-500/15 border border-amber-400/30 rounded-xl px-3 py-2 text-xs text-amber-200 text-left hover:bg-amber-500/25"
                  >
                    {t("diag.noProfile")} →
                  </button>
                )}
              </div>
            </div>

            {/* Risk verdict (red / amber / emerald) */}
            <RiskVerdictCard result={result} t={t} lang={lang as "en" | "bn"} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SkeletonRow({ label }: { label: string }) {
  return (
    <div className="bg-white/5 border border-white/10 rounded-xl px-3 py-2 flex items-center gap-3">
      <p className="text-[11px] text-emerald-300/80 font-medium shrink-0 min-w-[110px]">{label}</p>
      <div className="ml-auto h-3 w-24 rounded bg-emerald-700/40 animate-pulse" />
    </div>
  );
}

function RiskVerdictCard({
  result,
  t,
  lang,
}: {
  result: DiagnosticResult;
  t: (k: string) => string;
  lang: "en" | "bn";
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

  return (
    <div className={`rounded-3xl border ${tone.border} ${tone.bg} p-5 shadow-sm`}>
      <header className="flex items-start justify-between gap-3 mb-3">
        <div>
          <p className={`text-[10px] font-bold uppercase tracking-widest ${tone.muted}`}>{t("diag.verdict")}</p>
          <p className={`text-3xl font-black ${tone.text} mt-1`}>
            {result.riskScore}% <span className="text-lg font-bold">— {riskLabel}</span>
          </p>
        </div>
        <div className={`w-12 h-12 rounded-2xl border ${tone.border} ${tone.bg} flex items-center justify-center shrink-0`}>
          <AlertTriangle className={tone.text} size={26} />
        </div>
      </header>

      {/* Reason */}
      <div className={`rounded-xl bg-white/60 border ${tone.border} p-3`}>
        <p className={`text-[10px] font-bold uppercase tracking-widest ${tone.muted}`}>{t("diag.reason")}</p>
        <p className={`text-sm ${tone.text} mt-1`}>
          {lang === "bn" ? result.reason_bn : result.reason_en}
        </p>
      </div>

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
