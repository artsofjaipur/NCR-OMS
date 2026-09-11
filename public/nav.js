/* NCR-OMS — shared left sidebar + virtual assistant widget.
 * Injected on every authed page. Reads sessionStorage.ncr_auth (token +
 * permissions) and renders only the sections the user may access.
 */
(function () {
  "use strict";

  var auth = null;
  try { auth = JSON.parse(sessionStorage.getItem("ncr_auth") || "null"); } catch (e) { auth = null; }
  if (!auth || !auth.token) return; // unauth pages stay untouched

  var perms = Array.isArray(auth.permissions) ? auth.permissions : [];
  function can(sec) {
    if (auth.role === "OWNER" || auth.role === "ADMIN") return true;
    if (perms.length === 0) {
      // role defaults mirror the backend ROLE_DEFAULTS
      var defaults = {
        OPS: ["orders", "scan", "inventory", "dispatch", "returns"],
        VIEWER: ["orders", "reports"],
      }[auth.role] || ["orders", "reports"];
      return defaults.indexOf(sec) !== -1;
    }
    return perms.indexOf(sec) !== -1;
  }

  /* ---------------- links ---------------- */
  // inPage: scroll target inside /app instead of a separate URL.
  var LINKS = [
    { sec: "orders", ico: "🧾", label: "Orders", href: "/app", inPage: "kpi-today" },
    { sec: "scan", ico: "📦", label: "Scan Station", href: "/scan" },
    { sec: "inventory", ico: "📚", label: "Inventory", href: "/reports", inPageNav: "reports", tab: "fees" },
    { sec: "reports", ico: "📊", label: "Reports", href: "/reports", inPageNav: "reports" },
    { sec: "finance", ico: "💰", label: "Finance", href: "/finance", inPageNav: "finance" },
    { sec: "returns", ico: "↩️", label: "Returns", href: "/scan" },
    { sec: "setup", ico: "⚙️", label: "Company & Setup", href: "/app", inPage: "setup-box" },
    { sec: "setup", ico: "🤝", label: "Party Master", href: "/app", inPage: "sup-name" },
    { sec: "orders", ico: "✍️", label: "Single Entry", href: "/app", inPage: "upload-form" },
    { sec: "team", ico: "👥", label: "Team & Roles", href: "/app", inPage: "team-panel" },
  ];

  /* ---------------- sidebar ---------------- */
  var current = { "/app": "orders", "/scan": "scan", "/finance": "finance", "/reports": "reports" }[location.pathname] || "";

  var side = document.createElement("aside");
  side.className = "nav-side";
  var html =
    '<div class="nav-brand">' +
    '<img src="/brand/vardhamiti.svg" alt="" />' +
    '<span class="n-name">NCR<b>·</b>OMS</span>' +
    "</div>" +
    '<div class="nav-sec">Operations</div><ul class="nav-list">';
  LINKS.forEach(function (l) {
    if (!can(l.sec)) return;
    var active = l.href === location.pathname && (!l.inPage || current === "orders");
    html +=
      '<li class="nav-item"><a class="nav-link' + (active ? " active" : "") + '" href="' + l.href + '" data-inpage="' + (l.inPage || "") + '" data-tab="' + (l.tab || "") + '">' +
      '<span class="n-ico">' + l.ico + "</span>" + l.label + "</a></li>";
  });
  html += "</ul>";

  var initials = (auth.displayName || auth.email || "?").trim().split(/\s+/).map(function (w) { return w[0]; }).join("").slice(0, 2).toUpperCase();
  html +=
    '<div class="nav-profile"><div class="np-row">' +
    '<span class="np-avatar">' + initials + "</span>" +
    '<span><span class="np-name">' + (auth.displayName || auth.email || "") + "</span><br/>" +
    '<span class="np-role">' + auth.role + "</span></span></div>" +
    (auth.companyName ? '<div class="np-company">' + auth.companyName + "</div>" : "") +
    // Populated after mount from GET /auth/my-companies — hidden until there's
    // more than one company to switch between, so a single-company workspace
    // sees no change. "Baar baar login" gap: see BRAIN.md 2026-09-11.
    '<select class="np-switch" id="np-switch" hidden></select>' +
    (auth.role === "OWNER" ? '<button type="button" class="np-add-company" id="np-add-company">+ Add Company</button>' : "") +
    '<div class="np-actions"><a href="/app">Dashboard</a><button type="button" id="nav-logout">Logout</button></div>' +
    "</div>";
  side.innerHTML = html;
  document.body.classList.add("has-nav");
  document.body.insertBefore(side, document.body.firstChild);

  var burger = document.createElement("button");
  burger.type = "button";
  burger.className = "nav-burger";
  burger.innerHTML = "☰";
  burger.addEventListener("click", function () { document.body.classList.toggle("nav-open"); });
  document.body.appendChild(burger);

  document.getElementById("nav-logout").addEventListener("click", function () {
    sessionStorage.removeItem("ncr_auth");
    window.location.href = "/login.html";
  });

  /* ---------------- workspace (company) switcher ---------------- */
  // Merges a switch/add-company response into the stored session and
  // reloads — every panel on the page refetches for the new company rather
  // than trying to patch itself in place.
  function applySwitchedAuth(data) {
    var next = Object.assign({}, auth, {
      token: data.token,
      companyId: data.companyId,
      role: data.role || auth.role,
      displayName: data.displayName || auth.displayName,
      companyName: data.companyName,
      permissions: data.permissions || [],
    });
    sessionStorage.setItem("ncr_auth", JSON.stringify(next));
    window.location.reload();
  }

  var switchSel = document.getElementById("np-switch");
  api("/auth/my-companies").then(function (r) {
    if (!r || !r.ok || !Array.isArray(r.data) || r.data.length < 2) return; // nothing to switch between
    switchSel.innerHTML = r.data
      .map(function (c) { return '<option value="' + c.companyId + '"' + (c.current ? " selected" : "") + ">" + c.companyName + " (" + c.role + ")</option>"; })
      .join("");
    switchSel.hidden = false;
  }).catch(function () {});

  switchSel.addEventListener("change", function () {
    var companyId = Number(switchSel.value);
    if (!companyId || companyId === auth.companyId) return;
    switchSel.disabled = true;
    api("/auth/switch-company", { method: "POST", body: { companyId: companyId } }).then(function (r) {
      if (r && r.ok && r.data) {
        applySwitchedAuth(r.data);
      } else {
        switchSel.disabled = false;
        alert((r && r.data && r.data.error) || "Company switch nahi ho paya — dobara try karein.");
      }
    }).catch(function () {
      switchSel.disabled = false;
      alert("Network issue — dobara try karein.");
    });
  });

  var addBtn = document.getElementById("np-add-company");
  if (addBtn) {
    addBtn.addEventListener("click", function () {
      var name = window.prompt("Nayi company ka legal name likhein (jaise \"Rugara Pvt Ltd\"):");
      if (!name || !name.trim()) return;
      addBtn.disabled = true;
      api("/companies", { method: "POST", body: { legalName: name.trim() } }).then(function (r) {
        if (r && r.ok && r.data) {
          applySwitchedAuth(r.data);
        } else {
          addBtn.disabled = false;
          alert((r && r.data && r.data.error) || "Company add nahi ho payi — dobara try karein.");
        }
      }).catch(function () {
        addBtn.disabled = false;
        alert("Network issue — dobara try karein.");
      });
    });
  }

  // in-page deep links: open the target panel/section on /app
  side.querySelectorAll(".nav-link[data-inpage]").forEach(function (a) {
    a.addEventListener("click", function (e) {
      var target = a.getAttribute("data-inpage");
      var tab = a.getAttribute("data-tab");
      if (!target || location.pathname !== "/app") return; // normal nav from other pages
      e.preventDefault();
      var el = document.getElementById(target);
      if (el) {
        if (target === "team-panel") el.hidden = false;
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        if (el.tagName === "DETAILS") el.open = true;
      }
      if (tab && typeof window.reportsGoTab === "function") window.reportsGoTab(tab);
      document.body.classList.remove("nav-open");
    });
  });

  /* ---------------- assistant widget ---------------- */
  var panel = document.createElement("div");
  panel.className = "asst-panel";
  panel.hidden = true;
  panel.innerHTML =
    '<div class="asst-head"><span class="ah-ico">🤖</span>' +
    '<div><div class="ah-title">OMS Assistant</div><div class="ah-sub">Hinglish me poocho — live data se jawab</div></div>' +
    '<button type="button" id="asst-close">✕</button></div>' +
    '<div class="asst-alerts" id="asst-alerts"></div>' +
    '<div class="asst-chat" id="asst-chat"><div class="asst-msg bot">Namaste! Main tumhara OMS assistant hoon. 👋\nNeeche quick chips ya seedha poocho: "aaj kitne order aaye?"</div></div>' +
    '<div class="asst-chips" id="asst-chips"></div>' +
    '<div class="asst-input"><input id="asst-q" type="text" placeholder="e.g. pending dispatch kitna?" /><button type="button" id="asst-send">➤</button></div>';

  var fab = document.createElement("button");
  fab.type = "button";
  fab.className = "asst-fab";
  fab.innerHTML = '🤖<span class="a-dot" id="asst-dot"></span>';
  document.body.appendChild(fab);
  document.body.appendChild(panel);

  function api(path, options) {
    options = options || {};
    return fetch(path, {
      method: options.method || "GET",
      headers: Object.assign({ "Content-Type": "application/json" }, { Authorization: "Bearer " + auth.token }),
      body: options.body ? JSON.stringify(options.body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
    });
  }

  var chat = panel.querySelector("#asst-chat");
  function push(text, who) {
    var m = document.createElement("div");
    m.className = "asst-msg " + who;
    m.textContent = text;
    chat.appendChild(m);
    chat.scrollTop = chat.scrollHeight;
  }

  function ask(q) {
    push(q, "user");
    api("/assistant/query", { method: "POST", body: { question: q } }).then(function (r) {
      push((r && r.data && r.data.answer) || "Server se jawab nahi aaya — thodi der baad try karo.", "bot");
    }).catch(function () { push("Network issue — dobara try karo.", "bot"); });
  }

  panel.querySelector("#asst-send").addEventListener("click", function () {
    var inp = panel.querySelector("#asst-q");
    var v = inp.value.trim();
    if (!v) return;
    inp.value = "";
    ask(v);
  });
  panel.querySelector("#asst-q").addEventListener("keydown", function (e) {
    if (e.key === "Enter") panel.querySelector("#asst-send").click();
  });
  panel.querySelector("#asst-close").addEventListener("click", function () { panel.hidden = true; });

  fab.addEventListener("click", function () {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      panel.querySelector("#asst-q").focus();
      loadAlerts();
    }
  });

  // quick chips
  var CHIPS = ["aaj ke orders", "pending dispatch", "payout status", "party outstanding", "low stock", "brand-wise sale"];
  var chipBox = panel.querySelector("#asst-chips");
  CHIPS.forEach(function (c) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "asst-chip";
    b.textContent = c;
    b.addEventListener("click", function () { ask(c); });
    chipBox.appendChild(b);
  });

  // alerts: badge on the FAB + banner list inside the panel
  function loadAlerts() {
    api("/assistant/alerts").then(function (r) {
      if (!r || !r.ok || !r.data) return;
      var box = panel.querySelector("#asst-alerts");
      var icons = { dispatch: "📦", payout: "💸", returns: "↩️", stock: "📉" };
      box.innerHTML = (r.data.alerts || []).map(function (a) {
        return '<div class="asst-alert"><span class="al-ico">' + (icons[a.type] || "•") + "</span><span>" + a.message + "</span></div>";
      }).join("");
      var dot = fab.querySelector("#asst-dot");
      if (r.data.count > 0) {
        dot.textContent = String(r.data.count);
        dot.style.display = "inline-flex";
      } else {
        dot.style.display = "none";
      }
    }).catch(function () {});
  }
  loadAlerts();
  setInterval(loadAlerts, 60000); // har minute refresh — "alert deta rahega"
})();
