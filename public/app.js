/* NCR-OMS dashboard logic — auth guard, live KPIs, manual CSV upload. */
(function () {
  "use strict";

  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  // ---------- auth guard ----------
  var auth = null;
  try {
    auth = JSON.parse(sessionStorage.getItem("ncr_auth") || "null");
  } catch (e) { auth = null; }
  if (!auth || !auth.token) {
    window.location.replace("/login.html");
    return;
  }

  function api(path, options) {
    options = options || {};
    return fetch(path, {
      method: options.method || "GET",
      headers: Object.assign(
        { "Content-Type": "application/json" },
        { Authorization: "Bearer " + auth.token }
      ),
      body: options.body ? JSON.stringify(options.body) : undefined,
    }).then(function (res) {
      if (res.status === 401) {
        sessionStorage.removeItem("ncr_auth");
        window.location.replace("/login.html");
        throw new Error("session expired");
      }
      return res.json().catch(function () { return null; }).then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
    });
  }

  function money(v) {
    var n = Number(v || 0);
    return "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
  }
  function num(v) { return Number(v || 0).toLocaleString("en-IN"); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  $("#tb-role").textContent = auth.role || "OWNER";
  // Company Profile (the authoritative source) now lives on /setup — the
  // topbar here just mirrors the session's cached name, same as the other
  // secondary pages (finance.js, reports.js). Claude (Anthropic) 2026-09-11.
  $("#tb-company").textContent = auth.companyName || "";

  // ---------- live analog clock + date (topbar) — Claude (Anthropic) 2026-09-11 ----------
  // Pure client-side (uses the browser's own local time — no server round-trip),
  // so it keeps ticking even on a slow connection. See BRAIN.md 2026-09-11.
  (function initLiveClock() {
    var svgNS = "http://www.w3.org/2000/svg";
    var ticks = $("#tb-clock-ticks");
    var hourHand = $("#tb-clock-hour");
    var minHand = $("#tb-clock-min");
    var secHand = $("#tb-clock-sec");
    var digital = $("#tb-clock-digital");
    var dateEl = $("#tb-clock-date");
    if (!ticks || !hourHand || !minHand || !secHand || !digital || !dateEl) return;

    // 12 tick marks around the face, drawn once.
    for (var i = 0; i < 12; i++) {
      var angle = i * 30;
      var isMajor = i % 3 === 0; // 12/3/6/9 get a slightly longer tick
      var line = document.createElementNS(svgNS, "line");
      line.setAttribute("x1", "50");
      line.setAttribute("y1", isMajor ? "6" : "8");
      line.setAttribute("x2", "50");
      line.setAttribute("y2", "13");
      line.setAttribute("transform", "rotate(" + angle + " 50 50)");
      if (isMajor) line.style.strokeWidth = "3";
      ticks.appendChild(line);
    }

    function pad(n) { return n < 10 ? "0" + n : String(n); }
    var DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    function tick() {
      var now = new Date();
      var h = now.getHours() % 12;
      var m = now.getMinutes();
      var s = now.getSeconds();

      hourHand.style.transform = "rotate(" + (h * 30 + m * 0.5) + "deg)";
      minHand.style.transform = "rotate(" + (m * 6 + s * 0.1) + "deg)";
      secHand.style.transform = "rotate(" + (s * 6) + "deg)";

      var h12 = now.getHours() % 12 || 12;
      var ampm = now.getHours() < 12 ? "AM" : "PM";
      digital.textContent = pad(h12) + ":" + pad(m) + ":" + pad(s) + " " + ampm;
      dateEl.textContent = DOW[now.getDay()] + ", " + now.getDate() + " " + MON[now.getMonth()] + " " + now.getFullYear();
    }
    tick();
    setInterval(tick, 1000);
  })();

  $("#logout-btn").addEventListener("click", function () {
    sessionStorage.removeItem("ncr_auth");
    window.location.href = "/login.html";
  });

  // ---------- state ----------
  var summary = null;
  var selectedFile = null;

  // ---------- file input + drag & drop ----------
  var dropzone = $("#dropzone");
  var fileInput = $("#up-file");
  fileInput.addEventListener("change", function () {
    if (fileInput.files.length) setFile(fileInput.files[0]);
  });
  ["dragenter", "dragover"].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) {
      e.preventDefault();
      dropzone.classList.add("drag");
    });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) {
      e.preventDefault();
      dropzone.classList.remove("drag");
    });
  });
  dropzone.addEventListener("drop", function (e) {
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) setFile(f);
  });
  function setFile(f) {
    if (!/\.csv$/i.test(f.name)) {
      showResult("err", "Only .csv files are accepted.");
      return;
    }
    selectedFile = f;
    $("#dz-name").textContent = f.name + " (" + (f.size / 1024).toFixed(1) + " KB)";
  }

  // ---------- upload ----------
  var upForm = $("#upload-form");
  upForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var resultBox = $("#upload-result");
    resultBox.hidden = true;

    var accountId = Number($("#up-account").value);
    var warehouseId = Number($("#up-warehouse").value);
    if (!accountId) { showResult("err", "Pick a seller account first — create one under your brand if the list is empty."); return; }
    if (!warehouseId) { showResult("err", "Pick a warehouse."); return; }
    if (!selectedFile) { showResult("err", "Choose a CSV file to import."); return; }

    var reader = new FileReader();
    reader.onload = function () {
      var btn = $("#up-btn");
      btn.disabled = true;
      btn.classList.add("loading");
      var selAcc = $("#up-account").selectedOptions && $("#up-account").selectedOptions[0];
      var mp = selAcc && selAcc.getAttribute("data-mp") ? selAcc.getAttribute("data-mp").toLowerCase() : "flipkart";
      api("/orders/import/" + mp, {
        method: "POST",
        body: {
          marketplaceAccountId: accountId,
          warehouseId: warehouseId,
          csv: String(reader.result),
        },
      }).then(function (r) {
        btn.disabled = false;
        btn.classList.remove("loading");
        if (!r.ok) {
          showResult("err", (r.data && r.data.error) || "Import failed — try again.");
          return;
        }
        var imported = r.data.imported || 0;
        var failed = r.data.failed || 0;
        var html = "<b class='ok'>" + imported + " order" + (imported === 1 ? "" : "s") + " imported</b>" +
          (failed ? ", <b>" + failed + " failed</b>" : "") + ".";
        var errs = (r.data.results || []).filter(function (x) { return x.error; }).slice(0, 5);
        if (errs.length) {
          html += "<ul>" + errs.map(function (x) {
            return "<li>" + esc(x.order || x.marketplaceOrderId || "row") + ": " + esc(x.error) + "</li>";
          }).join("") + "</ul>";
        }
        showResult(imported > 0 ? "ok" : "err", html);
        loadOrders();
        loadSummary();
      }).catch(function (err) {
        btn.disabled = false;
        btn.classList.remove("loading");
        if (err && err.message !== "session expired") showResult("err", "Network error — try again.");
      });
    };
    reader.readAsText(selectedFile);
  });

  function showResult(kind, html) {
    var box = $("#upload-result");
    box.className = "result " + kind;
    box.innerHTML = html;
    box.hidden = false;
  }

  // ---------- summary ----------
  function loadSummary() {
    api("/dashboard/summary").then(function (r) {
      if (!r.ok || !r.data) return;
      summary = r.data;

      var k = summary.kpis || {};
      $("#kpi-today .kpi-value").textContent = num(k.ordersToday);
      $("#kpi-revenue").textContent = money(k.revenueToday);
      $("#kpi-pending").textContent = num(k.pendingDispatch);
      $("#kpi-returns").textContent = num(k.returnsOpen);
      $("#kpi-total").textContent = num(k.ordersTotal);
      $("#kpi-gmv").textContent = "GMV " + money(k.gmvTotal);

      renderAccounts();
      renderWarehouses();
      renderTrend();
    });
  }

  // ---------- company name in topbar ----------
  // Full Company Profile (edit form, bank accounts, access list, delete) now
  // lives on its own page — see /setup (public/setup.js). The dashboard only
  // needs the display name for the topbar chip, via /dashboard/summary
  // (loadSummary below) — cheaper than a second /companies/me round trip.
  // Split from this file by Claude (Anthropic) 2026-09-11, see BRAIN.md.

  // ---------- selects ----------
  // Seller account IS the selector — its marketplace auto-detected and shown
  // as a badge (user request: "seller account ke according marketplace change
  // ho jane chahiye").
  function fillAccountSelect() {
    var sel = $("#up-account");
    var accounts = ((summary && summary.accounts) || []).filter(function (a) { return a.isActive !== false; });
    sel.innerHTML = accounts.length
      ? accounts.map(function (a) {
          return "<option value=\"" + a.id + "\" data-mp=\"" + esc(a.marketplace) + "\">" +
            esc(a.sellerAccountLabel || a.marketplace + " #" + a.id) + " — " + esc(a.marketplace) +
            (a.brand ? " (" + esc(a.brand) + ")" : "") + "</option>";
        }).join("")
      : "<option value=\"\">No seller account yet — add under Brands &amp; Setup</option>";
    updateMpBadge();
  }

  function updateMpBadge() {
    var sel = $("#up-account");
    var opt = sel.selectedOptions && sel.selectedOptions[0];
    var badge = $("#up-mp-badge");
    if (badge) badge.textContent = opt && opt.getAttribute("data-mp") ? opt.getAttribute("data-mp") : "—";
  }

  function renderAccounts() { fillAccountSelect(); }
  $("#up-account").addEventListener("change", updateMpBadge);

  function renderWarehouses() {
    var sel = $("#up-warehouse");
    var whs = (summary && summary.warehouses) || [];
    sel.innerHTML = whs.map(function (w) {
      return "<option value=\"" + w.id + "\">" + esc(w.name) + (w.isDefault ? " (default)" : "") + "</option>";
    }).join("") || "<option value=\"\">No warehouse</option>";
  }

  // Brand/seller-account management, parties & stock-in now live on their own
  // pages (/setup, /party) — see public/setup.js and public/party.js.
  // Split from this file by Claude (Anthropic) 2026-09-11, see BRAIN.md.

  // ---------- trend ----------
  function renderTrend() {
    var chart = $("#trend-chart");
    var trend = (summary && summary.trend) || [];
    var byDay = {};
    trend.forEach(function (t) { byDay[t.day] = t; });

    var days = [];
    for (var i = 13; i >= 0; i--) {
      var d = new Date();
      d.setDate(d.getDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }
    var counts = days.map(function (day) { return (byDay[day] && byDay[day].count) || 0; });
    var max = Math.max.apply(null, counts.concat([1]));

    chart.innerHTML = days.map(function (day, idx) {
      var h = Math.max(3, Math.round((counts[idx] / max) * 100));
      return "<div class='bar' title='" + day + ": " + counts[idx] + " orders' style='height:" + h + "%;animation-delay:" + (idx * 40) + "ms'></div>";
    }).join("");

    var total14 = counts.reduce(function (a, b) { return a + b; }, 0);
    var rev14 = days.reduce(function (a, day) {
      return a + Number((byDay[day] && byDay[day].revenue) || 0);
    }, 0);
    $("#trend-foot").innerHTML = "<b>" + num(total14) + "</b> orders in 14 days &middot; <b>" + money(rev14) + "</b> revenue";
  }

  // ---------- recent orders ----------
  function loadOrders() {
    api("/orders").then(function (r) {
      if (!r.ok || !Array.isArray(r.data)) return;
      var rows = r.data.slice(0, 20);
      var accounts = (summary && summary.accounts) || [];
      var accMap = {};
      accounts.forEach(function (a) { accMap[a.id] = a.marketplace; });

      var tb = $("#orders-table tbody");
      $("#orders-empty").style.display = rows.length ? "none" : "block";
      tb.innerHTML = rows.map(function (o) {
        var dt = o.orderedAt ? new Date(o.orderedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";
        return "<tr>" +
          "<td><b>" + esc(o.marketplaceOrderId) + "</b></td>" +
          "<td>" + esc(accMap[o.marketplaceAccountId] || "—") + "</td>" +
          "<td><span class='status st-" + esc(o.status) + "'>" + esc(o.status.replace(/_/g, " ")) + "</span></td>" +
          "<td>—</td>" +
          "<td>" + dt + "</td></tr>";
      }).join("");
    });
  }

  // Single Entry (manual order/return) and Team & Permissions now live on
  // their own pages (/entry, /team) — see public/entry.js and public/team.js.
  // Split from this file by Claude (Anthropic) 2026-09-11, see BRAIN.md.

  // ---------- boot ----------
  loadSummary();
  loadOrders();
})();
