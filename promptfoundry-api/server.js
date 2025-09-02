// server.js — PromptFoundry API (Stripe subscription -> license -> unlock)
import express from "express";
import cors from "cors";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import bodyParser from "body-parser";

const {
  PORT = 3000,
  NODE_ENV = "production",
  APP_URL,                        // e.g. https://promptfoundry.onrender.com  (your static site)
  API_BASE_URL,                   // e.g. https://pf-api.onrender.com       (optional)
  STRIPE_SECRET_KEY,              // Stripe secret key
  STRIPE_PRICE_ID,                // price_xxx for $99/month
  STRIPE_WEBHOOK_SECRET,          // webhook signing secret
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  RESEND_API_KEY,                 // optional for emails
  SUPPORT_EMAIL = "support@yourdomain.com",
  BRAND_NAME = "PromptFoundry",
} = process.env;

if (!APP_URL) throw new Error("APP_URL required");
if (!STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY required");
if (!STRIPE_PRICE_ID) throw new Error("STRIPE_PRICE_ID required");
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase envs required");

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const app = express();
app.use((req, res, next) => {
  if (req.originalUrl === "/api/stripe/webhook") {
    bodyParser.raw({ type: "application/json" })(req, res, next);
  } else {
    bodyParser.json()(req, res, next);
  }
});
app.use(cors({ origin: true }));

app.get("/healthz", (_req, res) => res.json({ ok: true }));

const licenseToken = () =>
  `${uuidv4().replace(/-/g, "").slice(0, 12).toUpperCase()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

async function upsertCustomer({ email, stripe_customer_id }) {
  const { data, error } = await supabase
    .from("customers")
    .upsert({ email, stripe_customer_id }, { onConflict: "email" })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function createOrUpdateLicense({ customer_id, stripe_subscription_id, status, current_period_end, session_id }) {
  const { data: existing, error: findErr } = await supabase
    .from("licenses")
    .select("*")
    .eq("stripe_subscription_id", stripe_subscription_id)
    .maybeSingle();
  if (findErr) throw findErr;

  if (existing) {
    const { data, error } = await supabase
      .from("licenses")
      .update({ status, current_period_end, session_id })
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) throw error;
    return data;
  } else {
    const token = licenseToken();
    const { data, error } = await supabase
      .from("licenses")
      .insert({
        customer_id,
        token,
        status,
        current_period_end,
        stripe_subscription_id,
        tier: "all-access",
        session_id,
      })
      .select("*")
      .single();
    if (error) throw error;
    return data;
  }
}

async function emailSend({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    console.log("[email stub]", { to, subject });
    return { ok: true, stub: true };
  }
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `${BRAND_NAME} <no-reply@${new URL(APP_URL).hostname}>`,
      to,
      subject,
      html,
    }),
  });
  if (!resp.ok) throw new Error(`Email failed: ${await resp.text()}`);
  return resp.json();
}

const successEmailHtml = ({ license }) => `
<div style="font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.6">
  <h2>${BRAND_NAME}: You're In 🎉</h2>
  <p>Thanks for subscribing to <strong>All-Access ($99/month)</strong>.</p>
  <p><strong>Your license key:</strong></p>
  <pre style="padding:12px;background:#f6f7f9;border-radius:8px;font-size:16px">${license}</pre>
  <ol>
    <li>Open the site: <a href="${APP_URL}">${APP_URL}</a></li>
    <li>Click <b>Unlock Pro</b> → paste your key → full access.</li>
  </ol>
  <p>Need help? Reply here or email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
  <hr/>
  <p style="font-size:12px;color:#666">Manage billing via your Stripe receipt.</p>
</div>`;

// --- Routes ---

// Simple link you can hit from the static site
app.get("/api/checkout", async (_req, res) => {
  try {
    const success_url = `${APP_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`;
    const cancel_url = `${APP_URL}#pricing`;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url,
      cancel_url,
      allow_promotion_codes: true,
      billing_address_collection: "auto",
      subscription_data: { metadata: { plan: "all-access" } },
    });
    res.redirect(303, session.url);
  } catch (e) {
    console.error(e);
    res.status(500).send("Failed to create checkout session");
  }
});

// Fetch license by checkout session (used by success page)
app.get("/api/license/from-session", async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ ok: false, error: "session_id required" });
  const { data, error } = await supabase
    .from("licenses")
    .select("token,status")
    .eq("session_id", String(session_id))
    .maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!data) return res.json({ ok: false });
  res.json({ ok: true, token: data.token, status: data.status });
});

// Verify license (used by unlock.js)
app.get("/api/license/verify", async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ ok: false, error: "token required" });
  const { data, error } = await supabase
    .from("licenses")
    .select("status,tier,current_period_end")
    .eq("token", String(token))
    .maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!data) return res.json({ ok: false });
  const active = ["active", "trialing", "past_due"].includes(data.status);
  res.json({ ok: active, tier: data.tier, current_period_end: data.current_period_end });
});

// Stripe webhook
app.post("/api/stripe/webhook", async (req, res) => {
  let event;
  try {
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook verify failed", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        if (session.mode !== "subscription") break;
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
        const email = session.customer_details?.email || subscription.customer_email;

        const customer = await upsertCustomer({ email, stripe_customer_id: customerId });
        const license = await createOrUpdateLicense({
          customer_id: customer.id,
          stripe_subscription_id: subscription.id,
          status: subscription.status,
          current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
          session_id: session.id,
        });

        await emailSend({
          to: email,
          subject: `${BRAND_NAME} — Your All-Access license key`,
          html: successEmailHtml({ license: license.token }),
        });
        break;
      }

      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed": {
        const sub = event.data.object;
        const { error } = await supabase
          .from("licenses")
          .update({
            status: sub.status,
            current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
          })
          .eq("stripe_subscription_id", sub.id);
        if (error) throw error;
        break;
      }

      case "invoice.payment_failed": {
        const inv = event.data.object;
        if (inv.subscription) {
          await supabase.from("licenses").update({ status: "past_due" }).eq("stripe_subscription_id", inv.subscription);
        }
        break;
      }
      default:
        break;
    }
    res.json({ received: true });
  } catch (e) {
    console.error("Webhook handler error", e);
    res.status(500).send("Webhook failed");
  }
});

app.listen(PORT, () => console.log(`API listening on ${PORT} (${NODE_ENV})`));
