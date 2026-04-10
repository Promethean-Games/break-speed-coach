"use strict";

// ─── Billing Module ───────────────────────────────────────────────────────────
// Stripe live integration.
// Backend routes: POST /api/stripe/checkout, GET /api/stripe/verify
// Webhook:        POST /api/stripe/webhook  (handled server-side)
// ─────────────────────────────────────────────────────────────────────────────

const BILLING = (() => {
  const PRO_KEY = "bsc_pro_status";

  function isProUser() {
    try { return localStorage.getItem(PRO_KEY) === "true"; } catch { return false; }
  }

  function _setPro(val) {
    try { localStorage.setItem(PRO_KEY, val ? "true" : "false"); } catch {}
  }

  function getSubscriptionStatus() {
    return isProUser() ? "active" : "free";
  }

  // Creates a Stripe Checkout Session via the backend and redirects the user.
  async function initiateCheckout() {
    const res = await fetch("/api/stripe/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Checkout failed" }));
      throw new Error(err.error || "Checkout failed");
    }

    const { url } = await res.json();
    if (!url) throw new Error("No checkout URL returned");

    // Full-page redirect to Stripe Checkout.
    // On success, Stripe sends back to /?pro=success&session_id=cs_xxx
    window.location.href = url;

    // Return a promise that never resolves — navigation is taking over.
    return new Promise(() => {});
  }

  // Verifies a completed checkout session after Stripe redirects back.
  // Called automatically on page load when ?pro=success is present.
  async function verifySession(sessionId) {
    const res = await fetch(`/api/stripe/verify?session_id=${encodeURIComponent(sessionId)}`);
    if (!res.ok) return { verified: false };
    const data = await res.json().catch(() => ({ verified: false }));
    if (data.verified) _setPro(true);
    return data;
  }

  // Restore purchase — re-checks if this session has already been verified.
  // Without a user-auth system, this just checks localStorage.
  // When you add user accounts, replace this with a real server lookup.
  async function restorePurchase() {
    const active = isProUser();
    return { restored: active };
  }

  // Dev/testing helper — not exposed in UI
  function _revoke() {
    try { localStorage.removeItem(PRO_KEY); } catch {}
  }

  return { isProUser, getSubscriptionStatus, initiateCheckout, verifySession, restorePurchase, _setPro, _revoke };
})();
