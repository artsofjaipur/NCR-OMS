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

  // ==================== STOCK IN LEDGER ====================
  // Rebuilt 2026-09-25 per user request (Hinglish): "sabhi entry auto
  // calculate ho or edite delete option ke sath ho or entry page bhi ho
  // dilog box hi open ho" — every entry auto-calculates (Qty × Rate + GST =
  // Payable, live as you type), every row has Edit/Delete, and both the Add
  // and Edit forms are dialog boxes. Also added: bulk CSV import of a
  // party's historical "MASTER STOCK SHEET" (challan/GST/bill/payment
  // columns vary per party — the backend parser normalizes by header name,
  // see src/ingestion/parsers/stockIn.ts).
  var dash = null;
  var stockEntries = [];
  var money2 = function (v) { var n = Number(v || 0); return "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 2 }); };
  var fmtDate2 = function (v) { if (!v) return "—"; var d = new Date(v); return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }); };

  function fillWarehouseSelect(sel) {
    var whs = (dash && dash.warehouses) || [];
    sel.innerHTML = whs.length
      ? whs.map(function (w) { return "<option value=\"" + w.id + "\">" + esc(w.name) + (w.isDefault ? " (default)" : "") + "</option>"; }).join("")
      : "<option value=''>No warehouse — add via Company &amp; Setup</option>";
  }
  function fillBrandSelect(sel) {
    var brs = (dash && dash.brands) || [];
    sel.innerHTML = brs.length
      ? brs.map(function (b) { return "<option value='" + b.id + "'>" + esc(b.name) + "</option>"; }).join("")
      : "<option value=''>No brand yet — add via Company &amp; Setup</option>";
  }

  function loadStockEntries() {
    var supplierId = $("#pi-filter-supplier").value;
    return api("/purchases" + (supplierId ? "?supplierId=" + supplierId : "")).then(function (r) {
      if (!r.ok || !Array.isArray(r.data)) return;
      stockEntries = r.data;
      renderStockTable();
    });
  }

  function renderStockTable() {
    $("#pi-count").textContent = String(stockEntries.length);
    var tb = $("#pi-table tbody");
    if (!stockEntries.length) {
      tb.innerHTML = "<tr><td colspan='14' class='empty'>Koi Stock In entry nahi hai abhi — “+ Stock In Entry” ya CSV import se shuru karo.</td></tr>";
      return;
    }
    tb.innerHTML = stockEntries.map(function (e) {
      var paid = Number(e.paidAmount || 0);
      var total = Number(e.totalAmount || 0);
      var due = Math.max(0, total - paid);
      var chalan = [e.partyChalanNo, e.ourChalanNo].filter(Boolean).join(" / ") || "—";
      var actions = canEdit
        ? "<button type='button' class='bm-mini' data-si-edit='" + e.id + "'>Edit</button> " +
          "<button type='button' class='bm-mini danger' data-si-del='" + e.id + "'>Delete</button>"
        : "";
      return "<tr>" +
        "<td>" + fmtDate2(e.entryDate || e.createdAt) + "</td>" +
        "<td>" + esc(e.supplierName || "—") + "</td>" +
        "<td>" + esc(e.skuCode || "—") + (e.productTitle && e.productTitle !== e.skuCode ? "<br><small>" + esc(e.productTitle) + (e.size ? " · " + esc(e.size) : "") + "</small>" : "") + "</td>" +
        "<td style='text-align:right'>" + (e.quantity != null ? e.quantity : "—") + "</td>" +
        "<td style='text-align:right'>" + (e.unitCost != null ? money2(e.unitCost) : "—") + "</td>" +
        "<td style='text-align:right'>" + money2(e.subtotalAmount) + "</td>" +
        "<td style='text-align:right'>" + money2(e.gstAmount) + (e.gstPercent ? " <small>(" + e.gstPercent + "%)</small>" : "") + "</td>" +
        "<td style='text-align:right'><b>" + money2(e.totalAmount) + "</b></td>" +
        "<td><small>" + esc(chalan) + "</small></td>" +
        "<td><small>" + esc(e.supplierInvoiceNumber || "—") + (e.invoiceDate ? "<br>" + fmtDate2(e.invoiceDate) : "") + "</small></td>" +
        "<td style='text-align:right'>" + (paid > 0 ? "<span class='pill pill-ok'>" + money2(paid) + "</span>" : "<span class='pill'>unpaid</span>") + "</td>" +
        "<td style='text-align:right'>" + (due > 0 ? money2(due) : "—") + "</td>" +
        "<td style='text-align:right'>" + money2(e.runningBalance) + "</td>" +
        "<td style='white-space:nowrap'>" + actions + "</td></tr>";
    }).join("");

    $all("[data-si-edit]").forEach(function (btn) {
      btn.addEventListener("click", function () { openStockInModal(Number(btn.getAttribute("data-si-edit"))); });
    });
    $all("[data-si-del]").forEach(function (btn) {
      btn.addEventListener("click", function () { deleteStockEntry(Number(btn.getAttribute("data-si-del"))); });
    });
  }

  function deleteStockEntry(id) {
    var e = stockEntries.find(function (x) { return x.id === id; });
    if (!e) return;
    if (!confirm("Delete this Stock In entry (" + (e.skuCode || e.productTitle || "item") + ", qty " + e.quantity + ")? Inventory ledger auto-corrects.")) return;
    api("/purchases/" + id, { method: "DELETE" }).then(function (r) {
      if (r.status === 204) { showSetup("ok", "Entry deleted — stock ledger corrected."); loadStockEntries(); }
      else showSetup("err", (r.data && r.data.error) || "Delete failed.");
    });
  }

  function openStockInModal(editId) {
    var e = editId ? stockEntries.find(function (x) { return x.id === editId; }) : null;
    var m = window.NcrModal.open({
      wide: true,
      title: editId ? "Edit Stock In Entry" : "＋ Stock In Entry",
      bodyHtml:
        "<form id='si-form' class='fgrid fgrid-tight' style='grid-template-columns:1fr 1fr'>" +
          "<label>Party <select id='si-supplier'><option value=''>Loading parties…</option></select></label>" +
          "<label>To Warehouse <select id='si-warehouse'><option value=''>—</option></select></label>" +
          "<label>SKU <select id='si-sku'><option value=''>Loading SKUs…</option></select></label>" +
          "<label>Entry / In Date <input id='si-date' type='date' /></label>" +
          "<label>Qty Received <input id='si-qty' type='number' min='1' placeholder='e.g. 24' /></label>" +
          "<label>Rate / Qty (₹) <input id='si-rate' type='number' min='0' step='0.01' placeholder='e.g. 215.00' /></label>" +
          "<label>GST % <input id='si-gst' type='number' min='0' step='0.01' value='5' /></label>" +
          "<div></div>" +
          "<div class='result' style='grid-column:1/-1;background:var(--panel-2,#f6f6f6);padding:10px 14px;border-radius:10px;display:flex;gap:22px;flex-wrap:wrap'>" +
            "<span>Subtotal: <b id='si-calc-sub'>₹0</b></span>" +
            "<span>GST: <b id='si-calc-gst'>₹0</b></span>" +
            "<span>Payable: <b id='si-calc-total'>₹0</b></span>" +
          "</div>" +
          "<label>Party Chalan No. <input id='si-pchalan' type='text' placeholder='optional' /></label>" +
          "<label>Our Chalan No. <input id='si-ochalan' type='text' placeholder='optional' /></label>" +
          "<label>Bill / Invoice No. <input id='si-billno' type='text' placeholder='optional' /></label>" +
          "<label>Bill Date <input id='si-billdate' type='date' /></label>" +
          "<label>Remark / Notes <input id='si-remark' type='text' placeholder='optional' /></label>" +
          "<div></div>" +
          "<div id='si-modal-result' class='result' style='grid-column:1/-1' hidden></div>" +
          "<button type='submit' class='btn' style='grid-column:1/-1' id='si-save-btn'>" + (editId ? "Save Changes" : "＋ Add Entry") + "</button>" +
        "</form>" +
        (editId ? "<p class='panel-sub' style='margin-top:10px'>Payment record karne ke liye Finance → Party Ledger me “Record Payment” use karo (ye dialog sirf entry ke liye hai).</p>" : ""),
    });

    function siMsg(kind, msg) {
      var box = m.body.querySelector("#si-modal-result");
      box.className = "result " + kind;
      box.textContent = msg;
      box.hidden = false;
    }

    var supSel = m.body.querySelector("#si-supplier");
    var whSel = m.body.querySelector("#si-warehouse");
    var skuSel = m.body.querySelector("#si-sku");
    fillSupplierSelect(supSel);
    fillWarehouseSelect(whSel);
    api("/skus").then(function (r) {
      if (!r.ok || !Array.isArray(r.data)) return;
      skuSel.innerHTML = r.data.length
        ? r.data.map(function (s) { return "<option value='" + s.id + "'>" + esc(s.code) + (s.productTitle && s.productTitle !== s.code ? " — " + esc(s.productTitle) : "") + "</option>"; }).join("")
        : "<option value=''>No SKUs yet — add via Company &amp; Setup</option>";
      if (e && e.skuId) skuSel.value = String(e.skuId);
    });

    function isoDateOnly(v) { if (!v) return ""; var d = new Date(v); return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10); }

    if (e) {
      supSel.value = e.supplierId != null ? String(e.supplierId) : "";
      whSel.value = String(e.warehouseId);
      m.body.querySelector("#si-date").value = isoDateOnly(e.entryDate || e.createdAt);
      m.body.querySelector("#si-qty").value = e.quantity != null ? e.quantity : "";
      m.body.querySelector("#si-rate").value = e.unitCost != null ? e.unitCost : "";
      m.body.querySelector("#si-gst").value = e.gstPercent != null ? e.gstPercent : "5";
      m.body.querySelector("#si-pchalan").value = e.partyChalanNo || "";
      m.body.querySelector("#si-ochalan").value = e.ourChalanNo || "";
      m.body.querySelector("#si-billno").value = e.supplierInvoiceNumber || "";
      m.body.querySelector("#si-billdate").value = isoDateOnly(e.invoiceDate);
      m.body.querySelector("#si-remark").value = e.notes || "";
    } else {
      m.body.querySelector("#si-date").value = new Date().toISOString().slice(0, 10);
    }

    // ---- live auto-calculate (Qty × Rate, +GST = Payable) ----
    function recalc() {
      var qty = Number(m.body.querySelector("#si-qty").value) || 0;
      var rate = Number(m.body.querySelector("#si-rate").value) || 0;
      var gst = Number(m.body.querySelector("#si-gst").value) || 0;
      var subtotal = qty * rate;
      var gstAmt = subtotal * (gst / 100);
      var total = subtotal + gstAmt;
      m.body.querySelector("#si-calc-sub").textContent = money2(subtotal);
      m.body.querySelector("#si-calc-gst").textContent = money2(gstAmt);
      m.body.querySelector("#si-calc-total").textContent = money2(total);
    }
    ["si-qty", "si-rate", "si-gst"].forEach(function (id) {
      m.body.querySelector("#" + id).addEventListener("input", recalc);
    });
    recalc();

    m.body.querySelector("#si-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var skuId = Number(skuSel.value);
      var qty = Number(m.body.querySelector("#si-qty").value);
      var rate = m.body.querySelector("#si-rate").value.trim();
      var wh = Number(whSel.value);
      var gst = m.body.querySelector("#si-gst").value.trim();
      var supplierId = Number(supSel.value) || null;
      var dateVal = m.body.querySelector("#si-date").value;
      var billDateVal = m.body.querySelector("#si-billdate").value;
      if (!skuId) { siMsg("err", "Pick a SKU."); return; }
      if (!qty || qty < 1) { siMsg("err", "Quantity must be at least 1."); return; }
      if (!wh) { siMsg("err", "Pick the warehouse receiving the stock."); return; }

      var btn = m.body.querySelector("#si-save-btn");
      btn.disabled = true;

      var req;
      if (editId) {
        req = api("/purchases/" + editId, {
          method: "PATCH",
          body: {
            supplierId: supplierId,
            entryDate: dateVal ? new Date(dateVal).toISOString() : null,
            partyChalanNo: m.body.querySelector("#si-pchalan").value.trim() || null,
            ourChalanNo: m.body.querySelector("#si-ochalan").value.trim() || null,
            supplierInvoiceNumber: m.body.querySelector("#si-billno").value.trim() || null,
            invoiceDate: billDateVal ? new Date(billDateVal).toISOString() : null,
            notes: m.body.querySelector("#si-remark").value.trim() || null,
            gstPercent: gst || null,
            item: { skuId: skuId, quantity: qty, unitCost: rate ? rate : "0", warehouseId: wh },
          },
        });
      } else {
        req = api("/purchases", {
          method: "POST",
          body: {
            warehouseId: wh,
            supplierId: supplierId || undefined,
            source: "PURCHASE_ORDER",
            entryDate: dateVal ? new Date(dateVal).toISOString() : undefined,
            partyChalanNo: m.body.querySelector("#si-pchalan").value.trim() || undefined,
            ourChalanNo: m.body.querySelector("#si-ochalan").value.trim() || undefined,
            supplierInvoiceNumber: m.body.querySelector("#si-billno").value.trim() || undefined,
            invoiceDate: billDateVal ? new Date(billDateVal).toISOString() : undefined,
            notes: m.body.querySelector("#si-remark").value.trim() || undefined,
            gstPercent: gst || undefined,
            items: [{ skuId: skuId, quantity: qty, unitCost: rate ? rate : "0" }],
          },
        });
      }

      req.then(function (r) {
        btn.disabled = false;
        if (!r.ok && r.status !== 204) { siMsg("err", (r.data && r.data.error) || "Save failed."); return; }
        showSetup("ok", editId ? "Entry updated — ledger auto-corrected." : "Stock In recorded — " + qty + " unit(s) added, amounts auto-calculated.");
        loadStockEntries();
        m.close();
      }).catch(function () { btn.disabled = false; siMsg("err", "Network error."); });
    });
  }

  $("#pi-open-btn").addEventListener("click", function () { openStockInModal(null); });
  $("#pi-filter-supplier").addEventListener("change", loadStockEntries);

  // ---------- CSV bulk import (historical party Stock-In sheets) ----------
  function guessSupplierIdFromFilename(name) {
    var norm = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    var best = null;
    parties.forEach(function (p) {
      var pn = p.name.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (pn.length >= 3 && norm.indexOf(pn) !== -1) best = p.id;
    });
    return best;
  }

  $("#pi-import-btn").addEventListener("click", function () {
    var m = window.NcrModal.open({
      title: "Import Stock Sheet (CSV)",
      bodyHtml:
        "<div class='fgrid fgrid-tight' style='grid-template-columns:1fr'>" +
          "<p class='panel-sub' style='margin:0 0 6px'>Party ki purani \"MASTER STOCK SHEET\" (.csv) upload karo — har row ek editable Stock In entry ban jaayegi, SKU na ho to naya SKU apne aap ban jaata hai.</p>" +
          "<label>Brand (SKUs kis brand ke) <select id='ci-brand'><option value=''>Loading…</option></select></label>" +
          "<label>Party <select id='ci-supplier'><option value=''>Loading parties…</option></select></label>" +
          "<label>New party name (agar list me nahi hai) <input id='ci-sup-new' type='text' placeholder='e.g. APL' /></label>" +
          "<label>To Warehouse <select id='ci-warehouse'><option value=''>—</option></select></label>" +
          "<label>GST % (sheet me jo bhi ho, default) <input id='ci-gst' type='number' min='0' step='0.01' value='5' /></label>" +
          "<label>CSV File\n" +
            "<div class='dropzone' id='ci-drop'><span id='ci-drop-label'>Choose or drop a .csv file</span></div>" +
            "<input id='ci-file' type='file' accept='.csv' style='display:none' />" +
          "</label>" +
          "<div id='ci-modal-result' class='result' hidden></div>" +
          "<button type='button' class='btn' id='ci-btn'>⬆ Import</button>" +
        "</div>",
    });

    function ciMsg(kind, msg) {
      var box = m.body.querySelector("#ci-modal-result");
      box.className = "result " + kind;
      box.textContent = msg;
      box.hidden = false;
    }

    var brandSel = m.body.querySelector("#ci-brand");
    var supSel = m.body.querySelector("#ci-supplier");
    var whSel = m.body.querySelector("#ci-warehouse");
    fillBrandSelect(brandSel);
    fillSupplierSelect(supSel);
    fillWarehouseSelect(whSel);

    var selectedFile = null;
    var drop = m.body.querySelector("#ci-drop");
    var fileInput = m.body.querySelector("#ci-file");
    drop.addEventListener("click", function () { fileInput.click(); });
    fileInput.addEventListener("change", function () {
      if (fileInput.files && fileInput.files[0]) setCiFile(fileInput.files[0]);
    });
    function setCiFile(f) {
      if (!/\.csv$/i.test(f.name)) { ciMsg("err", "Only .csv files are accepted."); return; }
      selectedFile = f;
      m.body.querySelector("#ci-drop-label").textContent = f.name + " (" + (f.size / 1024).toFixed(1) + " KB)";
      var guess = guessSupplierIdFromFilename(f.name);
      if (guess) supSel.value = String(guess);
    }

    m.body.querySelector("#ci-btn").addEventListener("click", function () {
      var brandId = Number(brandSel.value);
      var supplierId = Number(supSel.value);
      var newSupplierName = m.body.querySelector("#ci-sup-new").value.trim();
      var wh = Number(whSel.value);
      var gst = m.body.querySelector("#ci-gst").value.trim();
      if (!brandId) { ciMsg("err", "Pick a brand (SKUs are created under it)."); return; }
      if (!supplierId && !newSupplierName) { ciMsg("err", "Pick an existing party or type a new party name."); return; }
      if (!wh) { ciMsg("err", "Pick the warehouse."); return; }
      if (!selectedFile) { ciMsg("err", "Choose a .csv file."); return; }

      var btn = m.body.querySelector("#ci-btn");
      btn.disabled = true;

      function proceedWithSupplier(supId) {
        var reader = new FileReader();
        reader.onload = function () {
          api("/purchases/import", {
            method: "POST",
            body: { brandId: brandId, supplierId: supId, warehouseId: wh, fileName: selectedFile.name, csvText: String(reader.result), gstPercent: gst || undefined },
          }).then(function (r) {
            btn.disabled = false;
            if (!r.ok) { ciMsg("err", (r.data && r.data.error) || "Import failed."); return; }
            var d = r.data;
            ciMsg("ok", d.entryCount + " entries imported (" + d.totalQuantity + " pcs, " + money2(d.totalPayable) + " payable, " + d.paidCount + " marked paid"
              + (d.skuCreatedCount ? ", " + d.skuCreatedCount + " new SKU(s) auto-created" : "") + ").");
            showSetup("ok", selectedFile.name + " imported — " + d.entryCount + " Stock In entries added.");
            loadStockEntries();
          }).catch(function () { btn.disabled = false; ciMsg("err", "Network error."); });
        };
        reader.readAsText(selectedFile);
      }

      if (!supplierId && newSupplierName) {
        api("/suppliers", { method: "POST", body: { name: newSupplierName } }).then(function (r) {
          if (!r.ok || !r.data || !r.data.id) { btn.disabled = false; ciMsg("err", "Could not create new party."); return; }
          loadParties().then(function () { proceedWithSupplier(r.data.id); });
        });
      } else {
        proceedWithSupplier(supplierId);
      }
    });
  });

  // ---------- boot ----------
  api("/dashboard/summary").then(function (r) {
    if (r.ok && r.data) {
      dash = r.data;
      var filterSel = $("#pi-filter-supplier");
      // populated properly once parties load too (loadParties re-fills the pi-sup-list select if present — kept for the old id, harmless if absent)
    }
  });
  loadParties().then(function () {
    var filterSel = $("#pi-filter-supplier");
    if (filterSel) {
      filterSel.innerHTML = "<option value=''>— sabhi parties —</option>" + parties.map(function (p) {
        return "<option value='" + p.id + "'>" + esc(p.name) + "</option>";
      }).join("");
    }
  });
  loadStockEntries();
})();
