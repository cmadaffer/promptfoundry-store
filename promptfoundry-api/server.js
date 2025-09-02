// server.js
// PromptFoundry API sidecar — Stripe subscription -> license -> unlock
// Copy-paste, set env vars, deploy as a Render Web Service (Node 18+)

import express from "express";
import cors from "cors";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import bodyParser from "body-parser";

// ---------- ENV ----------
const {
  PORT = 3000,
  NODE_ENV = "production",
  APP_URL,                        // https://your-static-site.onrender.com
  API_BASE_URL,                   // https://your-api.onrender.com  (optional; used in emails)
  STRIPE_SECRET_KEY,              // from Stripe
  STRIPE_PRICE_ID,                // price_xxx ($99/month)
  STRIPE_WEBHOOK_SECRET,          // webhook signing secret
  SUPABASE_URL,                   // https://xxxx.supabase.co
  SUPABASE_SERVICE_ROLE_KEY,      // service role key
  RESEND_API_KEY,                 // optional (transactional email)
  SUPPORT_EMAIL = "support@yourdomain.com",
  BRAND_NAME = "PromptFoundry",
} = process.env;

if (!APP_URL) throw new Error("APP_URL env required");
if (!STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY env required");
if (!STRIPE_PRICE_ID) throw new Error("STRIPE_PRICE_ID env required");
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Supabase SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env required");
}

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const app = express();

// Webhook needs raw body; other routes JSON
app.use((req, res, next) => {
  if (req.originalUrl === "/api/stripe/webhook") {
    bodyParser.raw({ type: "application/json" })(req, res, next);
  } else {
    bodyParser.json()(req, res, next);
  }
});

app.use(cors({
  origin: true, // allow static site + local dev
  credentials: false,
}));

app.get("/healthz", (req, res) => res.json({ ok: true }));

// ---------- Helpers ----------
function licenseToken() {
  // human-pasteable token
  const a = uuidv4().replace(/-/g, "").slice(0, 12).toUpperCase();
  const b = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `${a}-${b}`;
}

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
  // if license for this subscription exists, update; else create new
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
    console.log("[email:stub]", { to, subject });
    return { ok: true, stub: true };
  }
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${BRAND_NAME} <no-reply@${(new URL(APP_URL)).hostname}>`,
      to,
      subject,
      html,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    console.error("Resend error:", t);
    throw new Error("Email send failed");
  }
  return await resp.json();
}

function successEmailHtml({ license, appUrl = APP_URL, apiBase = API_BASE_URL || "" }) {
  const verifyUrl = `${appUrl}/success.html?session=done`;
  return `
  <div style="font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.6">
    <h2>${BRAND_NAME}: You're In 🎉</h2>
    <p>Thanks for subscribing to <strong>All-Access ($99/month)</strong>.</p>
    <p><strong>Your license key:</strong></p>
    <pre style="padding:12px;background:#f6f7f9;border-radius:8px;font-size:16px">${license}</pre>
    <ol>
      <li>Open the site: <a href="${appUrl}">${appUrl}</a></li>
      <li>Click <b>Unlock Pro</b> → paste your license → Access granted.</li>
    </ol>
    <p>Need help? Reply here or email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
    <hr/>
    <p style="font-size:12px;color:#666">Manage billing anytime via your Stripe receipt.</p>
  </div>`;
}

// ---------- Routes ----------

// Create Checkout Session (GET so you can use a simple link from static site)
app.get("/api/checkout", async (req, res) => {
  try {
    const successUrl = `${APP_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${APP_URL}#pricing`;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: successUrl,
      cancel_url: cancelUrl,
      // Expand customer email if provided by Stripe
      billing_address_collection: "auto",
      subscription_data: {
        metadata: { plan: "all-access" },
      },
    });

    return res.redirect(303, session.url);
  } catch (e) {
    console.error(e);
    return res.status(500).send("Failed to create checkout session");
  }
});

// License lookup by Checkout session (used by success.html to show the key)
app.get("/api/license/from-session", async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ ok: false, error: "session_id required" });

  // Find license by saved session_id
  const { data, error } = await supabase
    .from("licenses")
    .select("token,status")
    .eq("session_id", String(session_id))
    .maybeSingle();

  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!data) return res.json({ ok: false });

  return res.json({ ok: true, token: data.token, status: data.status });
});

// Verify license token (used by Unlock modal)
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

  const active = data.status === "active" || data.status === "trialing" || data.status === "past_due";
  return res.json({ ok: active, tier: data.tier, current_period_end: data.current_period_end });
});

// Stripe webhook
app.post("/api/stripe/webhook", async (req, res) => {
  let event;
  try {
    const sig = req.headers["stripe-signature"];
    if (!sig || !STRIPE_WEBHOOK_SECRET) throw new Error("Missing webhook secret");
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature verify failed.", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        if (session.mode !== "subscription") break;

        // Get subscription detail to read period end & status
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        const customerId = (typeof session.customer === "string") ? session.customer : session.customer?.id;
        const email = session.customer_details?.email || subscription.customer_email;

        const customer = await upsertCustomer({
          email,
          stripe_customer_id: customerId,
        });

        const license = await createOrUpdateLicense({
          customer_id: customer.id,
          stripe_subscription_id: subscription.id,
          status: subscription.status,
          current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
          session_id: session.id,
        });

        // Send email with license key
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
        const status = sub.status;
        const current_period_end = new Date(sub.current_period_end * 1000).toISOString();
        const { data: lic, error } = await supabase
          .from("licenses")
          .update({ status, current_period_end })
          .eq("stripe_subscription_id", sub.id)
          .select("*")
          .maybeSingle();
        if (error) throw error;
        if (!lic) console.warn("Subscription event for unknown license:", sub.id);
        break;
      }

      case "invoice.payment_failed": {
        const inv = event.data.object;
        if (inv.subscription) {
          await supabase
            .from("licenses")
            .update({ status: "past_due" })
            .eq("stripe_subscription_id", inv.subscription);
        }
        break;
      }

      default:
        // no-op for other events
        break;
    }

    res.json({ received: true });
  } catch (e) {
    console.error("Webhook handling error:", e);
    res.status(500).send("Webhook handler failed");
  }
});

// Start
app.listen(PORT, () => {
  console.log(`PromptFoundry API listening on port ${PORT} [${NODE_ENV}]`);
});
