/*
 * FeedBlocker page runtime.
 *
 * Registered at document_start alongside rules/<site>.css. It never changes
 * page markup except to add the "Show once" placeholder, and it never touches
 * players, comment boxes, forms or navigation.
 *
 * The stylesheet does the hiding, keyed off data attributes this script sets:
 *   <html data-fb-on="home-feed sidebar" data-fb-route="home" data-fb-show="">
 */
(function () {
  "use strict";

  const FB = globalThis.FeedBlocker;
  const DATA = globalThis.FeedBlockerData;
  if (!FB || !DATA) return;
  // The global guard lives in this isolated world, so reloading the extension
  // can inject a fresh runtime into an already-open tab. The DOM attribute is
  // only a visible marker for debugging.
  if (globalThis.__feedBlockerRuntime) return;
  globalThis.__feedBlockerRuntime = true;

  // The generated data carries the hostnames, so there is only one list.
  const host = location.hostname.toLowerCase();
  let siteId = null;
  for (const id of Object.keys(DATA)) {
    const hosts = DATA[id].hostnames || [];
    if (hosts.some((h) => host === h || host.endsWith("." + h))) {
      siteId = id;
      break;
    }
  }
  if (!siteId) return;

  const rule = DATA[siteId];
  let settings = null;
  let booted = false;
  const shown = new Set();
  let observer = null;
  let scanTimer = 0;
  let pauseTimer = 0;
  let lastUrl = location.href;
  let lastRedirect = 0;

  /* ---------------------------------------------------------------- *
   * Boot
   * ---------------------------------------------------------------- */

  let attempts = 0;
  function start() {
    if (!document.documentElement) {
      if (++attempts < 100) setTimeout(start, 10);
      return;
    }
    document.documentElement.setAttribute("data-fb-runtime", "");
    booted = true;
    applyRouteAttribute();
    primeDefaults();
    refresh();
  }
  start();

  /*
   * Settings are asynchronous, defaults are not. Applying the default-on ids
   * here means the first paint already hides the feed for the common case;
   * the storage read then corrects any user overrides a moment later.
   */
  function primeDefaults() {
    const root = document.documentElement;
    if (!root) return;
    const ids = [];
    for (const element of FB.leaves(rule)) {
      if (element.type === "behavior") continue;
      if (!Array.isArray(element.selectors) || !element.selectors.length) continue;
      if (element.default === true) ids.push(element.id);
    }
    if (ids.length) root.setAttribute("data-fb-on", ids.join(" "));
    else root.removeAttribute("data-fb-on");
    root.removeAttribute("data-fb-show");
    root.setAttribute("data-fb-state", "loading");
  }

  async function refresh() {
    if (!booted) return;
    let stored;
    try {
      stored = await browser.storage.sync.get(FB.STORAGE_KEY);
    } catch (error) {
      return;
    }
    settings = FB.normalize(stored[FB.STORAGE_KEY]);
    apply();
  }

  function apply() {
    const root = document.documentElement;
    if (!root || !rule || !settings) return;

    const enabled = FB.site(settings, rule.id).enabled;
    const paused = FB.isPaused(settings);
    const ids = FB.enabledIds(rule, settings);

    applyRouteAttribute();

    for (const id of [...shown]) {
      if (!ids.includes(id)) shown.delete(id);
    }
    syncShowAttribute();

    if (ids.length) {
      root.setAttribute("data-fb-on", ids.join(" "));
    } else {
      root.removeAttribute("data-fb-on");
    }

    // Lets tests and issue reports see why nothing is hidden.
    root.setAttribute(
      "data-fb-state",
      !enabled ? "off" : paused ? "paused" : ids.length ? "on" : "empty"
    );

    schedulePauseWake();
    refreshPlaceholders();
    watchDom();
    maybeRedirect();
  }

  function applyRouteAttribute() {
    const root = document.documentElement;
    if (!root || !rule) return;
    const tokens = FB.routeTokens(rule, location.pathname);
    if (tokens.length) root.setAttribute("data-fb-route", tokens.join(" "));
    else root.removeAttribute("data-fb-route");
  }

  function syncShowAttribute() {
    const root = document.documentElement;
    if (!root) return;
    if (shown.size) root.setAttribute("data-fb-show", [...shown].join(" "));
    else root.removeAttribute("data-fb-show");
  }

  /* ---------------------------------------------------------------- *
   * Show once
   * ---------------------------------------------------------------- */

  function firstOf(target) {
    const list = Array.isArray(target) ? target : target ? [target] : [];
    for (const selector of list) {
      try {
        const node = document.querySelector(selector);
        if (node) return node;
      } catch (error) {
        /* ignore a bad selector */
      }
    }
    return null;
  }

  function isHiddenByRules(element) {
    for (const selector of element.selectors || []) {
      let node = null;
      try {
        node = document.querySelector(selector);
      } catch (error) {
        continue;
      }
      if (!node) continue;
      if (node.getClientRects().length === 0) return true;
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return true;
    }
    return false;
  }

  function refreshPlaceholders() {
    if (!booted) return;
    const wanted = new Map();

    if (rule && settings) {
      const enabled = FB.site(settings, rule.id).enabled;
      if (enabled && !FB.isPaused(settings)) {
        for (const element of FB.leaves(rule)) {
          if (!element.placeholder) continue;
          if (!FB.isOn(settings, rule, element)) continue;
          if (shown.has(element.id)) continue;
          wanted.set(element.id, element);
        }
      }
    }

    for (const node of document.querySelectorAll(".fb-placeholder[data-fb-ph]")) {
      if (!wanted.has(node.getAttribute("data-fb-ph"))) node.remove();
    }

    for (const [id, element] of wanted) {
      if (document.querySelector('.fb-placeholder[data-fb-ph="' + id + '"]')) continue;
      addPlaceholder(id, element);
    }
  }

  function addPlaceholder(id, element) {
    const config = element.placeholder || {};
    const target = firstOf(config.target);
    if (!target) return;
    // Only claim the feed is hidden when our rules actually matched something.
    if (!isHiddenByRules(element)) return;

    const hostNode = document.createElement("div");
    hostNode.className = "fb-placeholder";
    hostNode.setAttribute("data-fb-ph", id);
    hostNode.style.cssText =
      "display:block !important;width:100% !important;box-sizing:border-box;";

    const shadow = hostNode.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = [
      ":host{display:block}",
      ".wrap{display:flex;align-items:center;justify-content:center;gap:10px;",
      "margin:16px auto;padding:14px 16px;max-width:640px;box-sizing:border-box;",
      'border:1px dashed #b1b1b9;border-radius:10px;color:#5b5b66;',
      'font:13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:center}',
      "span{min-width:0}",
      "button{appearance:none;flex:0 0 auto;border:1px solid #b1b1b9;border-radius:6px;",
      "background:transparent;color:inherit;font:inherit;padding:4px 10px;cursor:pointer}",
      "button:hover{background:rgba(128,128,128,.12)}",
      "button:focus-visible{outline:2px solid #0060df;outline-offset:2px}",
      "@media (prefers-color-scheme:dark){.wrap{color:#bfbfc9;border-color:#52525b}",
      "button{border-color:#52525b}button:focus-visible{outline-color:#80ebff}}",
      "@media (forced-colors:active){.wrap{border-color:CanvasText;color:CanvasText}",
      "button{border-color:ButtonText;color:ButtonText}}",
    ].join("");

    const wrap = document.createElement("div");
    wrap.className = "wrap";
    const label = document.createElement("span");
    const button = document.createElement("button");
    button.type = "button";
    wrap.append(label, button);
    shadow.append(style, wrap);

    label.textContent = config.text || "Feed hidden.";
    button.textContent = config.action || "Show once";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      shown.add(id);
      syncShowAttribute();
      hostNode.remove();
    });

    target.prepend(hostNode);
  }

  /* ---------------------------------------------------------------- *
   * DOM watching (placeholder only, debounced)
   * ---------------------------------------------------------------- */

  function watchDom() {
    const root = document.documentElement;
    if (!root || !rule || !settings) return;
    const active = FB.site(settings, rule.id).enabled && !FB.isPaused(settings);
    const needed =
      active &&
      FB.leaves(rule).some(
        (element) => element.placeholder && FB.isOn(settings, rule, element)
      );
    if (!needed) {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      return;
    }
    if (observer) return;
    observer = new MutationObserver(scheduleScan);
    observer.observe(root, { childList: true, subtree: true });
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      if (document.hidden) return;
      applyRouteAttribute();
      refreshPlaceholders();
    }, 300);
  }

  /* ---------------------------------------------------------------- *
   * SPA navigation
   * ---------------------------------------------------------------- */

  function checkUrl() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    shown.clear();
    syncShowAttribute();
    apply();
  }

  setInterval(checkUrl, 750);
  window.addEventListener("popstate", checkUrl);
  window.addEventListener("hashchange", checkUrl);
  document.addEventListener("yt-navigate-finish", checkUrl, true);
  document.addEventListener("yt-page-data-updated", checkUrl, true);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    // A background tab can throttle the pause timer, so re-read on return.
    checkUrl();
    refresh();
  });

  /* ---------------------------------------------------------------- *
   * Pause expiry
   * ---------------------------------------------------------------- */

  function schedulePauseWake() {
    clearTimeout(pauseTimer);
    if (!settings || !FB.isPaused(settings)) return;
    const wait = settings.pauseUntil - Date.now();
    if (wait > 0 && wait < 24 * 60 * 60 * 1000) {
      pauseTimer = setTimeout(() => refresh(), wait + 250);
    }
  }

  /* ---------------------------------------------------------------- *
   * Optional redirects (YouTube home -> Subscriptions)
   * ---------------------------------------------------------------- */

  function maybeRedirect() {
    if (!rule || !settings) return;
    if (!FB.site(settings, rule.id).enabled || FB.isPaused(settings)) return;
    for (const element of FB.leaves(rule)) {
      if (element.type !== "behavior" || element.behavior !== "redirect") continue;
      if (!FB.isOn(settings, rule, element)) continue;
      const from = Array.isArray(element.from) ? element.from : [];
      if (!from.some((pattern) => FB.matchPath(location.pathname, pattern))) continue;
      if (location.pathname + location.search === element.to) return;
      // Do not fight a site that bounces the redirect target back.
      if (Date.now() - lastRedirect < 3000) return;
      lastRedirect = Date.now();
      location.replace(element.to);
      return;
    }
  }

  /* ---------------------------------------------------------------- *
   * Settings changes and popup hand-off
   * ---------------------------------------------------------------- */

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes[FB.STORAGE_KEY]) refresh();
  });

  browser.runtime.onMessage.addListener((message) => {
    if (!message || typeof message.type !== "string") return undefined;
    if (message.type === "fb-ping") return Promise.resolve({ ok: true });
    if (message.type === "fb-refresh") {
      lastUrl = location.href;
      shown.clear();
      syncShowAttribute();
      return refresh().then(() => ({ ok: true }));
    }
    return undefined;
  });
})();
