/* NCR-OMS Finance — Zoho Books-inspired money view. Vanilla JS, same session guard. */
(function () {
  "use strict";

  function $(sel) { return document.querySelector(sel); }

  // ---------- auth guard (same session as dashboard) ----------
  var auth = null;
  try { auth = JSON.parse(sessionStorage.getItem("ncr_auth") || "null"); } catch (e) { auth = null; }
  if (!auth || !auth.token) { window.location.replace("/login.html"); return; }
  if (auth.role === "VIEWER") {
    document.body.innerHTML = "<div style='padding:60px;text-align:center;color:#98a2b3;font-family:Inter,sans-serif'>Your role (VIEWER) is read-only. Ask an OWNER/ADMIN for finance access.</div>";
    return;
  }

  $("#tb-company").textContent = auth.companyName || "";
  $("#tb-role").textContent = auth.role || "";
  $("#logout-btn").addEventListener("click", function () {
    sessionStorage.removeItem("ncr_auth");
    window.location.href = "/login.html";
  });

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

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function inr(n) {
    var v = Number(n || 0);
    return "₹" + v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function moneyCell(v, opts) {
    var num = Number(v || 0);
    var cls = "money" + (num > 0 ? " pos" : num < 0 ? " neg" : " zero");
    if (opts && opts.hero) cls += " money-hero";
    return "<td class='" + cls + "'>" + inr(num) + "</td>";
  }
  function fmtDate(d) {
    if (!d) return "—";
    try { return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }); }
    catch (e) { return "—"; }
  }

  var partiesCache = [];

  // ---------- tabs ----------
  var tabs = document.querySelectorAll(".tabs button");
  Array.prototype.forEach.call(tabs, function (b) {
    b.addEventListener("click", function () {
      Array.prototype.forEach.call(tabs, function (x) { x.classList.remove("sel"); });
      b.classList.add("sel");
      var tab = b.getAttribute("data-tab");
      ["stores", "cashflow", "bills", "payments", "notes", "parties"].forEach(function (t) {
        $("#tab-" + t).hidden = t !== tab;
      });
    });
  });

  // ============ OVERVIEW ============
  function loadOverview() {
    return api("/finance/overview").then(function (r) {
      if (!r.ok) return;
      var d = r.data;
      $("#k-in").textContent = inr(d.moneyIn.received);
      $("#k-in-sub").textContent = "expected " + inr(d.moneyIn.expected);
      $("#k-pend").textContent = d.moneyIn.pendingCount;
      $("#k-pend-sub").textContent = "payouts awaited";
      $("#k-bills").textContent = inr(d.moneyOut.billsTotal);
      $("#k-bills-sub").textContent = d.moneyOut.billCount + " bills · paid " + inr(d.moneyOut.paid);
      $("#k-out").textContent = inr(d.moneyOut.outstanding);
      $("#k-out-sub").textContent = d.moneyOut.overdueCount + " overdue · credit " + inr(d.moneyOut.creditNotes);
    }).catch(function () {});
  }

  // ============ STORE MONEY-IN ============
  function loadPayouts() {
    return api("/finance/payouts").then(function (r) {
      var tb = $("#payouts-table tbody");
      if (!r.ok) { tb.innerHTML = "<tr><td colspan='8' class='empty'>Failed to load payouts</td></tr>"; return; }
      if (!r.data.length) { tb.innerHTML = "<tr><td colspan='8' class='empty'>No payout batches yet — record them from the Orders/Payout flow. Expected payouts appear here automatically once created.</td></tr>"; return; }
      tb.innerHTML = r.data.map(function (p) {
        var received = !!p.receivedDate;
        var amt = Number(p.receivedAmount || p.expectedAmount || 0);
        return "<tr>" +
          "<td><b>" + esc(p.store || "—") + "</b></td>" +
          "<td>" + esc(p.marketplace) + "</td>" +
          "<td>" + esc(p.brand) + "</td>" +
          "<td>" + fmtDate(p.expectedDate) + "</td>" +
          "<td>" + (received ? fmtDate(p.receivedDate) : "<span class='pill pill-pend'>awaited</span>") + "</td>" +
          moneyCell(amt, { hero: true }) +
          "<td>" + esc(p.bankReference || "—") + "</td>" +
          "<td>" + (received ? "<span class='pill pill-ok'>RECEIVED</span>" : "<span class='pill pill-pend'>" + esc(p.status) + "</span>") + "</td>" +
          "</tr>";
      }).join("");
    }).catch(function () {});
  }

  // ============ CASHFLOW ============
  function loadCashflow() {
    return api("/finance/cashflow").then(function (r) {
      var chart = $("#cf-chart");
      if (!r.ok) { chart.innerHTML = "<div class='empty' style='margin:auto'>Failed to load cashflow</div>"; return; }
      var max = 0.000001;
      r.data.forEach(function (d) { max = Math.max(max, Number(d.in), Number(d.out)); });
      chart.innerHTML = r.data.map(function (d) {
        var hi = (Number(d.in) / max) * 100;
        var ho = (Number(d.out) / max) * 100;
        var tip = d.day + " · in " + inr(d.in) + " · out " + inr(d.out);
        return "<div class='cf-col'>" +
          "<div class='cf-tip'>" + esc(tip) + "</div>" +
          (Number(d.in) > 0 ? "<div class='cf-bar in' style='height:" + hi.toFixed(1) + "%'></div>" : "") +
          (Number(d.out) > 0 ? "<div class='cf-bar out' style='height:" + ho.toFixed(1) + "%'></div>" : "") +
          "</div>";
      }).join("");
    }).catch(function () {});
  }

  // ============ BILLS ============
  function loadBills() {
    return api("/finance/bills").then(function (r) {
      var tb = $("#bills-table tbody");
      if (!r.ok) { tb.innerHTML = "<tr><td colspan='9' class='empty'>Failed to load bills</td></tr>"; return; }
      $("#bills-chip").textContent = r.data.length + " BILLS";
      if (!r.data.length) { tb.innerHTML = "<tr><td colspan='9' class='empty'>No bills yet — every Stock In with a party + invoice creates a bill here automatically.</td></tr>"; return; }
      tb.innerHTML = r.data.map(function (b) {
        var cls = b.overdue ? " class='overdue-row'" : b.settled ? " class='settled-row'" : "";
        return "<tr" + cls + ">" +
          "<td><b>" + esc(b.invoiceNumber || "Bill #" + b.id) + "</b></td>" +
          "<td>" + esc(b.supplier || "—") + "</td>" +
          "<td>" + fmtDate(b.invoiceDate || b.createdAt) + "</td>" +
          "<td>" + fmtDate(b.dueDate) + (b.overdue ? " <span class='pill pill-red'>OVERDUE</span>" : "") + "</td>" +
          moneyCell(b.total, { hero: true }) +
          moneyCell(b.paid) +
          moneyCell(b.credited) +
          moneyCell(b.balance, { hero: true }) +
          "<td><button type='button' class='mini' data-pay-bill='" + b.id + "' data-bill-party='" + (b.supplierId || "") + "'>Pay</button></td>" +
          "</tr>";
      }).join("");
      bindPayButtons();
    }).catch(function () {});
  }

  function bindPayButtons() {
    document.querySelectorAll("[data-pay-bill]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        // Jump to payments tab with the party preselected.
        var tabsBtn = document.querySelector(".tabs button[data-tab='payments']");
        if (tabsBtn) tabsBtn.click();
        var pid = btn.getAttribute("data-bill-party");
        if (pid) $("#pay-party").value = pid;
        $("#pay-amount").focus();
      });
    });
  }

  // ============ PARTIES ============
  function loadParties() {
    return api("/finance/parties").then(function (r) {
      var tb = $("#parties-table tbody");
      if (!r.ok) { tb.innerHTML = "<tr><td colspan='8' class='empty'>Failed to load parties</td></tr>"; return; }
      partiesCache = r.data;
      fillPartySelects();
      if (!r.data.length) { tb.innerHTML = "<tr><td colspan='8' class='empty'>No parties yet — add one from the Dashboard (Brands &amp; Setup → Party / Supplier).</td></tr>"; return; }
      tb.innerHTML = r.data.map(function (p) {
        var bal = Number(p.balance);
        var balCls = bal > 0.009 ? " neg" : bal < -0.009 ? " pos" : " zero";
        return "<tr>" +
          "<td><b>" + esc(p.name) + "</b>" + (p.gstin ? "<div style='font-size:11px;color:var(--muted)'>GSTIN " + esc(p.gstin) + "</div>" : "") + "</td>" +
          "<td>" + esc(p.city || "—") + "</td>" +
          moneyCell(p.billed) +
          moneyCell(p.paid) +
          moneyCell(p.credit) +
          moneyCell(p.debit) +
          "<td class='money money-hero" + balCls + "'>" + inr(bal) + "</td>" +
          "<td><button type='button' class='mini' data-ledger='" + p.id + "' data-ledger-name='" + esc(p.name) + "'>Ledger</button></td>" +
          "</tr>";
      }).join("");
      bindLedgerButtons();
    }).catch(function () {});
  }

  function bindLedgerButtons() {
    document.querySelectorAll("[data-ledger]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        openLedger(Number(btn.getAttribute("data-ledger")), btn.getAttribute("data-ledger-name"));
      });
    });
  }

  function openLedger(supplierId, name) {
    api("/finance/ledger?supplierId=" + supplierId).then(function (r) {
      if (!r.ok) return;
      $("#ledger-box").hidden = false;
      $("#ledger-title").textContent = "Ledger — " + name + " (closing " + inr(r.data.closing) + ")";
      var tb = $("#ledger-table tbody");
      if (!r.data.entries.length) { tb.innerHTML = "<tr><td colspan='7' class='empty'>No entries yet for this party.</td></tr>"; return; }
      tb.innerHTML = r.data.entries.map(function (e) {
        return "<tr>" +
          "<td>" + fmtDate(e.date) + "</td>" +
          "<td><span class='pill " + (e.type === "BILL" || e.type === "DEBIT_NOTE" ? "pill-red" : "pill-ok") + "'>" + esc(e.type) + "</span></td>" +
          "<td>" + esc(e.ref) + "</td>" +
          "<td style='white-space:normal'>" + esc(e.detail) + "</td>" +
          moneyCell(e.debit) +
          moneyCell(e.credit) +
          moneyCell(e.balance) +
          "</tr>";
      }).join("");
      $("#ledger-box").scrollIntoView({ behavior: "smooth", block: "start" });
    }).catch(function () {});
  }
  $("#ledger-close").addEventListener("click", function () { $("#ledger-box").hidden = true; });

  // ============ PAYMENTS ============
  function fillPartySelects() {
    var opts = partiesCache.map(function (p) {
      return "<option value='" + p.id + "'>" + esc(p.name) + " (bal " + inr(p.balance) + ")</option>";
    }).join("");
    ["#pay-party", "#cn-party", "#dn-party"].forEach(function (sel) {
      var el = $(sel);
      var cur = el.value;
      el.innerHTML = "<option value=''>— choose party —</option>" + opts;
      if (cur) el.value = cur;
    });
  }

  function showResult(sel, ok, msg) {
    var el = $(sel);
    el.hidden = false;
    el.className = "result " + (ok ? "ok" : "bad");
    el.textContent = msg;
    setTimeout(function () { el.hidden = true; }, 6000);
  }

  $("#pay-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var supplierId = Number($("#pay-party").value);
    if (!supplierId) { showResult("#pay-result", false, "Choose a party first"); return; }
    var body = {
      supplierId: supplierId,
      amount: $("#pay-amount").value,
      method: $("#pay-method").value,
      reference: $("#pay-ref").value.trim() || undefined,
    };
    var d = $("#pay-date").value;
    if (d) body.paidAt = new Date(d + "T12:00:00").toISOString();
    var btn = $("#pay-btn");
    btn.disabled = true; btn.classList.add("loading");
    api("/finance/payments", { method: "POST", body: body }).then(function (r) {
      btn.disabled = false; btn.classList.remove("loading");
      if (!r.ok) { showResult("#pay-result", false, (r.data && r.data.error) || "Payment failed"); return; }
      showResult("#pay-result", true, "Payment recorded ✓");
      $("#pay-amount").value = ""; $("#pay-ref").value = "";
      loadOverview(); loadPayments(); loadParties(); loadBills(); loadCashflow();
    }).catch(function () { btn.disabled = false; btn.classList.remove("loading"); });
  });

  function loadPayments() {
    return api("/finance/payments").then(function (r) {
      var tb = $("#payments-table tbody");
      if (!r.ok) { tb.innerHTML = "<tr><td colspan='7' class='empty'>Failed to load payments</td></tr>"; return; }
      if (!r.data.length) { tb.innerHTML = "<tr><td colspan='7' class='empty'>No payments recorded yet.</td></tr>"; return; }
      tb.innerHTML = r.data.map(function (p) {
        return "<tr>" +
          "<td>" + fmtDate(p.paidAt) + "</td>" +
          "<td><b>" + esc(p.supplier || "—") + "</b></td>" +
          moneyCell(p.amount, { hero: true }) +
          "<td>" + esc(p.method) + "</td>" +
          "<td>" + esc(p.reference || "—") + "</td>" +
          "<td>" + esc(p.by || "—") + "</td>" +
          "<td style='white-space:normal'>" + esc(p.notes || "") + "</td>" +
          "</tr>";
      }).join("");
    }).catch(function () {});
  }

  // ============ NOTES ============
  function noteHandler(formSel, kind) {
    $(formSel).addEventListener("submit", function (e) {
      e.preventDefault();
      var prefix = kind === "credit" ? "#cn-" : "#dn-";
      var supplierId = Number($(prefix + "party").value);
      if (!supplierId) { showResult("#notes-result", false, "Choose a party first"); return; }
      var body = {
        supplierId: supplierId,
        noteNumber: $(prefix + "number").value.trim(),
        amount: $(prefix + "amount").value,
        reason: $(prefix + "reason").value.trim() || undefined,
      };
      var btn = $(prefix + "btn");
      btn.disabled = true; btn.classList.add("loading");
      api("/finance/notes/" + kind, { method: "POST", body: body }).then(function (r) {
        btn.disabled = false; btn.classList.remove("loading");
        if (!r.ok) { showResult("#notes-result", false, (r.data && r.data.error) || "Failed"); return; }
        showResult("#notes-result", true, (kind === "credit" ? "Credit" : "Debit") + " note added ✓");
        ["number", "amount", "reason"].forEach(function (f) { $(prefix + f).value = ""; });
        loadNotes(); loadOverview(); loadParties(); loadBills();
      }).catch(function () { btn.disabled = false; btn.classList.remove("loading"); });
    });
  }
  noteHandler("#cn-form", "credit");
  noteHandler("#dn-form", "debit");

  function loadNotes() {
    return Promise.all([
      api("/finance/notes?type=credit"),
      api("/finance/notes?type=debit"),
    ]).then(function (rs) {
      var tb = $("#notes-table tbody");
      var all = [];
      if (rs[0].ok) rs[0].data.forEach(function (n) { all.push(Object.assign({ type: "CREDIT" }, n)); });
      if (rs[1].ok) rs[1].data.forEach(function (n) { all.push(Object.assign({ type: "DEBIT" }, n)); });
      all.sort(function (a, b) { return new Date(b.noteDate) - new Date(a.noteDate); });
      if (!all.length) { tb.innerHTML = "<tr><td colspan='6' class='empty'>No notes yet.</td></tr>"; return; }
      tb.innerHTML = all.map(function (n) {
        return "<tr>" +
          "<td>" + fmtDate(n.noteDate) + "</td>" +
          "<td><span class='pill " + (n.type === "CREDIT" ? "pill-ok" : "pill-red") + "'>" + n.type + " NOTE</span></td>" +
          "<td><b>" + esc(n.noteNumber) + "</b></td>" +
          "<td>" + esc(n.supplier || "—") + "</td>" +
          moneyCell(n.amount, { hero: true }) +
          "<td style='white-space:normal'>" + esc(n.reason || "") + "</td>" +
          "</tr>";
      }).join("");
    }).catch(function () {});
  }

  // ---------- boot ----------
  loadOverview();
  loadPayouts();
  loadCashflow();
  loadBills();
  loadPayments();
  loadNotes();
  loadParties();
})();
