#!/usr/bin/env node
/*
 * Static checks for the rule files and generated stylesheets.
 *
 * Run: node tools/check.js
 * Exit code 1 on any problem, so CI can gate releases.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const problems = [];
const notes = [];

function fail(message) {
  problems.push(message);
}

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
}

const manifest = readJson("manifest.json");
const order = readJson("rules/index.json");

if (!Array.isArray(order) || !order.length) fail("rules/index.json must be a non-empty array");

const optional = new Set(manifest.optional_host_permissions || []);
const seenSites = new Set();
let elementCount = 0;

for (const id of order) {
  const file = "rules/" + id + ".json";
  if (!fs.existsSync(path.join(root, file))) {
    fail(file + " is listed in index.json but does not exist");
    continue;
  }
  const rule = readJson(file);
  seenSites.add(id);

  if (rule.id !== id) fail(file + ": id must match the file name");
  if (!rule.name) fail(file + ": missing name");
  if (!Array.isArray(rule.matches) || !rule.matches.length) fail(file + ": missing matches");
  if (!Array.isArray(rule.hostnames) || !rule.hostnames.length) fail(file + ": missing hostnames");
  if (!Array.isArray(rule.origins) || !rule.origins.length) fail(file + ": missing origins");

  for (const origin of rule.origins || []) {
    if (!optional.has(origin)) fail(file + ": origin not declared in manifest optional_host_permissions: " + origin);
  }

  for (const match of rule.matches || []) {
    if (!optional.has(match)) fail(file + ": match not declared in manifest optional_host_permissions: " + match);
  }

  const ids = new Set();
  const groups = Array.isArray(rule.groups) ? rule.groups : [];
  if (!groups.length) fail(file + ": no groups");

  for (const group of groups) {
    if (!group.id) fail(file + ": a group is missing an id");
    if (!group.label) fail(file + ": group " + group.id + " is missing a label");
    const isGroup = Array.isArray(group.children) && group.children.length > 0;

    if (isGroup) {
      for (const child of group.children) checkElement(child, group.id);
    } else {
      checkElement(group, null);
    }
  }

  function checkElement(element, parentId) {
    const where = file + " -> " + (parentId ? parentId + "/" : "") + (element.id || "(no id)");
    if (!element.id) fail(where + ": missing id");
    else if (ids.has(element.id)) fail(where + ": duplicate id");
    else {
      ids.add(element.id);
      elementCount++;
    }
    if (!element.label) fail(where + ": missing label");
    if (typeof element.default !== "boolean") fail(where + ": default must be true or false");

    if (element.type === "behavior") {
      if (element.behavior === "redirect") {
        if (!Array.isArray(element.from) || !element.from.length) fail(where + ": redirect needs from[]");
        if (typeof element.to !== "string" || !element.to) fail(where + ": redirect needs to");
      } else {
        fail(where + ": unknown behavior " + element.behavior);
      }
      return;
    }

    if (!Array.isArray(element.selectors) || element.selectors.length < 2) {
      fail(where + ": needs at least two fallback selectors");
    }
    for (const selector of element.selectors || []) {
      if (/^\s*html\b/.test(selector)) {
        fail(where + ": selector must not start with html (the build adds the guard)");
      }
      if (/!important/.test(selector)) fail(where + ": selectors must not include !important");
    }
    if (element.routes && !Array.isArray(element.routes)) fail(where + ": routes must be an array");
    for (const token of element.routes || []) {
      if (!rule.routes || !Array.isArray(rule.routes[token])) {
        fail(where + ": route token not defined in routes: " + token);
      }
    }
    if (element.placeholder) {
      if (!element.placeholder.text) fail(where + ": placeholder needs text");
      if (!element.placeholder.target) fail(where + ": placeholder needs a target");
    }
  }
}

// Generated CSS must be present and up to date.
for (const id of seenSites) {
  const cssFile = path.join(root, "rules", id + ".css");
  if (!fs.existsSync(cssFile)) {
    fail("rules/" + id + ".css is missing; run node tools/build.js");
    continue;
  }
  const css = fs.readFileSync(cssFile, "utf8");
  const rule = readJson("rules/" + id + ".json");
  const elementIds = [];
  for (const group of rule.groups || []) {
    const items = Array.isArray(group.children) && group.children.length ? group.children : [group];
    for (const element of items) {
      if (element.type === "behavior") continue;
      if (!Array.isArray(element.selectors) || !element.selectors.length) continue;
      elementIds.push(element.id);
    }
  }
  for (const elementId of elementIds) {
    if (css.indexOf('data-fb-on~="' + elementId + '"') === -1) {
      fail("rules/" + id + ".css is stale for " + elementId + "; run node tools/build.js");
    }
  }
}

// Generated runtime data must be present and up to date.
const runtimeData = readRuntimeData();

function readRuntimeData() {
  const file = path.join(root, "content", "site-data.js");
  if (!fs.existsSync(file)) {
    fail("content/site-data.js is missing; run node tools/build.js");
    return null;
  }
  const source = fs.readFileSync(file, "utf8");
  const marker = "globalThis.FeedBlockerData = ";
  const start = source.indexOf(marker);
  const end = source.lastIndexOf(";");
  if (start === -1 || end < start) {
    fail("content/site-data.js is malformed; run node tools/build.js");
    return null;
  }
  try {
    return JSON.parse(source.slice(start + marker.length, end));
  } catch (error) {
    fail("content/site-data.js is not valid JSON; run node tools/build.js");
    return null;
  }
}

if (runtimeData) {
  for (const id of Object.keys(runtimeData)) {
    if (!seenSites.has(id)) fail("content/site-data.js has an unknown site: " + id);
  }

  for (const id of seenSites) {
    const rule = readJson("rules/" + id + ".json");
    const site = runtimeData[id];
    if (!site) {
      fail("content/site-data.js is stale for " + id + "; run node tools/build.js");
      continue;
    }
    if (!same(site.hostnames, rule.hostnames)) {
      fail("content/site-data.js has stale hostnames for " + id + "; run node tools/build.js");
    }
    if (!same(site.routes, rule.routes || {})) {
      fail("content/site-data.js has stale routes for " + id + "; run node tools/build.js");
    }

    const expected = [];
    for (const group of rule.groups || []) {
      if (Array.isArray(group.children) && group.children.length) expected.push(...group.children);
      else expected.push(group);
    }
    const actual = [];
    for (const group of site.groups || []) {
      if (Array.isArray(group.children) && group.children.length) actual.push(...group.children);
      else actual.push(group);
    }

    const actualById = new Map(actual.map((element) => [element.id, element]));
    if (actualById.size !== actual.length) {
      fail("content/site-data.js has duplicate element ids for " + id + "; run node tools/build.js");
    }
    for (const element of expected) {
      const built = actualById.get(element.id);
      if (!built) {
        fail("content/site-data.js is stale for " + id + "/" + element.id + "; run node tools/build.js");
        continue;
      }
      if (element.type === "behavior") {
        if (built.type !== "behavior" || built.behavior !== element.behavior) {
          fail("content/site-data.js is stale for behavior " + id + "/" + element.id + "; run node tools/build.js");
        }
      } else if (!same(built.selectors, element.selectors)) {
        fail("content/site-data.js has stale selectors for " + id + "/" + element.id + "; run node tools/build.js");
      }
    }
    if (actualById.size !== expected.length) {
      fail("content/site-data.js has extra or missing elements for " + id + "; run node tools/build.js");
    }
  }
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Files referenced by the manifest must exist, including icon maps.
function filePaths(value, out) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) filePaths(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) filePaths(item, out);
  return out;
}

const referenced = filePaths(
  [
    manifest.background && manifest.background.scripts,
    manifest.action && manifest.action.default_popup,
    manifest.action && manifest.action.default_icon,
    manifest.icons,
  ],
  []
);

for (const entry of referenced) {
  if (!fs.existsSync(path.join(root, entry))) fail("manifest references a missing file: " + entry);
}

for (const icon of ["icons/on.svg", "icons/off.svg", "icons/paused.svg"]) {
  if (!fs.existsSync(path.join(root, icon))) fail("missing toolbar icon: " + icon);
}

for (const file of [
  "shared/compile.js",
  "content/runtime.js",
  "content/site-data.js",
  "popup/popup.html",
  "popup/popup.css",
  "popup/popup.js",
]) {
  if (!fs.existsSync(path.join(root, file))) fail("missing runtime file: " + file);
}

for (const id of order) {
  for (const suffix of [".css", ".json"]) {
    if (!fs.existsSync(path.join(root, "rules", id + suffix))) {
      fail("missing rules/" + id + suffix);
    }
  }
}

notes.push(order.length + " sites, " + elementCount + " elements");

if (problems.length) {
  console.error("FAIL");
  for (const problem of problems) console.error("  - " + problem);
  process.exitCode = 1;
} else {
  console.log("OK  " + notes.join("; "));
}
