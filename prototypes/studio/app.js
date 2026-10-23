/* Agent Monitor — Studio prototype behaviour (no framework, no build). */
(function () {
  "use strict";

  var THEME_KEY = "am-proto-studio-theme";
  var root = document.documentElement;
  var media = window.matchMedia("(prefers-color-scheme: dark)");

  function storedTheme() {
    try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
  }

  /* ───────── theme ───────── */
  var toggle = document.querySelector(".theme-toggle");
  function syncToggle() {
    if (!toggle) return;
    var dark = root.getAttribute("data-theme") === "dark";
    toggle.setAttribute("aria-pressed", String(dark));
    toggle.title = dark ? "Switch to light" : "Switch to dark";
  }
  if (toggle) {
    toggle.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* private mode */ }
      syncToggle();
    });
  }
  media.addEventListener("change", function (e) {
    var t = storedTheme();
    if (t !== "dark" && t !== "light") {
      root.setAttribute("data-theme", e.matches ? "dark" : "light");
      syncToggle();
    }
  });
  syncToggle();

  /* ───────── toast ───────── */
  var toastEl, toastTimer;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "toast";
      toastEl.setAttribute("role", "status");
      document.body.appendChild(toastEl);
    }
    toastEl.innerHTML = '<span class="agent" style="--s:#7048e8"><span class="agent-av"></span></span><span></span>';
    toastEl.lastChild.textContent = msg;
    requestAnimationFrame(function () { toastEl.classList.add("show"); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 2600);
  }
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-toast]");
    if (t) { e.preventDefault(); toast(t.getAttribute("data-toast")); }
  });

  /* ───────── waiting-on-you dropdown ───────── */
  var wBtn = document.querySelector(".waiting-btn");
  var wMenu = document.getElementById("waiting-menu");
  function setWaiting(open) {
    if (!wBtn || !wMenu) return;
    wBtn.setAttribute("aria-expanded", String(open));
    wMenu.hidden = !open;
  }
  if (wBtn) {
    wBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      setWaiting(wMenu.hidden);
      if (!wMenu.hidden) { var first = wMenu.querySelector("a"); if (first) first.focus({ preventScroll: true }); }
    });
  }

  /* project switcher (details) closes on outside click */
  var switcher = document.querySelector(".switcher");
  document.addEventListener("click", function (e) {
    if (wMenu && !wMenu.hidden && !e.target.closest(".waiting-wrap")) setWaiting(false);
    if (switcher && switcher.open && !e.target.closest(".switcher")) switcher.open = false;
  });

  /* ───────── header search: "/" focuses, submit goes to tasks.html?q= ───────── */
  var headerSearch = document.querySelector(".search input");
  document.addEventListener("keydown", function (e) {
    if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && !document.activeElement.isContentEditable) {
      e.preventDefault();
      var target = document.getElementById("task-search") || headerSearch;
      if (target) target.focus();
    }
  });

  /* ───────── topic panel ───────── */
  var SES = {
    "7f3a": "#0ca678", "b21e": "#f76707", "c4d0": "#4c6ef5", "91aa": "#e64980", "e7f2": "#74b816",
    "0b6e": "#868e96", "5d03": "#1098ad", "a8c1": "#f59f00", "3c9b": "#ae3ec9", "6f10": "#f03e3e", "d2a7": "#1c7ed6"
  };
  var TS = {
    open: ["Open", '<circle cx="12" cy="12" r="8" stroke-dasharray="3.2 3"/>', "ts-open"],
    progress: ["In progress", '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>', "ts-progress"],
    review: ["In review", '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>', "ts-review"],
    done: ["Done", '<circle cx="12" cy="12" r="8.5"/><path d="m8.2 12.3 2.6 2.6 5-5.4"/>', "ts-done"]
  };
  function svg(paths) {
    return '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + "</svg>";
  }
  var BELL = svg('<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 21h4"/>');

  // [title, task state, session id or null, session state]
  var TOPICS = {
    patch: {
      name: "Patch notes", project: "draftcoach", updated: "Armin · Oct 22, 21:10",
      status: '<p>Every patch gets a page at <code>/patch/&lt;version&gt;</code> within 24 hours of Riot\'s release.</p>' +
        "<ul><li>25.20 published Oct 9 (#24 merged)</li><li>25.21 in progress: draft done, copy review by Armin</li>" +
        "<li>Next: generate the Data Dragon diff automatically (an automation, step 7)</li></ul>" +
        '<p><strong>Open:</strong> who writes "what it means for your draft" when Lena is away?</p>',
      tasks: [["Patch 25.21 notes page", "progress", "7f3a", "waiting"], ["Patch notes: automate Data Dragon diff", "open", null], ["Patch 25.20 notes page", "done", null]]
    },
    riot: {
      name: "Riot pipeline", project: "draftcoach", updated: "Lena Hofmann · Oct 22, 17:30",
      status: "<p>Match fetch runs every 30 min on the hub; rank enrichment hits 429s at peak (task in progress). Snapshots publish to R2 hourly.</p>",
      tasks: [["Patch 25.21 notes page", "progress", "7f3a", "waiting"], ["Rank enrichment: retry on 429", "progress", "c4d0", "working"],
        ["Draft overlay: ban-phase suggestions", "progress", "91aa", "working"], ["Champion page: runes by elo bracket", "open", null],
        ["Snapshot publish: R2 cache headers", "review", null]]
    },
    desktop: {
      name: "Desktop app", project: "draftcoach", updated: "Armin · Oct 20, 16:45",
      status: "<p>Tauri rewrite (<code>app-next</code>) replaces the Slint app; beta channel next.</p>",
      tasks: [["Draft overlay: ban-phase suggestions", "progress", "91aa", "working"], ["Download page: SmartScreen note", "review", "e7f2", "idle"],
        ["Desktop app: beta update channel", "open", null], ["Redesign download page", "done", null]]
    },
    pro: {
      name: "Pro archives", project: "draftcoach", updated: "Armin · Oct 18, 11:02",
      status: "<p>LCK, LEC, LPL archives through Worlds 2026.</p>",
      tasks: [["Pro archives: add LCK Cup 2026", "open", "0b6e", "stopped"]]
    },
    auth: {
      name: "Auth & login", project: "draftcoach", updated: "Lena Hofmann · Oct 22, 15:20",
      status: "<p>Riot Sign On (RSO) behind the auth proxy; waiting on Riot's production key.</p>",
      tasks: [["Login with Riot account (RSO)", "progress", "b21e", "waiting"]]
    },
    redesign: {
      name: "Redesign", project: "agentmonitor", updated: "Armin · Oct 23, 08:40",
      status: "<p>Step 4 of <code>PLAN.md</code>, built as four parallel tasks.</p>" +
        "<ul><li>Task page and comments: comments and history done, editing in place next</li>" +
        "<li>Board, search and topics: waiting on Armin for the search scope</li>" +
        "<li>Task folders: upload and inline preview work, zip download next</li>" +
        "<li>Visual identity prototype: three directions to pick from</li></ul>",
      tasks: [["Board, search and topics", "progress", "5d03", "waiting"], ["Task page and comments", "progress", "a8c1", "working"],
        ["Task folders", "progress", "3c9b", "working"], ["Visual identity prototype", "progress", "6f10", "working"]]
    },
    host: {
      name: "Host sessions", project: "agentmonitor", updated: "Armin · Oct 22, 12:15",
      status: "<p>Sessions can run straight on armin-pc, without a container, for jobs that need the GPU or the desktop. Idle host sessions stop on their own after 30 minutes; that change is in review.</p>",
      tasks: [["Host sessions: idle stop", "review", "d2a7", "idle"]]
    },
    hub: {
      name: "Hub", project: "agentmonitor", updated: "Armin · Oct 21, 19:30",
      status: "<p>The hub runs on the Hetzner box and hosts the long-running sessions. Next: reach it through a Cloudflare Tunnel instead of an open port.</p>",
      tasks: [["Hub on Hetzner: Cloudflare Tunnel", "open", null]]
    },
    auto: {
      name: "Automations", project: "agentmonitor", updated: "Armin · Oct 20, 09:00",
      status: "<p>Automations start sessions without anyone clicking. The first trigger is a schedule (cron-style); webhooks come after.</p>",
      tasks: [["Automations: schedule trigger", "open", null]]
    }
  };

  function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;"); }

  function linkedRow(t) {
    var title = t[0], st = TS[t[1]], sid = t[2], ss = t[3];
    var sess;
    if (!sid) sess = '<span class="nosession">no session</span>';
    else {
      var a = '<span class="agent' + (ss === "working" ? " is-working" : ss === "stopped" ? " is-stopped" : "") + '" style="--s:' + SES[sid] + '"><span class="agent-av sm"></span><span class="agent-id">' + sid + "</span></span>";
      var pill = ss === "waiting" ? '<span class="sticker flat">' + BELL + "waiting on you</span>" : '<span class="state s-' + ss + '">' + ss + "</span>";
      sess = a + pill;
    }
    return '<a href="task.html"' + (ss === "waiting" ? ' class="needs"' : "") + '><span class="lt">' + esc(title) + '</span><span class="lm"><span class="tstate ' + st[2] + '">' + svg(st[1]) + st[0] + "</span>" + sess + "</span></a>";
  }

  var scrim, drawer, lastFocus;
  function buildDrawer() {
    scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.hidden = true;
    drawer = document.createElement("aside");
    drawer.className = "drawer";
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("aria-modal", "true");
    drawer.setAttribute("aria-labelledby", "drawer-title");
    drawer.hidden = true;
    document.body.appendChild(scrim);
    document.body.appendChild(drawer);
    scrim.addEventListener("click", closeTopic);
  }
  function openTopic(key, opener) {
    var t = TOPICS[key];
    if (!t) return;
    if (!drawer) buildDrawer();
    lastFocus = opener || document.activeElement;
    drawer.className = "drawer t-" + key;
    drawer.innerHTML =
      '<div class="drawer-head"><div><div class="kicker">Topic · ' + t.project + '</div>' +
      '<h2 id="drawer-title" style="margin:0"><span class="topic lg t-' + key + '">' + esc(t.name) + "</span></h2></div>" +
      '<button type="button" class="drawer-close" aria-label="Close topic panel">' + svg('<path d="M6 6l12 12M18 6 6 18"/>') + "</button></div>" +
      '<div class="drawer-body"><h3>Status<button type="button" class="linkish edit" data-toast="Status opens in the Markdown editor">Edit</button></h3>' +
      '<div class="status-card"><div class="md">' + t.status + '</div><div class="updated">' + svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>') + "Updated by " + t.updated + "</div></div>" +
      "<h3>Linked tasks <span class=\"pill-count\">" + t.tasks.length + '</span></h3><div class="linked">' + t.tasks.map(linkedRow).join("") + "</div></div>";
    drawer.querySelector(".drawer-close").addEventListener("click", closeTopic);
    scrim.hidden = false;
    drawer.hidden = false;
    requestAnimationFrame(function () {
      scrim.classList.add("open");
      drawer.classList.add("open");
    });
    drawer.querySelector(".drawer-close").focus({ preventScroll: true });
  }
  function closeTopic() {
    if (!drawer || drawer.hidden) return;
    scrim.classList.remove("open");
    drawer.classList.remove("open");
    setTimeout(function () { scrim.hidden = true; drawer.hidden = true; }, 260);
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  }
  document.addEventListener("click", function (e) {
    var t = e.target.closest(".topic[data-topic]");
    if (t) { e.preventDefault(); e.stopPropagation(); openTopic(t.getAttribute("data-topic"), t); }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (drawer && !drawer.hidden) closeTopic();
    else if (wMenu && !wMenu.hidden) { setWaiting(false); wBtn.focus(); }
    else if (switcher && switcher.open) switcher.open = false;
  });

  /* ───────── settings subtabs ───────── */
  var subtabs = document.querySelectorAll(".subtab[data-sub]");
  function showSub(name, push) {
    var found = false;
    subtabs.forEach(function (b) {
      var on = b.getAttribute("data-sub") === name;
      if (on) found = true;
      b.setAttribute("aria-selected", String(on));
      document.getElementById("sp-" + b.getAttribute("data-sub")).hidden = !on;
    });
    if (found && push) history.replaceState(null, "", "#" + name);
    return found;
  }
  if (subtabs.length) {
    subtabs.forEach(function (b) {
      b.addEventListener("click", function () { showSub(b.getAttribute("data-sub"), true); });
    });
    var initial = location.hash.slice(1);
    if (initial) showSub(initial, false);
    window.addEventListener("hashchange", function () { showSub(location.hash.slice(1), false); });
  }

  /* ───────── tasks list filtering ───────── */
  var search = document.getElementById("task-search");
  if (search) {
    var rows = Array.prototype.slice.call(document.querySelectorAll(".trow[data-state]"));
    var chips = document.querySelectorAll(".chip[data-filter]");
    var empty = document.getElementById("task-empty");
    var count = document.getElementById("task-count");
    var filter = "all";
    var apply = function () {
      var q = search.value.trim().toLowerCase();
      var shown = 0;
      rows.forEach(function (r) {
        var okState = filter === "all" || (filter === "waiting" ? r.getAttribute("data-waiting") === "1" : r.getAttribute("data-state") === filter);
        var okText = !q || r.getAttribute("data-title").indexOf(q) !== -1;
        var on = okState && okText;
        r.hidden = !on;
        if (on) shown++;
      });
      empty.hidden = shown !== 0;
      count.textContent = "Showing " + shown + " of " + rows.length + " tasks";
    };
    chips.forEach(function (c) {
      c.addEventListener("click", function () {
        filter = c.getAttribute("data-filter");
        chips.forEach(function (o) { o.setAttribute("aria-pressed", String(o === c)); });
        apply();
      });
    });
    search.addEventListener("input", apply);
    var q = new URLSearchParams(location.search).get("q");
    if (q) { search.value = q; if (headerSearch) headerSearch.value = q; }
    apply();
  }

  /* ───────── small affordances ───────── */
  document.querySelectorAll("[data-copy]").forEach(function (b) {
    b.addEventListener("click", function () {
      var v = b.getAttribute("data-copy");
      if (navigator.clipboard) navigator.clipboard.writeText(v).catch(function () {});
      toast("Copied " + v);
    });
  });
  var title = document.querySelector(".title-edit");
  if (title) {
    title.addEventListener("click", function () { toast("Renaming happens right here in the app"); });
    title.addEventListener("keydown", function (e) { if (e.key === "Enter") toast("Renaming happens right here in the app"); });
  }
  var dz = document.getElementById("dropzone");
  if (dz) {
    ["dragenter", "dragover"].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add("over"); }); });
    ["dragleave", "drop"].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove("over"); }); });
    dz.addEventListener("drop", function (e) {
      var n = e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files.length : 0;
      toast(n ? "Uploading " + n + " file" + (n === 1 ? "" : "s") + " to the task folder" : "Drop files to add them");
    });
  }
  document.querySelectorAll(".select").forEach(function (s) {
    s.addEventListener("click", function () { toast("Opens a picker in the app"); });
  });
})();
