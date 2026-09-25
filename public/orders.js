/* NCR-OMS — Orders page: search/filter/edit/cancel/delete. Split out of
 * app.js (the dashboard) into its own page by Claude (Anthropic)
 * 2026-09-25, per user request (Hinglish): "dusra summery desboard par hai
 * jo sahi hai lekin order page bhi vahi par ahi dono ko alag alag kaam hai
 * to usi hisab se karo na" — dashboard KPIs/Daily-Summary and the order
 * list are different jobs, so they're different pages now (matches the
 * existing /setup, /party, /entry, /team, /returns split pattern).
 *
 * Search fix (same commit): "order kese find hoga samjh me nahi aara,
 * order, awb search karne ka option nahi aara" -- the old search box only
 * ever filtered the ~50 rows already loaded on screen. GET /orders now
 * takes a real ?q= (order no / AWB / SKU) and ?status=, applied server-side
 * across the WHOLE order list -- see src/routes/orders.ts. The list fetch
 * below calls /api/orders explicitly (not the bare path) because /orders
 * itself is now a page route (this one) -- see src/app.ts's comment on
 * that route for why only this one call needed the /api/ prefix.
 */
(function () {
  "use strict";

  function $(sel) { return document.querySelector(sel); }

  // ---------- auth guard ----------
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

  // ---------- accounts (for the Marketplace column) ----------
  // This page has no KPI/upload panel of its own, so it doesn't need the
  // full /dashboard/summary payload -- just the accounts list, same source
  // the dashboard uses, so marketplace labels match exactly.
  var accounts = [];
  function accountLabel(id) {
    var a = accounts.filter(function (x) { return x.id === id; })[0];
    return a ? a.marketplace : "—";
  }
  api("/dashboard/summary").then(function (r) {
    if (r.ok && r.data && Array.isArray(r.data.accounts)) {
      accounts = r.data.accounts;
      renderOrdersTable();
    }
  });

  var RETURN_LABELS = {
    INITIATED: "Return upcoming",
    IN_TRANSIT: "Return upcoming",
    RECEIVED: "Return received",
    QC_PASSED: "QC passed",
    QC_FAILED: "QC failed",
    RESTOCKED: "Restocked",
    CLOSED: "Closed",
  };

  // ---------- orders (list, search, edit/delete) ----------
  var ordersPageSize = 50;
  var ordersLoaded = 0;
  var ordersRows = []; // accumulated across "Load more"
  var canDeleteOrders = auth.role === "OWNER" || auth.role === "ADMIN";

  function renderOrdersTable() {
    var tb = $("#orders-table tbody");
    $("#orders-empty").style.display = ordersRows.length ? "none" : "block";
    tb.innerHTML = ordersRows.map(function (o) {
      var dt = o.orderedAt ? new Date(o.orderedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";
      var skuText = o.skuSummary || "—";
      var awb = o.awbNumber || "—";
      var packedCell = o.packedAt
        ? "<span class='status pk-yes' title='" + esc(new Date(o.packedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })) + "'>PACKED</span>"
        : "<span class='pk-no'>—</span>";
      var returnCell = o.returnStatus
        ? "<button type='button' class='ret-link ord-edit' data-id='" + o.id + "' title='" + esc(o.returnType || "") + "'><span class='status ret-" + esc(o.returnStatus) + "'>" + esc(RETURN_LABELS[o.returnStatus] || o.returnStatus) + "</span></button>"
        : "<span class='muted'>—</span>";
      var showCancel = o.status !== "CANCELLED" && o.status !== "DELIVERED";
      return "<tr data-id='" + o.id + "'>" +
        "<td><b>" + esc(o.marketplaceOrderId) + "</b></td>" +
        "<td>" + esc(accountLabel(o.marketplaceAccountId)) + "</td>" +
        "<td>" + esc(skuText) + "</td>" +
        "<td>" + esc(awb) + "</td>" +
        "<td><span class='status st-" + esc(o.status) + "'>" + esc(o.status.replace(/_/g, " ")) + "</span></td>" +
        "<td>" + packedCell + "</td>" +
        "<td>" + returnCell + "</td>" +
        "<td>" + dt + "</td>" +
        "<td class='row-actions'>" +
          "<button type='button' class='btn btn-ghost btn-sm ord-edit' data-id='" + o.id + "'>Edit</button>" +
          (showCancel ? "<button type='button' class='btn btn-ghost btn-sm ord-cancel' data-id='" + o.id + "'>Cancel</button>" : "") +
          (canDeleteOrders ? "<button type='button' class='btn btn-danger btn-sm ord-del' data-id='" + o.id + "'>Delete</button>" : "") +
        "</td></tr>";
    }).join("");
  }

  // Every active filter goes to the server now (search fix, see file
  // header) -- q/status/today all combine in one query instead of q being
  // a client-side pass over whatever page happened to already be loaded.
  function activeFiltersQs() {
    var qs = "";
    var q = $("#orders-search").value.trim();
    if (q) qs += "&q=" + encodeURIComponent(q);
    var status = $("#orders-status-filter").value;
    if (status) qs += "&status=" + encodeURIComponent(status);
    if ($("#orders-today-only").checked) qs += "&today=1";
    return qs;
  }

  function loadOrders(reset) {
    if (reset) { ordersRows = []; ordersLoaded = 0; }
    var filtersQs = activeFiltersQs();
    api("/api/orders?limit=" + ordersPageSize + "&offset=" + ordersLoaded + filtersQs).then(function (r) {
      if (!r.ok || !Array.isArray(r.data)) return;
      ordersRows = ordersRows.concat(r.data);
      ordersLoaded += r.data.length;
      renderOrdersTable();
      $("#orders-load-more").hidden = r.data.length < ordersPageSize;
    });
    api("/orders/count?" + filtersQs.replace(/^&/, "")).then(function (r) {
      if (!r.ok || !r.data) return;
      var suffix = " total";
      if ($("#orders-search").value.trim() || $("#orders-status-filter").value) suffix = " matching";
      else if ($("#orders-today-only").checked) suffix = " today";
      $("#orders-count-chip").textContent = num(r.data.total) + suffix;
    });
  }

  var searchDebounce = null;
  $("#orders-search").addEventListener("input", function () {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(function () { loadOrders(true); }, 350);
  });
  $("#orders-status-filter").addEventListener("change", function () { loadOrders(true); });
  $("#orders-today-only").addEventListener("change", function () { loadOrders(true); });
  $("#orders-load-more").addEventListener("click", function () { loadOrders(false); });

  $("#orders-table tbody").addEventListener("click", function (e) {
    var editBtn = e.target.closest(".ord-edit");
    var delBtn = e.target.closest(".ord-del");
    var cancelBtn = e.target.closest(".ord-cancel");
    if (cancelBtn) cancelOrderRow(Number(cancelBtn.getAttribute("data-id")));
    else if (editBtn) openOrderModal(Number(editBtn.getAttribute("data-id")));
    else if (delBtn) deleteOrderRow(Number(delBtn.getAttribute("data-id")));
  });

  function cancelOrderRow(id) {
    var o = ordersRows.filter(function (x) { return x.id === id; })[0];
    var label = o ? o.marketplaceOrderId : id;
    if (!confirm("Cancel order \"" + label + "\"? Reserved stock is released back to inventory. This cannot be undone from here.")) return;
    api("/orders/" + id, { method: "PATCH", body: { status: "CANCELLED" } }).then(function (r) {
      if (r.ok) {
        if (o) o.status = "CANCELLED";
        renderOrdersTable();
      } else {
        alert((r.data && r.data.error) || "Cancel failed.");
      }
    });
  }

  function deleteOrderRow(id) {
    var o = ordersRows.filter(function (x) { return x.id === id; })[0];
    var label = o ? o.marketplaceOrderId : id;
    if (!confirm("Delete order \"" + label + "\"? This removes its items, shipment and return history too. This cannot be undone.")) return;
    api("/orders/" + id, { method: "DELETE" }).then(function (r) {
      if (r.status === 204) {
        ordersRows = ordersRows.filter(function (x) { return x.id !== id; });
        renderOrdersTable();
      } else {
        alert((r.data && r.data.error) || "Delete failed.");
      }
    });
  }

  /**
   * Order No, SKU(s), AWB and status all live together in this one dialog —
   * exactly the "sabhi se link ho" the floor asked for: edit any of them and
   * Save writes it back immediately, so the next scan/dispatch check reads
   * the updated state right away (no separate sync step).
   */
  function openOrderModal(id) {
    api("/orders/" + id).then(function (r) {
      if (!r.ok || !r.data) { alert((r.data && r.data.error) || "Could not load order."); return; }
      var detail = r.data;
      var o = detail.order;
      var items = detail.items || [];
      var ship = detail.shipment;
      var returnsList = detail.returns || [];

      var returnsHtml = returnsList.length
        ? "<div style='grid-column:1/-1;margin-top:6px'><b style='font-size:12.5px;color:var(--muted)'>RETURN HISTORY</b></div>" +
          "<div style='grid-column:1/-1;display:flex;flex-direction:column;gap:6px'>" +
          returnsList.map(function (rt) {
            var when = rt.initiatedAt ? new Date(rt.initiatedAt).toLocaleDateString("en-IN") : "—";
            return "<div style='display:flex;gap:8px;align-items:center;font-size:13px'>" +
              "<span class='status ret-" + esc(rt.status) + "'>" + esc(RETURN_LABELS[rt.status] || rt.status) + "</span>" +
              "<span>" + esc(rt.returnType || "unclassified") + "</span>" +
              "<span style='color:var(--muted)'>" + when + (rt.reverseAwb ? " · AWB " + esc(rt.reverseAwb) : "") + "</span>" +
              (rt.reason ? "<span style='color:var(--muted)'>· " + esc(rt.reason) + "</span>" : "") +
              "</div>";
          }).join("") +
          "</div>"
        : "";

      var itemsHtml = items.map(function (it) {
        return "<div class='fgrid fgrid-tight' style='grid-template-columns:2fr 1fr 1fr;align-items:end' data-item-id='" + it.id + "'>" +
          "<label>SKU code <input class='it-sku' type='text' value='" + esc(it.marketplaceSku) + "' /></label>" +
          "<label>Qty <input class='it-qty' type='number' min='1' value='" + it.quantity + "' /></label>" +
          "<label>Unit Price <input class='it-price' type='number' step='0.01' value='" + esc(it.unitPrice) + "' /></label>" +
          "</div>";
      }).join("");

      var m = window.NcrModal.open({
        title: "Order " + o.marketplaceOrderId,
        wide: true,
        bodyHtml:
          "<form id='ord-form' class='fgrid fgrid-tight' style='grid-template-columns:1fr 1fr'>" +
            "<label>Status <select id='ord-status'>" +
              ["CREATED", "READY_TO_DISPATCH", "DISPATCHED", "DELIVERED", "CANCELLED", "RTO_INITIATED", "ON_HOLD"].map(function (s) {
                return "<option value='" + s + "'" + (s === o.status ? " selected" : "") + ">" + s.replace(/_/g, " ") + "</option>";
              }).join("") +
            "</select></label>" +
            "<label>Invoice No. <input id='ord-invno' type='text' value='" + esc(o.invoiceNumber || "") + "' /></label>" +
            "<label>AWB Number <input id='ord-awb' type='text' value='" + esc((ship && ship.awbNumber) || "") + "' /></label>" +
            "<label>Carrier <input id='ord-carrier' type='text' value='" + esc((ship && ship.carrier) || "") + "' /></label>" +
            "<label style='grid-column:1/-1'>Hold Reason <input id='ord-hold' type='text' value='" + esc(o.holdReason || "") + "' placeholder='optional' /></label>" +
            "<div style='grid-column:1/-1;margin-top:6px'><b style='font-size:12.5px;color:var(--muted)'>ITEMS (SKU / QTY / PRICE)</b></div>" +
            "<div id='ord-items' style='grid-column:1/-1;display:flex;flex-direction:column;gap:8px'>" + (itemsHtml || "<span class='empty'>No items on this order.</span>") + "</div>" +
            returnsHtml +
            "<div id='ord-modal-result' class='result' style='grid-column:1/-1' hidden></div>" +
            "<button type='submit' class='btn' style='grid-column:1/-1' id='ord-save-btn'>Save Changes</button>" +
          "</form>",
      });

      function ordMsg(kind, msg) {
        var box = m.body.querySelector("#ord-modal-result");
        box.className = "result " + kind;
        box.textContent = msg;
        box.hidden = false;
      }

      m.body.querySelector("#ord-form").addEventListener("submit", function (e) {
        e.preventDefault();
        var patch = {
          status: m.body.querySelector("#ord-status").value,
          invoiceNumber: m.body.querySelector("#ord-invno").value.trim() || null,
          holdReason: m.body.querySelector("#ord-hold").value.trim() || null,
          shipment: {
            awbNumber: m.body.querySelector("#ord-awb").value.trim() || null,
            carrier: m.body.querySelector("#ord-carrier").value.trim() || null,
          },
          items: Array.prototype.map.call(m.body.querySelectorAll("#ord-items [data-item-id]"), function (row) {
            return {
              id: Number(row.getAttribute("data-item-id")),
              marketplaceSku: row.querySelector(".it-sku").value.trim(),
              quantity: Number(row.querySelector(".it-qty").value) || 1,
              unitPrice: row.querySelector(".it-price").value,
            };
          }),
        };
        if (!patch.items.length) delete patch.items;
        var btn = m.body.querySelector("#ord-save-btn");
        btn.disabled = true;
        api("/orders/" + id, { method: "PATCH", body: patch }).then(function (r2) {
          btn.disabled = false;
          if (!r2.ok) { ordMsg("err", (r2.data && r2.data.error) || "Save failed."); return; }
          ordMsg("ok", "Saved — updated everywhere (dashboard, dispatch, scan) immediately.");
          loadOrders(true);
          setTimeout(function () { m.close(); }, 600);
        }).catch(function () { btn.disabled = false; ordMsg("err", "Network error."); });
      });
    });
  }

  // ---------- boot ----------
  loadOrders(true);
})();
