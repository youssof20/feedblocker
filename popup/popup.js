/*
 * FeedBlocker popup.
 *
 * Reads state from the background, writes every change back through it, and
 * re-renders from the rule files. No unsaved state, no Save button.
 */
(function () {
  "use strict";

  const FB = globalThis.FeedBlocker;
  const REPO = "https://github.com/youssof20/feedblocker";
  const SVG_NS = "http://www.w3.org/2000/svg";

  const $ = (id) => document.getElementById(id);

  function chevron() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", "10");
    svg.setAttribute("height", "10");
    svg.setAttribute("viewBox", "0 0 10 10");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");

    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M3 1.5 6.5 5 3 8.5");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.6");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
    return svg;
  }

  const ui = {
    name: $("site-name"),
    siteStatus: $("site-status"),
    master: $("master"),
    masterWrap: $("master-wrap"),
    hint: $("site-hint"),
    elements: $("elements"),
    other: $("other"),
    otherList: $("other-list"),
    pause: $("pause"),
    tomorrow: $("pause-tomorrow"),
    exportBtn: $("export"),
    reset: $("reset"),
    importBtn: $("import"),
    importFile: $("import-file"),
    report: $("report"),
    footStatus: $("foot-status"),
  };

  let order = [];
  const rules = {};
  let settings = FB.emptySettings();
  const granted = {};
  const controls = new Map();
  const expandedSites = new Set();
  const expandedGroups = new Set();

  let tab = null;
  let currentHost = "";
  let current = null;
  let statusTimer = 0;

  /* ---------------------------------------------------------------- *
   * Boot
   * ---------------------------------------------------------------- */

  boot().catch((error) => {
    console.error("FeedBlocker popup failed", error);
    showStatus("Something went wrong. Reopen the popup.");
  });

  async function boot() {
    order = await fetchJson("rules/index.json");
    const loaded = await Promise.all(
      order.map((id) => fetchJson("rules/" + id + ".json"))
    );
    order.forEach((id, index) => {
      rules[id] = loaded[index];
    });

    const [state, tabs, grants] = await Promise.all([
      send({ type: "get-state" }),
      browser.tabs
        .query({ active: true, currentWindow: true })
        .catch(() => []),
      Promise.all(order.map((id) => hasPermission(id))),
    ]);

    if (state && state.settings) settings = state.settings;
    order.forEach((id, index) => {
      granted[id] = grants[index];
    });

    tab = tabs && tabs[0] ? tabs[0] : null;
    try {
      currentHost = tab && tab.url ? new URL(tab.url).hostname.toLowerCase() : "";
    } catch (error) {
      currentHost = "";
    }
    current = order.find((id) => matchesHost(rules[id], currentHost)) || null;

    wireEvents();
    render();
  }

  async function fetchJson(path) {
    const response = await fetch(browser.runtime.getURL(path));
    return response.json();
  }

  function matchesHost(rule, host) {
    if (!host) return false;
    return (rule.hostnames || []).some((h) => host === h || host.endsWith("." + h));
  }

  async function hasPermission(siteId) {
    try {
      return await browser.permissions.contains({ origins: rules[siteId].origins });
    } catch (error) {
      return false;
    }
  }

  async function send(message) {
    try {
      return await browser.runtime.sendMessage(message);
    } catch (error) {
      console.error("FeedBlocker popup message failed", error);
      return null;
    }
  }

  /* ---------------------------------------------------------------- *
   * Rendering
   * ---------------------------------------------------------------- */

  function render(focusKey) {
    controls.clear();
    renderHead();
    renderCurrent();
    renderOther();
    renderFooter();
    if (focusKey) {
      const input = document.querySelector('input[data-fk="' + focusKey + '"]');
      if (input) input.focus();
    }
  }

  function renderHead() {
    const rule = current ? rules[current] : null;

    if (!rule) {
      ui.name.textContent = "This site";
      ui.siteStatus.hidden = false;
      ui.siteStatus.textContent = "Not supported";
      ui.siteStatus.className = "chip";
      ui.masterWrap.hidden = true;
      ui.hint.hidden = false;
      ui.hint.textContent = currentHost
        ? "No rules for " + currentHost + " yet. Pick a site below."
        : "Open a supported site, or pick one below.";
      return;
    }

    ui.name.textContent = rule.name;
    const beta = rule.status === "beta";
    ui.siteStatus.hidden = !beta;
    if (beta) {
      ui.siteStatus.textContent = "Beta";
      ui.siteStatus.className = "chip chip-beta";
    }

    const site = FB.site(settings, rule.id);
    ui.masterWrap.hidden = false;
    ui.master.dataset.fk = "c:" + rule.id;
    ui.master.checked = site.enabled && granted[rule.id] === true;
    ui.master.indeterminate = site.enabled === true && granted[rule.id] !== true;
    ui.master.setAttribute("aria-label", "Enable FeedBlocker on " + rule.name);

    const total = FB.leaves(rule).filter((el) => el.type !== "behavior").length;
    const on = FB.activeCount(settings, rule);

    let hint;
    if (!site.enabled) {
      hint = "Off. Nothing is hidden on this site.";
    } else if (!granted[rule.id]) {
      hint = "Permission needed. Flip the switch to allow access to " + rule.name + ".";
    } else if (FB.isPaused(settings)) {
      hint = "Paused until " + formatTime(settings.pauseUntil) + ".";
    } else if (on === 0) {
      hint = "On, but every element is switched off.";
    } else {
      hint = on + " of " + total + " switched on.";
    }
    ui.hint.textContent = hint;
    ui.hint.hidden = false;
  }

  function renderCurrent() {
    ui.elements.textContent = "";
    if (!current) {
      ui.elements.hidden = true;
      return;
    }
    ui.elements.hidden = false;
    ui.elements.appendChild(buildElements(rules[current], current));
  }

  function renderOther() {
    ui.otherList.textContent = "";
    const ids = order.filter((id) => id !== current);
    if (!ids.length) {
      ui.other.hidden = true;
      return;
    }
    ui.other.hidden = false;

    for (const id of ids) {
      const rule = rules[id];
      const site = FB.site(settings, id);
      const active = site.enabled === true && granted[id] === true;

      const row = document.createElement("div");
      row.className = "site-row";

      const open = document.createElement("button");
      open.type = "button";
      open.className = "site-open";
      open.setAttribute("aria-expanded", String(expandedSites.has(id)));

      const openName = document.createElement("span");
      openName.className = "site-open-name";
      openName.textContent = rule.name;

      const openState = document.createElement("span");
      openState.className = "site-open-state";
      openState.textContent = active
        ? "On"
        : site.enabled
          ? "Needs permission"
          : "Off";

      open.append(openName, openState, chevron());

      const panel = document.createElement("div");
      panel.className = "site-panel";
      panel.hidden = !expandedSites.has(id);
      panel.appendChild(buildElements(rule, id));

      open.addEventListener("click", () => {
        const shouldOpen = panel.hidden;
        for (const other of ui.otherList.querySelectorAll(".site-panel")) other.hidden = true;
        for (const button of ui.otherList.querySelectorAll(".site-open")) {
          button.setAttribute("aria-expanded", "false");
        }
        expandedSites.clear();
        if (shouldOpen) {
          panel.hidden = false;
          open.setAttribute("aria-expanded", "true");
          expandedSites.add(id);
        }
      });

      const sw = makeSwitch({
        key: "m:" + id,
        label: "Enable on " + rule.name,
        checked: active,
        indeterminate: site.enabled === true && granted[id] !== true,
        onChange: (value) => setMaster(id, value),
      });

      row.appendChild(open);
      row.appendChild(sw);
      ui.otherList.appendChild(row);
      ui.otherList.appendChild(panel);
    }
  }

  function buildElements(rule, siteId) {
    const fragment = document.createDocumentFragment();

    for (const group of rule.groups) {
      const isGroup = Array.isArray(group.children) && group.children.length > 0;
      const item = document.createElement("div");
      item.className = "item";

      const row = document.createElement("div");
      row.className = "row";

      const slot = document.createElement("span");
      slot.className = "slot";

      let list = null;
      if (isGroup) {
        const key = siteId + ":" + group.id;
        const disc = document.createElement("button");
        disc.type = "button";
        disc.className = "disc";
        disc.append(chevron());
        disc.setAttribute("aria-expanded", String(expandedGroups.has(key)));
        disc.setAttribute("aria-label", "Show " + group.label + " options");

        list = document.createElement("div");
        list.className = "subitems";
        list.hidden = !expandedGroups.has(key);

        if (list.hidden) disc.setAttribute("aria-expanded", "false");
        disc.addEventListener("click", () => {
          const open = list.hidden;
          list.hidden = !open;
          disc.setAttribute("aria-expanded", String(open));
          if (open) expandedGroups.add(key);
          else expandedGroups.delete(key);
        });
        slot.appendChild(disc);
      }
      row.appendChild(slot);

      const label = document.createElement("span");
      label.className = "label";
      label.textContent = group.label;
      label.title = group.label;
      row.appendChild(label);

      const groupState = isGroup ? FB.groupState(settings, rule, group) : null;
      row.appendChild(
        makeSwitch({
          key: (isGroup ? "g:" : "e:") + siteId + ":" + group.id,
          label: group.label,
          checked: isGroup ? groupState !== "off" : FB.isOn(settings, rule, group),
          indeterminate: groupState === "mixed",
          onChange: (value) =>
            isGroup ? setGroup(siteId, group, value) : setElement(siteId, group.id, value),
        })
      );
      item.appendChild(row);

      if (isGroup) {
        for (const child of group.children) {
          const childRow = document.createElement("div");
          childRow.className = "row";

          const childSlot = document.createElement("span");
          childSlot.className = "slot";
          childRow.appendChild(childSlot);

          const childLabel = document.createElement("span");
          childLabel.className = "label";
          childLabel.textContent = child.label;
          childLabel.title = child.label;
          childRow.appendChild(childLabel);

          childRow.appendChild(
            makeSwitch({
              key: "e:" + siteId + ":" + child.id,
              label: child.label,
              checked: FB.isOn(settings, rule, child),
              onChange: (value) => setElement(siteId, child.id, value),
            })
          );
          list.appendChild(childRow);
        }
        item.appendChild(list);
      }

      fragment.appendChild(item);
    }

    return fragment;
  }

  function makeSwitch(options) {
    const wrap = document.createElement("label");
    wrap.className = "switch";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("role", "switch");
    input.checked = options.checked === true;
    input.indeterminate = options.indeterminate === true;
    input.setAttribute("aria-label", options.label);
    input.dataset.fk = options.key;
    input.addEventListener("change", () => {
      input.indeterminate = false;
      options.onChange(input.checked);
    });

    const track = document.createElement("span");
    track.className = "track";

    wrap.append(input, track);
    controls.set(options.key, input);
    return wrap;
  }

  function renderFooter() {
    const paused = FB.isPaused(settings);
    ui.pause.textContent = paused ? "Resume" : "Pause 30 min";
    ui.pause.title = paused
      ? "Resume hiding"
      : "Pause FeedBlocker for 30 minutes";
    ui.tomorrow.hidden = paused;

    ui.reset.textContent = current ? "Reset site" : "Reset all";
    ui.reset.title = current
      ? "Restore default elements for " + rules[current].name
      : "Restore all element defaults and resume";
  }

  function refreshSiteControls(siteId) {
    const rule = rules[siteId];
    if (!rule) return;

    for (const group of rule.groups) {
      if (Array.isArray(group.children) && group.children.length) {
        const groupInput = controls.get("g:" + siteId + ":" + group.id);
        if (groupInput) {
          const state = FB.groupState(settings, rule, group);
          groupInput.checked = state !== "off";
          groupInput.indeterminate = state === "mixed";
        }
        for (const child of group.children) {
          const input = controls.get("e:" + siteId + ":" + child.id);
          if (input) input.checked = FB.isOn(settings, rule, child);
        }
      } else {
        const input = controls.get("e:" + siteId + ":" + group.id);
        if (input) input.checked = FB.isOn(settings, rule, group);
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Actions
   * ---------------------------------------------------------------- */

  async function setMaster(siteId, want) {
    if (want && granted[siteId] !== true) {
      let grantedNow = false;
      try {
        grantedNow = await browser.permissions.request({ origins: rules[siteId].origins });
      } catch (error) {
        grantedNow = false;
      }
      granted[siteId] = await hasPermission(siteId);
      if (!grantedNow || !granted[siteId]) {
        showStatus("Permission was not granted.");
        render(siteId === current ? "c:" + siteId : "m:" + siteId);
        return;
      }
    }

    const result = await send({
      type: "set-site",
      siteId,
      enabled: want,
      tabId: siteId === current && tab ? tab.id : undefined,
    });
    if (!result || !result.settings) {
      render(siteId === current ? "c:" + siteId : "m:" + siteId);
      showStatus("Could not save. Try again.");
      return;
    }
    settings = result.settings;
    render(siteId === current ? "c:" + siteId : "m:" + siteId);
    if (want && siteId === current && result.injected === false) {
      showStatus("Reload the page to apply.");
    }
  }

  async function setElement(siteId, elementId, value) {
    const result = await send({ type: "set-element", siteId, elementId, value });
    if (!result || !result.settings) {
      refreshSiteControls(siteId);
      renderHead();
      showStatus("Could not save. Try again.");
      return;
    }
    settings = result.settings;
    refreshSiteControls(siteId);
    renderHead();
    renderFooter();
  }

  async function setGroup(siteId, group, value) {
    const result = await send({ type: "set-group", siteId, groupId: group.id, value });
    if (!result || !result.settings) {
      refreshSiteControls(siteId);
      renderHead();
      showStatus("Could not save. Try again.");
      return;
    }
    settings = result.settings;
    refreshSiteControls(siteId);
    renderHead();
    renderFooter();
  }

  async function setPause(message) {
    const result = await send(Object.assign({ type: "pause" }, message));
    if (!result || !result.settings) {
      showStatus("Could not save. Try again.");
      return;
    }
    settings = result.settings;
    renderHead();
    renderFooter();
    showStatus(
      FB.isPaused(settings)
        ? "Paused until " + formatTime(settings.pauseUntil) + "."
        : "Resumed."
    );
  }

  /* ---------------------------------------------------------------- *
   * Events
   * ---------------------------------------------------------------- */

  function wireEvents() {
    ui.master.addEventListener("change", () => {
      if (current) setMaster(current, ui.master.checked);
    });

    ui.pause.addEventListener("click", () => {
      setPause(FB.isPaused(settings) ? { resume: true } : { minutes: 30 });
    });

    ui.tomorrow.addEventListener("click", () => {
      const tomorrow = new Date();
      tomorrow.setHours(24, 0, 0, 0);
      setPause({ until: tomorrow.getTime() });
    });

    ui.exportBtn.addEventListener("click", () => {
      const payload = {
        app: "feedblocker",
        version: 1,
        exportedAt: new Date().toISOString(),
        pauseUntil: settings.pauseUntil,
        sites: settings.sites,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "feedblocker-settings.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      showStatus("Exported settings.");
    });

    ui.reset.addEventListener("click", async () => {
      const result = current
        ? await send({ type: "reset-site", siteId: current })
        : await send({ type: "reset-all" });
      if (!result || !result.settings) {
        showStatus("Could not save. Try again.");
        return;
      }
      settings = result.settings;
      render();
      showStatus(
        current
          ? rules[current].name + " reset to defaults."
          : "All element defaults restored."
      );
    });

    ui.importBtn.addEventListener("click", () => ui.importFile.click());

    ui.importFile.addEventListener("change", async () => {
      const file = ui.importFile.files && ui.importFile.files[0];
      ui.importFile.value = "";
      if (!file) return;
      if (file.size > 1000000) {
        showStatus("That file is too large for a settings file.");
        return;
      }

      let payload;
      try {
        payload = JSON.parse(await file.text());
      } catch (error) {
        showStatus("That file is not valid JSON.");
        return;
      }

      const result = await send({ type: "import", payload });
      if (!result || result.error) {
        showStatus("That is not a FeedBlocker settings file.");
        return;
      }

      settings = result.settings;
      for (const id of order) granted[id] = await hasPermission(id);
      render();
      showStatus("Settings imported.");
    });

    ui.report.addEventListener("click", () => {
      const rule = current ? rules[current] : null;
      const title = "Broken element on " + (rule ? rule.name : currentHost || "a site");
      const body = [
        "### Site",
        rule ? rule.name : currentHost || "Unknown",
        "",
        "### Element",
        "(which row in the popup is wrong?)",
        "",
        "### What happens",
        "(for example: the feed is still visible, or something else disappeared)",
        "",
        "### Build",
        "FeedBlocker " + browser.runtime.getManifest().version,
        "Firefox " + navigator.userAgent,
        "URL: " + (tab && tab.url ? tab.url : "(not available)"),
      ].join("\n");

      const url =
        REPO +
        "/issues/new?" +
        new URLSearchParams({ title, body, labels: "broken-element" }).toString();
      browser.tabs.create({ url });
    });

    browser.permissions.onRemoved.addListener(async () => {
      for (const id of order) granted[id] = await hasPermission(id);
      render();
    });
  }

  /* ---------------------------------------------------------------- *
   * Small helpers
   * ---------------------------------------------------------------- */

  function formatTime(timestamp) {
    try {
      return new Date(timestamp).toLocaleString([], {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch (error) {
      return "later";
    }
  }

  function showStatus(text) {
    ui.footStatus.textContent = text;
    ui.footStatus.hidden = false;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      ui.footStatus.hidden = true;
    }, 4000);
  }
})();
