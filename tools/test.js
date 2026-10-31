#!/usr/bin/env node
/*
 * Unit checks for shared/compile.js. Run: node tools/test.js
 */
"use strict";

const assert = require("assert");
const path = require("path");

require(path.join(__dirname, "..", "shared", "compile.js"));
const FB = globalThis.FeedBlocker;

const rule = {
  id: "demo",
  groups: [
    { id: "feed", label: "Feed", default: true, selectors: [".feed", ".feed2"] },
    {
      id: "shorts",
      label: "Shorts",
      type: "group",
      children: [
        { id: "shelf", label: "Shelf", default: true, selectors: [".shelf", ".shelf2"] },
        { id: "tab", label: "Tab", default: false, selectors: [".tab", ".tab2"] },
      ],
    },
    {
      id: "redirect",
      label: "Redirect",
      type: "behavior",
      behavior: "redirect",
      default: false,
      from: ["/"],
      to: "/feed/subscriptions",
    },
  ],
  routes: { home: ["/", "/home"], watch: ["/watch", "/watch/*"] },
};

// --- normalize ---
assert.deepStrictEqual(FB.normalize(null), { version: 1, pauseUntil: 0, sites: {} });

const normalized = FB.normalize({
  pauseUntil: 1234,
  sites: {
    demo: { enabled: true, elements: { feed: false, bogus: "yes" } },
    other: { enabled: "no" },
  },
});
assert.strictEqual(normalized.sites.demo.enabled, true);
assert.deepStrictEqual(normalized.sites.demo.elements, { feed: false });
assert.strictEqual(normalized.sites.other.enabled, false);

// --- isOn / groupState / enabledIds ---
let settings = FB.normalize({ sites: { demo: { enabled: true, elements: {} } } });
assert.strictEqual(FB.isOn(settings, rule, rule.groups[0]), true);
assert.strictEqual(FB.isOn(settings, rule, { id: "tab", default: false }), false);
assert.strictEqual(FB.groupState(settings, rule, rule.groups[1]), "mixed");
assert.deepStrictEqual(FB.enabledIds(rule, settings), ["feed", "shelf"]);

settings = FB.normalize({
  sites: { demo: { enabled: false, elements: { feed: false } } },
});
assert.deepStrictEqual(FB.enabledIds(rule, settings), [], "master off hides nothing");

settings = FB.normalize({
  sites: { demo: { enabled: true, elements: { feed: false } } },
  pauseUntil: Date.now() + 60000,
});
assert.strictEqual(FB.isPaused(settings), true);
assert.deepStrictEqual(FB.enabledIds(rule, settings), [], "pause hides nothing");

// --- matchPath ---
assert.strictEqual(FB.matchPath("/", "/"), true);
assert.strictEqual(FB.matchPath("/feed/", "/feed"), true);
assert.strictEqual(FB.matchPath("/r/popular", "/r/popular"), true);
assert.strictEqual(FB.matchPath("/r/popular/top", "/r/popular/*"), true);
assert.strictEqual(FB.matchPath("/r/other", "/r/popular/*"), false);
assert.strictEqual(FB.matchPath("/watch", "/watch"), true);
assert.strictEqual(FB.matchPath("/watch/abc", "/watch/*"), true);

// --- routeTokens ---
assert.deepStrictEqual(FB.routeTokens(rule, "/"), ["home"]);
assert.deepStrictEqual(FB.routeTokens(rule, "/watch/xyz"), ["watch"]);
assert.deepStrictEqual(FB.routeTokens(rule, "/channels"), []);

// --- activeCount ---
settings = FB.normalize({ sites: { demo: { enabled: true, elements: { tab: true } } } });
assert.strictEqual(FB.activeCount(settings, rule), 3, "feed, shelf and tab; behavior excluded");

console.log("OK  shared/compile.js unit checks");
