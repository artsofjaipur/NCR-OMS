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

  // ---------- SKU auto-match ("sku auto select kare khud samjh ke ki ye
  // isme jayega") — used by the "Map SKU" fix-it modal to guess which
  // internal SKU a marketplace SKU string like "HT-03-Black_XL" really
  // means, instead of making the person scroll/search every time. Pure
  // string comparison, no server round trip needed. ----------
  function skuCompact(s) { return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }
  function skuTokens(s) { return String(s || "").toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean); }
  function levenshtein(a, b) {
    var m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    var prev = [];
    for (var j = 0; j <= n; j++) prev[j] = j;
    for (var i = 1; i <= m; i++) {
      var cur = [i];
      for (var j2 = 1; j2 <= n; j2++) {
        cur[j2] = Math.min(prev[j2] + 1, cur[j2 - 1] + 1, prev[j2 - 1] + (a[i - 1] === b[j2 - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  }
  function tokenJaccard(aTokens, bTokens) {
    if (!aTokens.length || !bTokens.length) return 0;
    var setA = {}; aTokens.forEach(function (t) { setA[t] = 1; });
    var setB = {}; bTokens.forEach(function (t) { setB[t] = 1; });
    var inter = 0;
    Object.keys(setA).forEach(function (t) { if (setB[t]) inter++; });
    var union = Object.keys(setA).length + Object.keys(setB).length - inter;
    return union ? inter / union : 0;
  }
  /** 0..1 — how likely `marketplaceSku` refers to this internal `sku`. */
  function skuMatchScore(marketplaceSku, sku) {
    var mCompact = skuCompact(marketplaceSku);
    var mTokens = skuTokens(marketplaceSku);
    var candidates = [sku.code, sku.productTitle].filter(Boolean);
    var best = 0;
    candidates.forEach(function (c) {
      var cCompact = skuCompact(c);
      if (!cCompact) return;
      if (cCompact === mCompact) { best = 1; return; }
      var lev = 1 - levenshtein(mCompact, cCompact) / Math.max(mCompact.length, cCompact.length, 1);
      var jac = tokenJaccard(mTokens, skuTokens(c));
      var combined = Math.max(lev, jac) * 0.65 + Math.min(lev, jac) * 0.35;
      if (cCompact.indexOf(mCompact) !== -1 || mCompact.indexOf(cCompact) !== -1) combined = Math.max(combined, 0.8);
      if (combined > best) best = combined;
    });
    return best;
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
  var dailySummary = null;
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
        var newCount = r.data.newOrders != null ? r.data.newOrders : imported;
        var dupCount = r.data.duplicateOrders || 0;
        var failed = r.data.failed || 0;
        var stockWarnCount = r.data.stockWarnings || 0;
        var autoMappedCount = r.data.autoMapped || 0;
        var html = "<b class='ok'>" + imported + " order" + (imported === 1 ? "" : "s") + " imported</b>" +
          (failed ? ", <b>" + failed + " failed</b>" : "") + ".";
        // "Imported" used to lump brand-new orders and already-existing ones
        // (re-uploaded/overlapping rows, updated in place — safe, but silent)
        // into one number. User request: "duplicate order ka bhi pata chalna
        // chahiye" — so every duplicate is now called out by name, not just
        // counted.
        if (dupCount) {
          html += "<div style='margin-top:6px;color:var(--muted)'>" + newCount + " new, <b>" + dupCount +
            "</b> already existed in the system — updated (status refreshed), not re-created.</div>";
          var dupRows = (r.data.results || []).filter(function (x) { return x.orderId && x.created === false; }).slice(0, 8);
          if (dupRows.length) {
            html += "<div style='margin-top:4px;font-size:12.5px;color:var(--muted)'>Duplicate order no.(s): " +
              dupRows.map(function (x) { return esc(x.marketplaceOrderId); }).join(", ") +
              (dupCount > dupRows.length ? " …" : "") + "</div>";
          }
        }
        var errs = (r.data.results || []).filter(function (x) { return x.error; }).slice(0, 5);
        if (errs.length) {
          html += "<ul>" + errs.map(function (x) {
            var fixBtn = x.unmappedSku
              ? " <button type='button' class='bm-mini' data-map-sku='" + esc(x.unmappedSku) + "' data-account-id='" + accountId + "'>Map SKU</button>"
              : "";
            return "<li>" + esc(x.order || x.marketplaceOrderId || "row") + ": " + esc(x.error) + fixBtn + "</li>";
          }).join("") + "</ul>";
        }
        // Orders with no recorded stock still import (never blocked on a
        // stock count this app was never told) -- but flagged here so it's
        // not a silent negative number nobody notices.
        if (stockWarnCount) {
          var warnRows = (r.data.results || []).filter(function (x) { return x.stockWarning; }).slice(0, 5);
          html += "<div style='margin-top:8px;color:var(--orange)'>⚠ " + stockWarnCount + " order" + (stockWarnCount === 1 ? "" : "s") +
            " imported with no recorded stock for some SKU(s) — do a Stock In (Party Master page) when you can:</div>" +
            "<ul>" + warnRows.map(function (x) { return "<li>" + esc(x.marketplaceOrderId) + ": " + esc(x.stockWarning) + "</li>"; }).join("") + "</ul>";
        }
        // Unmapped marketplace SKUs no longer block the order at all (user's
        // explicit choice — "bilkul auto, kabhi block hi na ho"): a close
        // match auto-maps, anything else auto-creates a new SKU on the spot.
        // Called out here so it stays reviewable, not a silent catalog change.
        if (autoMappedCount) {
          var autoRows = (r.data.results || []).filter(function (x) { return x.autoMappedSku; }).slice(0, 8);
          html += "<div style='margin-top:8px;color:var(--gold)'>🔎 " + autoMappedCount + " order" + (autoMappedCount === 1 ? "" : "s") +
            " had a marketplace SKU auto-resolved (no manual mapping needed) — review when you can:</div>" +
            "<ul>" + autoRows.map(function (x) { return "<li>" + esc(x.marketplaceOrderId) + ": " + esc(x.autoMappedSku) + "</li>"; }).join("") + "</ul>";
        }
        showResult(imported > 0 ? "ok" : "err", html);
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

  // ---------- fix-it: map an unmapped marketplace SKU straight from the
  // failed-import list, instead of sending the user hunting for a separate
  // SKU-mapping screen. Once mapped, re-uploading the SAME csv is always
  // safe (ingestion is idempotent on marketplaceOrderId — the rows that
  // already imported come back as duplicates and just get their status
  // refreshed, per the duplicate messaging above). ----------
  $("#upload-result").addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("[data-map-sku]");
    if (!btn) return;
    openMapSkuModal(btn.getAttribute("data-map-sku"), Number(btn.getAttribute("data-account-id")));
  });

  function openMapSkuModal(marketplaceSku, accountId) {
    var acct = ((summary && summary.accounts) || []).filter(function (a) { return a.id === accountId; })[0];
    if (!acct || !acct.brandId) { alert("Could not find the brand for this seller account."); return; }

    var m = window.NcrModal.open({
      title: "Map “" + marketplaceSku + "”",
      bodyHtml:
        "<p style='margin:0 0 6px;font-size:13px;color:var(--muted)'>This marketplace SKU has no internal SKU mapping for <b>" +
          esc(acct.sellerAccountLabel || acct.marketplace) + "</b>, so orders using it get rejected.</p>" +
        "<div id='ms-hint' style='margin:0 0 10px;font-size:12px;color:var(--muted)'>Looking for a match…</div>" +
        "<label>Search your SKUs <input id='ms-search' type='text' placeholder='code or title…' autocomplete='off' /></label>" +
        "<div id='ms-list' style='max-height:220px;overflow:auto;display:flex;flex-direction:column;gap:4px;margin:8px 0'>Loading…</div>" +
        "<div class='bm-head' style='margin-top:14px'><b>Or create a new SKU &amp; map it</b></div>" +
        "<label>SKU code <input id='ms-new-code' type='text' value='" + esc(marketplaceSku) + "' /></label>" +
        "<button type='button' class='btn' id='ms-new-btn' style='margin-top:8px'>Create &amp; Map</button>" +
        "<div id='ms-result' class='result' style='margin-top:10px' hidden></div>",
    });

    function msMsg(kind, msg) {
      var box = m.body.querySelector("#ms-result");
      box.className = "result " + kind;
      box.textContent = msg;
      box.hidden = false;
    }

    // "SKU auto select kare khud samjh ke ki ye isme jayega" -- rank every
    // candidate SKU by how likely it is the same product as the marketplace
    // SKU string (see skuMatchScore above), instead of leaving the person to
    // scroll/search a possibly long SKU list every single time.
    var AUTO_THRESHOLD = 0.92; // near/exact match -- confident enough to map without a click
    var SUGGEST_THRESHOLD = 0.45; // still worth highlighting, but needs a confirm click
    var allSkus = [];
    var scored = [];
    function renderList(filterText) {
      var list = m.body.querySelector("#ms-list");
      var f = (filterText || "").trim().toLowerCase();
      var rows = !f ? scored : scored.filter(function (s) {
        return (s.code || "").toLowerCase().indexOf(f) !== -1 || (s.productTitle || "").toLowerCase().indexOf(f) !== -1;
      });
      if (!rows.length) { list.innerHTML = "<span class='empty'>No matching SKU — create one below.</span>"; return; }
      list.innerHTML = rows.slice(0, 100).map(function (s, idx) {
        var suggested = !f && idx === 0 && s._score >= SUGGEST_THRESHOLD;
        return "<button type='button' class='bm-mini' data-sku-id='" + s.id + "'" +
          " style='text-align:left;justify-content:flex-start;flex-direction:column;align-items:flex-start" +
          (suggested ? ";border-color:var(--gold2);background:rgba(216,180,92,0.08)" : "") + "'>" +
          (suggested ? "<span style='color:var(--gold);font-size:10px;letter-spacing:.6px;font-weight:600'>SUGGESTED MATCH</span>" : "") +
          "<span><b>" + esc(s.code) + "</b>" + (s.productTitle ? " — " + esc(s.productTitle) : "") + (s.size ? " (" + esc(s.size) + ")" : "") + "</span>" +
          "</button>";
      }).join("");
    }

    function mapToSku(skuId, auto) {
      api("/skus/map", { method: "POST", body: { marketplaceAccountId: accountId, marketplaceSku: marketplaceSku, skuId: skuId } }).then(function (r) {
        if (!r.ok) { msMsg("err", (r.data && r.data.error) || "Mapping failed."); return; }
        msMsg("ok", (auto ? "Auto-mapped (matched automatically). " : "Mapped! ") +
          "Re-upload the same CSV — this order will go through now (already-imported rows are safely skipped as duplicates).");
        setTimeout(function () { m.close(); }, 1800);
      }).catch(function () { msMsg("err", "Network error — try again."); });
    }

    api("/companies/me/brands/" + acct.brandId + "/skus").then(function (r) {
      allSkus = (r.ok && Array.isArray(r.data)) ? r.data : [];
      scored = allSkus
        .map(function (s) { return Object.assign({}, s, { _score: skuMatchScore(marketplaceSku, s) }); })
        .sort(function (a, b) { return b._score - a._score; });
      var top = scored[0];
      var hint = m.body.querySelector("#ms-hint");
      if (top && top._score >= AUTO_THRESHOLD) {
        hint.textContent = "Confident match found — mapping automatically…";
        renderList("");
        mapToSku(top.id, true);
      } else if (top && top._score >= SUGGEST_THRESHOLD) {
        hint.textContent = "Best guess highlighted below — click to confirm, or search/create a different one.";
        renderList("");
      } else {
        hint.textContent = allSkus.length ? "No confident match — search below or create a new SKU." : "No SKUs yet for this brand — create one below.";
        renderList("");
      }
    });

    m.body.querySelector("#ms-search").addEventListener("input", function (e2) { renderList(e2.target.value); });
    m.body.querySelector("#ms-list").addEventListener("click", function (e2) {
      var b = e2.target.closest && e2.target.closest("[data-sku-id]");
      if (b) mapToSku(Number(b.getAttribute("data-sku-id")));
    });
    m.body.querySelector("#ms-new-btn").addEventListener("click", function () {
      var code = m.body.querySelector("#ms-new-code").value.trim();
      if (!code) { msMsg("err", "Enter a SKU code."); return; }
      api("/skus", { method: "POST", body: { brandId: acct.brandId, code: code, productTitle: code } }).then(function (r) {
        if (!r.ok) { msMsg("err", (r.data && r.data.error) || "Could not create SKU (maybe it already exists — search above)."); return; }
        mapToSku(r.data.id);
      }).catch(function () { msMsg("err", "Network error — try again."); });
    });
  }

  // ---------- AWB / manifest upload (separate from the order-sheet upload
  // above -- no account/warehouse picker, matches by order id within
  // whichever company is currently selected) ----------
  var awbDropzone = $("#awb-dropzone");
  var awbFileInput = $("#awb-file");
  var awbSelectedFile = null;
  awbFileInput.addEventListener("change", function () {
    if (awbFileInput.files.length) setAwbFile(awbFileInput.files[0]);
  });
  ["dragenter", "dragover"].forEach(function (ev) {
    awbDropzone.addEventListener(ev, function (e) { e.preventDefault(); awbDropzone.classList.add("drag"); });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    awbDropzone.addEventListener(ev, function (e) { e.preventDefault(); awbDropzone.classList.remove("drag"); });
  });
  awbDropzone.addEventListener("drop", function (e) {
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) setAwbFile(f);
  });
  function setAwbFile(f) {
    if (!/\.csv$/i.test(f.name)) { showAwbResult("err", "Only .csv files are accepted."); return; }
    awbSelectedFile = f;
    $("#awb-dz-name").textContent = f.name + " (" + (f.size / 1024).toFixed(1) + " KB)";
  }

  $("#awb-upload-form").addEventListener("submit", function (e) {
    e.preventDefault();
    $("#awb-upload-result").hidden = true;
    if (!awbSelectedFile) { showAwbResult("err", "Choose the AWB/manifest CSV first."); return; }

    var reader = new FileReader();
    reader.onload = function () {
      var btn = $("#awb-up-btn");
      btn.disabled = true;
      btn.classList.add("loading");
      api("/orders/awb-import", { method: "POST", body: { csv: String(reader.result) } }).then(function (r) {
        btn.disabled = false;
        btn.classList.remove("loading");
        if (!r.ok) { showAwbResult("err", (r.data && r.data.error) || "Upload failed — try again."); return; }
        var imported = r.data.imported || 0;
        var failed = r.data.failed || 0;
        var html = "<b class='ok'>" + imported + " AWB" + (imported === 1 ? "" : "s") + " matched &amp; saved</b>" +
          (failed ? ", <b>" + failed + " failed</b>" : "") + ".";
        var errs = (r.data.results || []).filter(function (x) { return x.error; }).slice(0, 5);
        if (errs.length) {
          html += "<ul>" + errs.map(function (x) { return "<li>" + esc(x.order || "row") + ": " + esc(x.error) + "</li>"; }).join("") + "</ul>";
        }
        showAwbResult(imported > 0 ? "ok" : "err", html);
        loadSummary();
      }).catch(function (err) {
        btn.disabled = false;
        btn.classList.remove("loading");
        if (err && err.message !== "session expired") showAwbResult("err", "Network error — try again.");
      });
    };
    reader.readAsText(awbSelectedFile);
  });

  function showAwbResult(kind, html) {
    var box = $("#awb-upload-result");
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
      // Daily Summary panel has its own endpoint (different aggregation
      // shape) but should refresh whenever the KPI strip does — every
      // existing loadSummary() call site (order save, CSV import, boot)
      // picks this up for free this way.
      loadDailySummary();
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

  // ---------- Daily Summary dashboard (OVERALL TOTALS / PLATFORM-WISE
  // BREAKDOWN / DAILY SUMMARY, every number clickable) — added by Claude
  // (Anthropic) 2026-09-25 per user's dashboard spec. Backed by
  // GET /dashboard/daily-summary and GET /dashboard/daily-summary/detail
  // (src/routes/dashboard.ts). See that file's own comment for exactly how
  // "Orders Dispatched" is defined (shipments.packedAt) — the same
  // assumption is echoed in the panel's subtitle above the tiles. ----------
  var DS_TILES = [
    { key: "ordersDispatched", label: "Orders Dispatched", fmt: num },
    { key: "dispatchAmount", label: "Dispatch Amount", fmt: money },
    { key: "returnsExpected", label: "Returns Expected", fmt: num },
    { key: "returnsReceived", label: "Returns Received", fmt: num },
    { key: "returnsPending", label: "Returns Pending", fmt: num },
    { key: "returnsDueToday", label: "Returns Due Today", fmt: num },
    { key: "returnsOverdue", label: "Returns Overdue", fmt: num },
  ];

  var DS_RETURN_LABELS = {
    INITIATED: "Initiated", IN_TRANSIT: "In Transit", RECEIVED: "Received",
    QC_PASSED: "QC Passed", QC_FAILED: "QC Failed", RESTOCKED: "Restocked", CLOSED: "Closed",
  };
  var DS_DUE_LABELS = { DUE: "Due", OVERDUE: "Overdue", RECEIVED_ON_TIME: "Received — on time", RECEIVED_LATE: "Received — late" };

  function dsFmtDate(v) {
    if (!v) return "—";
    var d = new Date(v);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  }

  function loadDailySummary() {
    api("/dashboard/daily-summary?days=30").then(function (r) {
      if (!r.ok || !r.data) return;
      dailySummary = r.data;
      renderDsTotals();
      renderDsPlatform();
      renderDsDaily();
    });
  }

  function renderDsTotals() {
    var t = (dailySummary && dailySummary.totals) || {};
    $("#ds-totals").innerHTML = DS_TILES.map(function (tile) {
      var val = t[tile.key];
      var hasData = val != null && Number(val) > 0;
      return "<div class='ds-tile'>" +
        "<div class='ds-tile-label'>" + esc(tile.label) + "</div>" +
        "<button type='button' class='ds-tile-btn' data-metric='" + tile.key + "'" + (hasData ? "" : " disabled") + ">" +
          tile.fmt(val) +
        "</button>" +
        "</div>";
    }).join("");
  }

  function renderDsPlatform() {
    var rows = (dailySummary && dailySummary.byPlatform) || [];
    var tb = $("#ds-platform-table tbody");
    $("#ds-platform-empty").hidden = rows.length > 0;
    tb.innerHTML = rows.map(function (row) {
      return "<tr>" +
        "<td><b>" + esc(row.marketplace) + "</b></td>" +
        "<td>" + dsLinkCell(row.ordersDispatched, "ordersDispatched", { platform: row.marketplace }, num) + "</td>" +
        "<td>" + dsLinkCell(row.dispatchAmount, "dispatchAmount", { platform: row.marketplace }, money) + "</td>" +
        "<td>" + dsLinkCell(row.returnsReceived, "returnsReceived", { platform: row.marketplace }, num) + "</td>" +
        "</tr>";
    }).join("");
  }

  function renderDsDaily() {
    var rows = (dailySummary && dailySummary.byDate) || [];
    var tb = $("#ds-daily-table tbody");
    tb.innerHTML = rows.map(function (row) {
      return "<tr>" +
        "<td>" + dsFmtDate(row.date) + "</td>" +
        "<td>" + dsLinkCell(row.ordersDispatched, "ordersDispatched", { date: row.date }, num) + "</td>" +
        "<td>" + dsLinkCell(row.returnsExpected, "returnsExpected", { date: row.date }, num) + "</td>" +
        "<td>" + dsLinkCell(row.returnsReceived, "returnsReceived", { date: row.date }, num) + "</td>" +
        "</tr>";
    }).join("");
  }

  // A table cell that's a plain number when zero, and a clickable
  // drill-down link when not — data-* attributes carry the metric + filters
  // for the click handler below instead of one handler per cell.
  function dsLinkCell(val, metric, extra, fmt) {
    var n = Number(val || 0);
    if (!n) return "<span style='color:var(--muted)'>" + fmt(val) + "</span>";
    var attrs = "data-metric='" + metric + "'";
    if (extra && extra.date) attrs += " data-date='" + esc(extra.date) + "'";
    if (extra && extra.platform) attrs += " data-platform='" + esc(extra.platform) + "'";
    return "<button type='button' class='ds-link' " + attrs + ">" + fmt(val) + "</button>";
  }

  function dsMetricLabel(metric) {
    var found = DS_TILES.filter(function (t) { return t.key === metric; })[0];
    return found ? found.label : metric;
  }

  function openDailySummaryDetail(metric, filters) {
    filters = filters || {};
    var qs = "metric=" + encodeURIComponent(metric);
    if (filters.date) qs += "&date=" + encodeURIComponent(filters.date);
    if (filters.platform) qs += "&platform=" + encodeURIComponent(filters.platform);

    var titleBits = [dsMetricLabel(metric)];
    if (filters.platform) titleBits.push(filters.platform);
    if (filters.date) titleBits.push(dsFmtDate(filters.date));

    var m = window.NcrModal.open({
      title: titleBits.join(" — "),
      wide: true,
      bodyHtml: "<div id='ds-detail-body' class='empty'>Loading…</div>",
    });

    api("/dashboard/daily-summary/detail?" + qs).then(function (r) {
      var body = m.body.querySelector("#ds-detail-body");
      if (!r.ok || !r.data || !Array.isArray(r.data.rows) || !r.data.rows.length) {
        body.className = "empty";
        body.textContent = "No records found.";
        return;
      }
      var rows = r.data.rows;
      if (r.data.kind === "orders") {
        body.outerHTML =
          "<div class='tablewrap'><table><thead><tr>" +
            "<th>Order No</th><th>Marketplace</th><th>Brand</th><th>AWB</th><th>Status</th><th>Dispatched</th><th>Amount (₹)</th>" +
          "</tr></thead><tbody>" +
          rows.map(function (row) {
            return "<tr>" +
              "<td><b>" + esc(row.orderNo) + "</b></td>" +
              "<td>" + esc(row.marketplace) + "</td>" +
              "<td>" + esc(row.brand) + "</td>" +
              "<td>" + esc(row.awbNumber || "—") + "</td>" +
              "<td>" + esc((row.status || "").replace(/_/g, " ")) + "</td>" +
              "<td>" + dsFmtDate(row.dispatchedAt) + "</td>" +
              "<td>" + money(row.invoiceAmount) + "</td>" +
              "</tr>";
          }).join("") +
          "</tbody></table></div>";
      } else {
        body.outerHTML =
          "<div class='tablewrap'><table><thead><tr>" +
            "<th>Order No</th><th>Marketplace</th><th>Dispatch AWB</th><th>Return AWB</th><th>Initiated</th><th>Expected By</th><th>Received</th><th>Status</th>" +
          "</tr></thead><tbody>" +
          rows.map(function (row) {
            return "<tr>" +
              "<td><b>" + esc(row.orderNo) + "</b></td>" +
              "<td>" + esc(row.marketplace) + "</td>" +
              "<td>" + esc(row.dispatchAwb || "—") + "</td>" +
              "<td>" + esc(row.returnAwb || "—") + "</td>" +
              "<td>" + dsFmtDate(row.initiatedAt) + "</td>" +
              "<td>" + dsFmtDate(row.expectedReturnDate) + "</td>" +
              "<td>" + dsFmtDate(row.deliveredAt) + "</td>" +
              "<td><span class='status due-" + esc(row.dueStatus) + "'>" + esc(DS_DUE_LABELS[row.dueStatus] || row.dueStatus) + "</span></td>" +
              "</tr>";
          }).join("") +
          "</tbody></table></div>";
      }
    });
  }

  $("#daily-summary-panel").addEventListener("click", function (e) {
    var btn = e.target.closest(".ds-tile-btn, .ds-link");
    if (!btn || btn.disabled) return;
    var metric = btn.getAttribute("data-metric");
    if (!metric) return;
    openDailySummaryDetail(metric, {
      date: btn.getAttribute("data-date") || undefined,
      platform: btn.getAttribute("data-platform") || undefined,
    });
  });

  // ---------- boot ----------
  loadSummary();
})();
