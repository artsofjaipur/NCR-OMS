/* NCR-OMS Payments — marketplace settlement-sheet upload + reconciliation report. */
(function () {
  "use strict";

  var auth = (function () {
    try { return JSON.parse(sessionStorage.getItem("ncr_auth") || "null"); } catch (e) { return null; }
  })();
  if (!auth || !auth.token) { window.location.replace("/login.html"); return; }

  function $(sel) { return document.querySelector(sel); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function money(v) {
    var n = Number(v || 0);
    return "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  }
  function fmtDate(v) {
    if (!v) return "—";
    var d = new Date(v);
    return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  }

  function api(path, options) {
    options = options || {};
    return fetch(path, {
      method: options.method || "GET",
      headers: Object.assign({ "Content-Type": "application/json" }, { Authorization: "Bearer " + auth.token }),
      body: options.body ? JSON.stringify(options.body) : undefined,
    }).then(function (res) {
      if (res.status === 401) { sessionStorage.removeItem("ncr_auth"); window.location.replace("/login.html"); throw new Error("session expired"); }
      return res.json().catch(function () { return null; }).then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
    });
  }

  $("#logout-btn").addEventListener("click", function () {
    sessionStorage.removeItem("ncr_auth");
    window.location.replace("/login.html");
  });

  // ---------- seller account select (same convention as app.js's upload panel) ----------
  var summary = null;
  function fillAccountSelect() {
    var sel = $("#pay-account");
    var accounts = ((summary && summary.accounts) || []).filter(function (a) { return a.isActive !== false; });
    sel.innerHTML = accounts.length
      ? accounts.map(function (a) {
          return "<option value=\"" + a.id + "\">" + esc(a.sellerAccountLabel || a.marketplace + " #" + a.id) + " — " + esc(a.marketplace) +
            (a.brand ? " (" + esc(a.brand) + ")" : "") + "</option>";
        }).join("")
      : "<option value=\"\">No seller account yet — add under Company &amp; Setup</option>";
  }

  api("/dashboard/summary").then(function (r) {
    if (r.ok && r.data) {
      $("#tb-company").textContent = r.data.company ? r.data.company.displayName : "";
      $("#tb-role").textContent = auth.role || "";
      summary = r.data;
      fillAccountSelect();
    }
  });

  // ---------- upload ----------
  var selectedFile = null;
  var drop = $("#pay-drop");
  var fileInput = $("#pay-file");
  drop.addEventListener("click", function () { fileInput.click(); });
  ["dragenter", "dragover"].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("drag"); });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("drag"); });
  });
  drop.addEventListener("drop", function (e) {
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) setFile(f);
  });
  fileInput.addEventListener("change", function () {
    if (fileInput.files && fileInput.files[0]) setFile(fileInput.files[0]);
  });
  function setFile(f) {
    if (!/\.xlsx$/i.test(f.name)) { showResult("err", "Only .xlsx files are accepted."); return; }
    selectedFile = f;
    $("#pay-drop-label").innerHTML = esc(f.name) + " (" + (f.size / 1024).toFixed(1) + " KB)<br /><small>Click to change</small>";
  }

  function showResult(kind, msg) {
    var box = $("#pay-result");
    box.className = "result " + kind;
    box.textContent = msg;
    box.hidden = false;
  }

  $("#pay-form").addEventListener("submit", function (e) {
    e.preventDefault();
    $("#pay-result").hidden = true;
    var accountId = Number($("#pay-account").value);
    if (!accountId) { showResult("err", "Pick a seller account first."); return; }
    if (!selectedFile) { showResult("err", "Choose a payment report .xlsx file."); return; }

    var reader = new FileReader();
    reader.onload = function () {
      var base64 = String(reader.result).split(",")[1] || "";
      var btn = $("#pay-btn");
      btn.disabled = true;
      btn.classList.add("loading");
      api("/api/settlements/import", {
        method: "POST",
        body: { marketplaceAccountId: accountId, fileName: selectedFile.name, fileBase64: base64 },
      }).then(function (r) {
        btn.disabled = false;
        btn.classList.remove("loading");
        if (!r.ok) { showResult("err", (r.data && r.data.error) || "Import failed — try again."); return; }
        var d = r.data;
        showResult(
          "ok",
          d.marketplace + " report imported — " + d.entryCount + " row(s), " + d.matchedCount + " matched to orders" +
            (d.unmatchedCount ? ", " + d.unmatchedCount + " not matched (probably not in the system yet, or an ads/fee/tax line that was never order-level to begin with)" : "") +
            ". " + d.payoutBatchesTouched + " payout batch(es) updated in Finance."
        );
        selectedFile = null;
        fileInput.value = "";
        $("#pay-drop-label").innerHTML = "Choose or drop a .xlsx file<br /><small>Flipkart / Meesho / Snapdeal payment report</small>";
        loadHistory();
        loadReport();
      }).catch(function () { btn.disabled = false; btn.classList.remove("loading"); showResult("err", "Network error."); });
    };
    reader.readAsDataURL(selectedFile);
  });

  // ---------- report ----------
  var LINE_TYPE_LABELS = {
    ORDER_PAYMENT: "Order Payment", RETURN: "Return", FEE_REBATE: "Fee Rebate", NON_ORDER_CLAIM: "Non-order Claim",
    STORAGE_RECALL: "Storage / Recall", ADS: "Ads", TDS: "TDS", TCS: "TCS", GST_DETAIL: "GST Detail (info only)",
    COMMISSION_FEES: "Commission & Fees", NON_ORDER_TXN: "Non-order Txn", CLOSING_BALANCE: "Closing Balance",
    REFERRAL: "Referral", COMPENSATION_RECOVERY: "Compensation / Recovery", BANK_PAYMENT: "Bank Payment",
  };

  function loadReport() {
    // No start/end — settlement sheets are inherently historical (a company
    // might import an old quarter on day one), so the report defaults to
    // everything ever imported rather than a "last N days" window that
    // would hide a fresh import of old data. See src/routes/settlements.ts.
    return api("/api/settlements/report").then(function (r) {
      if (!r.ok || !r.data) return;
      var d = r.data;
      $("#pay-received").textContent = money(d.amountReceived);
      $("#pay-unmatched").textContent = d.unmatchedOrderPaymentRows;
      var rows = d.byType || [];
      $("#pay-breakdown tbody").innerHTML = rows.length
        ? rows.map(function (row) {
            return "<tr><td>" + esc(row.marketplace) + "</td><td>" + esc(LINE_TYPE_LABELS[row.lineType] || row.lineType) + "</td>" +
              "<td>" + row.count + "</td><td style='text-align:right'>" + money(row.total) + "</td>" +
              "<td>" + (row.bankMoney ? "<span class='pill pill-ok'>yes</span>" : "<span class='pill'>no — info only</span>") + "</td></tr>";
          }).join("")
        : "<tr><td colspan='5' class='empty'>Kuch import nahi hua abhi — upload karke shuru karo.</td></tr>";
    }).catch(function () {});
  }

  // ---------- import history ----------
  function loadHistory() {
    return api("/api/settlements").then(function (r) {
      if (!r.ok || !r.data) return;
      var rows = r.data;
      $("#pay-history-count").textContent = rows.length;
      $("#pay-history tbody").innerHTML = rows.length
        ? rows.map(function (h) {
            return "<tr><td>" + esc(h.marketplace) + "</td><td>" + esc(h.store) + "</td><td>" + esc(h.sourceFileName) + "</td>" +
              "<td>" + (h.periodStart ? fmtDate(h.periodStart) + " → " + fmtDate(h.periodEnd) : "—") + "</td>" +
              "<td>" + h.entryCount + "</td><td>" + h.matchedCount + "</td>" +
              "<td>" + (h.unmatchedCount ? "<button type='button' class='btn-ghost' data-unmatched='" + h.id + "'>" + h.unmatchedCount + " view</button>" : "0") + "</td>" +
              "<td>" + fmtDate(h.createdAt) + "</td><td></td></tr>";
          }).join("")
        : "<tr><td colspan='9' class='empty'>Koi import nahi hua abhi.</td></tr>";
    }).catch(function () {});
  }

  $("#pay-history").addEventListener("click", function (e) {
    var btn = e.target.closest("[data-unmatched]");
    if (!btn) return;
    var importId = btn.getAttribute("data-unmatched");
    api("/api/settlements/unmatched?importId=" + importId).then(function (r) {
      if (!r.ok || !r.data) { alert("Could not load unmatched rows."); return; }
      var rows = r.data;
      window.NcrModal.open({
        title: "Unmatched order-payment rows",
        wide: true,
        bodyHtml:
          "<p class='panel-sub' style='margin-bottom:10px'>Ye rows order-level settlement hain jinka order abhi tak NCR-OMS me nahi mila — order import nahi hua hoga ya order ID/SKU match nahi hua.</p>" +
          "<div class='tablewrap'><table class='ftable'><thead><tr><th>Order ID (raw)</th><th>Reference</th><th>Date</th><th style='text-align:right'>Amount</th></tr></thead><tbody>" +
          rows.map(function (u) {
            return "<tr><td>" + esc(u.marketplaceOrderIdRaw || "—") + "</td><td>" + esc(u.reference || "—") + "</td>" +
              "<td>" + fmtDate(u.occurredAt) + "</td><td style='text-align:right'>" + money(u.amount) + "</td></tr>";
          }).join("") +
          "</tbody></table></div>",
      });
    });
  });

  loadHistory();
  loadReport();
})();
