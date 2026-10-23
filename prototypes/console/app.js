/* Agent Monitor prototype — direction "Console". Plain JS, no dependencies. */
(function () {
  "use strict";

  var THEME_KEY = "am-proto-console-theme";
  var root = document.documentElement;

  /* ---------------- Theme ---------------- */
  function storedTheme() {
    try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
  }
  var media = window.matchMedia("(prefers-color-scheme: light)");
  media.addEventListener("change", function (e) {
    if (!storedTheme()) root.setAttribute("data-theme", e.matches ? "light" : "dark");
  });
  document.querySelectorAll(".theme-toggle").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* private mode: session-only */ }
    });
  });

  /* ---------------- Dropdowns (project switcher, waiting on you) ---------------- */
  var dropdowns = Array.prototype.slice.call(document.querySelectorAll("[data-dd]"));
  function closeDropdowns(except) {
    dropdowns.forEach(function (dd) {
      if (dd === except) return;
      dd.classList.remove("is-open");
      var b = dd.querySelector(".dd-btn");
      if (b) b.setAttribute("aria-expanded", "false");
    });
  }
  dropdowns.forEach(function (dd) {
    var btn = dd.querySelector(".dd-btn");
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var open = !dd.classList.contains("is-open");
      closeDropdowns(dd);
      dd.classList.toggle("is-open", open);
      btn.setAttribute("aria-expanded", String(open));
    });
  });
  document.addEventListener("click", function (e) {
    if (!e.target.closest("[data-dd]")) closeDropdowns();
  });

  /* ---------------- Topic panel ---------------- */
  var T = {
    patch: {
      name: "Patch notes", project: "draftcoach",
      status:
        "<p>Every patch gets a page at <code>/patch/&lt;version&gt;</code> within 24 hours of Riot’s release.</p>" +
        "<ul><li>25.20 published Oct 9 (#24 merged)</li>" +
        "<li>25.21 in progress: draft done, copy review by Armin</li>" +
        "<li>Next: generate the Data Dragon diff automatically (an automation, step 7)</li></ul>" +
        "<p><strong>Open:</strong> who writes “what it means for your draft” when Lena is away?</p>",
      updated: "Armin · Oct 22",
      tasks: [
        ["Patch 25.21 notes page", "progress", "needs", "7f3a"],
        ["Patch notes: automate Data Dragon diff", "open"],
        ["Patch 25.20 notes page", "done"]
      ]
    },
    riot: {
      name: "Riot pipeline", project: "draftcoach",
      status: "<p>Match fetch runs every 30 min on the hub; rank enrichment hits 429s at peak (task in progress). Snapshots publish to R2 hourly.</p>",
      updated: "Lena Hofmann · Oct 22",
      tasks: [
        ["Patch 25.21 notes page", "progress", "needs", "7f3a"],
        ["Rank enrichment: retry on 429", "progress", "working", "c4d0"],
        ["Draft overlay: ban-phase suggestions", "progress", "working", "91aa"],
        ["Champion page: runes by elo bracket", "open"],
        ["Snapshot publish: R2 cache headers", "review"]
      ]
    },
    desk: {
      name: "Desktop app", project: "draftcoach",
      status: "<p>Tauri rewrite (<code>app-next</code>) replaces the Slint app; beta channel next.</p>",
      updated: "Armin · Oct 21",
      tasks: [
        ["Draft overlay: ban-phase suggestions", "progress", "working", "91aa"],
        ["Download page: SmartScreen note", "review", "idle", "e7f2"],
        ["Desktop app: beta update channel", "open"],
        ["Redesign download page", "done"],
        ["Slint app: dark mode", "cancelled"]
      ]
    },
    pro: {
      name: "Pro archives", project: "draftcoach",
      status: "<p>LCK, LEC, LPL archives through Worlds 2026.</p>",
      updated: "Armin · Oct 18",
      tasks: [["Pro archives: add LCK Cup 2026", "open", "stopped", "0b6e"]]
    },
    auth: {
      name: "Auth & login", project: "draftcoach",
      status: "<p>Riot Sign On (RSO) behind the auth proxy; waiting on Riot’s production key.</p>",
      updated: "Lena Hofmann · Oct 20",
      tasks: [["Login with Riot account (RSO)", "progress", "needs", "b21e"]]
    },
    redesign: {
      name: "Redesign", project: "agentmonitor",
      status:
        "<p>Step 4 of <code>PLAN.md</code>, built as four parallel tasks.</p>" +
        "<ul><li>Task page and comments: comments and history done, editing in place next</li>" +
        "<li>Board, search and topics: waiting on Armin for the search scope</li>" +
        "<li>Task folders: upload and inline preview work, zip download next</li>" +
        "<li>Visual identity prototype: three directions to pick from</li></ul>",
      updated: "Armin · Oct 23",
      tasks: [
        ["Board, search and topics", "progress", "needs", "5d03"],
        ["Task page and comments", "progress", "working", "a8c1"],
        ["Task folders", "progress", "working", "3c9b"],
        ["Visual identity prototype", "progress", "working", "6f10"]
      ]
    },
    host: {
      name: "Host sessions", project: "agentmonitor",
      status: "<p>Sessions can run straight on armin-pc without a container. Idle ones stop on their own after 30 minutes; that change is in review.</p>",
      updated: "Armin · Oct 22",
      tasks: [["Host sessions: idle stop", "review", "idle", "d2a7"]]
    },
    hub: {
      name: "Hub", project: "agentmonitor",
      status: "<p>The hub on Hetzner runs sessions next to the Riot pipeline. A Cloudflare Tunnel replaces the open port next.</p>",
      updated: "Armin · Oct 19",
      tasks: [["Hub on Hetzner: Cloudflare Tunnel", "open"]]
    },
    auto: {
      name: "Automations", project: "agentmonitor",
      status: "<p>Triggers that start a session without anyone at the keyboard: a schedule first, Riot’s patch release after that (step 7).</p>",
      updated: "Armin · Oct 17",
      tasks: [["Automations: schedule trigger", "open"]]
    }
  };
  var SESS = {
    "7f3a": "#12b886", b21e: "#f59f00", c4d0: "#4dabf7", "91aa": "#cc5de8", e7f2: "#ff8787",
    "0b6e": "#909296", "5d03": "#f783ac", a8c1: "#fcc419", "3c9b": "#748ffc", "6f10": "#ff6b6b", d2a7: "#22b8cf"
  };
  var TS_LABEL = { open: "Open", progress: "In progress", review: "In review", done: "Done", cancelled: "Cancelled" };
  var TS_SVG = {
    open: '<rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.3"/>',
    progress: '<rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="1.5" y="1.5" width="4.5" height="9" fill="currentColor"/>',
    review: '<rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="1.5" y="1.5" width="9" height="6" fill="currentColor"/>',
    done: '<rect x="1" y="1" width="10" height="10" fill="currentColor"/><path d="M3.3 6.2 5.2 8 8.8 4" fill="none" stroke="var(--bg)" stroke-width="1.5"/>',
    cancelled: '<rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3.5 8.5l5-5" stroke="currentColor" stroke-width="1.3"/>'
  };
  var BOT = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0.5 9.6 6.4 15.5 8 9.6 9.6 8 15.5 6.4 9.6 0.5 8 6.4 6.4Z"/></svg>';
  var ST = {
    needs: '<span class="st st-needs"><i class="cur" aria-hidden="true"></i>Needs you</span>',
    working: '<span class="st st-working"><i class="pulse"></i>Working<i class="scan"></i></span>',
    idle: '<span class="st st-idle"><i class="dot"></i>Idle</span>',
    stopped: '<span class="st st-stopped"><i class="dot"></i>Stopped</span>'
  };

  function taskRow(t) {
    var title = t[0], state = t[1], sess = t[2], sid = t[3];
    var right = sess
      ? '<span class="agent"><span class="hex" style="--sc:' + SESS[sid] + '">' + BOT + '</span><span class="sid">' + sid + "</span></span>" + ST[sess]
      : '<span class="st st-none">' + (state === "done" || state === "cancelled" ? "closed" : "no session") + "</span>";
    return '<li' + (sess === "needs" ? ' class="is-needs"' : "") + '><a href="task.html">' +
      '<span class="tt">' + title + "</span>" +
      '<span class="tr"><span class="ts ts-' + state + '"><svg viewBox="0 0 12 12" aria-hidden="true">' + TS_SVG[state] + "</svg>" + TS_LABEL[state] + "</span>" +
      '<span class="dim">·</span>' + right + "</span></a></li>";
  }

  var panelRoot = document.createElement("div");
  panelRoot.innerHTML =
    '<div class="tp-backdrop" data-tp-close></div>' +
    '<aside class="tp-panel" role="dialog" aria-modal="true" aria-labelledby="tp-title" aria-hidden="true">' +
    '<div class="tp-h"><span class="label">Topic</span><span class="proj-tag" id="tp-proj"></span>' +
    '<button type="button" class="icon-btn tp-close" data-tp-close aria-label="Close topic panel">' +
    '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg></button></div>' +
    '<div class="tp-body"><div class="tp-name" id="tp-name"></div>' +
    '<div class="tp-sec"><div class="label">Status<a class="edit" href="#" data-noop>Edit</a></div><div class="prose tp-status" id="tp-status"></div></div>' +
    '<div class="tp-sec"><div class="label">Linked tasks <span class="dim" id="tp-count"></span></div><ul class="tp-tasks" id="tp-tasks"></ul></div></div>' +
    '<div class="tp-f"><span id="tp-updated"></span><span class="sp"></span><span><kbd>esc</kbd> close</span></div>' +
    "</aside>";
  document.body.appendChild(panelRoot);
  var panel = panelRoot.querySelector(".tp-panel");
  var lastFocus = null;

  function openTopic(key) {
    var t = T[key];
    if (!t) return;
    closeDropdowns();
    document.getElementById("tp-proj").textContent = "· " + t.project;
    document.getElementById("tp-name").innerHTML =
      '<span class="topic topic-lg tp-' + key + '" id="tp-title">' + t.name + "</span>";
    document.getElementById("tp-status").innerHTML = t.status;
    document.getElementById("tp-count").textContent = t.tasks.length;
    document.getElementById("tp-tasks").innerHTML = t.tasks.map(taskRow).join("");
    document.getElementById("tp-updated").textContent = "Status updated by " + t.updated;
    lastFocus = document.activeElement;
    root.classList.add("tp-open");
    panel.setAttribute("aria-hidden", "false");
    panel.querySelector(".tp-close").focus();
  }
  function closeTopic() {
    if (!root.classList.contains("tp-open")) return false;
    root.classList.remove("tp-open");
    panel.setAttribute("aria-hidden", "true");
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    return true;
  }
  document.addEventListener("click", function (e) {
    var tp = e.target.closest("[data-topic]");
    if (tp) { e.preventDefault(); e.stopPropagation(); openTopic(tp.getAttribute("data-topic")); return; }
    if (e.target.closest("[data-tp-close]")) closeTopic();
    if (e.target.closest("[data-noop]")) e.preventDefault();
  });

  /* ---------------- Keyboard: / search, g b board, g t tasks, Esc ---------------- */
  var pendingG = 0;
  function typing(el) {
    return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
  }
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (closeTopic()) return;
      closeDropdowns();
      if (typing(document.activeElement)) document.activeElement.blur();
      return;
    }
    if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "/") {
      e.preventDefault();
      var s = document.getElementById("task-q") || document.querySelector(".search input");
      if (s) { s.focus(); s.select(); }
      return;
    }
    if (e.key === "g") { pendingG = Date.now(); return; }
    if (pendingG && Date.now() - pendingG < 1200) {
      pendingG = 0;
      if (e.key === "b") location.href = document.body.getAttribute("data-board") || "index.html";
      if (e.key === "t") location.href = "tasks.html";
    }
  });

  /* ---------------- Copy branch ---------------- */
  document.querySelectorAll("[data-copy]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var done = function () {
        var tag = document.createElement("span");
        tag.className = "copied";
        tag.textContent = "copied";
        btn.replaceWith(tag);
        setTimeout(function () { tag.replaceWith(btn); }, 1400);
      };
      if (navigator.clipboard) navigator.clipboard.writeText(btn.getAttribute("data-copy")).then(done, done);
      else done();
    });
  });

  /* ---------------- Editable title: Enter commits ---------------- */
  document.querySelectorAll(".t-title-edit [contenteditable]").forEach(function (el) {
    el.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); el.blur(); }
    });
  });

  /* ---------------- Comment composer ---------------- */
  var composer = document.getElementById("composer");
  var commentBtn = document.getElementById("comment-btn");
  if (composer && commentBtn) {
    composer.addEventListener("input", function () { commentBtn.disabled = !composer.value.trim(); });
  }

  /* ---------------- Folder drop zone ---------------- */
  var dz = document.getElementById("dropzone");
  if (dz) {
    ["dragenter", "dragover"].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add("is-over"); });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove("is-over"); });
    });
  }

  /* ---------------- Settings subtabs ---------------- */
  var subs = document.querySelectorAll("[data-sub]");
  if (subs.length) {
    var show = function (key) {
      if (!document.querySelector('[data-panel="' + key + '"]')) key = "changes";
      subs.forEach(function (s) {
        var on = s.getAttribute("data-sub") === key;
        s.classList.toggle("is-active", on);
        s.setAttribute("aria-selected", String(on));
      });
      document.querySelectorAll("[data-panel]").forEach(function (p) {
        p.classList.toggle("is-active", p.getAttribute("data-panel") === key);
      });
    };
    subs.forEach(function (s) {
      s.addEventListener("click", function (e) {
        e.preventDefault();
        var key = s.getAttribute("data-sub");
        history.replaceState(null, "", "#" + key);
        show(key);
      });
    });
    window.addEventListener("hashchange", function () { show(location.hash.slice(1)); });
    show(location.hash.slice(1) || "changes");
  }

  /* ---------------- Tasks list filtering ---------------- */
  var q = document.getElementById("task-q");
  var table = document.getElementById("task-table");
  if (q && table) {
    var rows = Array.prototype.slice.call(table.tBodies[0].rows);
    var chips = document.querySelectorAll(".chip");
    var empty = document.getElementById("task-empty");
    var shown = document.getElementById("shown");
    var filter = "all";
    var apply = function () {
      var term = q.value.trim().toLowerCase();
      var n = 0;
      rows.forEach(function (r) {
        var okState = filter === "all" ||
          (filter === "needs" ? r.getAttribute("data-needs") === "1" : r.getAttribute("data-state") === filter);
        var ok = okState && (!term || r.getAttribute("data-title").indexOf(term) !== -1);
        r.hidden = !ok;
        if (ok) n++;
      });
      shown.textContent = n;
      empty.hidden = n !== 0;
      table.hidden = n === 0;
      document.getElementById("task-empty-q").textContent = term ? "“" + q.value.trim() + "”" : "this filter";
    };
    chips.forEach(function (c) {
      c.addEventListener("click", function () {
        filter = c.getAttribute("data-f");
        chips.forEach(function (o) {
          o.classList.toggle("is-on", o === c);
          o.setAttribute("aria-pressed", String(o === c));
        });
        apply();
      });
    });
    q.addEventListener("input", apply);
    document.getElementById("task-clear").addEventListener("click", function () {
      q.value = "";
      chips[0].click();
    });
    var initial = new URLSearchParams(location.search).get("q");
    if (initial) {
      q.value = initial;
      var hdrInput = document.querySelector(".search input[name=q]");
      if (hdrInput) hdrInput.value = initial;
    }
    apply();
  }
})();
