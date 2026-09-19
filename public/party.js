/* NCR-OMS — Party Master page: supplier/party directory (add, edit, delete)
 * plus Stock In (purchase bill against a party). Split out of app.js into
 * its own page by Claude (Anthropic) 2026-09-11. Redesigned 2026-09-19 per
 * user request ("dilogbox se kaam me lo... attractive banao") — Add/Edit
 * Party and Stock In both moved into modal dialogs (window.NcrModal,
 * public/modal.js) instead of always-visible inline forms. See BRAIN.md.
 * Same session guard pattern as the other secondary pages. */
(function () {
  "use strict";

  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

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

  var canEdit = auth.role === "OWNER" || auth.role === "ADMIN";
  var parties = [];

  function showParty(kind, msg) {
    var box = $("#party-result");
    box.className = "result " + kind;
    box.textContent = msg;
    box.hidden = false;
    setTimeout(function () { box.hidden = true; }, 6000);
  }
  function showSetup(kind, msg) {
    var box = $("#setup-result");
    box.className = "result " + kind;
    box.textContent = msg;
    box.hidden = false;
  }

  if (!canEdit) {
    $("#pt-open-btn").disabled = true;
    $("#pt-open-btn").title = "Sirf OWNER/ADMIN parties add/edit kar sakte hain";
  }

  // ==================== PARTY DIRECTORY ====================
  function renderPartyTable() {
    $("#party-count").textContent = String(parties.length);
    var tb = $("#party-table tbody");
    if (!parties.length) {
      tb.innerHTML = "<tr><td colspan='6' class='empty'>No parties yet — click “+ Add Party” above.</td></tr>";
      return;
    }
    tb.innerHTML = parties.map(function (p) {
      var actions = canEdit
        ? "<button type='button' class='bm-mini' data-pt-edit='" + p.id + "'>Edit</button> " +
          "<button type='button' class='bm-mini danger' data-pt-del='" + p.id + "'>Delete</button>"
        : "";
      return "<tr>" +
        "<td><b>" + esc(p.name) + "</b></td>" +
        "<td>" + esc(p.gstin || "—") + "</td>" +
        "<td>" + esc(p.contactPhone || "—") + "</td>" +
        "<td>" + esc(p.contactEmail || "—") + "</td>" +
        "<td>" + esc(p.city || "—") + "</td>" +
        "<td style='white-space:nowrap'>" + actions + "</td></tr>";
    }).join("");

    $all("[data-pt-edit]").forEach(function (btn) {
      btn.addEventListener("click", function () { openPartyModal(Number(btn.getAttribute("data-pt-edit"))); });
    });
    $all("[data-pt-del]").forEach(function (btn) {
      btn.addEventListener("click", function () { deleteParty(Number(btn.getAttribute("data-pt-del"))); });
    });
  }

  function loadParties() {
    return api("/suppliers").then(function (r) {
      if (!r.ok || !Array.isArray(r.data)) return;
      parties = r.data;
      renderPartyTable();
      var stockSel = document.getElementById("pi-sup-list");
      if (stockSel) fillSupplierSelect(stockSel);
    });
  }

  function fillSupplierSelect(sel) {
    sel.innerHTML = parties.length
      ? "<option value=''>— pick party (optional) —</option>" + parties.map(function (s) {
          return "<option value='" + s.id + "'>" + esc(s.name) + "</option>";
        }).join("")
      : "<option value=''>No parties yet — add one first</option>";
  }

  function deleteParty(id) {
    var p = parties.find(function (x) { return x.id === id; });
    if (!p) return;
    if (!confirm("Delete party \"" + p.name + "\"? Parties with bills/payments on record cannot be deleted.")) return;
    api("/suppliers/" + id, { method: "DELETE" }).then(function (r) {
      if (r.status === 204) {
        showParty("ok", "Party deleted.");
        loadParties();
      } else {
        showParty("err", (r.data && r.data.error) || "Delete failed.");
      }
    });
  }

  // ---------- Add / Edit Party — modal dialog ----------
  function openPartyModal(editId) {
    var p = editId ? parties.find(function (x) { return x.id === editId; }) : null;
    var m = window.NcrModal.open({
      title: editId ? "Edit Party — " + p.name : "Add Party",
      bodyHtml:
        "<form id='pt-form' class='fgrid fgrid-tight' style='grid-template-columns:1fr 1fr'>" +
          "<label style='grid-column:1/-1'>Name <input id='pt-name' type='text' required placeholder='e.g. Shree Textiles' /></label>" +
          "<label>GSTIN <input id='pt-gstin' type='text' maxlength='15' placeholder='optional' style='text-transform:uppercase' /></label>" +
          "<label>Phone <input id='pt-phone' type='text' placeholder='+91 ...' /></label>" +
          "<label>Email <input id='pt-email' type='email' placeholder='optional' /></label>" +
          "<label>City <input id='pt-city' type='text' placeholder='optional' /></label>" +
          "<label>State <input id='pt-state' type='text' placeholder='optional' /></label>" +
          "<label style='grid-column:1/-1'>Address Line 1 <input id='pt-addr1' type='text' placeholder='optional' /></label>" +
          "<div id='pt-modal-result' class='result' style='grid-column:1/-1' hidden></div>" +
          "<button type='submit' class='btn' style='grid-column:1/-1' id='pt-save-btn'>" + (editId ? "Save Changes" : "Add Party") + "</button>" +
        "</form>",
    });
    if (p) {
      m.body.querySelector("#pt-name").value = p.name || "";
      m.body.querySelector("#pt-gstin").value = p.gstin || "";
      m.body.querySelector("#pt-phone").value = p.contactPhone || "";
      m.body.querySelector("#pt-email").value = p.contactEmail || "";
      m.body.querySelector("#pt-city").value = p.city || "";
      m.body.querySelector("#pt-state").value = p.state || "";
      m.body.querySelector("#pt-addr1").value = p.addressLine1 || "";
    }

    function ptMsg(kind, msg) {
      var box = m.body.querySelector("#pt-modal-result");
      box.className = "result " + kind;
      box.textContent = msg;
      box.hidden = false;
    }

    m.body.querySelector("#pt-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var name = m.body.querySelector("#pt-name").value.trim();
      if (name.length < 2) { ptMsg("err", "Party name needs 2+ characters."); return; }
      var body = {
        name: name,
        gstin: m.body.querySelector("#pt-gstin").value.trim() || undefined,
        contactPhone: m.body.querySelector("#pt-phone").value.trim() || undefined,
        contactEmail: m.body.querySelector("#pt-email").value.trim() || undefined,
        city: m.body.querySelector("#pt-city").value.trim() || undefined,
        state: m.body.querySelector("#pt-state").value.trim() || undefined,
        addressLine1: m.body.querySelector("#pt-addr1").value.trim() || undefined,
      };
      var btn = m.body.querySelector("#pt-save-btn");
      btn.disabled = true;
      var req = editId
        ? api("/suppliers/" + editId, { method: "PATCH", body: body })
        : api("/suppliers", { method: "POST", body: body });
      req.then(function (r) {
        btn.disabled = false;
        if (!r.ok && r.status !== 204) { ptMsg("err", (r.data && r.data.error) || "Save failed."); return; }
        showParty("ok", editId ? "Party updated." : "Party added.");
        loadParties();
        m.close();
      }).catch(function () { btn.disabled = false; });
    });
  }

  $("#pt-open-btn").addEventListener("click", function () { openPartyModal(null); });

  // ==================== STOCK IN (PURCHASE BILL) ====================
  $("#pi-open-btn").addEventListener("click", function () {
    var m = window.NcrModal.open({
      title: "Stock In (Purchase Bill)",
      bodyHtml:
        "<div class='fgrid fgrid-tight' style='grid-template-columns:1fr'>" +
          "<label>SKU <select id='pi-sku'><option value=''>Loading SKUs…</option></select></label>" +
          "<label>Qty Received <input id='pi-qty' type='number' min='1' placeholder='e.g. 24' /></label>" +
          "<label>Unit Cost (₹) <input id='pi-cost' type='number' min='0' step='0.01' placeholder='e.g. 450.00' /></label>" +
          "<label>To Warehouse <select id='pi-warehouse'><option value=''>—</option></select></label>" +
          "<label>Party (stock source) <select id='pi-sup-list'><option value=''>Loading parties…</option></select></label>" +
          "<div id='pi-modal-result' class='result' hidden></div>" +
          "<button type='button' class='btn' id='pi-btn'>＋ Stock In (Purchase Bill)</button>" +
        "</div>",
    });

    function piMsg(kind, msg) {
      var box = m.body.querySelector("#pi-modal-result");
      box.className = "result " + kind;
      box.textContent = msg;
      box.hidden = false;
    }

    var skuSel = m.body.querySelector("#pi-sku");
    var whSel = m.body.querySelector("#pi-warehouse");
    var supSel = m.body.querySelector("#pi-sup-list");
    fillSupplierSelect(supSel);

    api("/skus").then(function (r) {
      if (!r.ok || !Array.isArray(r.data)) return;
      skuSel.innerHTML = r.data.length
        ? r.data.map(function (s) {
            return "<option value='" + s.id + "'>" + esc(s.code) + (s.productTitle && s.productTitle !== s.code ? " — " + esc(s.productTitle) : "") + "</option>";
          }).join("")
        : "<option value=''>No SKUs yet — add via Company & Setup</option>";
    });
    api("/dashboard/summary").then(function (r) {
      if (!r.ok || !r.data) return;
      var whs = r.data.warehouses || [];
      whSel.innerHTML = whs.map(function (w) {
        return "<option value=\"" + w.id + "\">" + esc(w.name) + (w.isDefault ? " (default)" : "") + "</option>";
      }).join("") || "<option value=\"\">No warehouse</option>";
    });

    m.body.querySelector("#pi-btn").addEventListener("click", function () {
      var skuId = Number(skuSel.value);
      var qty = Number(m.body.querySelector("#pi-qty").value);
      var cost = m.body.querySelector("#pi-cost").value.trim();
      var wh = Number(whSel.value);
      var supplierId = Number(supSel.value) || undefined;
      if (!skuId) { piMsg("err", "Pick a SKU."); return; }
      if (!qty || qty < 1) { piMsg("err", "Quantity must be at least 1."); return; }
      if (!wh) { piMsg("err", "Pick the warehouse receiving the stock."); return; }
      api("/purchases", {
        method: "POST",
        body: {
          warehouseId: wh,
          supplierId: supplierId,
          source: "PURCHASE_ORDER",
          poReference: supSel.selectedOptions && supSel.selectedOptions[0] ? supSel.selectedOptions[0].text : undefined,
          items: [{ skuId: skuId, quantity: qty, unitCost: cost ? cost : "0" }],
        },
      }).then(function (r) {
        if (!r.ok) { piMsg("err", (r.data && r.data.error) || "Stock In failed."); return; }
        showSetup("ok", "Stock In recorded — " + qty + " unit(s) added to inventory (ledger updated)."
          + (supplierId ? " Party bill reference saved." : ""));
        m.close();
      });
    });
  });

  // ---------- boot ----------
  loadParties();
})();
