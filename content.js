// Epic Free Games Claimer - content script v0.1.1 (runs in all frames on store.epicgames.com)
//
// Keep every fragile selector/regex in SELECTORS so layout changes are a one-line fix.

const SELECTORS = {
  cta: '[data-testid="purchase-cta-button"]',
  ownedText: /in library|owned/i,
  getText: /^get$/i,
  placeOrderText: /place order/i,
  agreeText: /^i agree$/i,
  continueText: /^continue$/i,
  thankYouText: /thank you for your order/i,
  captchaFrame: 'iframe[src*="hcaptcha"][title*="challenge" i]',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const note = (text) => browser.runtime.sendMessage({ type: "claim-note", note: text });
const report = (status, detail = "") =>
  browser.runtime.sendMessage({ type: "claim-result", status, detail });

async function waitFor(fn, timeoutMs, stepMs = 500) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value;
    await sleep(stepMs);
  }
  return null;
}

function buttonByText(re, root = document) {
  return [...root.querySelectorAll("button")].find(
    (b) => re.test(b.textContent.trim()) && !b.disabled
  );
}

function visible(el) {
  const r = el?.getBoundingClientRect();
  return !!r && r.width > 100 && r.height > 100;
}

// Mature-content age gate: a dialog with a "Continue" button.
function dismissAgeGate() {
  const dialog = document.querySelector('[role="dialog"]');
  const btn = dialog && buttonByText(SELECTORS.continueText, dialog);
  if (btn) btn.click();
}

// ---- Top frame: the store page ------------------------------------------------

async function runTop() {
  await note(`page loaded: "${document.title.slice(0, 40)}"`);
  const cta = await waitFor(() => {
    dismissAgeGate();
    return document.querySelector(SELECTORS.cta);
  }, 20000);
  if (!cta) return report("error", `no purchase button found; page title "${document.title.slice(0, 40)}"`);

  const label = () => document.querySelector(SELECTORS.cta)?.textContent.trim() ?? "";
  await note(`button label "${label()}"`);
  if (SELECTORS.ownedText.test(label())) return report("already-owned");
  if (!SELECTORS.getText.test(label())) return report("error", `unexpected button label "${label()}"`);

  cta.click();
  await note("clicked Get");

  // The checkout iframe usually reports success first; this is the fallback.
  const owned = await waitFor(() => SELECTORS.ownedText.test(label()), 90000, 1000);
  if (owned) return report("claimed");
  report("timeout", `button still "${label()}" after checkout`);
}

// ---- Checkout iframe ----------------------------------------------------------

async function runCheckoutFrame() {
  await note("checkout frame loaded");
  const end = Date.now() + 90000;
  let orderClicks = 0;

  while (Date.now() < end) {
    if (SELECTORS.thankYouText.test(document.body?.innerText ?? "")) {
      return report("claimed");
    }
    if (visible(document.querySelector(SELECTORS.captchaFrame))) {
      return report("captcha");
    }

    const agree = buttonByText(SELECTORS.agreeText);
    if (agree) {
      await note("clicked I Agree");
      agree.click();
      await sleep(1500);
      continue;
    }

    const place = orderClicks < 3 && buttonByText(SELECTORS.placeOrderText);
    if (place) {
      orderClicks++;
      await note("clicked Place Order");
      place.click();
      await sleep(3000);
      continue;
    }

    await sleep(700);
  }
  await note("checkout frame gave up waiting");
}

// ---- Entry point ----------------------------------------------------------------

(async () => {
  const { active } = await browser.runtime.sendMessage({ type: "claim-context" });
  if (!active) return; // normal browsing - do nothing

  if (window === window.top) {
    await runTop();
  } else if (location.pathname.startsWith("/purchase")) {
    await runCheckoutFrame();
  }
})();
