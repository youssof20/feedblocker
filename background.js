/*
 * FeedBlocker background event page.
 *
 * Responsibilities:
 *   - load rule files
 *   - register/unregister per-site CSS + runtime content scripts
 *   - own all writes to storage.sync
 *   - keep the toolbar icon in sync with the on/paused/off state
 *
 * It makes no network requests and never touches page content directly.
 */
"use strict";

const FB = globalThis.FeedBlocker;
const ALARM_UNPAUSE = "fb-unpause";
const ICON_SIZES = [16, 32, 48, 96];

let rulesPromise = null;

async function getRules() {
  if (!rulesPromise) {
    rulesPromise = (async () => {
      const order = await fetchJson("rules/index.json");
      const rules = {};
      for (const id of order) rules[id] = await fetchJson("rules/" + id + ".json");
      return rules;
    })().catch((error) => {
      rulesPromise = null;
      throw error;
    });
  }
  return rulesPromise;
}

async function fetchJson(path) {
  const response = await fetch(browser.runtime.getURL(path));
  if (!response.ok) throw new Error("Cannot load " + path);
  return response.json();
}

async function getSettings() {
  const stored = await browser.storage.sync.get(FB.STORAGE_KEY);
  return FB.normalize(stored[FB.STORAGE_KEY]);
}

async function saveSettings(settings) {
  const clean = FB.normalize(settings);
  await browser.storage.sync.set({ [FB.STORAGE_KEY]: clean });
  return clean;
}

function ensureSite(settings, siteId) {
  if (!settings.sites[siteId]) settings.sites[siteId] = { enabled: false, elements: {} };
  return settings.sites[siteId];
}

/* ------------------------------------------------------------------ *
 * Content script registration
 * ------------------------------------------------------------------ */

let syncChain = Promise.resolve();

function queueSync() {
  syncChain = syncChain.then(sync, sync).catch((error) => {
    console.error("FeedBlocker: sync failed", error);
  });
  return syncChain;
}

/*
 * Storage writes are read-modify-write. Serialising them keeps two quick
 * switch flips from overwriting each other with the same starting state.
 */
let writeChain = Promise.resolve();

function serializeWrite(task) {
  const run = writeChain.then(task);
  writeChain = run.catch(() => {});
  return run;
}

async function sync() {
  const rules = await getRules();
  const settings = await getSettings();
  const siteIds = Object.keys(rules);

  const registered = await browser.scripting.getRegisteredContentScripts();
  const existing = new Set(registered.map((script) => script.id));
  const wanted = new Set();

  for (const siteId of siteIds) {
    const rule = rules[siteId];
    const site = FB.site(settings, siteId);
    const cssId = "fb-css-" + siteId;
    const jsId = "fb-js-" + siteId;
    wanted.add(cssId);
    wanted.add(jsId);

    const granted =
      site.enabled === true &&
      (await browser.permissions.contains({ origins: rule.origins }).catch(() => false));

    if (!granted) {
      const stale = [cssId, jsId].filter((id) => existing.has(id));
      if (stale.length) {
        await browser.scripting.unregisterContentScripts({ ids: stale }).catch(() => {});
        for (const id of stale) existing.delete(id);
      }
      continue;
    }

    if (!existing.has(cssId)) {
      try {
        await browser.scripting.registerContentScripts([
          {
            id: cssId,
            matches: rule.matches,
            css: ["rules/" + siteId + ".css"],
            cssOrigin: "user",
            runAt: "document_start",
            persistAcrossSessions: true,
          },
        ]);
        existing.add(cssId);
      } catch (error) {
        console.error("FeedBlocker: cannot register CSS for " + siteId, error);
      }
    }

    if (!existing.has(jsId)) {
      try {
        await browser.scripting.registerContentScripts([
          {
            id: jsId,
            matches: rule.matches,
            js: ["shared/compile.js", "content/site-data.js", "content/runtime.js"],
            runAt: "document_start",
            persistAcrossSessions: true,
          },
        ]);
        existing.add(jsId);
      } catch (error) {
        console.error("FeedBlocker: cannot register runtime for " + siteId, error);
      }
    }
  }

  const stale = [...existing].filter((id) => id.indexOf("fb-") === 0 && !wanted.has(id));
  if (stale.length) {
    await browser.scripting.unregisterContentScripts({ ids: stale }).catch(() => {});
  }

  await updateAction(settings, rules);
}

async function updateAction(settings, rules) {
  const paused = FB.isPaused(settings);
  const anyEnabled = Object.keys(rules || {}).some((id) => FB.site(settings, id).enabled);
  const state = paused ? "paused" : anyEnabled ? "on" : "off";
  const path = {};
  for (const size of ICON_SIZES) path[size] = "icons/" + state + ".svg";
  const title = paused
    ? "FeedBlocker — paused"
    : anyEnabled
      ? "FeedBlocker — on"
      : "FeedBlocker — off";

  await browser.action.setIcon({ path }).catch(() => {});
  await browser.action.setTitle({ title }).catch(() => {});
}

/* ------------------------------------------------------------------ *
 * Applying to an already-open tab
 * ------------------------------------------------------------------ */

async function injectIntoTab(tabId, siteId) {
  try {
    const response = await browser.tabs.sendMessage(
      tabId,
      { type: "fb-ping" },
      { frameId: 0 }
    );
    if (response && response.ok) {
      await browser.tabs.sendMessage(tabId, { type: "fb-refresh" }, { frameId: 0 });
      return true;
    }
  } catch (error) {
    /* no runtime in this tab yet */
  }

  try {
    await browser.scripting.insertCSS({
      target: { tabId, frameIds: [0] },
      files: ["rules/" + siteId + ".css"],
      origin: "user",
    });
    await browser.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      files: ["shared/compile.js", "content/site-data.js", "content/runtime.js"],
    });
    return true;
  } catch (error) {
    // Injection can be refused on privileged pages. The registered content
    // scripts will cover the next ordinary load.
    console.warn("FeedBlocker: could not inject into tab " + tabId, error);
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Pause timer
 * ------------------------------------------------------------------ */

async function armPauseAlarm(pauseUntil) {
  await browser.alarms.clear(ALARM_UNPAUSE).catch(() => {});
  if (pauseUntil && pauseUntil > Date.now()) {
    browser.alarms.create(ALARM_UNPAUSE, { when: pauseUntil });
  }
}

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_UNPAUSE) return;
  const rules = await getRules();
  await updateAction(await getSettings(), rules);
});

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

browser.runtime.onMessage.addListener((message, sender) => handleMessage(message, sender));

async function handleMessage(message, sender) {
  if (!message || typeof message.type !== "string") return undefined;

  switch (message.type) {
    case "get-state":
      await writeChain;
      return { settings: await getSettings() };

    case "set-site":
      return serializeWrite(async () => {
        const settings = await getSettings();
        const site = ensureSite(settings, message.siteId);
        site.enabled = message.enabled === true;
        const saved = await saveSettings(settings);
        await queueSync();
        let injected = true;
        if (saved.sites[message.siteId].enabled && Number.isInteger(message.tabId)) {
          injected = await injectIntoTab(message.tabId, message.siteId);
        }
        return { settings: saved, injected };
      });

    case "set-element":
      return serializeWrite(async () => {
        const rules = await getRules();
        const rule = rules[message.siteId];
        if (!rule) return { error: "unknown-site" };
        const element = FB.leaves(rule).find((el) => el.id === message.elementId);
        if (!element) return { error: "unknown-element" };

        const settings = await getSettings();
        const site = ensureSite(settings, message.siteId);
        const value = message.value === true;
        const fallback = element.default === true;
        if (value === fallback) delete site.elements[element.id];
        else site.elements[element.id] = value;

        const saved = await saveSettings(settings);
        return { settings: saved };
      });

    case "set-group":
      return serializeWrite(async () => {
        const rules = await getRules();
        const rule = rules[message.siteId];
        if (!rule) return { error: "unknown-site" };
        const group = (rule.groups || []).find((g) => g.id === message.groupId);
        if (!group || !Array.isArray(group.children)) return { error: "unknown-group" };

        const settings = await getSettings();
        const site = ensureSite(settings, message.siteId);
        const value = message.value === true;
        for (const child of group.children) {
          const fallback = child.default === true;
          if (value === fallback) delete site.elements[child.id];
          else site.elements[child.id] = value;
        }
        const saved = await saveSettings(settings);
        return { settings: saved };
      });

    case "pause":
      return serializeWrite(async () => {
        const settings = await getSettings();
        if (message.resume === true) {
          settings.pauseUntil = 0;
        } else if (Number.isFinite(message.until)) {
          settings.pauseUntil = Math.floor(message.until);
        } else if (Number.isFinite(message.minutes)) {
          settings.pauseUntil = Date.now() + Math.max(1, message.minutes) * 60000;
        } else {
          settings.pauseUntil = 0;
        }
        const saved = await saveSettings(settings);
        await armPauseAlarm(saved.pauseUntil);
        await queueSync();
        return { settings: saved };
      });

    case "reset-site":
      return serializeWrite(async () => {
        const settings = await getSettings();
        const site = ensureSite(settings, message.siteId);
        site.elements = {};
        const saved = await saveSettings(settings);
        return { settings: saved };
      });

    case "reset-all":
      return serializeWrite(async () => {
        const settings = await getSettings();
        for (const siteId of Object.keys(settings.sites)) settings.sites[siteId].elements = {};
        settings.pauseUntil = 0;
        const saved = await saveSettings(settings);
        await armPauseAlarm(0);
        await queueSync();
        return { settings: saved };
      });

    case "import":
      return serializeWrite(async () => {
        const payload = message.payload;
        const validSites =
          payload &&
          !Array.isArray(payload) &&
          payload.sites &&
          typeof payload.sites === "object" &&
          !Array.isArray(payload.sites);
        if (!payload || payload.app !== "feedblocker" || !validSites) {
          return { error: "not-feedblocker" };
        }
        const settings = FB.normalize(payload);
        const saved = await saveSettings(settings);
        await armPauseAlarm(saved.pauseUntil);
        await queueSync();
        return { settings: saved };
      });

    default:
      return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

browser.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  await saveSettings(settings);
  await armPauseAlarm(settings.pauseUntil);
  queueSync();
});

browser.runtime.onStartup.addListener(async () => {
  const settings = await getSettings();
  await armPauseAlarm(settings.pauseUntil);
  queueSync();
});

browser.permissions.onAdded.addListener(() => queueSync());
browser.permissions.onRemoved.addListener(() => queueSync());

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  const change = changes[FB.STORAGE_KEY];
  if (!change) return;
  const next = change.newValue;
  armPauseAlarm(next && Number.isFinite(next.pauseUntil) ? next.pauseUntil : 0);
  queueSync();
});

// Register at load as well: an event page that woke for any reason should
// converge on the right set of registered scripts.
queueSync();
