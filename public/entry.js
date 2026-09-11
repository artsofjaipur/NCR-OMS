/* NCR-OMS — Single Entry page: manual one-off order + return creation.
 * Split out of app.js into its own page by Claude (Anthropic) 2026-09-11,
 * per user request — see BRAIN.md. Same session guard pattern as the other
 * secondary pages. */
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

  function fillEntrySelects() {
    api("/dashboard/summary").then(function (r) {
      if (!r.ok || !r.data) return;
      var accounts = (r.data.accounts || []).filter(function (a) { return a.isActive !== false; });
      var opts = accounts.map(function (a) {
        return "<option value='" + a.id + "'>" + esc(a.sellerAccountLabel || a.marketplace) + " — " + esc(a.marketplace) + "</option>";
      }).join("");
      $("#so-account").innerHTML = opts || "<option value=''>No seller account — add one under Company & Setup</option>";
      var whs = r.data.warehouses || [];
      var wopts = whs.map(function (w) { return "<option value='" + w.id + "'>" + esc(w.name) + "</option>"; }).join("");
      $("#so-warehouse").innerHTML = wopts || "<option value=''>No warehouse</option>";
    });
  }

  $("#so-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var body = {
      marketplaceAccountId: Number($("#so-account").value),
      warehouseId: Number($("#so-warehouse").value),
      marketplaceOrderId: $("#so-oid").value.trim(),
      marketplaceSku: $("#so-sku").value.trim().toUpperCase(),
      quantity: Number($("#so-qty").value) || 1,
      unitPrice: $("#so-price").value,
      customerCity: $("#so-city").value.trim() || undefined,
    };
    var size = $("#so-size").value.trim();
    if (size) body.size = size;
    if (!body.marketplaceAccountId || !body.warehouseId) { entryMsg("err", "Store aur warehouse chuno."); return; }
    var btn = $("#so-btn");
    btn.disabled = true;
    api("/entry/order", { method: "POST", body: body }).then(function (r) {
      btn.disabled = false;
      if (!r.ok) { entryMsg("err", (r.data && r.data.error) || "Order entry failed."); return; }
      entryMsg("ok", "Order #" + r.data.orderId + " created — stock reserved, ledger connected ✓");
      ["#so-oid", "#so-sku", "#so-size", "#so-city"].forEach(function (s) { $(s).value = ""; });
    }).catch(function () { btn.disabled = false; });
  });

  $("#sr-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var body = { marketplaceOrderId: $("#sr-oid").value.trim() };
    if ($("#sr-awb").value.trim()) body.reverseAwb = $("#sr-awb").value.trim();
    if ($("#sr-courier").value.trim()) body.reverseCarrier = $("#sr-courier").value.trim();
    if ($("#sr-note").value.trim()) body.notes = $("#sr-note").value.trim();
    var btn = $("#sr-btn");
    btn.disabled = true;
    api("/entry/return", { method: "POST", body: body }).then(function (r) {
      btn.disabled = false;
      if (!r.ok) { entryMsg("err", (r.data && r.data.error) || "Return entry failed."); return; }
      entryMsg("ok", "Return #" + r.data.returnId + " created for order #" + r.data.orderId + " ✓");
      ["#sr-oid", "#sr-awb", "#sr-courier", "#sr-note"].forEach(function (s) { $(s).value = ""; });
    }).catch(function () { btn.disabled = false; });
  });

  $("#sr-recv-btn").addEventListener("click", function () {
    var id = Number($("#sr-recv").value);
    if (!id) { entryMsg("err", "Return ID daalo."); return; }
    api("/entry/return/" + id + "/receive", { method: "POST" }).then(function (r) {
      if (r.status === 204) { entryMsg("ok", "Return #" + id + " marked RECEIVED ✓"); $("#sr-recv").value = ""; }
      else entryMsg("err", (r.data && r.data.error) || "Receive failed.");
    });
  });

  // ---------- boot ----------
  fillEntrySelects();
})();
