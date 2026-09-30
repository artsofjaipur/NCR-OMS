/* NCR-OMS — Inventory / Stock report (SKU × size × product). Added
 * 2026-09-25 per user request. Same session-guard + api() helper pattern as
 * the other secondary pages (party.js, payments.js). */
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
  function num(v) { return Number(v || 0).toLocaleString("en-IN"); }

  var debounceTimer = null;
  function debounced(fn, ms) {
    return function () {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(fn, ms);
    };
  }

  function fillBrandSelect() {
    api("/dashboard/summary").then(function (r) {
      if (!r.ok || !r.data) return;
      var brands = r.data.brands || [];
      var sel = $("#inv-brand");
      sel.innerHTML = "<option value=''>— sabhi brands —</option>" + brands.map(function (b) {
        return "<option value='" + b.id + "'>" + esc(b.name) + "</option>";
      }).join("");
    });
  }

  function loadStock() {
    var q = $("#inv-search").value.trim();
    var brandId = $("#inv-brand").value;
    var params = [];
    if (q) params.push("q=" + encodeURIComponent(q));
    if (brandId) params.push("brandId=" + encodeURIComponent(brandId));
    var qs = params.length ? "?" + params.join("&") : "";
    api("/inventory/stock" + qs).then(function (r) {
      if (!r.ok || !Array.isArray(r.data)) return;
      renderStockTable(r.data);
    });
  }

  function renderStockTable(rows) {
    $("#inv-count").textContent = String(rows.length);
    var totalPieces = rows.reduce(function (s, r) { return s + Number(r.totalQty || 0); }, 0);
    $("#inv-kpi-skus").textContent = num(rows.length);
    $("#inv-kpi-pieces").textContent = num(totalPieces);

    var tb = $("#inv-table tbody");
    if (!rows.length) {
      tb.innerHTML = "<tr><td colspan='7' class='empty'>Koi stock record nahi mila — pehle <a href=\"/party\">Stock In</a> se maal receive karo.</td></tr>";
      return;
    }
    tb.innerHTML = rows.map(function (row) {
      var whBreakdown = (row.warehouses || []).map(function (w) {
        return esc(w.warehouseName) + ": " + num(w.qty);
      }).join(" · ") || "—";
      var qtyClass = Number(row.totalQty) < 0 ? "neg" : (Number(row.totalQty) === 0 ? "zero" : "pos");
      return "<tr>" +
        "<td><b>" + esc(row.code) + "</b></td>" +
        "<td>" + esc(row.productTitle || "—") + "</td>" +
        "<td>" + esc(row.size || "—") + "</td>" +
        "<td>" + esc(row.color || "—") + "</td>" +
        "<td>" + esc(row.brandName || "—") + "</td>" +
        "<td class='money " + qtyClass + "'>" + num(row.totalQty) + "</td>" +
        "<td><small>" + whBreakdown + "</small></td></tr>";
    }).join("");
  }

  function loadSummary() {
    var brandId = $("#inv-brand").value;
    var qs = brandId ? "?brandId=" + encodeURIComponent(brandId) : "";
    api("/inventory/stock/summary" + qs).then(function (r) {
      if (!r.ok || !r.data) return;
      var byProduct = r.data.byProduct || [];
      var bySize = r.data.bySize || [];
      $("#inv-by-product tbody").innerHTML = byProduct.length
        ? byProduct.map(function (p) { return "<tr><td>" + esc(p.productTitle) + "</td><td class='money'>" + num(p.qty) + "</td></tr>"; }).join("")
        : "<tr><td colspan='2' class='empty'>No data.</td></tr>";
      $("#inv-by-size tbody").innerHTML = bySize.length
        ? bySize.map(function (s) { return "<tr><td>" + esc(s.size) + "</td><td class='money'>" + num(s.qty) + "</td></tr>"; }).join("")
        : "<tr><td colspan='2' class='empty'>No data.</td></tr>";
    });
  }

  function reload() { loadStock(); loadSummary(); }

  $("#inv-search").addEventListener("input", debounced(loadStock, 300));
  $("#inv-brand").addEventListener("change", reload);

  fillBrandSelect();
  reload();
})();
