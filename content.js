// Epic Free Games Claimer - content script v0.2.0
//
// Runs on store.epicgames.com but only acts inside the tab the background page
// opened for a claim. The checkout iframe is same-origin, so this one top-frame
// script drives both the store page and the checkout document.
//
// Keep every fragile selector/string in SELECTORS so layout changes are a one-line fix.

const SELECTORS = {
  cta: '[data-testid="purchase-cta-button"]',
  nav: "egs-navigation", // carries an isloggedin="true|false" attribute
  checkoutFrame: "#webPurchaseContainer iframe",
  ageGate: "#btn_age_continue",
  // Dialogs that only need their Continue button clicked (age gate, "Device not supported").
  gateDialog: /not\s+(supported|compatible)|mature|age restrict/i,
  continueText: "continue",
  getText: /^get$/i, // free games say "Get"; paid ones say "Buy Now" - never click those
  ownedText: /in library|owned/i,
  // Checkout buttons in their usual order. Each is clicked at most once per claim.
  checkoutButtons: ["i accept", "add to library", "place order"],
  successText: /thanks for your order|it['\u2019]s all yours|added to your library/i,
  captchaFrame: 'iframe[src*="hcaptcha"][title*="challenge" i]',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const pause = (a, b) => sleep(rand(a, b));
const note = (text) => browser.runtime.sendMessage({ type: "claim-note", note: text });
const report = (status, detail = "") =>
  browser.runtime.sendMessage({ type: "claim-result", status, detail });

const visible = (el) => !!el && el.getClientRects().length > 0;
const bigVisible = (el) => {
  const r = el?.getBoundingClientRect();
  return !!r && r.width > 100 && r.height > 100;
};

// An hCaptcha challenge frame can sit in the DOM at full size while hidden or auto-passing, so a
// size check alone gives false alarms. Require it (and every ancestor) to be actually showing.
function challengeShowing(doc) {
  const el = doc.querySelector(SELECTORS.captchaFrame);
  if (!bigVisible(el)) return false;
  const view = doc.defaultView;
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const s = view.getComputedStyle(n);
    if (s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity) < 0.1) return false;
  }
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.right > 0 && r.top < view.innerHeight && r.left < view.innerWidth;
}

async function waitFor(fn, timeoutMs, stepMs = 500) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value;
    await sleep(stepMs);
  }
  return null;
}

// A full mouse sequence looks more like a person than a bare .click().
function humanClick(el) {
  for (const type of ["mousedown", "mouseup", "click"]) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
  }
}

function buttonByText(root, text) {
  return (
    [...root.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim().toLowerCase() === text && !b.disabled && visible(b)
    ) ?? null
  );
}

// The store page plus the checkout iframe document once it exists (checkout first).
function checkoutDocs() {
  const docs = [document];
  try {
    const d = document.querySelector(SELECTORS.checkoutFrame)?.contentDocument;
    if (d?.body) docs.unshift(d);
  } catch {
    // cross-origin or not ready yet; poll again next loop
  }
  return docs;
}

function gateButton(docs) {
  for (const d of docs) {
    const age = d.querySelector(SELECTORS.ageGate);
    if (age && !age.disabled && visible(age)) return age;
    for (const dlg of d.querySelectorAll('[role="dialog"]')) {
      if (SELECTORS.gateDialog.test(dlg.textContent ?? "")) {
        const b = buttonByText(dlg, SELECTORS.continueText);
        if (b) return b;
      }
    }
  }
  return null;
}

function loginState() {
  const v = document.querySelector(SELECTORS.nav)?.getAttribute("isloggedin");
  return v === "true" ? "in" : v === "false" ? "out" : "unknown";
}

const ctaLabel = () => document.querySelector(SELECTORS.cta)?.textContent.trim() ?? "";

// What was on screen when we gave up - shown in the failure notification and log.
function describeScreen() {
  const docs = checkoutDocs();
  const buttons = docs
    .flatMap((d) =>
      [...d.querySelectorAll("button")]
        .filter((b) => visible(b))
        .map((b) => (b.textContent ?? "").trim().slice(0, 24))
        .filter(Boolean)
    )
    .slice(0, 12);
  const dialogs = docs.flatMap((d) =>
    [...d.querySelectorAll('[role="dialog"]')].map((x) => (x.textContent ?? "").trim().slice(0, 60))
  );
  return `buttons: ${buttons.join(" | ") || "none"}; dialogs: ${dialogs.join(" | ") || "none"}`;
}

// ---- Checkout loop ---------------------------------------------------------------

const CAPTCHA_WAIT_MS = 150000; // how long to wait for the person to solve a captcha
const CAPTCHA_GRACE_MS = 12000; // a challenge that clears on its own within this is not worth interrupting for

async function completeCheckout(timeoutMs) {
  let end = Date.now() + timeoutMs;
  let captchaSeen = false;
  let captchaSince = 0;
  const clicked = new Set();

  while (Date.now() < end) {
    const docs = checkoutDocs();

    if (docs.some((d) => SELECTORS.successText.test(d.body?.innerText ?? ""))) return "claimed";
    if (SELECTORS.ownedText.test(ctaLabel())) return "claimed";
    if (docs.some(challengeShowing)) {
      // Captchas are for the person to solve. Give an auto-passing one a few seconds to clear; if it
      // stays up, bring the tab forward, wait, and resume once it goes away.
      captchaSince ||= Date.now();
      if (!captchaSeen && Date.now() - captchaSince >= CAPTCHA_GRACE_MS) {
        captchaSeen = true;
        await browser.runtime.sendMessage({ type: "captcha-wait" });
        end = Math.max(end, Date.now() + CAPTCHA_WAIT_MS);
      }
      await sleep(500);
      continue;
    }
    if (captchaSince) {
      await note(`captcha frame gone after ${Math.round((Date.now() - captchaSince) / 1000)}s`);
      captchaSince = 0;
    }

    const gate = gateButton(docs);
    if (gate) {
      await note("dismissing gate dialog");
      await pause(200, 400);
      humanClick(gate);
      await pause(300, 600);
      continue;
    }

    let next = null;
    for (const label of SELECTORS.checkoutButtons) {
      if (clicked.has(label)) continue;
      for (const d of docs) {
        const el = buttonByText(d, label);
        if (el) {
          next = { label, el };
          break;
        }
      }
      if (next) break;
    }
    if (next) {
      clicked.add(next.label);
      await note(`clicking "${next.label}"`);
      await pause(200, 400);
      humanClick(next.el);
      await pause(800, 1200);
      continue;
    }

    await sleep(250);
  }
  return captchaSeen ? "captcha" : null;
}

// ---- Main flow -------------------------------------------------------------------

async function runClaim() {
  await note(`page loaded: "${document.title.slice(0, 40)}"`);

  // A signed-out session is the most common failure, so check it first.
  await waitFor(() => loginState() !== "unknown", 8000);
  const login = loginState();
  await note(`login state: ${login}`);
  if (login === "out") return report("login", "store page reports signed out");

  const cta = await waitFor(() => {
    const gate = gateButton([document]);
    if (gate) humanClick(gate);
    return document.querySelector(SELECTORS.cta);
  }, 20000);
  if (!cta) return report("error", `no purchase button found. ${describeScreen()}`);

  const label = ctaLabel();
  await note(`button label "${label}"`);
  if (SELECTORS.ownedText.test(label)) return report("already-owned");
  if (!SELECTORS.getText.test(label)) {
    return report("error", `unexpected button label "${label}" (not clicking)`);
  }

  await pause(400, 900);
  humanClick(cta);
  await note("clicked Get");

  const result = await completeCheckout(75000);
  if (result) return report(result);
  report("timeout", describeScreen());
}

(async () => {
  if (window !== window.top) return; // the checkout iframe is driven from the top frame
  const { active } = await browser.runtime.sendMessage({ type: "claim-context" });
  if (!active) return; // normal browsing - do nothing
  try {
    await runClaim();
  } catch (err) {
    await report("error", `script error: ${err.message}`);
  }
})();
