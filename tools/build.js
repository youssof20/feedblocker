#!/usr/bin/env node
/*
 * Generates:
 *   rules/<site>.css     the attribute-guarded stylesheet
 *   content/site-data.js the trimmed rule data the page runtime needs
 *
 * Both come from rules/<site>.json — the single source of truth.
 *
 * Run from the repository root:  node tools/build.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const order = JSON.parse(fs.readFileSync(path.join(root, "rules", "index.json"), "utf8"));

function esc(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}

const data = {};

for (const id of order) {
  const rule = JSON.parse(fs.readFileSync(path.join(root, "rules", id + ".json"), "utf8"));
  const lines = [
    "/* Generated from rules/" + id + ".json. Do not edit by hand. */",
    "/* Run: node tools/build.js */",
  ];

  const runtimeGroups = [];

  for (const group of rule.groups || []) {
    const isGroup = Array.isArray(group.children) && group.children.length > 0;
    const items = isGroup ? group.children : [group];
    const runtimeGroup = { id: group.id };

    if (isGroup) {
      runtimeGroup.children = [];
    } else {
      copyElement(group, runtimeGroup);
    }

    for (const element of items) {
      if (element.type === "behavior") {
        if (isGroup) runtimeGroup.children.push(trim(element, true));
        continue;
      }
      const selectors = Array.isArray(element.selectors) ? element.selectors : [];
      if (!selectors.length) continue;

      let guard = 'html[data-fb-on~="' + esc(element.id) + '"]';
      if (Array.isArray(element.routes) && element.routes.length) {
        guard +=
          element.routes.length === 1
            ? '[data-fb-route~="' + esc(element.routes[0]) + '"]'
            : ":is(" + element.routes.map((r) => '[data-fb-route~="' + esc(r) + '"]').join(",") + ")";
      }
      if (element.placeholder) {
        guard += ':not([data-fb-show~="' + esc(element.id) + '"])';
      }

      lines.push("");
      for (const selector of selectors) {
        lines.push(guard + " " + selector + "{display:none !important}");
      }

      if (isGroup) runtimeGroup.children.push(trim(element, false));
    }

    runtimeGroups.push(runtimeGroup);
  }

  fs.writeFileSync(path.join(root, "rules", id + ".css"), lines.join("\n") + "\n");

  data[id] = {
    id,
    hostnames: rule.hostnames || [],
    routes: rule.routes || {},
    groups: runtimeGroups,
  };
}

const siteData =
  "/* Generated from rules/*.json. Do not edit by hand. Run: node tools/build.js */\n" +
  "globalThis.FeedBlockerData = " +
  JSON.stringify(data) +
  ";\n";

fs.writeFileSync(path.join(root, "content", "site-data.js"), siteData);

for (const id of order) console.log("wrote rules/" + id + ".css");
console.log("wrote content/site-data.js");

/** Copy the element fields the build needs into a runtime group. */
function copyElement(element, target) {
  if (element.type === "behavior") {
    Object.assign(target, trim(element, true));
    return;
  }
  const selectors = Array.isArray(element.selectors) ? element.selectors : [];
  if (!selectors.length) return;
  Object.assign(target, trim(element, false));
}

/**
 * Keep only what content/runtime.js reads. Labels stay out on purpose: the
 * popup renders from the JSON rule files.
 */
function trim(element, isBehavior) {
  const out = { id: element.id, default: element.default === true };
  if (isBehavior) {
    out.type = "behavior";
    if (element.behavior) out.behavior = element.behavior;
    if (element.from) out.from = element.from;
    if (element.to) out.to = element.to;
    return out;
  }
  out.selectors = element.selectors;
  if (Array.isArray(element.routes) && element.routes.length) out.routes = element.routes;
  if (element.placeholder) {
    out.placeholder = {
      text: element.placeholder.text || "Feed hidden.",
      target: element.placeholder.target,
    };
    if (element.placeholder.action) out.placeholder.action = element.placeholder.action;
  }
  return out;
}
