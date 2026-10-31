/*
 * FeedBlocker shared logic.
 *
 * Loaded as a classic script in three places:
 *   - the background event page (manifest background.scripts)
 *   - every registered content script (before content/runtime.js)
 *   - the popup (before popup/popup.js)
 *
 * It must not use modules, top-level await, or DOM APIs.
 */
(function () {
  "use strict";

  const FB = (globalThis.FeedBlocker = globalThis.FeedBlocker || {});

  FB.STORAGE_KEY = "fb";
  FB.SCHEMA_VERSION = 1;

  /** Coerce anything that came from storage or an import file into our schema. */
  FB.normalize = function (raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    const out = { version: FB.SCHEMA_VERSION, pauseUntil: 0, sites: {} };
    if (Number.isFinite(src.pauseUntil) && src.pauseUntil > 0) {
      out.pauseUntil = Math.floor(src.pauseUntil);
    }
    const sites = src.sites && typeof src.sites === "object" ? src.sites : {};
    for (const id of Object.keys(sites)) {
      const s = sites[id];
      if (!s || typeof s !== "object") continue;
      const elements = {};
      if (s.elements && typeof s.elements === "object") {
        for (const key of Object.keys(s.elements)) {
          if (typeof s.elements[key] === "boolean") elements[key] = s.elements[key];
        }
      }
      out.sites[id] = { enabled: s.enabled === true, elements };
    }
    return out;
  };

  FB.emptySettings = function () {
    return FB.normalize(null);
  };

  FB.isPaused = function (settings) {
    return !!(settings && settings.pauseUntil && settings.pauseUntil > Date.now());
  };

  FB.site = function (settings, siteId) {
    const s = settings && settings.sites ? settings.sites[siteId] : null;
    return s || { enabled: false, elements: {} };
  };

  /** Flatten a rule's groups into the list of things that can be hidden. */
  FB.leaves = function (rule) {
    const out = [];
    for (const group of (rule && rule.groups) || []) {
      if (Array.isArray(group.children) && group.children.length) {
        for (const child of group.children) {
          out.push(Object.assign({}, child, { groupId: group.id }));
        }
      } else {
        out.push(group);
      }
    }
    return out;
  };

  /** Effective state of one leaf: stored override if present, else its default. */
  FB.isOn = function (settings, rule, element) {
    const site = FB.site(settings, rule.id);
    const stored = site.elements ? site.elements[element.id] : undefined;
    return typeof stored === "boolean" ? stored : element.default === true;
  };

  /** "on" | "off" | "mixed" for the disclosure row of a group. */
  FB.groupState = function (settings, rule, group) {
    const children = group.children || [];
    if (!children.length) return FB.isOn(settings, rule, group) ? "on" : "off";
    let on = 0;
    for (const child of children) if (FB.isOn(settings, rule, child)) on++;
    if (on === 0) return "off";
    if (on === children.length) return "on";
    return "mixed";
  };

  /** Count of CSS switches currently on. */
  FB.activeCount = function (settings, rule) {
    let n = 0;
    for (const el of FB.leaves(rule)) {
      if (el.type === "behavior") continue;
      if (FB.isOn(settings, rule, el)) n++;
    }
    return n;
  };

  /** Element ids the page should currently hide, as an array for data-fb-on. */
  FB.enabledIds = function (rule, settings) {
    const site = FB.site(settings, rule.id);
    if (!site.enabled) return [];
    if (FB.isPaused(settings)) return [];
    const ids = [];
    for (const el of FB.leaves(rule)) {
      if (el.type === "behavior") continue;
      if (!Array.isArray(el.selectors) || !el.selectors.length) continue;
      if (FB.isOn(settings, rule, el)) ids.push(el.id);
    }
    return ids;
  };

  /** Simple path matcher used by route guards and redirects. `*` is a wildcard. */
  FB.matchPath = function (path, pattern) {
    if (typeof pattern !== "string") return false;
    const p = path.replace(/\/+$/, "") || "/";
    const q = pattern.replace(/\/+$/, "") || "/";
    if (q === p) return true;
    if (q.indexOf("*") === -1) return false;
    const escaped = q
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp("^" + escaped + "$").test(p);
  };

  /** Route tokens for the current path, e.g. ["feed"]. */
  FB.routeTokens = function (rule, pathname) {
    const routes = rule && rule.routes;
    if (!routes || typeof routes !== "object") return [];
    const tokens = [];
    for (const token of Object.keys(routes)) {
      const patterns = routes[token];
      if (!Array.isArray(patterns)) continue;
      if (patterns.some((pattern) => FB.matchPath(pathname, pattern))) tokens.push(token);
    }
    return tokens;
  };
})();
