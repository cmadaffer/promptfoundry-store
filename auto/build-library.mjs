// auto/build-library.mjs
// Generates a revenue-ready library.json from templates + overlays (no LLM required)

import { writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";

const STRIPE = "https://buy.stripe.com/fZudR89pEfa68sDgSs5Ne00"; // your link

// --- Helpers
const nowIso = () => new Date().toISOString();
const uid = (s) => createHash("md5").update(String(s)).digest("hex").slice(0, 10);
const esc = (s) => String(s).replaceAll("&","&amp;").replaceAll("<","&lt;");
const goalToCategory = (g) => g === "leadgen" ? "LeadGen" : g === "invoice" ? "ClientReach" : g === "chargebacks" ? "Chargebacks" : g === "pricing" ? "Ops" : "Landing";

// --- Core building blocks
const OVERLAYS = [
  { key: "Home Services", industry: "Home Services", role: "Owner",  service: "installation",  city: "Naples, FL", proof_point: "100+ jobs", time_window: "15-minute", tone: "confident, respectful, direct" },
  { key: "eCommerce",     industry: "eCommerce",     role: "Owner",  service: "store optimization", city: "Austin, TX", proof_point: "conversion lift", time_window: "15-minute", tone: "confident, respectful, direct" },
  { key: "B2B SaaS",      industry: "B2B SaaS",      role: "Founder",service: "demo setup",   city: "NYC, NY",   proof_point: "ROI metric", time_window: "20-minute", tone: "pragmatic, concise" },
  { key: "Agencies",      industry: "Agency",        role: "Principal", service: "campaign build", city: "Miami, FL", proof_point: "client wins", time_window: "20-minute", tone: "credible, direct" },
  { key: "Local Retail",  industry: "Local Retail",  role: "Owner",  service: "POS + marketing", city: "Tampa, FL", proof_point: "local refs", time_window: "15-minute", tone: "friendly, straight" },
];

const TEMPLATES = [
  { goal: "leadgen",  title: "Local Services — 75-Word Lead Gen", tags: ["Universal","LeadGen"], channels: ["email","dm","sms"],
    template: `Write a {{channel}} outreach for a {{industry}} {{role}} offering {{service}} in {{city}}. Tone: {{tone}}. Include one proof ({{proof_point}}) and a single CTA to book a {{time_window}} using {{cta_link}}. Keep under {{word_limit}} words.` },
  { goal: "invoice",  title: "Operations — Overdue Invoice Follow-Up", tags: ["Universal","Finance"], channels: ["email"],
    template: `Write a {{channel}} follow-up for Invoice {{invoice_number}} ({{amount}}) sent {{sent_date}}. Tone: {{tone}}. Include payment link {{cta_link}} and two optional call slots. Cap at {{word_limit}} words.` },
  { goal: "chargebacks", title: "Merchant — Network-Safe Chargeback Letter", tags: ["Universal","Disputes"], channels: ["email"],
    template: `Draft a representment for {{network}} {{reason_code}}. Include {{order_id}}, {{amount}}, {{order_date}} and evidence (IP/device, AVS/CVV, 3-D Secure, delivery, comms). Map evidence → criteria. Ask for reversal.` },
  { goal: "pricing",  title: "Pricing — Margin Impact Playbook", tags: ["Universal","Pricing"], channels: ["landing"],
    template: `Given competitor prices and cost basis {{cost_basis}}, output top 10 price moves with estimated margin delta and risks. Prioritize.` },
  { goal: "landing",  title: "Landing — Value Prop & Hero", tags: ["Universal","Copy"], channels: ["landing"],
    template: `For {{industry}} {{service}}, write a hero headline (≤10), subhead (≤18), three benefits, and a primary CTA label. Output compact JSON.` },
];

const STARTER = [
  { category:"Chargebacks", title:"Chargeback Win Kit — Visa 10.4 (Fraud)", tags:["Disputes","Operations"], price:99,
    prompt:`Draft a Visa 10.4 representment for {{order_id}} {{amount}} {{order_date}}. Map evidence to 10.4 criteria. Include: 3-D Secure data, AVS/CVV, IP/device, delivery proof, prior comms. Close with issuer guidance.` },
  { category:"Chargebacks", title:"Chargeback Win Kit — Mastercard 4853", tags:["Disputes","Operations"], price:99,
    prompt:`Draft a Mastercard 4853 representment for {{order_id}} {{amount}} {{order_date}}. Map evidence to 4853 documentation. Include identity/auth, usage logs, delivery, support thread, refund policy, terms consent.` },
  { category:"ClientReach", title:"ClientReach — Overdue Invoice Nudge", tags:["ClientReach","Cold Email"], price:49,
    prompt:`Follow-up for Invoice {{invoice_number}} ({{amount}}) sent {{sent_date}}. Include {{pay_url}} and two call slots. Tone: confident, respectful, direct. Keep to {{word_limit}} words.` },
  { category:"Ops", title:"Ops — SOP Writer", tags:["Operations"], price:59,
    prompt:`Turn a process description into an SOP with Roles, Tools, Steps, QA checks, and Risks. Output Markdown. Ask for missing inputs before drafting.` },
];

const OUTCOME = (vars, goal) => {
  const label = goal==="leadgen"?"Leads/Appointments":goal==="invoice"?"Invoice Collections":goal==="chargebacks"?"Win Chargebacks":goal==="pricing"?"Pricing/Margins":"Landing Page Copy";
  const attach = goal==="chargebacks"?"Attach: receipts, IP/device, AVS/CVV, 3-DS, delivery, comms"
              : goal==="invoice"?"Attach: invoice PDF, payment link, prior thread"
              : goal==="leadgen"?"Attach: proof/case + calendar link"
              : goal==="pricing"?"Attach: price CSV, cost basis"
              : "Attach: relevant artifact(s)";
  const to = goal==="leadgen"?`Send to: prospects in ${vars.city}`:goal==="invoice"?"Send to: accounting/contact":goal==="chargebacks"?"Send to: processor/issuer":"Send to: stakeholder";
  const expected = goal==="leadgen"?"Expected: reply or booking":goal==="invoice"?"Expected: payment or call confirm":goal==="chargebacks"?"Expected: reversal":"Expected: approved copy/actions";
  const filled = Object.keys(vars).filter(k=>!["brand_voice"].includes(k)).map(k=>`{{${k}}}`).join(" ");
  return `

---
OUTCOME CARD
Use when: ${label}
Fill: ${filled}
${attach}
${to}
${expected}`;
};

const apply = (tpl, vars) => tpl.replace(/\{\{(.*?)\}\}/g, (_, k) => vars[k.trim()] ?? `{{${k.trim()}}}`);

async function main() {
  // Load previous to avoid exploding diffs (optional)
  const prev = existsSync("library.json") ? JSON.parse(await readFile("library.json","utf8")) : [];

  // 1) Seed “flagship” items
  const seeded = STARTER.map(x => ({
    id: uid(x.title + x.category),
    category: x.category,
    title: x.title,
    tags: x.tags,
    rating: 5,
    price: x.price,
    buyUrl: STRIPE,
    prompt: x.prompt
  }));

  // 2) Generate packs per overlay + template
  const generated = [];
  for (const ov of OVERLAYS) {
    for (const tpl of TEMPLATES) {
      for (const ch of (tpl.channels && tpl.channels.length ? tpl.channels : ["email"])) {
        const vars = {
          ...ov,
          channel: ch,
          cta_link: "https://cal.com/you",
          word_limit: tpl.goal === "leadgen" ? 110 : 120,
          sent_date: "{{sent_date}}",
          amount: "{{amount}}",
          invoice_number: "{{invoice_number}}",
          cost_basis: "{{cost_basis}}",
          network: "{{network}}",
          reason_code: "{{reason_code}}",
          order_id: "{{order_id}}",
          order_date: "{{order_date}}"
        };
        let body = apply(tpl.template, vars) + OUTCOME(vars, tpl.goal);
        const title = `${tpl.title} — ${ov.key} — ${ch.toUpperCase()}`;
        generated.push({
          id: uid(title + body),
          category: goalToCategory(tpl.goal),
          title,
          tags: ["Generated", ov.key, tpl.goal],
          rating: 5,
          price: ["chargebacks"].includes(tpl.goal) ? 99 : ["invoice","leadgen"].includes(tpl.goal) ? 49 : 59,
          buyUrl: STRIPE,
          prompt: body
        });
      }
    }
  }

  // 3) Merge (avoid duplicates by title::prompt)
  const seen = new Set();
  const merged = [...seeded, ...generated, ...prev].filter(it => {
    const key = (it.title||"")+"::"+(it.prompt||"");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 4) Sort by rating then title for stability
  merged.sort((a,b)=>(b.rating||0)-(a.rating||0) || String(a.title).localeCompare(String(b.title)));

  await writeFile("library.json", JSON.stringify(merged, null, 2));
  console.log(`✅ library.json updated (${merged.length} items) — ${nowIso()}`);
}

main().catch(err => { console.error("❌ build failed", err); process.exit(1); });
