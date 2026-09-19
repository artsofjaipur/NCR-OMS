/* NCR-OMS — Single Entry page: manual one-off order + return creation.
 * Split out of app.js into its own page by Claude (Anthropic) 2026-09-11.
 * Redesigned 2026-09-19 per user request ("dilogbox se kaam me lo...
 * attractive banao") — New Order / New Return / Mark Received now open
 * modal dialogs (window.NcrModal, public/modal.js) from action cards,
 * with a small "this session" log so the page doesn't look empty between
 * entries. See BRAIN.md. Same session guard pattern as the other secondary
 * pages. */
(function () {
  "use strict";

  function $(sel) { return document.querySelector(sel); }

  var auth = null;
  try { auth = JSON.parse(sessionStorage.getItem("ncr_auth") || "null"); } catch (e) { auth = null; }
  if (!auth || !auth.token) { window.location.replace("/login.html"); return; }

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

  function entryMsg(kind, msg) {
    var box = $("#entry-result");
    box.className = "result " + kind;
    box.textContent = msg;
    box.hidden = false;
    setTimeout(function () { box.hidden = true; }, 7000);
  }

  var logEntries = [];
  function logEntry(text) {
    logEntries.unshift({ text: text, at: new Date() });
    if (logEntries.length > 20) logEntries.length = 20;
    renderLog();
  }
  function renderLog() {
    var box = $("#entry-log");
    if (!logEntries.length) {
      box.className = "empty-state";
      box.textContent = "Koi entry nahi ki gayi ab tak is session mein.";
      return;
    }
    box.className = "";
    box.innerHTML = logEntries.map(function (e) {
      var t = e.at.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
      return "<div class='log-row'><span>" + esc(e.text) + "</span><span class='log-time'>" + t + "</span></div>";
    }).join("");
  }

  function accountsAndWarehouses() {
    return api("/dashboard/summary").then(function (r) {
      if (!r.ok || !r.data) return { accounts: [], warehouses: [] };
      return {
        accounts: (r.data.accounts || []).filter(function (a) { return a.isActive !== false; }),
        warehouses: r.data.warehouses || [],
      };
    });
  }

  // ---------- New Order — modal dialog ----------
  $("#so-open-btn").addEventListener("click", function () {
    var m = window.NcrModal.open({
      title: "＋ New Order (single)",
      bodyHtml:
        "<form id='so-form' class='fgrid fgrid-tight' style='grid-template-columns:1fr 1fr'>" +
          "<label>Store <select id='so-account' required></select></label>" +
          "<label>Warehouse <select id='so-warehouse' required></select></label>" +
          "<label>Order ID <input id='so-oid' type='text' required placeholder='MKTP-12345' /></label>" +
          "<label>SKU (code) <input id='so-sku' type='text' required placeholder='VDM-001' style='text-transform:uppercase' /></label>" +
          "<label>Size <input id='so-size' type='text' placeholder='XL' /></label>" +
          "<label>Qty <input id='so-qty' type='number' min='1' value='1' required /></label>" +
          "<label>Price (₹) <input id='so-price' type='number' min='0' step='0.01' required placeholder='1299.00' /></label>" +
          "<label>City <input id='so-city' type='text' placeholder='Jaipur' /></label>" +
          "<div id='so-modal-result' class='result' style='grid-column:1/-1' hidden></div>" +
          "<button type='submit' class='btn' style='grid-column:1/-1' id='so-btn'>Create Order</button>" +
        "</form>",
    });
    function soMsg(kind, msg) {
      var box = m.body.querySelector("#so-modal-result");
      box.className = "result " + kind;
      box.textContent = msg;
      box.hidden = false;
    }
    accountsAndWarehouses().then(function (d) {
      var accSel = m.body.querySelector("#so-account");
      accSel.innerHTML = d.accounts.length
        ? d.accounts.map(function (a) { return "<option value='" + a.id + "'>" + esc(a.sellerAccountLabel || a.marketplace) + " — " + esc(a.marketplace) + "</option>"; }).join("")
        : "<option value=''>No seller account — add one under Company & Setup</option>";
      var whSel = m.body.querySelector("#so-warehouse");
      whSel.innerHTML = d.warehouses.map(function (w) { return "<option value='" + w.id + "'>" + esc(w.name) + "</option>"; }).join("") || "<option value=''>No warehouse</option>";
    });

    m.body.querySelector("#so-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var body = {
        marketplaceAccountId: Number(m.body.querySelector("#so-account").value),
        warehouseId: Number(m.body.querySelector("#so-warehouse").value),
        marketplaceOrderId: m.body.querySelector("#so-oid").value.trim(),
        marketplaceSku: m.body.querySelector("#so-sku").value.trim().toUpperCase(),
        quantity: Number(m.body.querySelector("#so-qty").value) || 1,
        unitPrice: m.body.querySelector("#so-price").value,
        customerCity: m.body.querySelector("#so-city").value.trim() || undefined,
      };
      var size = m.body.querySelector("#so-size").value.trim();
      if (size) body.size = size;
      if (!body.marketplaceAccountId || !body.warehouseId) { soMsg("err", "Store aur warehouse chuno."); return; }
      var btn = m.body.querySelector("#so-btn");
      btn.disabled = true;
      api("/entry/order", { method: "POST", body: body }).then(function (r) {
        btn.disabled = false;
        if (!r.ok) { soMsg("err", (r.data && r.data.error) || "Order entry failed."); return; }
        entryMsg("ok", "Order #" + r.data.orderId + " created — stock reserved, ledger connected ✓");
        logEntry("Order #" + r.data.orderId + " created (" + body.marketplaceOrderId + ")");
        m.close();
      }).catch(function () { btn.disabled = false; });
    });
  });

  // ---------- New Return — modal dialog ----------
  $("#sr-open-btn").addEventListener("click", function () {
    var m = window.NcrModal.open({
      title: "↩ New Return (single)",
      bodyHtml:
        "<form id='sr-form' class='fgrid fgrid-tight' style='grid-template-columns:1fr'>" +
          "<label>Order ID <input id='sr-oid' type='text' required placeholder='Order ID jo return hua' /></label>" +
          "<label>Reverse AWB <input id='sr-awb' type='text' placeholder='optional' /></label>" +
          "<label>Courier <input id='sr-courier' type='text' placeholder='optional' /></label>" +
          "<label>Note <input id='sr-note' type='text' placeholder='reason / remark' /></label>" +
          "<div id='sr-modal-result' class='result' hidden></div>" +
          "<button type='submit' class='btn ghostbtn2' id='sr-btn'>Create Return</button>" +
        "</form>",
    });
    function srMsg(kind, msg) {
      var box = m.body.querySelector("#sr-modal-result");
      box.className = "result " + kind;
      box.textContent = msg;
      box.hidden = false;
    }
    m.body.querySelector("#sr-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var body = { marketplaceOrderId: m.body.querySelector("#sr-oid").value.trim() };
      if (m.body.querySelector("#sr-awb").value.trim()) body.reverseAwb = m.body.querySelector("#sr-awb").value.trim();
      if (m.body.querySelector("#sr-courier").value.trim()) body.reverseCarrier = m.body.querySelector("#sr-courier").value.trim();
      if (m.body.querySelector("#sr-note").value.trim()) body.notes = m.body.querySelector("#sr-note").value.trim();
      var btn = m.body.querySelector("#sr-btn");
      btn.disabled = true;
      api("/entry/return", { method: "POST", body: body }).then(function (r) {
        btn.disabled = false;
        if (!r.ok) { srMsg("err", (r.data && r.data.error) || "Return entry failed."); return; }
        entryMsg("ok", "Return #" + r.data.returnId + " created for order #" + r.data.orderId + " ✓");
        logEntry("Return #" + r.data.returnId + " created for order #" + r.data.orderId);
        m.close();
      }).catch(function () { btn.disabled = false; });
    });
  });

  // ---------- Mark Return Received — modal dialog ----------
  $("#sr-recv-open-btn").addEventListener("click", function () {
    var m = window.NcrModal.open({
      title: "Mark Return Received",
      bodyHtml:
        "<div class='fgrid fgrid-tight' style='grid-template-columns:1fr'>" +
          "<label>Return ID <input id='sr-recv' type='number' min='1' placeholder='return id' /></label>" +
          "<div id='sr-recv-modal-result' class='result' hidden></div>" +
          "<button type='button' class='btn ghostbtn2' id='sr-recv-btn'>Mark Received</button>" +
        "</div>",
    });
    function recvMsg(kind, msg) {
      var box = m.body.querySelector("#sr-recv-modal-result");
      box.className = "result " + kind;
      box.textContent = msg;
      box.hidden = false;
    }
    m.body.querySelector("#sr-recv-btn").addEventListener("click", function () {
      var id = Number(m.body.querySelector("#sr-recv").value);
      if (!id) { recvMsg("err", "Return ID daalo."); return; }
      api("/entry/return/" + id + "/receive", { method: "POST" }).then(function (r) {
        if (r.status === 204) {
          entryMsg("ok", "Return #" + id + " marked RECEIVED ✓");
          logEntry("Return #" + id + " marked RECEIVED");
          m.close();
        } else recvMsg("err", (r.data && r.data.error) || "Receive failed.");
      });
    });
  });
})();
