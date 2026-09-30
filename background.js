// Epic Free Games Claimer - background event page (MV3, Firefox/Floorp) v0.1.1
//
// All state lives in storage.local because MV3 event pages get suspended.
// Never rely on in-memory variables surviving between events.
// storage.local.log keeps the last 40 events for debugging.

const API =
  "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions" +
  "?locale=en-US&country=US&allowCountries=US";
const STORE = "https://store.epicgames.com/en-US";
const CHECK_EVERY_MIN = 180;
const CLAIM_TIMEOUT_MIN = 2;
const STALE_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;

const get = async (key, fallback) => (await browser.storage.local.get(key))[key] ?? fallback;
const set = (obj) => browser.storage.local.set(obj);

async function log(msg) {
  const entries = await get("log", []);
  entries.push({ t: new Date().toISOString(), msg });
  await set({ log: entries.slice(-40) });
}

function notify(title, message) {
  browser.notifications.create({
    type: "basic",
    iconUrl: browser.runtime.getURL("icon.svg"),
    title,
    message,
  });
}

// ---- Scheduling -----------------------------------------------------------
// Firefox does not persist alarms across browser restarts, so re-create on startup.

function scheduleChecks() {
  browser.alarms.create("check", { delayInMinutes: 1, periodInMinutes: CHECK_EVERY_MIN });
}

browser.runtime.onInstalled.addListener(scheduleChecks);
browser.runtime.onStartup.addListener(async () => {
  scheduleChecks();
  await set({ current: null, queue: [] }); // a restart abandons any in-flight claim
  checkFreeGames(false);
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "check") checkFreeGames(false);
  if (alarm.name === "claim-timeout") finish("timeout", "no result within 2 minutes");
});

browser.action.onClicked.addListener(async () => {
  await set({ attempts: {} }); // manual check resets the retry cap
  await log("manual check");
  notify("Epic Free Games", "Checking for free games...");
  checkFreeGames(true);
});

// ---- Discovery --------------------------------------------------------------

// Epic's unofficial promotions endpoint. discountPercentage === 0 means 100% off.
function currentFreeOffers(json) {
  const now = Date.now();
  const elements = json?.data?.Catalog?.searchStore?.elements ?? [];
  return elements
    .filter((el) => {
      const windows =
        el.promotions?.promotionalOffers?.flatMap((p) => p.promotionalOffers) ?? [];
      return windows.some(
        (o) =>
          o.discountSetting?.discountPercentage === 0 &&
          Date.parse(o.startDate) <= now &&
          now < Date.parse(o.endDate)
      );
    })
    .map((el) => {
      const slug =
        el.offerMappings?.[0]?.pageSlug ||
        el.catalogNs?.mappings?.[0]?.pageSlug ||
        el.productSlug ||
        el.urlSlug;
      return { id: el.id, title: el.title, url: slug ? `${STORE}/p/${slug}` : null };
    })
    .filter((o) => o.url);
}

// A claim that outlived its timeout (e.g. the browser restarted mid-claim) would
// otherwise block the queue forever.
async function recoverStale() {
  const cur = await get("current", null);
  if (cur && Date.now() - (cur.startedAt ?? 0) > STALE_MS) {
    await finish("timeout", "stale claim recovered");
  }
}

async function checkFreeGames(manual = false) {
  try {
    const res = await fetch(API);
    if (!res.ok) throw new Error(`Epic API returned ${res.status}`);
    const offers = currentFreeOffers(await res.json());
    await recoverStale();

    const claimed = await get("claimed", {});
    const attempts = await get("attempts", {});
    const queue = await get("queue", []);
    const current = await get("current", null);
    const busy = new Set([...queue.map((o) => o.id), current?.id]);

    const fresh = offers.filter(
      (o) => !claimed[o.id] && !busy.has(o.id) && (attempts[o.id] ?? 0) < MAX_ATTEMPTS
    );
    await log(`check: ${offers.length} free now, ${fresh.length} to claim`);

    if (fresh.length) {
      await set({ queue: [...queue, ...fresh] });
      notify(
        `Claiming ${fresh.length} free game${fresh.length > 1 ? "s" : ""}`,
        fresh.map((o) => o.title).join(", ")
      );
    } else if (manual) {
      notify(
        "Epic Free Games",
        offers.length
          ? `Nothing new to claim: ${offers.map((o) => o.title).join(", ")} already handled or in progress.`
          : "No free games right now."
      );
    }
    await processNext();
  } catch (err) {
    await log(`check failed: ${err.message}`);
    if (manual) notify("Epic Free Games", `Check failed: ${err.message}`);
  }
}

// ---- Claim queue ------------------------------------------------------------

async function processNext() {
  if (await get("current", null)) return; // one claim at a time
  const queue = await get("queue", []);
  const next = queue.shift();
  if (!next) return;

  // Mark busy before the async tab creation to avoid double-starts.
  const startedAt = Date.now();
  await set({ queue, current: { ...next, tabId: null, startedAt } });
  const tab = await browser.tabs.create({ url: next.url, active: false });
  await set({ current: { ...next, tabId: tab.id, startedAt } });
  await log(`${next.title}: opened claim tab`);
  browser.alarms.create("claim-timeout", { delayInMinutes: CLAIM_TIMEOUT_MIN });
}

async function finish(status, detail = "") {
  const cur = await get("current", null);
  if (!cur) return;
  await browser.alarms.clear("claim-timeout");
  await set({ current: null });
  if (cur.tabId != null) browser.tabs.remove(cur.tabId).catch(() => {});
  await log(`${cur.title}: ${status}${detail ? " - " + detail : ""}`);

  if (status === "claimed" || status === "already-owned") {
    const claimed = await get("claimed", {});
    claimed[cur.id] = { title: cur.title, status, at: Date.now() };
    await set({ claimed });
    notify(
      status === "claimed" ? "Claimed free game" : "Already in your library",
      cur.title
    );
  } else {
    const attempts = await get("attempts", {});
    attempts[cur.id] = (attempts[cur.id] ?? 0) + 1;
    await set({ attempts });
    const why =
      {
        captcha: "A captcha needs you - open the store page and claim it manually.",
        login: "Not signed in to Epic in this browser. Log in at store.epicgames.com, then click the toolbar button.",
        timeout: "Couldn't confirm the claim. Are you logged in to Epic?",
        error: "Unexpected page state. Epic may have changed its layout.",
      }[status] ?? "Claim failed.";
    notify(`Action needed: ${cur.title}`, detail ? `${why} (${detail})` : why);
  }
  await processNext();
}

// Being bounced to Epic's login page means there is no signed-in session.
browser.tabs.onUpdated.addListener(
  async (tabId, changeInfo) => {
    if (!changeInfo.url || !/epicgames\.com\/id\/login/i.test(changeInfo.url)) return;
    const cur = await get("current", null);
    if (cur && cur.tabId === tabId) finish("login", "redirected to Epic login");
  },
  { urls: ["*://*.epicgames.com/*"] }
);

// ---- Messages from the content script ---------------------------------------
// The content script runs in every frame of store.epicgames.com (including the
// checkout iframe), so it first asks whether its tab is the active claim tab.

browser.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab?.id;
  if (msg.type === "claim-context") {
    return get("current", null).then((cur) => ({ active: !!cur && cur.tabId === tabId }));
  }
  if (msg.type === "claim-note") {
    return get("current", null).then((cur) => {
      if (cur && cur.tabId === tabId) return log(`${cur.title}: ${msg.note}`);
    });
  }
  if (msg.type === "claim-result") {
    return get("current", null).then((cur) => {
      if (cur && cur.tabId === tabId) return finish(msg.status, msg.detail);
    });
  }
});
