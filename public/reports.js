/* NCR-OMS Reports — P&L, turnover, balance sheet, expenses, store fees. */
(function () {
  "use strict";

  function $(sel) { return document.querySelector(sel); }

  // ---------- auth guard ----------
  var auth = null;
  try { auth = JSON.parse(sessionStorage.getItem("ncr_auth") || "null"); } catch (e) { auth = null; }
  if (!auth || !auth.token) { window.location.replace("/login.html"); return; }

  var perms = (auth && auth.permissions) || [];
  if (perms.length && perms.indexOf("reports") === -1) {
    document.body.innerHTML = "<div style='padding:60px;text-align:center;color:#98a2b3;font-family:Inter,sans-serif'>No access to Reports — ask an OWNER/ADMIN for permission.</div>";
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
  function inr(n) { return "₹" + Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function moneyCell(v, hero) { return "<td class='money" + (hero ? " money-hero" : "") + "'>" + inr(v) + "</td>"; }
  function fmtDate(d) {
    if (!d) return "—";
    try { return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }); }
    catch (e) { return "—"; }
  }

  // ---------- tabs ----------
  var tabs = document.querySelectorAll(".tabs button");
  Array.prototype.forEach.call(tabs, function (b) {
    b.addEventListener("click", function () {
      Array.prototype.forEach.call(tabs, function (x) { x.classList.remove("sel"); });
      b.classList.add("sel");
      var tab = b.getAttribute("data-tab");
      ["pnl", "turnover", "balance", "expenses", "fees"].forEach(function (t) {
        $("#tab-" + t).hidden = t !== tab;
      });
    });
  });

  var canWrite = auth.role === "OWNER" || auth.role === "ADMIN";

  // ============ P&L ============
  function loadPnl() {
    return api("/reports/pnl").then(function (r) {
      if (!r.ok) return;
      var d = r.data;
      $("#k-gmv").textContent = inr(d.gmv);
      $("#k-gmv-sub").textContent = d.period.start.slice(0, 10) + " → " + d.period.end.slice(0, 10);
      $("#k-recv").textContent = inr(d.payoutReceived);
      $("#k-recv-sub").textContent = "store fees " + inr(d.storeFees);
      $("#k-gross").textContent = inr(d.grossProfit);
      $("#k-net").textContent = inr(d.netProfit);
      $("#k-net-sub").textContent = "expenses " + inr(d.expenses);

      var rows = [
        ["GMV (orders value)", d.gmv, ""],
        ["Store payouts expected", Number(d.storeFees) + d.payoutReceived, "dim"],
        ["− Store fees (commission/shipping cut)", d.storeFees, "neg"],
        ["= Payout actually received", d.payoutReceived, "ok"],
        ["− Party purchases (bills in period)", d.purchases, "neg"],
        ["= Gross profit", d.grossProfit, d.grossProfit >= 0 ? "ok" : "neg"],
        ["− Overhead expenses", d.expenses, "neg"],
        ["− Payments already made to parties", d.paymentsToParties, "dim"],
        ["= NET PROFIT", d.netProfit, d.netProfit >= 0 ? "ok" : "neg"],
      ];
      $("#pnl-table tbody").innerHTML = rows.map(function (row) {
        var cls = row[2] === "dim" ? " style='color:var(--muted)'" : "";
        var amtCls = row[2] === "neg" ? "neg" : row[2] === "ok" ? "pos" : "";
        var label = row[0].indexOf("−") === 0 || row[0].indexOf("=") === 0
          ? "<span style='" + (row[2] === "ok" || row[2] === "neg" ? "font-weight:700" : "") + "'>" + esc(row[0]) + "</span>"
          : "<b>" + esc(row[0]) + "</b>";
        return "<tr" + cls + "><td>" + label + "</td><td class='money money-hero " + amtCls + "'>" + inr(row[1]) + "</td></tr>";
      }).join("");
    }).catch(function () {});
  }

  // ============ TURNOVER ============
  function loadTurnover() {
    return api("/reports/turnover").then(function (r) {
      if (!r.ok) return;
      var d = r.data;
      var max = 0.000001;
      d.byDay.forEach(function (x) { max = Math.max(max, Number(x.gmv)); });
      $("#to-chart").innerHTML = d.byDay.map(function (x) {
        var h = (Number(x.gmv) / max) * 100;
        return "<div class='cf-col'><div class='cf-tip'>" + x.day + " · " + inr(x.gmv) + " · " + x.orderCount + " orders</div>" +
          (Number(x.gmv) > 0 ? "<div class='cf-bar in' style='height:" + h.toFixed(1) + "%'></div>" : "") + "</div>";
      }).join("");

      $("#to-brands tbody").innerHTML = d.byBrand.length
        ? d.byBrand.map(function (b) {
            return "<tr><td><b>" + esc(b.brand) + "</b></td><td>" + b.orderCount + "</td>" + moneyCell(b.gmv, true) + "</tr>";
          }).join("")
        : "<tr><td colspan='3' class='empty'>No sales yet</td></tr>";

      $("#to-stores tbody").innerHTML = d.byStore.length
        ? d.byStore.map(function (s) {
            return "<tr><td><b>" + esc(s.store) + "</b></td><td><span class='mp-tag'>" + esc(s.marketplace) + "</span> " + esc(s.brand) + "</td><td>" + s.orderCount + "</td>" + moneyCell(s.gmv, true) + "</tr>";
          }).join("")
        : "<tr><td colspan='4' class='empty'>No sales yet</td></tr>";
    }).catch(function () {});
  }

  // ============ BALANCE ============
  function loadBalance() {
    return api("/reports/balance").then(function (r) {
      if (!r.ok) return;
      var d = r.data;
      var c = d.components;
      $("#bal-table tbody").innerHTML =
        "<tr><td><span class='pill pill-ok'>RECEIVABLE</span></td><td>Pending store payouts (aane hai)</td>" + moneyCell(c.pendingPayouts, true) + "</tr>" +
        "<tr><td><span class='pill pill-red'>PAYABLE</span></td><td>Party bills total</td>" + moneyCell(c.billsTotal) + "</tr>" +
        "<tr><td></td><td>− Payments made</td>" + moneyCell("-" + c.paymentsMade) + "</tr>" +
        "<tr><td></td><td>− Credit notes</td>" + moneyCell("-" + c.creditNotes) + "</tr>" +
        "<tr><td></td><td>+ Debit notes (claims)</td>" + moneyCell(c.debitNotes) + "</tr>" +
        "<tr><td></td><td><b>= Net payable</b></td>" + moneyCell(d.payable, true) + "</tr>" +
        "<tr><td><span class='pill pill-pend'>NET POSITION</span></td><td><b>Receivable − Payable</b></td><td class='money money-hero " + (Number(d.netPosition) >= 0 ? "pos" : "neg") + "'>" + inr(d.netPosition) + "</td></tr>";
    }).catch(function () {});
  }

  // ============ EXPENSES ============
  function showExp(kind, msg) {
    var el = $("#exp-result");
    el.className = "result " + kind;
    el.textContent = msg;
    el.hidden = false;
    setTimeout(function () { el.hidden = true; }, 6000);
  }

  function loadExpenses() {
    return api("/reports/expenses").then(function (r) {
      var tb = $("#exp-table tbody");
      if (!r.ok) { tb.innerHTML = "<tr><td colspan='6' class='empty'>Failed to load expenses</td></tr>"; return; }
      $("#exp-count").textContent = String(r.data.length);
      if (!r.data.length) { tb.innerHTML = "<tr><td colspan='6' class='empty'>No expenses yet — add one above.</td></tr>"; return; }
      tb.innerHTML = r.data.map(function (x) {
        var actions = canWrite
          ? "<button type='button' class='mini' data-exp-edit='" + x.id + "' data-cat='" + esc(x.category) + "' data-amt='" + x.amount + "' data-note='" + esc(x.notes || "") + "'>Edit</button>" +
            " <button type='button' class='mini danger' data-exp-del='" + x.id + "'>Delete</button>"
          : "";
        return "<tr>" +
          "<td>" + fmtDate(x.periodStart) + "</td>" +
          "<td><b>" + esc(x.category) + "</b></td>" +
          "<td>" + esc(x.brand || "—") + "</td>" +
          "<td style='white-space:normal'>" + esc(x.notes || "") + "</td>" +
          moneyCell(x.amount, true) +
          "<td>" + actions + "</td></tr>";
      }).join("");

      $all("[data-exp-del]").forEach(function (b) {
        b.addEventListener("click", function () {
          if (!confirm("Delete this expense?")) return;
          api("/reports/expenses/" + b.getAttribute("data-exp-del"), { method: "DELETE" }).then(function (res) {
            if (res.status === 204) { showExp("ok", "Expense deleted ✓"); loadExpenses(); loadPnl(); }
            else showExp("err", (res.data && res.data.error) || "Delete failed.");
          });
        });
      });
      $all("[data-exp-edit]").forEach(function (b) {
        b.addEventListener("click", function () {
          var cat = prompt("Category:", b.getAttribute("data-cat"));
          if (cat === null) return;
          var amt = prompt("Amount (₹):", b.getAttribute("data-amt"));
          if (amt === null) return;
          var note = prompt("Note:", b.getAttribute("data-note"));
          if (note === null) return;
          api("/reports/expenses/" + b.getAttribute("data-exp-edit"), {
            method: "PATCH",
            body: { category: cat, amount: amt, description: note || undefined },
          }).then(function (res) {
            if (res.status === 204) { showExp("ok", "Expense updated ✓"); loadExpenses(); loadPnl(); }
            else showExp("err", (res.data && res.data.error) || "Update failed.");
          });
        });
      });
    }).catch(function () {});
  }

  $("#exp-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var d = $("#exp-date").value;
    var body = {
      category: $("#exp-cat").value.trim(),
      amount: $("#exp-amount").value,
      expenseDate: d ? new Date(d + "T12:00:00").toISOString() : new Date().toISOString(),
      description: $("#exp-note").value.trim() || undefined,
    };
    var btn = $("#exp-btn");
    btn.disabled = true;
    api("/reports/expenses", { method: "POST", body: body }).then(function (r) {
      btn.disabled = false;
      if (!r.ok) { showExp("err", (r.data && r.data.error) || "Could not add expense."); return; }
      showExp("ok", "Expense added ✓ — P&L updated");
      $("#exp-cat").value = ""; $("#exp-amount").value = ""; $("#exp-note").value = "";
      loadExpenses(); loadPnl();
    }).catch(function () { btn.disabled = false; });
  });

  // ============ STORE FEES ============
  function loadFees() {
    return api("/reports/store-fees").then(function (r) {
      var tb = $("#fees-table tbody");
      if (!r.ok) { tb.innerHTML = "<tr><td colspan='7' class='empty'>Failed to load store fees</td></tr>"; return; }
      if (!r.data.length) { tb.innerHTML = "<tr><td colspan='7' class='empty'>No payout batches yet.</td></tr>"; return; }
      tb.innerHTML = r.data.map(function (f) {
        var received = !!f.receivedDate;
        return "<tr>" +
          "<td><b>" + esc(f.store) + "</b></td>" +
          "<td><span class='mp-tag'>" + esc(f.marketplace) + "</span></td>" +
          moneyCell(f.expectedAmount) +
          moneyCell(f.receivedAmount || 0) +
          "<td class='money money-hero" + (Number(f.fee) > 0.009 ? " neg" : " zero") + "'>" + inr(f.fee) + "</td>" +
          "<td>" + (received ? fmtDate(f.receivedDate) : "<span class='pill pill-pend'>awaited</span>") + "</td>" +
          "<td>" + (received ? "<span class='pill pill-ok'>RECEIVED</span>" : "<span class='pill pill-pend'>" + esc(f.status) + "</span>") + "</td></tr>";
      }).join("");
    }).catch(function () {});
  }

  // ---------- boot ----------
  loadPnl();
  loadTurnover();
  loadBalance();
  loadExpenses();
  loadFees();
})();
