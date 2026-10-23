// Agent Monitor prototype · direction "Paper"
(function () {
  "use strict";

  var THEME_KEY = "am-proto-paper-theme";
  var root = document.documentElement;
  var $ = function (sel, ctx) { return (ctx || document).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };

  // ------------------------------------------------------------ theme
  function storedTheme() {
    try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
  }
  $$(".theme-toggle").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var next = root.dataset.theme === "dark" ? "light" : "dark";
      root.dataset.theme = next;
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* private mode */ }
    });
  });
  var mq = window.matchMedia("(prefers-color-scheme: dark)");
  var onScheme = function (e) {
    var t = storedTheme();
    if (t !== "dark" && t !== "light") root.dataset.theme = e.matches ? "dark" : "light";
  };
  if (mq.addEventListener) mq.addEventListener("change", onScheme);

  // ------------------------------------------------------------ popovers
  var needsBtn = $(".needs-btn");
  var needsMenu = $(".needs-menu");
  var switcher = $(".switcher");

  function setNeeds(open) {
    if (!needsBtn) return;
    needsBtn.setAttribute("aria-expanded", open ? "true" : "false");
    needsMenu.hidden = !open;
  }
  if (needsBtn) {
    needsBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      setNeeds(needsMenu.hidden);
      if (switcher) switcher.open = false;
    });
  }
  document.addEventListener("click", function (e) {
    if (needsMenu && !needsMenu.hidden && !needsMenu.contains(e.target)) setNeeds(false);
    if (switcher && switcher.open && !switcher.contains(e.target)) switcher.open = false;
  });

  // "/" focuses search
  document.addEventListener("keydown", function (e) {
    var tag = (e.target.tagName || "").toLowerCase();
    if (e.key === "/" && tag !== "input" && tag !== "textarea") {
      var s = $(".search input");
      if (s) { e.preventDefault(); s.focus(); }
    }
  });

  // ------------------------------------------------------------ topic panel
  var T = {
    "patch-notes": {
      name: "Patch notes", project: "draftcoach",
      status:
        "<p>Every patch gets a page at <code>/patch/&lt;version&gt;</code> within 24 hours of Riot's release.</p>" +
        "<ul><li>25.20 published Oct 9 (#24 merged)</li>" +
        "<li>25.21 in progress: draft done, copy review by Armin</li>" +
        "<li>Next: generate the Data Dragon diff automatically (an automation, step 7)</li></ul>" +
        "<p><strong>Open:</strong> who writes “what it means for your draft” when Lena is away?</p>",
      tasks: [
        ["Patch 25.21 notes page", "progress", "waiting", "7f3a"],
        ["Patch notes: automate Data Dragon diff", "open"],
        ["Patch 25.20 notes page", "done"]
      ]
    },
    "riot-pipeline": {
      name: "Riot pipeline", project: "draftcoach",
      status: "<p>Match fetch runs every 30 min on the hub; rank enrichment hits 429s at peak (task in progress). Snapshots publish to R2 hourly.</p>",
      tasks: [
        ["Patch 25.21 notes page", "progress", "waiting", "7f3a"],
        ["Rank enrichment: retry on 429", "progress", "working", "c4d0"],
        ["Draft overlay: ban-phase suggestions", "progress", "working", "91aa"],
        ["Champion page: runes by elo bracket", "open"],
        ["Snapshot publish: R2 cache headers", "review"]
      ]
    },
    "desktop-app": {
      name: "Desktop app", project: "draftcoach",
      status: "<p>Tauri rewrite (<code>app-next</code>) replaces the Slint app; beta channel next.</p>",
      tasks: [
        ["Draft overlay: ban-phase suggestions", "progress", "working", "91aa"],
        ["Download page: SmartScreen note", "review", "idle", "e7f2"],
        ["Desktop app: beta update channel", "open"],
        ["Redesign download page", "done"],
        ["Slint app: dark mode", "cancelled"]
      ]
    },
    "pro-archives": {
      name: "Pro archives", project: "draftcoach",
      status: "<p>LCK, LEC, LPL archives through Worlds 2026.</p>",
      tasks: [["Pro archives: add LCK Cup 2026", "open", "stopped", "0b6e"]]
    },
    "auth-login": {
      name: "Auth & login", project: "draftcoach",
      status: "<p>Riot Sign On (RSO) behind the auth proxy; waiting on Riot's production key.</p>",
      tasks: [["Login with Riot account (RSO)", "progress", "waiting", "b21e"]]
    },
    "redesign": {
      name: "Redesign", project: "agentmonitor",
      status:
        "<p>Step 4 of <code>PLAN.md</code>, built as four parallel tasks.</p>" +
        "<ul><li>Task page and comments: comments and history done, editing in place next</li>" +
        "<li>Board, search and topics: waiting on Armin for the search scope</li>" +
        "<li>Task folders: upload and inline preview work, zip download next</li>" +
        "<li>Visual identity prototype: three directions to pick from</li></ul>",
      tasks: [
        ["Board, search and topics", "progress", "waiting", "5d03"],
        ["Task page and comments", "progress", "working", "a8c1"],
        ["Task folders", "progress", "working", "3c9b"],
        ["Visual identity prototype", "progress", "working", "6f10"]
      ]
    },
    "host-sessions": {
      name: "Host sessions", project: "agentmonitor",
      status: "<p>Sessions can run straight on armin-pc instead of in a container, for work that needs the GPU or the desktop app. Idle host sessions stop on their own after 30 minutes (in review).</p>",
      tasks: [["Host sessions: idle stop", "review", "idle", "d2a7"]]
    },
    "hub": {
      name: "Hub", project: "agentmonitor",
      status: "<p>The hub on Hetzner keeps sessions running while armin-pc sleeps. Next: reach it through a Cloudflare Tunnel instead of an open port.</p>",
      tasks: [["Hub on Hetzner: Cloudflare Tunnel", "open"]]
    },
    "automations": {
      name: "Automations", project: "agentmonitor",
      status: "<p>Automations start a session on their own. First trigger: a schedule, so the Data Dragon diff can run every patch day without anyone asking.</p>",
      tasks: [["Automations: schedule trigger", "open"]]
    }
  };
  var COL = { open: "Open", progress: "In progress", review: "In review", done: "Done", cancelled: "Cancelled" };
  var ST = { waiting: "Waiting on you", working: "Working", idle: "Idle", stopped: "Stopped" };
  var SPARK = '<svg class="spark" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2v11.6M2.98 5.1l10.04 5.8M2.98 10.9l10.04-5.8"/></svg>';

  var drawer = $(".drawer");
  var backdrop = $(".drawer-backdrop");
  var lastFocus = null;

  function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;"); }

  function openTopic(key, trigger) {
    var t = T[key];
    if (!t || !drawer) return;
    lastFocus = trigger || document.activeElement;
    drawer.style.setProperty("--c", "var(--t-" + key + ")");
    $(".drawer-project", drawer).textContent = t.project;
    $(".drawer-title", drawer).innerHTML = "<i aria-hidden=\"true\"></i>" + esc(t.name);
    $(".drawer-status", drawer).innerHTML = t.status;
    $(".drawer-count", drawer).textContent = t.tasks.length;
    $(".drawer-count", drawer).className = "drawer-count count";
    $(".drawer-tasks", drawer).innerHTML = t.tasks.map(function (x) {
      var sess = x[2]
        ? '<span class="stamp stamp-xs" data-s="' + x[3] + '"><span class="stamp-glyph">' + SPARK + '</span><span class="stamp-id">' + x[3] + "</span></span>" +
          '<span class="st st-' + x[2] + '"><i class="st-mark" aria-hidden="true"></i>' + ST[x[2]] + "</span>"
        : (x[1] === "done" || x[1] === "cancelled" ? "" : '<span class="no-session">No session</span>');
      return '<li class="' + (x[2] === "waiting" ? "is-waiting" : "") + '"><a href="task.html">' +
        '<span class="dt-title">' + esc(x[0]) + "</span>" +
        '<span class="dt-meta"><span class="colpill col-' + x[1] + '"><i aria-hidden="true"></i>' + COL[x[1]] + "</span>" + sess + "</span>" +
        "</a></li>";
    }).join("");
    drawer.hidden = false;
    backdrop.hidden = false;
    $(".drawer-close", drawer).focus();
  }
  function closeTopic() {
    if (!drawer || drawer.hidden) return;
    drawer.hidden = true;
    backdrop.hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  document.addEventListener("click", function (e) {
    var t = e.target.closest(".topic[data-topic]");
    if (t && !drawer.contains(t)) {
      e.preventDefault();
      e.stopPropagation();
      openTopic(t.dataset.topic, t);
    }
  });
  if (drawer) {
    $(".drawer-close", drawer).addEventListener("click", closeTopic);
    backdrop.addEventListener("click", closeTopic);
  }
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (drawer && !drawer.hidden) { closeTopic(); return; }
    if (needsMenu && !needsMenu.hidden) { setNeeds(false); needsBtn.focus(); }
    if (switcher && switcher.open) switcher.open = false;
  });

  // ------------------------------------------------------------ settings subtabs
  var subtabs = $$(".subtab[data-sub]");
  if (subtabs.length) {
    var show = function (name, push) {
      if (!$('[data-panel="' + name + '"]')) name = "changes";
      subtabs.forEach(function (s) {
        var on = s.dataset.sub === name;
        s.classList.toggle("on", on);
        s.setAttribute("aria-selected", on ? "true" : "false");
      });
      $$(".sub-panel").forEach(function (p) { p.hidden = p.dataset.panel !== name; });
      if (push) history.replaceState(null, "", "#" + name);
    };
    subtabs.forEach(function (s) {
      s.addEventListener("click", function (e) { e.preventDefault(); show(s.dataset.sub, true); });
    });
    show((location.hash || "#changes").slice(1), false);
    window.addEventListener("hashchange", function () { show(location.hash.slice(1), false); });
  }

  // ------------------------------------------------------------ tasks filter
  var filter = $("#task-filter");
  if (filter) {
    var chips = $$(".chip[data-filter]");
    var rows = $$(".tasklist tbody tr");
    var groups = $$(".tl-group");
    var empty = $(".tl-empty");
    var state = "all";
    var q = new URLSearchParams(location.search).get("q");
    if (q) filter.value = q;
    var headerSearch = $(".search input");
    if (q && headerSearch) headerSearch.value = q;

    var apply = function () {
      var needle = filter.value.trim().toLowerCase();
      var shown = 0;
      rows.forEach(function (r) {
        var okText = !needle || r.dataset.title.indexOf(needle) !== -1;
        var okState = state === "all" || (state === "waiting" ? r.dataset.state === "waiting" : r.dataset.col === state);
        r.hidden = !(okText && okState);
        if (!r.hidden) shown++;
      });
      groups.forEach(function (g) {
        var visible = $$("tbody tr", g).filter(function (r) { return !r.hidden; }).length;
        g.hidden = visible === 0;
        var c = $(".section-title .count", g);
        if (c) c.textContent = visible;
      });
      empty.hidden = shown !== 0;
      $(".tl-empty-q", empty).textContent = needle ? "“" + filter.value.trim() + "”" : "these filters";
    };
    filter.addEventListener("input", apply);
    chips.forEach(function (c) {
      c.addEventListener("click", function () {
        state = c.dataset.filter;
        chips.forEach(function (o) { o.setAttribute("aria-pressed", o === c ? "true" : "false"); });
        apply();
      });
    });
    $(".tl-reset").addEventListener("click", function () {
      filter.value = "";
      state = "all";
      chips.forEach(function (o) { o.setAttribute("aria-pressed", o.dataset.filter === "all" ? "true" : "false"); });
      apply();
      filter.focus();
    });
    apply();
  }

  // ------------------------------------------------------------ drop zone feedback
  var dz = $(".dropzone");
  if (dz) {
    ["dragenter", "dragover"].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add("is-over"); });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove("is-over"); });
    });
  }
})();
