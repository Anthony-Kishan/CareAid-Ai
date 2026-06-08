import { useState, useRef, useEffect, useCallback } from "react";
import { Mic, Send, Info, Loader2, MicOff, WifiOff, UserRound, Trash2, Volume2, Square } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import Markdown from "react-markdown";
import { cn } from "@/src/lib/utils";
import { useLanguage } from "../lib/LanguageContext.tsx";
import { User } from "firebase/auth";
import { useTfEngine } from "../lib/transformersEngine.ts";
import { chat as routerChat, type ChatSource } from "../lib/tierRouter.ts";
import { DiagnosticPanel } from "../components/DiagnosticPanel.tsx";
import { PatientProfileSheet } from "../components/PatientProfileSheet.tsx";
import { usePatientProfile, summariseProfile } from "../lib/profile.ts";
import { listTriageMessages, saveTriageMessages, clearTriageMessages, KEYS, subscribe } from "../lib/store.ts";
import type { TriageMessage } from "../lib/types.ts";
import { startManualRecording, getVoiceState, prefetch as prefetchVoice, type ManualRecorder } from "../lib/voiceEngine.ts";
import { speak, stop as ttsStop, warmupVoices } from "../lib/tts.ts";

interface Message { id?: string; timestamp?: string; role: "user" | "assistant"; content: string; safety?: { verdict: string; matched: string[]; scrubbedLines?: number }; source?: ChatSource; diagnosticForSymptoms?: string; }
interface OfflineRule { keywords: string[]; verdict: string; en: string; bn: string; }

function genMsgId(): string {
  return `tm_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

export function TriagePage({ onLoginRequired, user }: { onLoginRequired: () => void; user: User | null }) {
  const { t, lang } = useLanguage();
  const [messages, setMessages] = useState<Message[]>(() => {
    const cached = listTriageMessages();
    if (cached.length > 0) return cached as Message[];
    return [{ id: genMsgId(), timestamp: new Date().toISOString(), role: "assistant", content: t("triage.welcome") }];
  });
  // Signature of the last-persisted chat. Persistence keys off CONTENT CHANGE, not effect
  // run-count, so the first real message always persists and StrictMode double-runs are no-ops.
  const lastPersistedSigRef = useRef<string | null>(null);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [offlineRules, setOfflineRules] = useState<OfflineRule[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const tf = useTfEngine();
  const profile = usePatientProfile();
  const [showProfile, setShowProfile] = useState(false);
  // TTS state — track which assistant message is currently being read aloud. Tap the speaker
  // icon on a message to listen; tap the same message again (or another) to stop.
  const [speakingMsgId, setSpeakingMsgId] = useState<string | null>(null);
  // Strip the bilingual AI-disclaimer + emoji headers so the spoken reply is clean speech, not
  // "warning emoji warning" punctuation noise.
  const cleanForSpeech = (text: string): string =>
    text
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/[🚨⚠️🏠⏳]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const toggleSpeak = (msgId: string, content: string) => {
    if (speakingMsgId === msgId) { ttsStop(); setSpeakingMsgId(null); return; }
    if (speakingMsgId) ttsStop();
    const clean = cleanForSpeech(content);
    if (!clean) return;
    setSpeakingMsgId(msgId);
    speak(clean, {
      lang: lang === "bn" ? "bn-BD" : "en-US",
      onEnd: () => setSpeakingMsgId(null),
      onError: () => setSpeakingMsgId(null),
    });
  };
  useEffect(() => { warmupVoices(); return () => { ttsStop(); }; }, []);

  // Monitor online status
  useEffect(() => {
    const onOnline = () => setIsOffline(false);
    const onOffline = () => setIsOffline(true);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => { window.removeEventListener("online", onOnline); window.removeEventListener("offline", onOffline); };
  }, []);

  // Persist chat: every change is mirrored to localStorage + Firestore (if signed in).
  useEffect(() => {
    const sig = JSON.stringify(messages.map((m) => [m.role, m.content, m.source, m.diagnosticForSymptoms]));
    // First run: record the hydrated-from-storage signature WITHOUT re-persisting it (we just
    // loaded it). Every later run persists only when the content actually changed.
    if (lastPersistedSigRef.current === null) { lastPersistedSigRef.current = sig; return; }
    if (sig === lastPersistedSigRef.current) return; // no real change → no write
    const onlyWelcome = messages.length === 1 && messages[0].role === "assistant" && messages[0].content === t("triage.welcome");
    if (onlyWelcome) { lastPersistedSigRef.current = sig; return; }
    lastPersistedSigRef.current = sig;
    const stamped: TriageMessage[] = messages.map((m) => ({
      id: m.id || genMsgId(),
      timestamp: m.timestamp || new Date().toISOString(),
      role: m.role,
      content: m.content,
      source: m.source,
      safety: m.safety,
      diagnosticForSymptoms: m.diagnosticForSymptoms,
    }));
    saveTriageMessages(stamped);
  }, [messages, t]);

  // Listen for cross-tab / Firestore-snapshot updates that rewrote the cached chat.
  useEffect(() => {
    return subscribe(KEYS.TRIAGE_CHAT_KEY, () => {
      const fresh = listTriageMessages();
      if (fresh.length === 0) return;
      setMessages((prev) => (fresh.length > prev.length ? (fresh as Message[]) : prev));
    });
  }, []);

  // Prefetch offline rules
  useEffect(() => {
    fetch("/api/offline-triage").then(r => r.json()).then(d => setOfflineRules(d.rules || [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, isLoading]);

  const checkOffline = useCallback((text: string) => {
    const lower = text.toLowerCase();
    for (const rule of offlineRules) {
      if (rule.keywords.some(k => lower.includes(k))) {
        const verdictEmoji = rule.verdict === "GO_NOW" ? "🚨" : rule.verdict === "HOME" ? "🏠" : "⏳";
        const verdictLabel = rule.verdict === "GO_NOW" ? "GO TO HOSPITAL NOW" : rule.verdict === "HOME" ? "FIRST-AID AT HOME" : "WAIT AND WATCH";
        return `**${verdictEmoji} ${verdictLabel}**\n\n${rule.en}\n\n---\n\n**${verdictEmoji} ${verdictLabel}**\n\n${rule.bn}\n\n⚠️ Offline mode — connect to internet for full AI analysis. / অফলাইন মোড — সম্পূর্ণ বিশ্লেষণের জন্য ইন্টারনেট সংযোগ করুন।`;
      }
    }
    return `I'm currently offline. Based on your symptoms, please monitor closely and seek medical care if symptoms worsen.\n\n---\n\nআমি এখন অফলাইনে আছি। আপনার লক্ষণ মনোযোগ দিয়ে দেখুন এবং অবস্থা খারাপ হলে ডাক্তার দেখান।`;
  }, [offlineRules]);

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;
    const userMessage = input.trim();
    setInput("");
    setMessages(prev => [...prev, { id: genMsgId(), timestamp: new Date().toISOString(), role: "user", content: userMessage }]);
    setIsLoading(true);

    // Count user turns BEFORE this one (this message has already been pushed). The diagnostic
    // panel runs only after 3 user turns of symptom-gathering — the LLM does its multi-round
    // questioning first, so the risk score is grounded in the full picture instead of a single
    // first-message guess.
    const userTurnsSoFar = messages.filter(m => m.role === "user").length + 1;
    const DIAGNOSTIC_AFTER = 3;
    const allUserSymptoms = [
      ...messages.filter(m => m.role === "user").map(m => m.content),
      userMessage,
    ].join("\n");

    // Insert an empty assistant placeholder so streaming tokens can fill in live. Match it by a
    // stable `id` (NOT array index): in React's concurrent/batched mode a captured index can be
    // wrong or never set, which silently drops every streamed chunk. The id is bulletproof.
    const placeholderId = genMsgId();
    setMessages(prev => [
      ...prev,
      {
        id: placeholderId,
        timestamp: new Date().toISOString(),
        role: "assistant",
        content: "",
        // Only stamp the diagnostic trigger once we have enough turns. Pass the FULL
        // concatenated symptom history so the engine reasons over everything, not the
        // latest message alone.
        diagnosticForSymptoms: userTurnsSoFar >= DIAGNOSTIC_AFTER ? allUserSymptoms : undefined,
      },
    ]);

    try {
      const result = await routerChat(
        messages.map(m => ({ role: m.role, content: m.content })),
        userMessage,
        {
          lang,
          onChunk: (_chunk, full, source) => {
            setMessages(prev =>
              prev.map(m => (m.id === placeholderId ? { ...m, content: full, source } : m))
            );
          },
        }
      );
      // Final settle (also sets safety + source if it wasn't streamed).
      setMessages(prev =>
        prev.map(m =>
          m.id === placeholderId
            ? { ...m, content: result.text, safety: result.safety as any, source: result.source }
            : m
        )
      );
    } catch (err) {
      console.error("Triage router failed completely", err);
      setMessages(prev =>
        prev.map(m =>
          m.id === placeholderId
            ? { ...m, content: checkOffline(userMessage), source: "rules" as ChatSource }
            : m
        )
      );
    } finally {
      setIsLoading(false);
    }
  };

  // Hybrid voice input. Online + Web Speech API available → use it (free, fast, no model). Offline
  // OR if the user has downloaded the Whisper-tiny model → use the on-device Whisper pipeline so
  // the mic button works without internet. Both modes are tap-to-start, tap-again-to-stop.
  const [voiceMode, setVoiceMode] = useState<"idle" | "warming" | "recording" | "transcribing">("idle");
  const manualRecRef = useRef<ManualRecorder | null>(null);

  const startWebSpeech = async (): Promise<void> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      alert(lang === "bn"
        ? "মাইক্রোফোন ব্যবহারের অনুমতি দিন। ব্রাউজার সেটিংস থেকে Allow করুন।"
        : "Microphone access denied. Please allow it in your browser settings.");
      return;
    }
    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      // Browser doesn't have Web Speech — fall through to offline Whisper (warm if cold).
      if (await tryStartWhisperWithWarmup()) return;
      alert(lang === "bn"
        ? "আপনার ব্রাউজার ভয়েস সাপোর্ট করে না। সেটিংসে গিয়ে অফলাইন AI ডাউনলোড করুন।"
        : "Voice not supported in this browser. Download Offline AI in Settings to enable on-device voice.");
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = lang === "bn" ? "bn-BD" : "en-US";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (e: any) => { setInput(e.results[0][0].transcript); setIsRecording(false); };
    recognition.onerror = (e: any) => {
      if (e.error === "not-allowed") {
        alert(lang === "bn" ? "মাইক্রোফোন ব্লক করা আছে।" : "Microphone blocked.");
      } else if (e.error === "network" || e.error === "service-not-allowed") {
        // Web Speech fell over (often happens when offline). Fall back to Whisper — warm if cold.
        void (async () => {
          if (await tryStartWhisperWithWarmup()) return;
          alert(lang === "bn"
            ? "ভয়েস সার্ভিস উপলব্ধ নেই। সেটিংসে গিয়ে অফলাইন AI ডাউনলোড করুন।"
            : "Voice service unavailable. Download Offline AI in Settings for offline voice.");
        })();
      }
      setIsRecording(false);
    };
    recognition.onend = () => setIsRecording(false);
    recognitionRef.current = recognition;
    recognition.start();
    setIsRecording(true);
  };

  const startWhisper = async (): Promise<void> => {
    try {
      const rec = await startManualRecording(lang as "en" | "bn", (s) => setVoiceMode(s));
      manualRecRef.current = rec;
      setIsRecording(true);
    } catch (e: any) {
      console.error("[voice] mic open failed", e);
      alert(lang === "bn"
        ? "মাইক্রোফোন চালু করা যায়নি। অনুমতি দিন এবং আবার চেষ্টা করুন।"
        : "Could not open the microphone. Please allow access and try again.");
      setIsRecording(false);
      setVoiceMode("idle");
    }
  };

  const stopWhisper = async (): Promise<void> => {
    const rec = manualRecRef.current;
    if (!rec) return;
    manualRecRef.current = null;
    try {
      const text = await rec.stop();
      if (text) setInput(text);
    } catch (e) {
      console.error("[voice] transcription failed", e);
    } finally {
      setIsRecording(false);
      setVoiceMode("idle");
    }
  };

  // Whisper-with-warmup. If the model is downloaded but cold (page reload, autoload pending),
  // warm it on-demand and then start recording — instead of falsely telling the user it isn't
  // downloaded. The `cached` flag from localStorage can be missing in real-world scenarios
  // (storage eviction, mid-download crash, multi-tab race), so when the user is OFFLINE we
  // always attempt a warm-up: if the model is in transformers.js' Cache Storage it loads from
  // disk; if it isn't there the network fetch fails fast (no accidental 75 MB download because
  // we're offline). We only gate the warm-up on `cached` when ONLINE, to avoid auto-starting
  // a fresh download from a single mic tap.
  // Returns true if we kicked off (or completed) recording / notified the user; false if the
  // caller should show the "go download" alert.
  const tryStartWhisperWithWarmup = async (): Promise<boolean> => {
    const vs = getVoiceState();
    if (vs.status === "ready") { await startWhisper(); return true; }
    const offline = typeof navigator !== "undefined" && !navigator.onLine;
    const shouldAttempt = offline || vs.cached || vs.status === "loading";
    if (!shouldAttempt) return false;
    setVoiceMode("warming");
    try {
      await prefetchVoice(); // idempotent — no-op if already loading/ready
      await startWhisper();
      return true;
    } catch (e) {
      console.error("[voice] warm-up failed", e);
      setVoiceMode("idle");
      // Honest signal — the weights aren't actually in the browser cache.
      alert(lang === "bn"
        ? "অফলাইন ভয়েস মডেল ব্রাউজার ক্যাশে নেই। অনুগ্রহ করে ইন্টারনেট সংযোগ করে সেটিংস → ‘Voice + Scanner only’ থেকে আবার ডাউনলোড করুন।"
        : "The offline voice model isn't in your browser cache. Reconnect to the internet and re-download it from Settings → 'Voice + Scanner only'.");
      return true; // user notified; don't show the duplicate "go download" alert
    }
  };

  const toggleRecording = async () => {
    if (isRecording) {
      // If we're using Whisper, stop & transcribe. Otherwise stop Web Speech recognition.
      if (manualRecRef.current) { await stopWhisper(); return; }
      recognitionRef.current?.stop();
      setIsRecording(false);
      return;
    }
    // Engine choice — ONLINE always prefers Web Speech (fast, reliable, free — the behaviour that
    // worked before). Whisper is reserved for OFFLINE use, so downloading the offline AI never
    // makes online voice slower/flakier. Order:
    //   • online + browser has Web Speech  → Web Speech
    //   • offline (or no Web Speech) + Whisper downloaded → on-device Whisper (warm if cold)
    //   • offline + Whisper truly not downloaded → prompt to download
    const online = typeof navigator !== "undefined" ? navigator.onLine : true;
    const hasWebSpeech = !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

    if (online && hasWebSpeech) {
      await startWebSpeech();
      return;
    }
    if (await tryStartWhisperWithWarmup()) return;
    alert(lang === "bn"
      ? "অফলাইন ভয়েসের জন্য সেটিংসে গিয়ে অফলাইন AI ডাউনলোড করুন (Whisper ভয়েস মডেল)।"
      : "For offline voice input, download the Offline AI in Settings (includes the Whisper voice model).");
  };

  return (
    <div className="flex flex-col h-full lg:max-w-3xl lg:mx-auto lg:w-full lg:my-6 lg:rounded-3xl lg:overflow-hidden lg:shadow-xl lg:border lg:border-gray-100 lg:bg-white lg:min-h-[80vh]">
      {/* Profile sheet */}
      <AnimatePresence>
        {showProfile && <PatientProfileSheet onClose={() => setShowProfile(false)} />}
      </AnimatePresence>

      {/* Offline banner */}
      <AnimatePresence>
        {isOffline && (
          <motion.div initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }}
            className="bg-orange-500 text-white px-4 py-2 flex items-center gap-2 overflow-hidden">
            <WifiOff size={14} />
            <span className="text-xs font-bold">{lang === "bn" ? "অফলাইন মোড — সীমিত পরামর্শ উপলব্ধ" : "Offline Mode — Limited advice available"}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Disclaimer — text-xs (not 10px) for readability + leading-relaxed for breathing room. */}
      <div className="bg-amber-50 px-4 py-3 flex items-start gap-3 border-b border-amber-100">
        <Info size={16} className="text-amber-600 shrink-0 mt-0.5" />
        <p className="text-xs text-amber-900 leading-relaxed font-medium">{t("triage.disclaimer")}</p>
      </div>

      {/* Profile bar — drives the diagnostic engine */}
      <div className="flex items-center gap-2 px-4 py-2 bg-white border-b border-gray-100">
        <button
          onClick={() => setShowProfile(true)}
          className="flex items-center gap-2 flex-1 min-w-0 text-left hover:bg-gray-50 rounded-lg -mx-1 px-1 py-1 transition-colors"
        >
          <div className="w-7 h-7 bg-emerald-50 rounded-lg flex items-center justify-center text-emerald-600 shrink-0">
            <UserRound size={14} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">{t("triage.profile.label")}</p>
            <p className="text-xs font-medium text-gray-800 truncate">{summariseProfile(profile, lang as "en" | "bn")}</p>
          </div>
          <span className="text-[10px] font-bold text-emerald-600 shrink-0">{t("triage.profile.edit")}</span>
        </button>
        {messages.length > 1 && (
          <button
            onClick={() => {
              const ok = window.confirm(lang === "bn" ? "চ্যাট মুছে ফেলবেন? এটি ফিরিয়ে আনা যাবে না।" : "Clear this chat? This cannot be undone.");
              if (!ok) return;
              clearTriageMessages();
              setMessages([{ id: genMsgId(), timestamp: new Date().toISOString(), role: "assistant", content: t("triage.welcome") }]);
            }}
            className="shrink-0 inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-bold text-gray-500 hover:text-red-600 hover:bg-red-50 transition-colors"
            title={lang === "bn" ? "চ্যাট মুছুন" : "Clear chat"}
          >
            <Trash2 size={12} />
            {lang === "bn" ? "মুছুন" : "Clear"}
          </button>
        )}
      </div>

      {/* Messages — extra bottom padding on mobile so the last message isn't hidden
          behind the fixed input bar (input ~120px + bottom nav ~68px + breathing room). */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 pb-48 lg:pb-4 space-y-4">
        <AnimatePresence initial={false}>
          {messages.map((msg, i) => (
            <motion.div key={i} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
              className={cn("flex flex-col gap-2", msg.role === "user" ? "items-end" : "items-start")}>
              <div className={cn(
                "max-w-[88%] px-4 py-3 rounded-2xl text-sm leading-relaxed shadow-sm prose prose-sm",
                msg.role === "user"
                  ? "bg-emerald-600 text-white rounded-tr-none prose-invert"
                  : "bg-white text-gray-800 rounded-tl-none border border-gray-100"
              )}>
                <Markdown>{msg.content || (msg.role === "assistant" ? "…" : "")}</Markdown>
              </div>
              {/* TTS Listen / Stop — bilingual voice output so non-readers can hear the reply.
                  Only shown for non-empty assistant messages (not the streaming placeholder). */}
              {msg.role === "assistant" && msg.content && msg.id && i > 0 && (
                <button
                  onClick={() => toggleSpeak(msg.id!, msg.content)}
                  className={cn(
                    "inline-flex items-center gap-1.5 text-[10px] font-bold px-2.5 py-1 rounded-full border transition-colors",
                    speakingMsgId === msg.id
                      ? "bg-red-50 text-red-700 border-red-200 hover:bg-red-100"
                      : "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100"
                  )}
                  aria-label={speakingMsgId === msg.id ? (lang === "bn" ? "থামুন" : "Stop") : (lang === "bn" ? "শুনুন" : "Listen")}
                >
                  {speakingMsgId === msg.id ? <Square size={10} className="fill-current" /> : <Volume2 size={10} />}
                  {speakingMsgId === msg.id ? (lang === "bn" ? "থামুন" : "Stop") : (lang === "bn" ? "শুনুন" : "Listen")}
                </button>
              )}
              {/* Multi-factor diagnostic panel — runs alongside the chat reply. */}
              {msg.role === "assistant" && msg.diagnosticForSymptoms && (
                <div className="w-full lg:max-w-[480px] mt-1">
                  <DiagnosticPanel symptoms={msg.diagnosticForSymptoms} />
                </div>
              )}
            </motion.div>
          ))}
          {isLoading && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex justify-start">
              <div className="bg-white px-4 py-3 rounded-2xl rounded-tl-none border border-gray-100 flex items-center gap-2 shadow-sm">
                <Loader2 size={16} className="animate-spin text-emerald-600" />
                <span className="text-xs text-gray-500 font-medium italic">{t("triage.thinking")}</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Quick prompts + Input — pinned above the bottom navbar on mobile.
          BottomNav is fixed bottom-0 with py-3 (~68px tall); we sit just above it via
          `bottom-[68px]` and a safe-area inset so iOS home-indicator devices don't clip.
          On desktop (lg+) we revert to inline flow inside the bordered card. */}
      <div className="fixed left-0 right-0 bottom-[68px] max-w-md mx-auto lg:static lg:max-w-none lg:mx-0 lg:bottom-auto bg-white border-t border-gray-100 shadow-[0_-4px_20px_rgba(0,0,0,0.06)] lg:shadow-lg z-40">
      {messages.length === 1 && (
        <div className="px-4 pt-3 pb-1 flex gap-2 overflow-x-auto no-scrollbar">
          {[
            { en: "Fever & headache", bn: "জ্বর ও মাথাব্যথা" },
            { en: "Chest pain", bn: "বুকে ব্যথা" },
            { en: "Diarrhea", bn: "ডায়রিয়া" },
            { en: "Child not eating", bn: "শিশু খাচ্ছে না" },
          ].map((p, i) => (
            <button key={i} onClick={() => setInput(lang === "bn" ? p.bn : p.en)}
              className="shrink-0 px-3 py-1.5 bg-emerald-50 border border-emerald-100 rounded-full text-xs font-medium text-emerald-700 whitespace-nowrap">
              {lang === "bn" ? p.bn : p.en}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <div className="p-3 lg:p-4">
        <div className="flex items-center gap-2">
          <motion.button whileTap={{ scale: 0.9 }} onClick={toggleRecording}
            className={cn("w-12 h-12 rounded-full flex items-center justify-center transition-all shadow-lg",
              isRecording ? "bg-red-500 animate-pulse text-white" : "bg-emerald-600 text-white")}>
            {isRecording ? <MicOff size={22} /> : <Mic size={22} />}
          </motion.button>
          <div className="flex-1 relative">
            <input type="text" value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleSend()}
              placeholder={t("triage.placeholder")}
              className="w-full bg-gray-100 rounded-full py-3 px-5 pr-12 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
            <button onClick={handleSend} disabled={isLoading || !input.trim()}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-emerald-600 disabled:opacity-40">
              <Send size={20} />
            </button>
          </div>
        </div>
        {voiceMode === "warming" && (
          <p className="text-center text-xs text-emerald-700 font-medium mt-2 animate-pulse">
            {lang === "bn" ? "অফলাইন ভয়েস মডেল প্রস্তুত হচ্ছে... একটু সময় লাগতে পারে" : "Preparing offline voice model... this may take a moment"}
          </p>
        )}
        {isRecording && voiceMode !== "transcribing" && voiceMode !== "warming" && (
          <p className="text-center text-xs text-red-500 font-medium mt-2 animate-pulse">
            {lang === "bn" ? "শুনছি... কথা বলুন · থামাতে আবার ট্যাপ করুন" : "Listening... speak now · tap again to stop"}
          </p>
        )}
        {voiceMode === "transcribing" && (
          <p className="text-center text-xs text-blue-600 font-medium mt-2">
            {lang === "bn" ? "অফলাইন ভয়েস প্রক্রিয়া হচ্ছে..." : "Transcribing offline voice..."}
          </p>
        )}
        <EngineStatus isOffline={isOffline} tfStatus={tf.status} t={t} />
      </div>
      </div>
    </div>
  );
}

function EngineStatus({ isOffline, tfStatus, t }: { isOffline: boolean; tfStatus: string; t: (k: string) => string }) {
  let key: string | null = null;
  if (isOffline && tfStatus === "ready") key = "triage.engine.wasmActive";
  else if (isOffline) key = "triage.engine.rulesActive";
  else if (tfStatus === "ready") key = "triage.engine.localReady";
  if (!key) return null;
  return <p className="text-center text-[10px] text-gray-400 font-medium mt-2">{t(key)}</p>;
}

