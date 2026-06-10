// /docs — live pitch deck + technical whitepaper + system dashboard, with admin-controlled
// visibility scheduling. Rendered as a standalone full-page route (outside the app tab shell).
//
// Sections: YC pitch deck (Problem → Vision), Team grid, and a deep technical layer
// (architecture, data flow, tech stack, API docs, AI layer, roadmap, security, analytics,
// changelog). Live system stats are pulled from /api/webhooks/daily-summary.

import { useEffect, useMemo, useState } from "react";
import {
  Shield, Lock, Calendar, Eye, EyeOff, Printer, Search, Menu, X, CheckCircle2,
  Cpu, Database, Cloud, Mic, ScanLine, Stethoscope, Activity, Server, GitBranch,
  Users, Save, Plus, Trash2, ChevronRight, Globe, Zap, AlertTriangle,
} from "lucide-react";
import {
  getDocsConfig, saveDocsConfig, getVisibility, maybeUnlockAdmin, lockAdmin,
  type DocsConfig, type TeamMember,
} from "../lib/docsConfig.ts";

interface LiveStats {
  kb_entries: number;
  kb_critical: number;
  kb_urgent: number;
  kb_mild: number;
  models: string[];
  mcp_tools: string[];
  kb_version?: number;
}

const NAV = [
  { id: "problem", label: "Problem" },
  { id: "solution", label: "Solution" },
  { id: "why-now", label: "Why Now" },
  { id: "product", label: "Product" },
  { id: "market", label: "Market" },
  { id: "business", label: "Business Model" },
  { id: "traction", label: "Traction" },
  { id: "competition", label: "Competition" },
  { id: "advantage", label: "Advantage" },
  { id: "gtm", label: "Go-To-Market" },
  { id: "team", label: "Team" },
  { id: "vision", label: "Vision" },
  { id: "architecture", label: "Architecture" },
  { id: "dataflow", label: "Data Flow" },
  { id: "stack", label: "Tech Stack" },
  { id: "api", label: "API Docs" },
  { id: "ai-layer", label: "AI Layer" },
  { id: "safety-hardening", label: "Safety Hardening" },
  { id: "roadmap", label: "Roadmap" },
  { id: "security", label: "Security" },
  { id: "analytics", label: "Analytics" },
  { id: "changelog", label: "Changelog" },
];

export function DocsPage() {
  const [config, setConfig] = useState<DocsConfig>(getDocsConfig());
  const [admin, setAdmin] = useState(false);
  const [stats, setStats] = useState<LiveStats | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [showAdminPanel, setShowAdminPanel] = useState(false);

  const [publishMsg, setPublishMsg] = useState<string | null>(null);

  useEffect(() => {
    setAdmin(maybeUnlockAdmin());
    fetch("/api/webhooks/daily-summary")
      .then((r) => r.json())
      .then((d) => setStats(d.system))
      .catch(() => {});

    // Subscribe to the GLOBAL config in Firestore so the admin's published schedule reaches every
    // visitor in real time. Falls back silently to the localStorage default if Firestore is down.
    let unsub = () => {};
    import("../lib/db.ts")
      .then((m) => {
        unsub = m.subscribeDocsConfig((remote) => {
          // Merge the remote doc over our defaults and cache locally for instant next load.
          const merged = saveDocsConfig(remote as Partial<DocsConfig>);
          setConfig(merged);
        });
      })
      .catch(() => {});
    return () => { try { unsub(); } catch { /* ignore */ } };
  }, []);

  const vis = useMemo(() => getVisibility(config, admin), [config, admin]);

  // ── Access-control gate ──────────────────────────────────────────────────
  if (!vis.visible) {
    return <NotAvailable reason={vis.reason} startISO={vis.startISO} endISO={vis.endISO} />;
  }

  const filteredNav = query
    ? NAV.filter((n) => n.label.toLowerCase().includes(query.toLowerCase()))
    : NAV;

  const jump = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setNavOpen(false);
  };

  return (
    <div className="min-h-screen bg-white text-gray-900">
      {/* Top bar */}
      <header className="sticky top-0 z-40 bg-emerald-950 text-white print:hidden">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <button onClick={() => setNavOpen((v) => !v)} className="lg:hidden p-2 -ml-2">
            {navOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
          <div className="flex items-center gap-2 font-black text-lg">
            <img src="/icons/Favicon.png" alt="CareAid AI" className="w-8 h-8 rounded-lg object-contain bg-white" />
            CareAid AI <span className="text-emerald-400 font-medium hidden sm:inline">/ docs</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative hidden sm:block">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-emerald-300" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search sections…"
                className="bg-emerald-900 text-white placeholder:text-emerald-400/60 text-xs rounded-lg pl-8 pr-3 py-2 w-40 focus:w-56 transition-all focus:outline-none focus:ring-1 focus:ring-emerald-400"
              />
            </div>
            <button onClick={() => window.print()} title="Export PDF" className="p-2 rounded-lg bg-emerald-900 hover:bg-emerald-800">
              <Printer size={16} />
            </button>
            {admin && (
              <button onClick={() => setShowAdminPanel(true)} className="px-3 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-xs font-bold flex items-center gap-1.5">
                <Shield size={14} /> Admin
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Admin status strip */}
      {admin && (
        <div className="bg-amber-400 text-amber-950 text-[11px] font-bold px-4 py-1.5 text-center print:hidden">
          ADMIN MODE — visibility: {config.enabled ? "ON" : "OFF"} · window: {fmtDate(config.startISO)} → {fmtDate(config.endISO)} · {vis.reason === "admin" ? "you bypass the schedule" : ""}
        </div>
      )}

      <div className="max-w-6xl mx-auto lg:flex">
        {/* Side nav */}
        <nav className={`${navOpen ? "block" : "hidden"} lg:block lg:w-56 lg:shrink-0 lg:sticky lg:top-[57px] lg:h-[calc(100vh-57px)] lg:overflow-y-auto border-r border-gray-100 p-4 print:hidden`}>
          <ul className="space-y-0.5">
            {filteredNav.map((n) => (
              <li key={n.id}>
                <button onClick={() => jump(n.id)} className="w-full text-left text-sm text-gray-600 hover:text-emerald-700 hover:bg-emerald-50 rounded-lg px-3 py-1.5 transition-colors">
                  {n.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {/* Content */}
        <main className="flex-1 min-w-0 px-5 sm:px-8 py-10 space-y-20">
          <Hero stats={stats} />

          {/* ── YC PITCH DECK ──────────────────────────────────────────── */}
          <Section id="problem" kicker="01 · Problem" title="72 million people, no doctor when it matters">
            <p>In rural Bangladesh, timely healthcare is blocked by four walls at once: <strong>unreliable internet, no nearby doctors, low health literacy, and economic barriers.</strong> The nearest qualified doctor can be 47+ km away. Roads flood in monsoon. Mobile networks drop to zero bars at night. And the most common device — a 2–3 GB RAM Android phone — can't run the heavy AI models that urban telehealth apps assume.</p>
            <p>When a crisis hits a rural family at 2 AM with no signal, they have nothing: no Google, no telemedicine app, no one to call. Existing telehealth is built for stable internet and urban users. It fails exactly where it's needed most.</p>
          </Section>

          <Section id="solution" kicker="02 · Solution" title="A triage nurse in every pocket — that works offline">
            <p>CareAid AI is a fully offline-capable AI health companion. It gives <strong>clinical triage, prescription scanning, and first-aid guidance in Bangla</strong>, on low-end phones, without requiring internet.</p>
            <p>The core insight: we don't try to <em>diagnose diseases</em> (the hardest, most dangerous AI task). We <strong>triage to a safe action</strong>, <strong>abstain when our retrieval confidence is low</strong>, and run two independent reasoners side-by-side (a free-form chat LLM and a deterministic BM25 panel) so a hallucination by one is caught by the other — built on 82 clinician-authored protocols that run in &lt;5 ms on any device.</p>
            <FeatureGrid />
          </Section>

          <Section id="why-now" kicker="03 · Why Now" title="On-device AI finally fits a $80 phone">
            <ul className="list-disc pl-5 space-y-1.5">
              <li>WebAssembly + ONNX Runtime now run 360M-param LLMs in a browser tab, no app store, no GPU.</li>
              <li>Whisper-tiny brings offline Bangla speech recognition under 75 MB.</li>
              <li>PWAs install like native apps and cache everything for offline use.</li>
              <li>Bangladesh's 2024 Telemedicine Guideline created a regulatory lane for AI-assisted triage.</li>
            </ul>
          </Section>

          <Section id="product" kicker="04 · Product" title="What it does">
            <p><strong>Target users:</strong> rural patients & families, community health workers, pregnant women, chronic-disease patients (diabetes, hypertension), and anyone holding a prescription they can't read.</p>
            <p><strong>Core use cases:</strong> symptom triage (voice or text), printed-prescription scanning with bilingual medicine guidance, first-aid for emergencies (choking, snake bite, postpartum bleeding), and nearest-hospital routing.</p>
          </Section>

          <Section id="market" kicker="05 · Market" title="Market opportunity">
            <StatRow items={[
              { big: "72M", small: "rural Bangladeshis with poor connectivity" },
              { big: "168M", small: "total population (TAM)" },
              { big: "1:1.6k", small: "doctor-to-patient ratio (rural far worse)" },
            ]} />
            <p className="mt-4">Beyond Bangladesh, the same offline-first model applies to rural India, Sub-Saharan Africa, and South-East Asia — anywhere connectivity and clinicians are scarce. A globally reusable architecture.</p>
          </Section>

          <Section id="business" kicker="06 · Business Model" title="Sustainable, not extractive">
            <ul className="list-disc pl-5 space-y-1.5">
              <li><strong>B2G / NGO licensing:</strong> deploy via DGHS, BRAC, icddr,b community health programs.</li>
              <li><strong>Telco partnerships:</strong> zero-rated data + pre-installed PWA on entry Android.</li>
              <li><strong>Pharmacy network:</strong> verified prescription scanning + generic price transparency.</li>
              <li>Patient-facing features stay <strong>free</strong> — the value is public-health reach, not per-user fees.</li>
            </ul>
          </Section>

          <Section id="traction" kicker="07 · Traction" title="Live system, real data">
            <p>Built and deployed as a working PWA with a full offline AI stack. Current system state (live):</p>
            <LiveStatsCards stats={stats} />
          </Section>

          <Section id="competition" kicker="08 · Competition" title="How we're different">
            <CompareTable />
          </Section>

          <Section id="advantage" kicker="09 · Unique Advantage" title="Graceful degradation, never graceful failure">
            <p>Every feature has a fallback path: Cloud AI → on-device LLM → decision tree → safety rules. Firestore → IndexedDB → localStorage. Web Speech → Whisper. Gemini OCR → Tesseract. <strong>No single point of failure can leave a patient without guidance.</strong> The clinical content has zero AI dependency — it's a doctor-reviewed JSON file, not model weights.</p>
          </Section>

          <Section id="gtm" kicker="10 · Go-To-Market" title="Reach where the network doesn't">
            <ul className="list-disc pl-5 space-y-1.5">
              <li>Partner with community health workers (CHWs) as the distribution layer.</li>
              <li>Pre-cache the PWA at union health complexes & pharmacies.</li>
              <li>Bangla-first, voice-first onboarding for low-literacy users.</li>
              <li>Seed trust via MBBS-audited content + transparent disclaimers.</li>
            </ul>
          </Section>

          {/* ── TEAM ───────────────────────────────────────────────────── */}
          <Section id="team" kicker="11 · Team" title={config.teamName || "Team"}>
            <TeamGrid team={config.team} />
          </Section>

          <Section id="vision" kicker="12 · Vision" title="Healthcare shouldn't require a connection">
            <p className="text-xl font-medium text-emerald-900 leading-relaxed">
              Our vision is a world where a mother in a flooded village at 2 AM gets the same safe, trustworthy first guidance as someone in a city hospital — in her own language, on the phone already in her hand, whether or not there's signal. <strong>CareAid AI puts a nurse protocol in every pocket.</strong>
            </p>
          </Section>

          {/* ── TECHNICAL LAYER ────────────────────────────────────────── */}
          <Divider label="Technical Documentation" />

          <Section id="architecture" kicker="T1 · Architecture" title="System architecture">
            <ArchitectureDiagram />
          </Section>

          <Section id="dataflow" kicker="T2 · Data Flow" title="Input → Processing → AI → Output → Feedback">
            <DataFlowDiagram />
          </Section>

          <Section id="stack" kicker="T3 · Tech Stack" title="Technology stack">
            <StackTable />
          </Section>

          <Section id="api" kicker="T4 · API" title="API documentation">
            <ApiDocs />
          </Section>

          <Section id="ai-layer" kicker="T5 · AI Layer" title="AI architecture, models & RAG">
            <AiLayer stats={stats} />
          </Section>

          <Section id="safety-hardening" kicker="T6 · Safety Hardening" title="How we keep the side-panel verdict honest">
            <SafetyHardening />
          </Section>

          <Section id="roadmap" kicker="T7 · Roadmap" title="Product roadmap">
            <Roadmap />
          </Section>

          <Section id="security" kicker="T8 · Security" title="Security, RBAC & data protection">
            <ul className="list-disc pl-5 space-y-1.5">
              <li><strong>Auth:</strong> Firebase Auth (email/password + Google OAuth).</li>
              <li><strong>RBAC:</strong> Firestore security rules enforce per-user isolation (<code>users/&#123;uid&#125;/*</code>); admin gate on /docs.</li>
              <li><strong>Data protection:</strong> offline AI inference is 100% on-device — health data never leaves the phone offline. Online messages used only for response generation, never stored or sold.</li>
              <li><strong>Compliance:</strong> follows DGHS Telemedicine Practice Guideline 2020 + BMDC rules. Plain-language Bangla privacy policy.</li>
            </ul>
          </Section>

          <Section id="analytics" kicker="T9 · Analytics" title="KPIs & usage metrics">
            <ul className="list-disc pl-5 space-y-1.5">
              <li>Triage sessions completed; % resolved offline vs cloud.</li>
              <li>Red-flag emergencies detected & routed to hospital.</li>
              <li>Prescriptions scanned; doctor legibility scores aggregated.</li>
              <li>Offline-model adoption (downloads) on low-RAM devices.</li>
              <li>MBBS audit ratings (accurate / needs-revision / unsafe) over time.</li>
            </ul>
          </Section>

          <Section id="changelog" kicker="T10 · Changelog" title="Version history">
            <Changelog />
          </Section>

          <footer className="pt-10 border-t border-gray-100 text-sm text-gray-400">
            CareAid AI — স্বাস্থ্য সহায়ক · The Infinity AI BuildFest 2026 · This documentation is live and reflects real system state.
          </footer>
        </main>
      </div>

      {/* Admin panel */}
      {admin && showAdminPanel && (
        <AdminPanel
          config={config}
          publishMsg={publishMsg}
          onClose={() => { setShowAdminPanel(false); setPublishMsg(null); }}
          onSave={async (c) => {
            // Save locally for instant feedback, then publish globally to Firestore.
            setConfig(saveDocsConfig(c));
            setPublishMsg("Publishing…");
            try {
              const m = await import("../lib/db.ts");
              const res = await m.publishDocsConfig(c as unknown as Record<string, unknown>);
              setPublishMsg(res.ok
                ? "✓ Published globally — all visitors now see this."
                : `Saved on this device only. To publish to everyone, sign in to CareAid AI first. (${res.error})`);
            } catch (e: any) {
              setPublishMsg("Saved locally. Global publish unavailable: " + (e?.message || e));
            }
          }}
          onLock={() => { lockAdmin(); setAdmin(false); setShowAdminPanel(false); }}
        />
      )}
    </div>
  );
}

// ── Access-control "Not Available" view ─────────────────────────────────────
function NotAvailable({ reason, startISO, endISO }: { reason: string; startISO: string; endISO: string }) {
  const msg = reason === "disabled"
    ? "This documentation is currently not published."
    : reason === "before_window"
    ? "This documentation will be available soon."
    : "The documentation viewing window has closed.";
  return (
    <div className="min-h-screen bg-emerald-950 text-white flex items-center justify-center p-6">
      <div className="max-w-md text-center space-y-4">
        <div className="w-16 h-16 bg-emerald-900 rounded-2xl flex items-center justify-center mx-auto">
          <Lock size={28} className="text-emerald-400" />
        </div>
        <h1 className="text-2xl font-black">Not Available</h1>
        <p className="text-emerald-300/80">{msg}</p>
        <div className="bg-emerald-900/60 rounded-xl p-4 text-sm text-emerald-200 inline-flex items-center gap-2">
          <Calendar size={16} />
          Public window: {fmtDate(startISO)} → {fmtDate(endISO)}
        </div>
        <p className="text-[11px] text-emerald-400/50">HTTP 403 · CareAid AI /docs</p>
      </div>
    </div>
  );
}

// ── Admin panel ──────────────────────────────────────────────────────────────
function AdminPanel({ config, publishMsg, onClose, onSave, onLock }: {
  config: DocsConfig; publishMsg: string | null; onClose: () => void; onSave: (c: DocsConfig) => void; onLock: () => void;
}) {
  const [draft, setDraft] = useState<DocsConfig>(config);
  const set = (patch: Partial<DocsConfig>) => setDraft((d) => ({ ...d, ...patch }));
  const toLocalInput = (iso: string) => {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const updateMember = (i: number, patch: Partial<TeamMember>) => {
    const team = draft.team.map((m, idx) => (idx === i ? { ...m, ...patch } : m));
    set({ team });
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4 print:hidden">
      <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <header className="sticky top-0 bg-white border-b border-gray-100 px-5 py-4 flex items-center justify-between">
          <h2 className="font-black text-lg flex items-center gap-2"><Shield size={18} className="text-emerald-600" /> Docs Admin</h2>
          <button onClick={onClose}><X size={20} className="text-gray-400" /></button>
        </header>

        <div className="p-5 space-y-6">
          {/* Visibility */}
          <section className="space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400">Visibility</h3>
            <button
              onClick={() => set({ enabled: !draft.enabled })}
              className={`w-full flex items-center justify-between rounded-xl px-4 py-3 border ${draft.enabled ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-gray-50 border-gray-200 text-gray-600"}`}
            >
              <span className="flex items-center gap-2 font-bold text-sm">
                {draft.enabled ? <Eye size={16} /> : <EyeOff size={16} />}
                {draft.enabled ? "Published (ON)" : "Unpublished (OFF)"}
              </span>
              <span className={`w-10 h-6 rounded-full relative transition-colors ${draft.enabled ? "bg-emerald-500" : "bg-gray-300"}`}>
                <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full transition-all ${draft.enabled ? "left-[18px]" : "left-0.5"}`} />
              </span>
            </button>
          </section>

          {/* Schedule */}
          <section className="space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400">Schedule (public window)</h3>
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="text-xs text-gray-600">
                Start
                <input type="datetime-local" value={toLocalInput(draft.startISO)}
                  onChange={(e) => set({ startISO: new Date(e.target.value).toISOString() })}
                  className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
              </label>
              <label className="text-xs text-gray-600">
                End
                <input type="datetime-local" value={toLocalInput(draft.endISO)}
                  onChange={(e) => set({ endISO: new Date(e.target.value).toISOString() })}
                  className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
              </label>
            </div>
          </section>

          {/* Team */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400">Team</h3>
              <button onClick={() => set({ team: [...draft.team, { name: "", role: "", email: "" }] })}
                className="text-xs font-bold text-emerald-700 flex items-center gap-1"><Plus size={12} /> Add member</button>
            </div>
            <input value={draft.teamName} onChange={(e) => set({ teamName: e.target.value })}
              placeholder="Team name" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            {draft.team.map((m, i) => (
              <div key={i} className="border border-gray-100 rounded-xl p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold text-gray-400">Member {i + 1}</span>
                  <button onClick={() => set({ team: draft.team.filter((_, idx) => idx !== i) })}><Trash2 size={14} className="text-red-400" /></button>
                </div>
                <div className="grid sm:grid-cols-2 gap-2">
                  <input value={m.name} onChange={(e) => updateMember(i, { name: e.target.value })} placeholder="Full name" className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                  <input value={m.role} onChange={(e) => updateMember(i, { role: e.target.value })} placeholder="Role" className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                  <input value={m.email} onChange={(e) => updateMember(i, { email: e.target.value })} placeholder="Email" className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                  <input value={m.photoUrl || ""} onChange={(e) => updateMember(i, { photoUrl: e.target.value })} placeholder="Photo URL (optional)" className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                </div>
                <div className="flex gap-4 text-xs text-gray-600">
                  <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!m.isNRB} onChange={(e) => updateMember(i, { isNRB: e.target.checked })} /> NRB</label>
                  <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!m.isFemale} onChange={(e) => updateMember(i, { isFemale: e.target.checked })} /> Female</label>
                </div>
              </div>
            ))}
          </section>

          {publishMsg && (
            <div className={`text-xs rounded-lg px-3 py-2 ${publishMsg.startsWith("✓") ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>
              {publishMsg}
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <button onClick={() => onSave(draft)} className="flex-1 bg-emerald-600 text-white rounded-xl py-3 font-bold text-sm flex items-center justify-center gap-2 hover:bg-emerald-500">
              <Save size={16} /> Save & Publish to everyone
            </button>
            <button onClick={onLock} className="px-4 rounded-xl border border-gray-200 text-gray-600 text-sm font-bold hover:bg-gray-50">Lock admin</button>
          </div>
          <p className="text-[11px] text-gray-400 text-center">Publishing globally requires you to be signed in to CareAid AI (Firestore write rule).</p>
        </div>
      </div>
    </div>
  );
}

// ── Content building blocks ──────────────────────────────────────────────────
function Hero({ stats }: { stats: LiveStats | null }) {
  return (
    <div className="text-center space-y-4 pt-4">
      <span className="inline-block text-[11px] font-bold uppercase tracking-widest text-emerald-600 bg-emerald-50 px-3 py-1 rounded-full">The Infinity AI BuildFest 2026</span>
      <h1 className="text-4xl sm:text-5xl font-black tracking-tight">CareAid AI <span className="text-emerald-600">/ স্বাস্থ্য সহায়ক</span></h1>
      <p className="text-lg text-gray-500 max-w-2xl mx-auto">An offline-first AI telehealth companion bringing safe clinical triage to rural Bangladesh — in Bangla, on any phone, with or without internet.</p>
      <div className="flex flex-wrap justify-center gap-2 pt-2">
        {["Offline-first PWA", "Bilingual (BN + EN)", "On-device AI", "MBBS-audited", `${stats?.kb_entries ?? 82} clinical protocols`].map((b) => (
          <span key={b} className="text-xs font-medium bg-gray-100 text-gray-700 px-3 py-1.5 rounded-full">{b}</span>
        ))}
      </div>
    </div>
  );
}

function Section({ id, kicker, title, children }: { id: string; kicker: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20">
      <p className="text-[11px] font-bold uppercase tracking-widest text-emerald-600 mb-1">{kicker}</p>
      <h2 className="text-2xl sm:text-3xl font-black tracking-tight mb-4">{title}</h2>
      <div className="prose prose-emerald max-w-none text-gray-700 leading-relaxed space-y-3 [&_strong]:text-gray-900 [&_code]:text-emerald-700 [&_code]:bg-emerald-50 [&_code]:px-1 [&_code]:rounded">{children}</div>
    </section>
  );
}

function Divider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-4 pt-6">
      <div className="h-px bg-gray-200 flex-1" />
      <span className="text-xs font-bold uppercase tracking-widest text-gray-400">{label}</span>
      <div className="h-px bg-gray-200 flex-1" />
    </div>
  );
}

function FeatureGrid() {
  const items = [
    { icon: <Stethoscope size={18} />, t: "AI Triage", d: "Multi-turn symptom assessment, confirm-don't-guess, red-flag detection." },
    { icon: <ScanLine size={18} />, t: "Prescription Scan", d: "Gemini Vision online / Tesseract OCR offline → structured bilingual meds." },
    { icon: <Mic size={18} />, t: "Offline Voice", d: "Whisper-tiny on-device STT for Bangla + English, no internet." },
    { icon: <Activity size={18} />, t: "Decision Tree", d: "82 clinician-authored protocols, <5ms, runs on any device." },
  ];
  return (
    <div className="grid sm:grid-cols-2 gap-3 not-prose mt-4">
      {items.map((x) => (
        <div key={x.t} className="border border-gray-100 rounded-xl p-4 flex gap-3">
          <div className="w-9 h-9 bg-emerald-50 text-emerald-600 rounded-lg flex items-center justify-center shrink-0">{x.icon}</div>
          <div><p className="font-bold text-gray-900 text-sm">{x.t}</p><p className="text-xs text-gray-500 mt-0.5">{x.d}</p></div>
        </div>
      ))}
    </div>
  );
}

function StatRow({ items }: { items: { big: string; small: string }[] }) {
  return (
    <div className="grid grid-cols-3 gap-3 not-prose">
      {items.map((x) => (
        <div key={x.small} className="bg-emerald-50 rounded-xl p-4 text-center">
          <p className="text-2xl sm:text-3xl font-black text-emerald-700">{x.big}</p>
          <p className="text-[11px] text-emerald-900/70 mt-1 leading-tight">{x.small}</p>
        </div>
      ))}
    </div>
  );
}

function LiveStatsCards({ stats }: { stats: LiveStats | null }) {
  if (!stats) return <p className="text-sm text-gray-400 not-prose">Loading live system data…</p>;
  const cards = [
    { label: "Clinical protocols", value: stats.kb_entries, icon: <Database size={16} /> },
    { label: "Critical-severity", value: stats.kb_critical, icon: <AlertTriangle size={16} /> },
    { label: "On-device models", value: stats.models?.length ?? 0, icon: <Cpu size={16} /> },
    { label: "MCP tools", value: stats.mcp_tools?.length ?? 0, icon: <Server size={16} /> },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 not-prose mt-3">
      {cards.map((c) => (
        <div key={c.label} className="border border-gray-100 rounded-xl p-4">
          <div className="text-emerald-600 mb-2">{c.icon}</div>
          <p className="text-2xl font-black text-gray-900">{c.value}</p>
          <p className="text-[11px] text-gray-500">{c.label}</p>
        </div>
      ))}
      <div className="col-span-2 sm:col-span-4 text-[11px] text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2 flex items-center gap-2">
        <Zap size={12} /> Live — fetched from <code className="bg-white/60 px-1 rounded">/api/webhooks/daily-summary</code>
      </div>
    </div>
  );
}

function CompareTable() {
  const rows = [
    ["Works fully offline", "CareAid AI", true, "Typical telehealth", false],
    ["Bangla voice input", "CareAid AI", true, "Typical telehealth", false],
    ["Runs on 2GB Android", "CareAid AI", true, "Typical telehealth", false],
    ["Clinician-authored, no hallucination", "CareAid AI", true, "Generic chatbots", false],
    ["Abstains honestly when retrieval confidence is low", "CareAid AI", true, "Diagnostic AI", false],
  ];
  return (
    <div className="not-prose overflow-x-auto">
      <table className="w-full text-sm border border-gray-100 rounded-xl overflow-hidden">
        <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
          <tr><th className="text-left px-4 py-2 font-bold">Capability</th><th className="px-4 py-2 font-bold text-emerald-700">CareAid AI</th><th className="px-4 py-2 font-bold">Others</th></tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-gray-100">
              <td className="px-4 py-2.5 text-gray-700">{r[0] as string}</td>
              <td className="px-4 py-2.5 text-center"><CheckCircle2 size={16} className="text-emerald-600 inline" /></td>
              <td className="px-4 py-2.5 text-center"><X size={16} className="text-gray-300 inline" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Team grid (uniform cards + initials fallback) ────────────────────────────
function TeamGrid({ team }: { team: TeamMember[] }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 not-prose">
      {team.map((m, i) => (
        <div key={i} className="border border-gray-100 rounded-2xl p-4 text-center hover:shadow-md transition-shadow">
          <Avatar name={m.name} photoUrl={m.photoUrl} />
          <p className="font-bold text-gray-900 text-sm mt-3 truncate">{m.name || "—"}</p>
          <p className="text-[11px] text-emerald-700 font-medium truncate">{m.role || "—"}</p>
          {m.email && <a href={`mailto:${m.email}`} className="text-[10px] text-gray-400 truncate block hover:text-emerald-600">{m.email}</a>}
          <div className="flex justify-center gap-1 mt-2">
            {m.isNRB && <span className="text-[9px] bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded font-bold">NRB</span>}
            {m.isFemale && <span className="text-[9px] bg-pink-50 text-pink-700 px-1.5 py-0.5 rounded font-bold">F</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function Avatar({ name, photoUrl }: { name: string; photoUrl?: string }) {
  const initials = (name || "?").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  if (photoUrl) {
    return <img src={photoUrl} alt={name} className="w-20 h-20 rounded-full object-cover mx-auto border-2 border-emerald-100" />;
  }
  return (
    <div className="w-20 h-20 rounded-full mx-auto bg-emerald-100 text-emerald-700 flex items-center justify-center text-xl font-black border-2 border-emerald-200">
      {initials}
    </div>
  );
}

// ── Diagrams (pure CSS/flex, no Mermaid dependency) ──────────────────────────
function Box({ children, tone = "gray" }: { children: React.ReactNode; tone?: "gray" | "emerald" | "blue" | "purple" | "amber" }) {
  const tones: Record<string, string> = {
    gray: "bg-gray-50 border-gray-200 text-gray-700",
    emerald: "bg-emerald-50 border-emerald-200 text-emerald-800",
    blue: "bg-blue-50 border-blue-200 text-blue-800",
    purple: "bg-purple-50 border-purple-200 text-purple-800",
    amber: "bg-amber-50 border-amber-200 text-amber-800",
  };
  return <div className={`border rounded-xl px-3 py-2 text-xs font-medium text-center ${tones[tone]}`}>{children}</div>;
}
function Arrow() { return <ChevronRight size={16} className="text-gray-300 shrink-0 mx-auto rotate-90 sm:rotate-0" />; }

function ArchitectureDiagram() {
  return (
    <div className="not-prose space-y-3">
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
        <Box tone="emerald">UI · React 19 PWA<br /><span className="opacity-60">Triage · Scanner · Docs</span></Box>
        <Arrow />
        <Box>Express API<br /><span className="opacity-60">/api/* · /mcp/* · /webhooks/*</span></Box>
        <Arrow />
        <Box tone="purple">Services<br /><span className="opacity-60">Tier Router · Safety · RAG</span></Box>
        <Arrow />
        <Box tone="blue">Data<br /><span className="opacity-60">Firestore · IndexedDB · localStorage</span></Box>
      </div>
      <div className="grid sm:grid-cols-3 gap-2">
        <Box tone="amber">Cloud AI<br /><span className="opacity-60">Gemini 2.5 Flash · Groq Llama-4</span></Box>
        <Box tone="purple">On-device AI<br /><span className="opacity-60">SmolLM2 · Whisper · Tesseract (WASM)</span></Box>
        <Box tone="emerald">Offline KB<br /><span className="opacity-60">82 protocols · BM25 · decision tree</span></Box>
      </div>
    </div>
  );
}

function DataFlowDiagram() {
  return (
    <div className="not-prose flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
      <Box tone="emerald">Input<br /><span className="opacity-60">voice / text / image</span></Box>
      <Arrow />
      <Box>Safety classifier<br /><span className="opacity-60">30+ red-flags</span></Box>
      <Arrow />
      <Box tone="purple">Tier router<br /><span className="opacity-60">cloud → LLM → tree</span></Box>
      <Arrow />
      <Box tone="blue">Output<br /><span className="opacity-60">verdict + action</span></Box>
      <Arrow />
      <Box tone="amber">Feedback<br /><span className="opacity-60">confirm / correct / MBBS audit</span></Box>
    </div>
  );
}

function StackTable() {
  const rows: [string, string][] = [
    ["Frontend", "React 19 · TypeScript · Vite · Tailwind CSS · Framer Motion"],
    ["Backend", "Express.js (Node) · MCP SSE endpoints · webhook automation"],
    ["Database", "Firebase Firestore (offline-first IndexedDB persistence) + localStorage"],
    ["Cloud AI", "Gemini 2.5 Flash (vision/OCR) · Groq Llama-4 Maverick/Scout (chat)"],
    ["On-device AI", "SmolLM2-360M (LLM) · Whisper-tiny (STT) · Tesseract v7 (OCR) — all ONNX/WASM"],
    ["Retrieval", "Custom BM25 over 82-entry bilingual medical KB"],
    ["PWA / Offline", "vite-plugin-pwa + Workbox · service-worker precache + runtime cache"],
    ["Auth", "Firebase Auth (email/password + Google OAuth)"],
    ["Integration", "Model Context Protocol (5 tools) · n8n-ready webhooks"],
    ["Hosting", "Render (Express + static build)"],
  ];
  return (
    <div className="not-prose overflow-x-auto">
      <table className="w-full text-sm border border-gray-100 rounded-xl overflow-hidden">
        <tbody>
          {rows.map(([k, v], i) => (
            <tr key={i} className="border-t border-gray-100 first:border-t-0">
              <td className="px-4 py-2.5 font-bold text-gray-900 align-top w-32 bg-gray-50">{k}</td>
              <td className="px-4 py-2.5 text-gray-700">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ApiDocs() {
  const endpoints: [string, string, string][] = [
    ["POST", "/api/triage", "Cloud AI triage chat with safety hints + RAG context"],
    ["POST", "/api/scan-prescription", "Gemini → Groq vision cascade, returns structured prescription JSON"],
    ["POST", "/api/rate-doctor", "Submit prescription legibility rating"],
    ["GET", "/api/offline-triage", "Prefetch offline safety rules for the decision tree"],
    ["GET", "/mcp/sse", "MCP Server-Sent-Events transport (5 clinical tools)"],
    ["POST", "/mcp/messages", "MCP JSON-RPC message channel"],
    ["GET", "/mcp/health", "MCP server health + tool count"],
    ["POST", "/api/webhooks/prescription-scanned", "n8n webhook — fires on new scan"],
    ["POST", "/api/webhooks/critical-alert", "n8n webhook — fires on red-flag emergency"],
    ["GET", "/api/webhooks/daily-summary", "Live system stats (used by this page)"],
  ];
  return (
    <div className="not-prose space-y-2">
      <p className="text-sm text-gray-600 mb-3">Auth model: public REST for patient features; Firestore rules enforce per-user data isolation. MCP tools: <code className="bg-emerald-50 text-emerald-700 px-1 rounded">triage_symptoms</code>, <code className="bg-emerald-50 text-emerald-700 px-1 rounded">search_medical_kb</code>, <code className="bg-emerald-50 text-emerald-700 px-1 rounded">classify_safety</code>, <code className="bg-emerald-50 text-emerald-700 px-1 rounded">list_conditions</code>, <code className="bg-emerald-50 text-emerald-700 px-1 rounded">get_condition</code>.</p>
      {endpoints.map(([m, path, desc], i) => (
        <div key={i} className="flex items-center gap-3 border border-gray-100 rounded-lg px-3 py-2">
          <span className={`text-[10px] font-black px-2 py-1 rounded ${m === "GET" ? "bg-blue-50 text-blue-700" : "bg-emerald-50 text-emerald-700"}`}>{m}</span>
          <code className="text-xs text-gray-900 font-mono shrink-0">{path}</code>
          <span className="text-xs text-gray-500 ml-auto text-right hidden sm:block">{desc}</span>
        </div>
      ))}
    </div>
  );
}

function AiLayer({ stats }: { stats: LiveStats | null }) {
  return (
    <div className="space-y-4">
      <p>Four-tier graceful-degradation architecture. The local LLM is the priority offline tier (challenge criterion); the curated decision tree is the deterministic bedrock.</p>
      <div className="not-prose overflow-x-auto">
        <table className="w-full text-sm border border-gray-100 rounded-xl overflow-hidden">
          <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
            <tr><th className="text-left px-4 py-2 font-bold">Tier</th><th className="text-left px-4 py-2 font-bold">Engine</th><th className="text-left px-4 py-2 font-bold">Latency</th><th className="text-left px-4 py-2 font-bold">Availability</th></tr>
          </thead>
          <tbody>
            {[
              ["Cloud", "Gemini 2.5 Flash · Groq Llama-4", "~2s", "Online"],
              ["On-device LLM", "SmolLM2-360M (ONNX/WASM)", "~5-15s", "Offline · 2GB+ RAM"],
              ["Decision Tree", `${stats?.kb_entries ?? 82} protocols + BM25`, "<5ms", "Any device"],
              ["Safety Rules", "Keyword classifier", "<1ms", "Any device"],
            ].map((r, i) => (
              <tr key={i} className="border-t border-gray-100">
                {r.map((c, j) => <td key={j} className={`px-4 py-2.5 ${j === 0 ? "font-bold text-gray-900" : "text-gray-700"}`}>{c}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="list-disc pl-5 space-y-1.5">
        <li><strong>RAG:</strong> BM25 retrieval over the medical KB; top-3 matches injected as grounding context.</li>
        <li><strong>Knowledge graph:</strong> the decision tree is a condition→question→severity→action graph.</li>
        <li><strong>Explainability:</strong> the diagnostic panel shows every contributing factor (symptom, profile, regional trend, guideline) with the risk score — never a black box.</li>
        <li><strong>Safety-first:</strong> classifier runs before any model; critical red-flags force the emergency protocol the LLM cannot override.</li>
      </ul>
    </div>
  );
}

function SafetyHardening() {
  // Each entry is one clinical / retrieval safety mechanism we added to keep the side-panel
  // verdict honest. Pitch frame: the chat LLM and the BM25 panel are two INDEPENDENT reasoners;
  // these mechanisms harden the BM25 panel + the cloud prompt so neither can quietly drift.
  const items: { title: string; how: string; src: string }[] = [
    {
      title: "Negation-aware retrieval",
      how: "stripNormalcyClauses() splits the patient's message on punctuation + conjunctions, drops any clause containing normalcy phrases (স্বাভাবিকভাবে, ভালো আছে, ঠিক আছে, জাগ্রত আছে, fine, normal, no <symptom>, not <aux>) or Bangla negation particles (নেই, নাই, নয়). Applied only to the query, never to KB docs. Fixed the case where 'breathing normally, alert' was matching the breathing-difficulty entry — the OPPOSITE of what the patient reported.",
      src: "src/lib/rag.ts",
    },
    {
      title: "Implicit-symptom enrichment",
      how: "deriveImplicitSymptoms() detects temperature readings (≥99°F / ≥38°C, Bangla numerals normalised) and pediatric age (≤24 months or ≤5 years), then injects derived clinical tokens — fever, infant, pediatric, infant fever — into the BM25 query. So '৮ মাস বয়সী, ১০২ ডিগ্রী' now correctly hits fever-child-high (urgent) and fever-infant (critical) instead of an adult-diarrhea entry.",
      src: "src/lib/rag.ts",
    },
    {
      title: "Self-reflective abstention",
      how: "MIN_KB_CONFIDENCE = 2.5 threshold in runDiagnostic(). If the top BM25 score is below threshold (and no safety-critical flag fired and no forced entry), the engine returns lowConfidence: true. The UI renders an amber 'More info needed' card with the patient's own words echoed back — no percentage, no fabricated condition. Honest over confident.",
      src: "src/lib/diagnostic.ts · src/components/DiagnosticPanel.tsx",
    },
    {
      title: "Chief-complaint tracking",
      how: "chiefComplaintRef captures the first symptom-bearing user message (≥3 words). The diagnostic panel reasons over chief + latest, so a context-free clarification ('yes diarrhea, breathing normal, alert') doesn't lose the original '8mo baby + 102°F' context. Auto-resets on Clear Chat AND when the previous assistant message contained a verdict marker (🚨/🏠/⏳) — that's the explicit end-of-episode signal.",
      src: "src/pages/Triage.tsx",
    },
    {
      title: "Safety-DESC tie-break + stopword filter",
      how: "Candidate sort is BM25 score DESC with severity DESC tie-break (critical wins ties) — replaces an earlier mild-first sort that was silently downgrading critical conditions to low-risk auto-picks. Stopword list (BN+EN pronouns, modal/aux verbs, conjunctions, time/position words, question words) prevents a connective like 'আর' from driving 4+ IDF on a single-doc accident.",
      src: "src/lib/diagnostic.ts · src/lib/rag.ts",
    },
    {
      title: "Two independent reasoners, two safety nets",
      how: "The cloud/WASM chat reply and the BM25 DiagnosticPanel run in parallel and never share state. If the LLM hallucinates a wrong condition the BM25 panel is unaffected; if BM25 picks the wrong entry the LLM's free-form reasoning catches it. Plus a third always-on net: safety.classifySymptoms() runs a regex red-flag classifier on every input, and safety.scrubMedicines() strips dose-pattern lines from any critical-verdict reply.",
      src: "src/lib/tierRouter.ts · src/lib/safety.ts",
    },
    {
      title: "Pediatric ORS clinical rule (WHO IMCI)",
      how: "TRIAGE_SYSTEM in server.ts (cloud) and the offline system prompt in tierRouter.ts both carry an explicit rule: for diarrhea/vomiting in children under 5, recommend ORS (খাবার স্যালাইন) + zinc + continued breastfeeding — never plain water. Bilingual phrasing templates included. Plain water is a leading preventable-death cause for infants with diarrhea in rural BD; the rule fires even when escalating to hospital, as the immediate en-route action.",
      src: "server.ts · src/lib/tierRouter.ts",
    },
    {
      title: "Voice & UX reliability",
      how: "Web Speech runs in continuous + interim-results mode, accumulating final transcripts across utterances so a natural mid-sentence pause doesn't end the recording. Multiple voice segments append to the input draft instead of overwriting. Whisper warm-up is triggered on-demand when offline (model can be cached even when the localStorage flag was evicted) — fixed the false 'go download' alert. Empty/failed offline transcription surfaces a bilingual alert instead of silently failing. Per-message TTS Listen button reads any reply aloud in BN/EN.",
      src: "src/pages/Triage.tsx · src/lib/voiceEngine.ts · src/lib/tts.ts",
    },
    {
      title: "Gemini multi-key rotation",
      how: "collectGeminiKeys() merges GEMINI_API_KEY (legacy), GEMINI_API_KEYS (comma list), and GEMINI_API_KEY_1..._10 (numbered). Prescription-scan endpoint iterates clients on isGeminiQuotaError() (detects 429 / quota / rate / permission). Multiplies free-tier headroom for judging without hardcoded retry loops.",
      src: "server.ts",
    },
  ];
  return (
    <div className="not-prose space-y-3">
      <p className="text-sm text-gray-600">
        After observing a wrong-verdict failure in safety testing (an 8-month-old with fever + diarrhea was matched to an unrelated condition), we hardened the BM25 panel and the cloud prompt with the mechanisms below. Each is small, defensible, and code-cited — the failure became the regression test.
      </p>
      <div className="grid sm:grid-cols-2 gap-3">
        {items.map((it) => (
          <div key={it.title} className="border border-gray-100 rounded-xl p-4 bg-gradient-to-br from-emerald-50/40 to-white">
            <p className="font-bold text-emerald-800 text-sm mb-1.5 flex items-center gap-1.5">
              <Shield size={14} className="text-emerald-600" /> {it.title}
            </p>
            <p className="text-xs text-gray-700 leading-relaxed">{it.how}</p>
            <p className="text-[10px] text-gray-400 mt-2 font-mono">{it.src}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function Roadmap() {
  const cols = [
    { h: "Short term", items: ["Negation-aware BM25 + low-confidence abstention (shipped)", "Offline Whisper voice (shipped)", "MCP + webhook integration (shipped)"] },
    { h: "Mid term", items: ["Fine-tuned <100MB Bangla triage model", "Pre-cached first-aid video library", "Pregnancy & vaccination trackers"] },
    { h: "Long term", items: ["CHW coordination + SMS fallback", "Multi-country protocol packs", "Real BMDC verification API integration"] },
  ];
  return (
    <div className="grid sm:grid-cols-3 gap-3 not-prose">
      {cols.map((c) => (
        <div key={c.h} className="border border-gray-100 rounded-xl p-4">
          <p className="font-bold text-emerald-700 text-sm mb-2 flex items-center gap-1.5"><GitBranch size={14} /> {c.h}</p>
          <ul className="space-y-1.5">
            {c.items.map((x) => <li key={x} className="text-xs text-gray-600 flex gap-1.5"><span className="text-emerald-500">•</span>{x}</li>)}
          </ul>
        </div>
      ))}
    </div>
  );
}

function Changelog() {
  const log: [string, string][] = [
    ["v2.1", "Safety hardening: negation-aware BM25 (stripNormalcyClauses) · implicit symptom enrichment (temperature → fever, age → pediatric) · chief-complaint tracking with verdict-marker reset · MIN_KB_CONFIDENCE abstention + LowConfidenceCard UI · pediatric ORS rule in TRIAGE_SYSTEM (WHO IMCI) · per-message TTS Listen button · Whisper warm-up-on-demand · continuous-mode Web Speech with multi-utterance accumulation · Gemini multi-key rotation"],
    ["v2.0", "Triage refresh: auto-pick top BM25 candidate (no confirm picker) · severity-DESC tie-break for safety · BM25 stopword filter (BN+EN) · 'What I heard' echo + 'Likely: <condition>' label · triage-not-diagnose prompts · accept-corrections · /docs module"],
    ["v1.5", "Removed WebGPU tier · SmolLM2-360M on-device · offline Whisper STT · 82-entry KB · MCP server + n8n webhooks"],
    ["v1.0", "Offline-first PWA · tiered AI · prescription scanner · Firebase auth + sync · bilingual triage"],
  ];
  return (
    <div className="not-prose space-y-2">
      {log.map(([v, d], i) => (
        <div key={i} className="flex gap-3">
          <span className="text-xs font-black text-emerald-700 bg-emerald-50 rounded px-2 py-1 h-fit shrink-0">{v}</span>
          <p className="text-sm text-gray-600">{d}</p>
        </div>
      ))}
    </div>
  );
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}
