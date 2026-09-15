import React, { useState, useEffect } from "react";

const FONTS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
`;

const initialForm = {
  company: "",
  contactName: "",
  contactTitle: "",
  linkedinUrl: "",
  product: "",
  notes: "",
};

// Scans for every balanced {...} span in the text (handles model prose,
// markdown fences, or stray braces before/after the real payload), then
// returns the first one that both parses and contains the given key.
function extractJSON(text, requiredKey) {
  const candidates = [];
  const starts = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") starts.push(i);
    else if (text[i] === "}" && starts.length) {
      const start = starts.pop();
      if (starts.length === 0) candidates.push(text.slice(start, i + 1));
    }
  }
  candidates.sort((a, b) => b.length - a.length);
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === "object" && requiredKey in parsed) {
        return parsed;
      }
    } catch (_) {
      // not valid JSON, try next candidate
    }
  }
  throw new Error("No JSON found in response");
}

function stripFences(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

// In this chat, Uncover calls api.anthropic.com directly because Claude.ai
// injects credentials for artifacts automatically. A real deployment has no
// such injection, so this calls your own backend instead — see server.js /
// api/messages.js in this same project, which holds the real API key and
// pins the model + token cap server-side.
async function callClaude(prompt, { webSearch = false } = {}) {
  const response = await fetch("/api/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
      ...(webSearch ? { tools: [{ type: "web_search_20250305", name: "web_search" }] } : {}),
    }),
  });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  const data = await response.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const sources = [];
  (data.content || []).forEach((b) => {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      b.content.forEach((r) => {
        if (r.url) sources.push({ url: r.url, title: r.title || r.url });
      });
    }
  });
  return { text, sources };
}

// Palette — Rocketlane-style: white surface, indigo/violet primary, lavender tints
const C = {
  bg: "#FFFFFF",
  sidebar: "#FAFAFD",
  border: "#E7E5F2",
  ink: "#14142B",
  sub: "#6E7191",
  faint: "#A0A3BD",
  primary: "#6C4FF6",
  primaryDark: "#5B3FE0",
  lavender: "#F1EEFE",
  lavenderBorder: "#DED8FB",
  green: "#1FAE6D",
  greenBg: "#E7F8F0",
  amber: "#B4740E",
  amberBg: "#FDF1DC",
  red: "#B23B3B",
  redBg: "#FDECEC",
  shadow: "0 1px 2px rgba(20,20,43,0.05), 0 8px 24px rgba(20,20,43,0.04)",
};

const TABS = [
  { id: "briefing", label: "Briefing" },
  { id: "score", label: "Score" },
  { id: "email", label: "Email" },
  { id: "script", label: "Call script" },
  { id: "sequence", label: "Sequence" },
  { id: "crm", label: "CRM note" },
];

export default function CallBrief() {
  const [form, setForm] = useState(initialForm);
  const [status, setStatus] = useState("idle"); // idle | loading | done | error (briefing only)
  const [brief, setBrief] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [sources, setSources] = useState([]);
  const [briefsBuilt, setBriefsBuilt] = useState(null);
  const [activeTab, setActiveTab] = useState("briefing");

  // Per-tab lazily-generated artifacts: { [tabId]: { status, data, error } }
  const [artifacts, setArtifacts] = useState({});

  useEffect(() => {
    (async () => {
      try {
        const result = await window.storage.get("uncover:briefsBuilt");
        setBriefsBuilt(result ? parseInt(result.value, 10) || 0 : 0);
      } catch (_) {
        setBriefsBuilt(0);
      }
    })();
  }, []);

  const update = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const canSubmit = form.company.trim().length > 0 && status !== "loading";

  async function generateBriefing() {
    setStatus("loading");
    setErrorMsg("");
    setBrief(null);
    setArtifacts({});
    setActiveTab("briefing");

    const userPrompt = `You are preparing a salesperson for an upcoming call. Research the company below using web search, then produce a call briefing.

Prospect company: ${form.company}
Contact: ${form.contactName || "unknown"}${form.contactTitle ? `, ${form.contactTitle}` : ""}${form.linkedinUrl ? `\nContact's LinkedIn: ${form.linkedinUrl} — check this profile for their recent posts, role history, and shared connections or interests worth referencing.` : ""}
What we're selling: ${form.product || "not specified"}
Rep's notes so far: ${form.notes || "none"}

After researching, respond with ONLY a JSON object (no markdown fences, no commentary before or after) with this exact shape:
{
  "companySnapshot": "2-3 sentence plain-language summary of what the company does, size, and market position",
  "recentTriggers": ["2-4 short bullet strings on recent news, funding, product launches, leadership changes, or other timely hooks"],
  "painPoints": ["3-4 short bullet strings on likely business pains this company faces that relate to what we're selling"],
  "talkingPoints": ["3-4 short bullet strings — specific, tailored angles the rep should raise, referencing the company by name where natural"],
  "discoveryQuestions": ["3-5 open-ended questions the rep should ask on the call"],
  "objections": [{"objection": "short anticipated objection", "response": "1-2 sentence suggested response"}],
  "openingLine": "one natural sentence the rep could use to open the call, referencing something specific and current about the company"
}
Keep every string concise and concrete. Do not invent specific numbers you did not find; keep those qualitative if unsure.`;

    try {
      const { text, sources: foundSources } = await callClaude(userPrompt, { webSearch: true });
      const parsed = extractJSON(text, "companySnapshot");
      setBrief(parsed);
      setSources(foundSources.slice(0, 5));
      setStatus("done");

      const nextCount = (briefsBuilt || 0) + 1;
      setBriefsBuilt(nextCount);
      try {
        await window.storage.set("uncover:briefsBuilt", String(nextCount));
      } catch (_) {
        // non-fatal
      }
    } catch (err) {
      setErrorMsg(err.message || "Something went wrong generating the briefing.");
      setStatus("error");
    }
  }

  // Builds the shared research context handed to every downstream generator,
  // so the score/email/script/sequence/CRM note all stay grounded in the same facts.
  function researchContext() {
    return `Company: ${form.company}
Contact: ${form.contactName || "unknown"}${form.contactTitle ? `, ${form.contactTitle}` : ""}
Selling: ${form.product || "not specified"}
Research already gathered:
${JSON.stringify(brief, null, 2)}`;
  }

  async function generateArtifact(kind) {
    setArtifacts((a) => ({ ...a, [kind]: { status: "loading" } }));
    try {
      let text;
      if (kind === "score") {
        const prompt = `Based on this account research, score the prospect's sales-readiness.
${researchContext()}

Respond with ONLY JSON (no fences, no commentary):
{
  "score": <integer 1-10>,
  "band": "Hot" | "Warm" | "Cool",
  "reasoning": "2-3 sentences grounded in the specific research above — not generic. If the research is too thin to score confidently, say so and default to a middle score.",
  "factors": [{"label": "short factor name", "note": "one line on why it helped or hurt the score"}]
}`;
        const { text: t } = await callClaude(prompt);
        const parsed = extractJSON(t, "score");
        setArtifacts((a) => ({ ...a, score: { status: "done", data: parsed } }));
        return;
      }

      if (kind === "email") {
        const prompt = `Draft a short outreach email using this research.
${researchContext()}

Requirements: under 150 words, one clear call to action, natural tone (not salesy), reference something specific and current about the company. Respond in exactly this plain-text format, nothing else:
Subject: <subject line>

<body>`;
        ({ text } = await callClaude(prompt));
      } else if (kind === "script") {
        const prompt = `Build a flexible call outline (not a word-for-word script) for a discovery call, using this research.
${researchContext()}

Structure with these plain-text headers: Opening, Discovery questions, Value alignment, Likely objections, Close. Keep it a guide the rep adapts live, not lines to read verbatim. Respond with plain text only, no markdown fences.`;
        ({ text } = await callClaude(prompt));
      } else if (kind === "sequence") {
        const prompt = `Design a 5-6 touch outbound sequence (mix of email, LinkedIn, and call) over roughly 2-3 weeks, using this research.
${researchContext()}

For each touch give: day number, channel, goal, and a one-line content idea. Respond as a plain-text numbered list, no markdown fences.`;
        ({ text } = await callClaude(prompt));
      } else if (kind === "crm") {
        const prompt = `Write a concise CRM activity note summarizing this account's research and call readiness, suitable for logging against the contact's record.
${researchContext()}

Under 100 words, factual, no fluff. Plain text only.`;
        ({ text } = await callClaude(prompt));
      }
      setArtifacts((a) => ({ ...a, [kind]: { status: "done", data: stripFences(text) } }));
    } catch (err) {
      setArtifacts((a) => ({ ...a, [kind]: { status: "error", error: err.message || "Generation failed." } }));
    }
  }

  function selectTab(id) {
    setActiveTab(id);
    if (id !== "briefing" && !artifacts[id]) generateArtifact(id);
  }

  return (
    <div style={{ fontFamily: "'Inter', sans-serif", background: C.bg, minHeight: "100%", color: C.ink }}>
      <style>{FONTS}</style>
      <div style={{ display: "flex", flexWrap: "wrap", minHeight: "100%" }}>
        {/* Sidebar */}
        <div
          style={{
            width: "320px",
            flex: "0 0 320px",
            background: C.sidebar,
            borderRight: `1px solid ${C.border}`,
            padding: "24px 22px",
            boxSizing: "border-box",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "9px", marginBottom: "22px" }}>
            <div
              style={{
                width: "26px",
                height: "26px",
                borderRadius: "7px",
                background: C.primary,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#fff",
                fontSize: "13px",
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              U
            </div>
            <div style={{ fontSize: "16px", fontWeight: 700, color: C.ink }}>Uncover</div>
          </div>

          <div style={{ fontSize: "13px", color: C.sub, lineHeight: 1.55, marginBottom: "14px" }}>
            Give it a company and what you know. It researches the account, then builds everything downstream from
            that same research: a score, an email, a call outline, a sequence, and a CRM note.
          </div>

          <div
            style={{
              fontSize: "12px",
              color: C.faint,
              lineHeight: 1.6,
              marginBottom: "22px",
              paddingBottom: "20px",
              borderBottom: `1px solid ${C.border}`,
            }}
          >
            The CRM note is a draft to paste in — this runs as a standalone tool, so it can't write to your CRM
            directly without a connected integration.
          </div>

          <Field label="Company">
            <input value={form.company} onChange={update("company")} placeholder="e.g. Northwind Logistics" style={inputStyle} />
          </Field>

          <div style={{ display: "flex", gap: "10px" }}>
            <div style={{ flex: 1 }}>
              <Field label="Contact name">
                <input value={form.contactName} onChange={update("contactName")} placeholder="Jordan Lee" style={inputStyle} />
              </Field>
            </div>
            <div style={{ flex: 1 }}>
              <Field label="Their title">
                <input value={form.contactTitle} onChange={update("contactTitle")} placeholder="VP Ops" style={inputStyle} />
              </Field>
            </div>
          </div>

          <Field label="Their LinkedIn (optional)">
            <input value={form.linkedinUrl} onChange={update("linkedinUrl")} placeholder="linkedin.com/in/jordanlee" style={inputStyle} />
          </Field>

          <Field label="What you're selling">
            <input value={form.product} onChange={update("product")} placeholder="e.g. warehouse routing software" style={inputStyle} />
          </Field>

          <Field label="Notes so far (optional)">
            <textarea
              value={form.notes}
              onChange={update("notes")}
              placeholder="Anything from prior emails, a referral, LinkedIn activity..."
              rows={4}
              style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }}
            />
          </Field>

          <button
            onClick={generateBriefing}
            disabled={!canSubmit}
            style={{
              width: "100%",
              marginTop: "6px",
              padding: "11px 16px",
              borderRadius: "8px",
              border: "none",
              background: canSubmit ? C.primary : "#E4E2F1",
              color: canSubmit ? "#fff" : C.faint,
              fontWeight: 600,
              fontSize: "14px",
              cursor: canSubmit ? "pointer" : "not-allowed",
              boxShadow: canSubmit ? "0 1px 2px rgba(108,79,246,0.35)" : "none",
            }}
          >
            {status === "loading" ? "Researching…" : "Build the briefing"}
          </button>

          {status === "error" && (
            <div
              style={{
                marginTop: "12px",
                fontSize: "13px",
                color: C.red,
                background: C.redBg,
                border: "1px solid #F6D0D0",
                borderRadius: "8px",
                padding: "10px 12px",
                lineHeight: 1.5,
              }}
            >
              Couldn't finish that briefing: {errorMsg}. Try again.
            </div>
          )}

          {briefsBuilt !== null && briefsBuilt > 0 && (
            <div
              style={{
                marginTop: "20px",
                paddingTop: "16px",
                borderTop: `1px solid ${C.border}`,
                display: "flex",
                alignItems: "center",
                gap: "8px",
                fontSize: "13px",
                color: C.sub,
              }}
            >
              <span
                style={{
                  fontSize: "12px",
                  fontWeight: 700,
                  color: C.primaryDark,
                  background: C.lavender,
                  border: `1px solid ${C.lavenderBorder}`,
                  borderRadius: "999px",
                  padding: "3px 9px",
                }}
              >
                🎯 {briefsBuilt}
              </span>
              {briefsBuilt === 1 ? "briefing built" : "briefings built"}
            </div>
          )}
        </div>

        {/* Main panel */}
        <div style={{ flex: "1 1 480px", padding: "32px 40px", minWidth: "320px" }}>
          {status === "idle" && <EmptyState />}
          {status === "loading" && <LoadingState company={form.company} />}
          {(status === "done" || status === "error") && brief && (
            <>
              <TabBar activeTab={activeTab} onSelect={selectTab} />
              {activeTab === "briefing" && <Briefing brief={brief} form={form} sources={sources} />}
              {activeTab !== "briefing" && (
                <ArtifactPanel kind={activeTab} state={artifacts[activeTab]} form={form} onRetry={() => generateArtifact(activeTab)} />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function TabBar({ activeTab, onSelect }) {
  return (
    <div style={{ display: "flex", gap: "4px", borderBottom: `1px solid ${C.border}`, marginBottom: "22px", flexWrap: "wrap" }}>
      {TABS.map((t) => {
        const active = activeTab === t.id;
        return (
          <button
            key={t.id}
            onClick={() => onSelect(t.id)}
            style={{
              border: "none",
              background: "none",
              cursor: "pointer",
              padding: "10px 14px",
              fontSize: "13px",
              fontWeight: active ? 700 : 500,
              color: active ? C.primaryDark : C.sub,
              borderBottom: active ? `2px solid ${C.primary}` : "2px solid transparent",
              marginBottom: "-1px",
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function ArtifactPanel({ kind, state, form, onRetry }) {
  const titles = {
    score: "Account score",
    email: "Outreach email",
    script: "Call outline",
    sequence: "Outbound sequence",
    crm: "CRM note",
  };

  if (!state || state.status === "loading") {
    return (
      <div style={{ maxWidth: "620px" }}>
        <div style={{ fontSize: "14px", color: C.sub }}>Generating {titles[kind].toLowerCase()}…</div>
        <div style={{ marginTop: "14px", height: "6px", width: "180px", background: C.lavender, borderRadius: "999px", overflow: "hidden" }}>
          <div style={{ height: "100%", width: "40%", background: C.primary, borderRadius: "999px", animation: "loadbar 1.1s ease-in-out infinite" }} />
        </div>
        <style>{`@keyframes loadbar { 0% { transform: translateX(-100%); } 100% { transform: translateX(350%); } }`}</style>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div style={{ maxWidth: "500px" }}>
        <div
          style={{
            fontSize: "13px",
            color: C.red,
            background: C.redBg,
            border: "1px solid #F6D0D0",
            borderRadius: "8px",
            padding: "12px 14px",
            marginBottom: "12px",
          }}
        >
          Couldn't generate that: {state.error}
        </div>
        <button
          onClick={onRetry}
          style={{
            border: `1px solid ${C.border}`,
            background: "#fff",
            borderRadius: "8px",
            padding: "8px 14px",
            fontSize: "13px",
            fontWeight: 600,
            color: C.ink,
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  if (kind === "score") return <ScorePanel data={state.data} />;

  // email, script, sequence, crm are all plain text
  return (
    <div style={{ maxWidth: "620px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" }}>
        <div style={{ fontSize: "20px", fontWeight: 700, color: C.ink }}>{titles[kind]}</div>
        <CopyButton text={state.data} />
      </div>
      {kind === "crm" && (
        <div
          style={{
            fontSize: "12px",
            color: C.amber,
            background: C.amberBg,
            border: "1px solid #F3DBAA",
            borderRadius: "8px",
            padding: "8px 12px",
            marginBottom: "14px",
          }}
        >
          Draft only — copy this into your CRM. This tool has no live connection to write it for you.
        </div>
      )}
      <Card style={{ whiteSpace: "pre-wrap", fontSize: "14px", lineHeight: 1.7, color: "#4E4B66" }}>{state.data}</Card>
    </div>
  );
}

function ScorePanel({ data }) {
  const bandTone = data.band === "Hot" ? "green" : data.band === "Cool" ? "amber" : "lavender";
  return (
    <div style={{ maxWidth: "560px" }}>
      <div style={{ fontSize: "20px", fontWeight: 700, color: C.ink, marginBottom: "14px" }}>Account score</div>
      <Card style={{ display: "flex", alignItems: "center", gap: "18px", marginBottom: "16px" }}>
        <div
          style={{
            width: "58px",
            height: "58px",
            borderRadius: "999px",
            background: C.lavender,
            border: `2px solid ${C.primary}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "20px",
            fontWeight: 700,
            color: C.primaryDark,
            flexShrink: 0,
          }}
        >
          {data.score}
        </div>
        <div>
          <Badge tone={bandTone}>{data.band}</Badge>
          <div style={{ fontSize: "13px", color: C.sub, marginTop: "8px", lineHeight: 1.6 }}>{data.reasoning}</div>
        </div>
      </Card>
      {Array.isArray(data.factors) && data.factors.length > 0 && (
        <>
          <SectionTitle>What's driving this</SectionTitle>
          {data.factors.map((f, i) => (
            <div key={i} style={{ display: "flex", gap: "8px", marginBottom: "8px", fontSize: "13px" }}>
              <span style={{ fontWeight: 600, color: C.ink, flexShrink: 0 }}>{f.label}:</span>
              <span style={{ color: C.sub }}>{f.note}</span>
            </div>
          ))}
        </>
      )}
      <div style={{ fontSize: "12px", color: C.faint, marginTop: "18px", lineHeight: 1.6 }}>
        This is a heuristic read from public research, not a model calibrated on your actual win/loss data — treat
        it as a starting point, not a verdict.
      </div>
    </div>
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for environments without the async clipboard API
        const el = document.createElement("textarea");
        el.value = text;
        el.style.position = "fixed";
        el.style.opacity = "0";
        document.body.appendChild(el);
        el.select();
        document.execCommand("copy");
        document.body.removeChild(el);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch (_) {
      // clipboard blocked — button simply won't confirm; text is still selectable
    }
  }

  return (
    <button
      onClick={handleCopy}
      style={{
        border: `1px solid ${copied ? C.green : C.border}`,
        background: copied ? C.greenBg : "#fff",
        color: copied ? C.green : C.sub,
        borderRadius: "7px",
        padding: "6px 12px",
        fontSize: "12px",
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: "14px" }}>
      <label style={{ display: "block", fontSize: "12px", fontWeight: 500, color: C.sub, marginBottom: "6px" }}>
        {label}
      </label>
      {children}
    </div>
  );
}

const inputStyle = {
  width: "100%",
  boxSizing: "border-box",
  background: "#fff",
  border: `1px solid ${C.border}`,
  borderRadius: "8px",
  padding: "9px 11px",
  fontSize: "14px",
  color: C.ink,
  outline: "none",
};

function Badge({ children, tone = "lavender" }) {
  const tones = {
    lavender: { bg: C.lavender, border: C.lavenderBorder, color: C.primaryDark },
    green: { bg: C.greenBg, border: "#BEEBD4", color: C.green },
    amber: { bg: C.amberBg, border: "#F3DBAA", color: C.amber },
  };
  const t = tones[tone];
  return (
    <span
      style={{
        display: "inline-block",
        fontSize: "12px",
        fontWeight: 600,
        padding: "3px 10px",
        borderRadius: "999px",
        background: t.bg,
        border: `1px solid ${t.border}`,
        color: t.color,
      }}
    >
      {children}
    </span>
  );
}

function Card({ children, style }) {
  return (
    <div
      style={{
        background: "#fff",
        border: `1px solid ${C.border}`,
        borderRadius: "12px",
        boxShadow: C.shadow,
        padding: "18px 20px",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function EmptyState() {
  return (
    <div style={{ maxWidth: "460px", marginTop: "48px" }}>
      <style>{`
        @keyframes radarPulse {
          0% { transform: scale(0.9); opacity: 0.7; }
          70% { transform: scale(1.9); opacity: 0; }
          100% { transform: scale(1.9); opacity: 0; }
        }
        @keyframes idleRise {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      <div style={{ position: "relative", width: "44px", height: "44px", marginBottom: "18px" }}>
        <span
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "999px",
            border: `2px solid ${C.primary}`,
            animation: "radarPulse 2.4s ease-out infinite",
          }}
        />
        <span
          style={{
            position: "absolute",
            inset: "10px",
            borderRadius: "999px",
            background: C.primary,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            fontSize: "13px",
          }}
        >
          🔍
        </span>
      </div>

      <div style={{ animation: "idleRise 400ms ease-out" }}>
        <Badge>Pre-call research</Badge>
        <div style={{ fontSize: "22px", fontWeight: 700, color: C.ink, margin: "14px 0 10px" }}>
          Walk in already knowing them
        </div>
        <p style={{ color: C.sub, fontSize: "14px", lineHeight: 1.7, marginBottom: "22px" }}>
          Drop in a company on the left. Once the research is in, you can generate a score, an email, a call
          outline, a sequence, and a CRM note — all built from the same facts.
        </p>

        <div style={{ border: `1px dashed ${C.border}`, borderRadius: "12px", padding: "16px 18px", background: C.sidebar }}>
          <div style={{ fontSize: "11px", fontWeight: 700, color: C.faint, marginBottom: "10px" }}>What you'll get</div>
          {[
            "A briefing: opening line, pain points, objection cover",
            "A sales-readiness score with its reasoning shown",
            "A draft outreach email",
            "A flexible call outline",
            "A multi-touch outbound sequence",
            "A CRM note ready to paste in",
          ].map((line, i, arr) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: i === arr.length - 1 ? 0 : "8px" }}>
              <span style={{ width: "5px", height: "5px", borderRadius: "999px", background: C.primary, flexShrink: 0 }} />
              <span style={{ fontSize: "13px", color: "#4E4B66" }}>{line}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function LoadingState({ company }) {
  const steps = [
    `Pulling up everything public about ${company || "the account"}`,
    "Scanning for recent news and funding signals",
    "Sizing up the pain points your pitch should hit",
    "Drafting an opening line worth using",
    "Lining up answers to the objections they'll raise",
  ];
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    setStepIndex(0);
    const id = setInterval(() => {
      setStepIndex((i) => Math.min(i + 1, steps.length - 1));
    }, 1400);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company]);

  return (
    <div style={{ marginTop: "60px", maxWidth: "440px" }}>
      <div style={{ fontSize: "18px", fontWeight: 700, color: C.ink, marginBottom: "16px" }}>Building your briefing…</div>
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {steps.map((step, i) => {
          const state = i < stepIndex ? "done" : i === stepIndex ? "active" : "pending";
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <span
                style={{
                  width: "18px",
                  height: "18px",
                  borderRadius: "999px",
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "11px",
                  fontWeight: 700,
                  color: state === "pending" ? C.faint : "#fff",
                  background: state === "done" ? C.green : state === "active" ? C.primary : C.lavender,
                  border: state === "pending" ? `1px solid ${C.border}` : "none",
                  transition: "background 200ms ease",
                }}
              >
                {state === "done" ? "✓" : ""}
              </span>
              <span style={{ fontSize: "14px", color: state === "pending" ? C.faint : C.ink, fontWeight: state === "active" ? 600 : 400 }}>
                {step}
                {state === "active" && <AnimatedDots />}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AnimatedDots() {
  return (
    <span style={{ display: "inline-block", width: "18px" }}>
      <style>{`
        @keyframes dotfade { 0%, 20% { opacity: 0; } 50% { opacity: 1; } 100% { opacity: 0; } }
        .uncover-dot { animation: dotfade 1.4s infinite; }
        .uncover-dot:nth-child(2) { animation-delay: 0.2s; }
        .uncover-dot:nth-child(3) { animation-delay: 0.4s; }
      `}</style>
      <span className="uncover-dot">.</span>
      <span className="uncover-dot">.</span>
      <span className="uncover-dot">.</span>
    </span>
  );
}

function SectionTitle({ children }) {
  return <div style={{ fontSize: "13px", fontWeight: 700, color: C.ink, marginBottom: "10px", marginTop: "26px" }}>{children}</div>;
}

function Briefing({ brief, form, sources }) {
  const [showConfetti, setShowConfetti] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setShowConfetti(false), 1300);
    return () => clearTimeout(t);
  }, []);

  const insightCount =
    (brief.recentTriggers?.length || 0) +
    (brief.painPoints?.length || 0) +
    (brief.talkingPoints?.length || 0) +
    (brief.discoveryQuestions?.length || 0) +
    (brief.objections?.length || 0) +
    (brief.openingLine ? 1 : 0);

  return (
    <div style={{ maxWidth: "660px", position: "relative", animation: "riseIn 380ms ease-out" }}>
      <style>{`@keyframes riseIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }`}</style>
      {showConfetti && <Confetti />}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
        <Badge>Call briefing</Badge>
        {insightCount > 0 && <Badge tone="green">{insightCount} insights uncovered</Badge>}
      </div>
      <div style={{ fontSize: "26px", fontWeight: 700, color: C.ink, margin: "12px 0 2px" }}>{form.company}</div>
      {form.contactName && (
        <div style={{ fontSize: "14px", color: C.sub }}>
          {form.contactName}
          {form.contactTitle ? `, ${form.contactTitle}` : ""}
          {form.linkedinUrl && (
            <>
              {" · "}
              <a
                href={form.linkedinUrl.startsWith("http") ? form.linkedinUrl : `https://${form.linkedinUrl}`}
                target="_blank"
                rel="noreferrer"
                style={{ color: C.primary }}
              >
                LinkedIn
              </a>
            </>
          )}
        </div>
      )}

      <Card style={{ marginTop: "18px", borderLeft: `3px solid ${C.primary}` }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" }}>
          <div>
            <span style={{ color: C.sub, fontSize: "12px", fontWeight: 600, display: "block", marginBottom: "4px" }}>Open with</span>
            <span style={{ fontSize: "14px", lineHeight: 1.6, color: C.ink }}>“{brief.openingLine}”</span>
          </div>
          <CopyButton text={brief.openingLine} />
        </div>
      </Card>

      <SectionTitle>Company snapshot</SectionTitle>
      <p style={{ fontSize: "14px", lineHeight: 1.7, color: "#4E4B66", margin: 0 }}>{brief.companySnapshot}</p>

      {brief.recentTriggers?.length > 0 && (
        <>
          <SectionTitle>Recent triggers</SectionTitle>
          <BulletList items={brief.recentTriggers} />
        </>
      )}

      {brief.painPoints?.length > 0 && (
        <>
          <SectionTitle>Likely pain points</SectionTitle>
          <BulletList items={brief.painPoints} />
        </>
      )}

      {brief.talkingPoints?.length > 0 && (
        <>
          <SectionTitle>Talking points</SectionTitle>
          <BulletList items={brief.talkingPoints} />
        </>
      )}

      {brief.discoveryQuestions?.length > 0 && (
        <>
          <SectionTitle>Questions to ask</SectionTitle>
          <ol style={{ margin: 0, paddingLeft: "20px", color: "#4E4B66", fontSize: "14px", lineHeight: 1.9 }}>
            {brief.discoveryQuestions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ol>
        </>
      )}

      {brief.objections?.length > 0 && (
        <>
          <SectionTitle>If they push back</SectionTitle>
          {brief.objections.map((o, i) => (
            <Card key={i} style={{ marginBottom: "10px", padding: "14px 16px" }}>
              <div style={{ fontSize: "14px", color: C.ink, fontWeight: 600, marginBottom: "4px" }}>“{o.objection}”</div>
              <div style={{ fontSize: "13px", color: C.sub, lineHeight: 1.6 }}>{o.response}</div>
            </Card>
          ))}
        </>
      )}

      {sources.length > 0 && (
        <>
          <SectionTitle>Sources</SectionTitle>
          <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "12px", color: C.faint, lineHeight: 1.8 }}>
            {sources.map((s, i) => (
              <li key={i}>
                <a href={s.url} target="_blank" rel="noreferrer" style={{ color: C.faint }}>
                  {s.title}
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Confetti() {
  const colors = [C.primary, C.green, C.amber, C.primaryDark, "#3AA0FF"];
  const pieces = Array.from({ length: 16 }, (_, i) => ({
    left: 4 + ((i * 61) % 96),
    delay: (i % 6) * 60,
    duration: 900 + (i % 5) * 140,
    color: colors[i % colors.length],
    rotate: (i * 47) % 360,
  }));

  return (
    <div style={{ position: "absolute", top: "-10px", left: 0, right: 0, height: "90px", overflow: "hidden", pointerEvents: "none" }}>
      <style>{`@keyframes confettiFall { 0% { transform: translateY(-10px) rotate(0deg); opacity: 1; } 100% { transform: translateY(90px) rotate(340deg); opacity: 0; } }`}</style>
      {pieces.map((p, i) => (
        <span
          key={i}
          style={{
            position: "absolute",
            top: 0,
            left: `${p.left}%`,
            width: "6px",
            height: "9px",
            background: p.color,
            borderRadius: "1px",
            transform: `rotate(${p.rotate}deg)`,
            animation: `confettiFall ${p.duration}ms ease-in ${p.delay}ms forwards`,
          }}
        />
      ))}
    </div>
  );
}

function BulletList({ items }) {
  return (
    <ul style={{ margin: 0, paddingLeft: "18px", color: "#4E4B66", fontSize: "14px", lineHeight: 1.9 }}>
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}
