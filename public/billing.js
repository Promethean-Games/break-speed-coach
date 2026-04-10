"use strict";

// ─── Billing Module ───────────────────────────────────────────────────────────
// Stripe-ready architecture.
// To wire real Stripe: replace initiateCheckout() body with:
//   const stripe = Stripe('pk_live_YOUR_KEY');
//   return stripe.redirectToCheckout({ lineItems: [{ price: 'price_xxx', quantity: 1 }], mode: 'subscription', successUrl: ..., cancelUrl: ... });
//
// getSubscriptionStatus() should call your backend to verify server-side.
// ─────────────────────────────────────────────────────────────────────────────

const BILLING = (() => {
  const PRO_KEY = "bsc_pro_status";

  function isProUser() {
    try { return localStorage.getItem(PRO_KEY) === "true"; } catch { return false; }
  }

  function getSubscriptionStatus() {
    return isProUser() ? "active" : "free";
  }

  // Mock checkout — replace internals with real Stripe when ready.
  async function initiateCheckout() {
    // ── Real Stripe (uncomment when keys are added): ──────────────────────
    // const stripe = Stripe("pk_live_...");
    // return stripe.redirectToCheckout({
    //   lineItems: [{ price: "price_pro_monthly", quantity: 1 }],
    //   mode: "subscription",
    //   successUrl: window.location.origin + "/?pro=success",
    //   cancelUrl:  window.location.origin + "/?pro=cancel",
    // });
    // ─────────────────────────────────────────────────────────────────────

    // Mock: simulate network + payment processing delay
    return new Promise((resolve) => {
      setTimeout(() => {
        try { localStorage.setItem(PRO_KEY, "true"); } catch {}
        resolve({ success: true });
      }, 1600);
    });
  }

  async function restorePurchase() {
    // ── Real Stripe: call your backend to verify subscription status ──────
    // const res = await fetch("/api/subscription/status");
    // const { active } = await res.json();
    // if (active) localStorage.setItem(PRO_KEY, "true");
    // ─────────────────────────────────────────────────────────────────────

    const active = isProUser();
    return { restored: active };
  }

  // Dev/testing helper — not exposed in UI
  function _revoke() {
    try { localStorage.removeItem(PRO_KEY); } catch {}
  }

  return { isProUser, getSubscriptionStatus, initiateCheckout, restorePurchase, _revoke };
})();
