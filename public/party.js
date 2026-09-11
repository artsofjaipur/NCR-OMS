/* NCR-OMS — Party Master page: supplier/party directory (add, edit, delete)
 * plus Stock In (purchase bill against a party). Split out of app.js into
 * its own page by Claude (Anthropic) 2026-09-11, per user request — see
 * BRAIN.md. Same session guard pattern as the other secondary pages. */
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
  var editingId = null;

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

  // ==================== PARTY DIRECTORY ====================
  function renderPartyTable() {
    $("#party-count").textContent = String(parties.length);
    var tb = $("#party-table tbody");
    if (!parties.length) {
      tb.innerHTML = "<tr><td colspan='6' class='empty'>No parties yet — add your first above.</td></tr>";
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
      btn.addEventListener("click", function () { startEdit(Number(btn.getAttribute("data-pt-edit"))); });
    });
    $all("[data-pt-del]").forEach(function (btn) {
      btn.addEventListener("click", function () { deleteParty(Number(btn.getAttribute("data-pt-del"))); });
    });
  }

  function fillSupplierSelect() {
    var sel = $("#sup-list");
    sel.innerHTML = parties.length
      ? "<option value=''>— pick party (optional) —</option>" + parties.map(function (s) {
          return "<option value='" + s.id + "'>" + esc(s.name) + "</option>";
        }).join("")
      : "<option value=''>No parties yet — add above</option>";
  }

  function loadParties() {
    return api("/suppliers").then(function (r) {
      if (!r.ok || !Array.isArray(r.data)) return;
      parties = r.data;
      renderPartyTable();
      fillSupplierSelect();
    });
  }

  function resetPartyForm() {
    editingId = null;
    ["pt-name", "pt-gstin", "pt-phone", "pt-email", "pt-city", "pt-state", "pt-addr1"].forEach(function (id) { $("#" + id).value = ""; });
    $("#pt-form-title").textContent = "＋ Add Party";
    $("#pt-save-btn").textContent = "Add Party";
    $("#pt-cancel-btn").hidden = true;
  }

  function startEdit(id) {
    var p = parties.find(function (x) { return x.id === id; });
    if (!p) return;
    editingId = id;
    $("#pt-name").value = p.name || "";
    $("#pt-gstin").value = p.gstin || "";
    $("#pt-phone").value = p.contactPhone || "";
    $("#pt-email").value = p.contactEmail || "";
    $("#pt-city").value = p.city || "";
    $("#pt-state").value = p.state || "";
    $("#pt-addr1").value = p.addressLine1 || "";
    $("#pt-form-title").textContent = "✎ Edit Party — " + p.name;
    $("#pt-save-btn").textContent = "Save Changes";
    $("#pt-cancel-btn").hidden = false;
    $("#pt-form").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  $("#pt-cancel-btn").addEventListener("click", resetPartyForm);

  function deleteParty(id) {
    var p = parties.find(function (x) { return x.id === id; });
    if (!p) return;
    if (!confirm("Delete party \"" + p.name + "\"? Parties with bills/payments on record cannot be deleted.")) return;
    api("/suppliers/" + id, { method: "DELETE" }).then(function (r) {
      if (r.status === 204) {
        showParty("ok", "Party deleted.");
        if (editingId === id) resetPartyForm();
        loadParties();
      } else {
        showParty("err", (r.data && r.data.error) || "Delete failed.");
      }
    });
  }

  $("#pt-form").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!canEdit) { showParty("err", "Sirf OWNER/ADMIN parties add/edit kar sakte hain."); return; }
    var name = $("#pt-name").value.trim();
    if (name.length < 2) { showParty("err", "Party name needs 2+ characters."); return; }
    var body = {
      name: name,
      gstin: $("#pt-gstin").value.trim() || undefined,
      contactPhone: $("#pt-phone").value.trim() || undefined,
      contactEmail: $("#pt-email").value.trim() || undefined,
      city: $("#pt-city").value.trim() || undefined,
      state: $("#pt-state").value.trim() || undefined,
      addressLine1: $("#pt-addr1").value.trim() || undefined,
    };
    var btn = $("#pt-save-btn");
    btn.disabled = true;
    var req = editingId
      ? api("/suppliers/" + editingId, { method: "PATCH", body: body })
      : api("/suppliers", { method: "POST", body: body });
    req.then(function (r) {
      btn.disabled = false;
      if (!r.ok && r.status !== 204) { showParty("err", (r.data && r.data.error) || "Save failed."); return; }
      showParty("ok", editingId ? "Party updated." : "Party added.");
      resetPartyForm();
      loadParties();
    }).catch(function () { btn.disabled = false; });
  });

  if (!canEdit) {
    $("#pt-save-btn").disabled = true;
    $("#pt-save-btn").title = "Sirf OWNER/ADMIN parties add/edit kar sakte hain";
  }

  // ==================== STOCK IN (PURCHASE BILL) ====================
  function renderSkuPicker() {
    api("/skus").then(function (r) {
      if (!r.ok || !Array.isArray(r.data)) return;
      var sel = $("#pi-sku");
      sel.innerHTML = r.data.length
        ? r.data.map(function (s) {
            return "<option value='" + s.id + "'>" + esc(s.code) + (s.productTitle && s.productTitle !== s.code ? " — " + esc(s.productTitle) : "") + "</option>";
          }).join("")
        : "<option value=''>No SKUs yet — add via Company & Setup</option>";
    });
  }

  function renderWarehouses() {
    api("/dashboard/summary").then(function (r) {
      if (!r.ok || !r.data) return;
      var sel = $("#pi-warehouse");
      var whs = r.data.warehouses || [];
      sel.innerHTML = whs.map(function (w) {
        return "<option value=\"" + w.id + "\">" + esc(w.name) + (w.isDefault ? " (default)" : "") + "</option>";
      }).join("") || "<option value=\"\">No warehouse</option>";
    });
  }

  $("#pi-btn").addEventListener("click", function () {
    var skuId = Number($("#pi-sku").value);
    var qty = Number($("#pi-qty").value);
    var cost = $("#pi-cost").value.trim();
    var wh = Number($("#pi-warehouse").value);
    var supplierId = Number($("#sup-list").value) || undefined;
    if (!skuId) { showSetup("err", "Pick a SKU."); return; }
    if (!qty || qty < 1) { showSetup("err", "Quantity must be at least 1."); return; }
    if (!wh) { showSetup("err", "Pick the warehouse receiving the stock."); return; }
    api("/purchases", {
      method: "POST",
      body: {
        warehouseId: wh,
        supplierId: supplierId,
        source: "PURCHASE_ORDER",
        poReference: $("#sup-list").selectedOptions && $("#sup-list").selectedOptions[0] ? $("#sup-list").selectedOptions[0].text : undefined,
        items: [{ skuId: skuId, quantity: qty, unitCost: cost ? cost : "0" }],
      },
    }).then(function (r) {
      if (!r.ok) { showSetup("err", (r.data && r.data.error) || "Stock In failed."); return; }
      showSetup("ok", "Stock In recorded — " + qty + " unit(s) added to inventory (ledger updated)."
        + (supplierId ? " Party bill reference saved." : ""));
      $("#pi-qty").value = ""; $("#pi-cost").value = "";
    });
  });

  // ---------- boot ----------
  loadParties();
  renderSkuPicker();
  renderWarehouses();
})();
