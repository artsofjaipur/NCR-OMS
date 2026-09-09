/* NCR-OMS dashboard logic — auth guard, live KPIs, manual CSV upload. */
(function () {
  "use strict";

  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  // ---------- auth guard ----------
  var auth = null;
  try {
    auth = JSON.parse(sessionStorage.getItem("ncr_auth") || "null");
  } catch (e) { auth = null; }
  if (!auth || !auth.token) {
    window.location.replace("/login.html");
    return;
  }

  function api(path, options) {
    options = options || {};
    return fetch(path, {
      method: options.method || "GET",
      headers: Object.assign(
        { "Content-Type": "application/json" },
        { Authorization: "Bearer " + auth.token }
      ),
      body: options.body ? JSON.stringify(options.body) : undefined,
    }).then(function (res) {
      if (res.status === 401) {
        sessionStorage.removeItem("ncr_auth");
        window.location.replace("/login.html");
        throw new Error("session expired");
      }
      return res.json().catch(function () { return null; }).then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
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

  $("#tb-role").textContent = auth.role || "OWNER";

  $("#logout-btn").addEventListener("click", function () {
    sessionStorage.removeItem("ncr_auth");
    window.location.href = "/login.html";
  });

  // ---------- state ----------
  var summary = null;
  var selectedMp = "flipkart";
  var selectedFile = null;

  // ---------- marketplace segmented control ----------
  $all("#up-marketplace button").forEach(function (b) {
    b.addEventListener("click", function () {
      $all("#up-marketplace button").forEach(function (x) { x.classList.remove("sel"); });
      b.classList.add("sel");
      selectedMp = b.getAttribute("data-mp");
      fillAccountSelect();
    });
  });

  // ---------- file input + drag & drop ----------
  var dropzone = $("#dropzone");
  var fileInput = $("#up-file");
  fileInput.addEventListener("change", function () {
    if (fileInput.files.length) setFile(fileInput.files[0]);
  });
  ["dragenter", "dragover"].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) {
      e.preventDefault();
      dropzone.classList.add("drag");
    });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) {
      e.preventDefault();
      dropzone.classList.remove("drag");
    });
  });
  dropzone.addEventListener("drop", function (e) {
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) setFile(f);
  });
  function setFile(f) {
    if (!/\.csv$/i.test(f.name)) {
      showResult("err", "Only .csv files are accepted.");
      return;
    }
    selectedFile = f;
    $("#dz-name").textContent = f.name + " (" + (f.size / 1024).toFixed(1) + " KB)";
  }

  // ---------- upload ----------
  var upForm = $("#upload-form");
  upForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var resultBox = $("#upload-result");
    resultBox.hidden = true;

    var accountId = Number($("#up-account").value);
    var warehouseId = Number($("#up-warehouse").value);
    if (!accountId) { showResult("err", "Pick a seller account first — create one under your brand if the list is empty."); return; }
    if (!warehouseId) { showResult("err", "Pick a warehouse."); return; }
    if (!selectedFile) { showResult("err", "Choose a CSV file to import."); return; }

    var reader = new FileReader();
    reader.onload = function () {
      var btn = $("#up-btn");
      btn.disabled = true;
      btn.classList.add("loading");
      api("/orders/import/" + selectedMp, {
        method: "POST",
        body: {
          marketplaceAccountId: accountId,
          warehouseId: warehouseId,
          csv: String(reader.result),
        },
      }).then(function (r) {
        btn.disabled = false;
        btn.classList.remove("loading");
        if (!r.ok) {
          showResult("err", (r.data && r.data.error) || "Import failed — try again.");
          return;
        }
        var imported = r.data.imported || 0;
        var failed = r.data.failed || 0;
        var html = "<b class='ok'>" + imported + " order" + (imported === 1 ? "" : "s") + " imported</b>" +
          (failed ? ", <b>" + failed + " failed</b>" : "") + ".";
        var errs = (r.data.results || []).filter(function (x) { return x.error; }).slice(0, 5);
        if (errs.length) {
          html += "<ul>" + errs.map(function (x) {
            return "<li>" + esc(x.order || x.marketplaceOrderId || "row") + ": " + esc(x.error) + "</li>";
          }).join("") + "</ul>";
        }
        showResult(imported > 0 ? "ok" : "err", html);
        loadOrders();
        loadSummary();
      }).catch(function (err) {
        btn.disabled = false;
        btn.classList.remove("loading");
        if (err && err.message !== "session expired") showResult("err", "Network error — try again.");
      });
    };
    reader.readAsText(selectedFile);
  });

  function showResult(kind, html) {
    var box = $("#upload-result");
    box.className = "result " + kind;
    box.innerHTML = html;
    box.hidden = false;
  }

  // ---------- summary ----------
  function loadSummary() {
    api("/dashboard/summary").then(function (r) {
      if (!r.ok || !r.data) return;
      summary = r.data;

      var k = summary.kpis || {};
      $("#kpi-today .kpi-value").textContent = num(k.ordersToday);
      $("#kpi-revenue").textContent = money(k.revenueToday);
      $("#kpi-pending").textContent = num(k.pendingDispatch);
      $("#kpi-returns").textContent = num(k.returnsOpen);
      $("#kpi-total").textContent = num(k.ordersTotal);
      $("#kpi-gmv").textContent = "GMV " + money(k.gmvTotal);

      renderAccounts();
      renderWarehouses();
      renderBrands();
      renderTrend();
    });
  }

  // ---------- selects ----------
  function fillAccountSelect() {
    var sel = $("#up-account");
    var accounts = (summary && summary.accounts) || [];
    var visible = accounts.filter(function (a) {
      var mp = (a.marketplace || "").toLowerCase();
      return selectedMp === "flipkart" ? mp === "flipkart"
        : selectedMp === "meesho" ? mp === "meesho"
        : mp === "snapdeal";
    });
    sel.innerHTML = visible.length
      ? visible.map(function (a) {
          return "<option value=\"" + a.id + "\">" + esc(a.sellerAccountLabel || a.marketplace + " #" + a.id) + "</option>";
        }).join("")
      : "<option value=\"\">No " + esc(selectedMp) + " account yet</option>";
  }

  function renderAccounts() { fillAccountSelect(); }

  function renderWarehouses() {
    var sel = $("#up-warehouse");
    var whs = (summary && summary.warehouses) || [];
    sel.innerHTML = whs.map(function (w) {
      return "<option value=\"" + w.id + "\">" + esc(w.name) + (w.isDefault ? " (default)" : "") + "</option>";
    }).join("") || "<option value=\"\">No warehouse</option>";
  }

  // ---------- brands ----------
  var openManageBrandId = null;

  function renderBrands() {
    var list = $("#brand-list");
    var brands = (summary && summary.brands) || [];
    var accounts = (summary && summary.accounts) || [];
    $("#brand-count").textContent = String(brands.length);
    if (!brands.length) {
      list.innerHTML = "<div class='empty'>No brands yet — add your first below.</div>";
    } else {
      list.innerHTML = brands.map(function (b) {
        var mps = accounts.filter(function (a) { return a.brandId === b.id; });
        return "<div class='brand-row'>" +
          "<div><div class='b-name'>" + esc(b.name) + "</div></div>" +
          "<div class='b-mps'>" + mps.map(function (a) {
            return "<span class='mp-tag'>" + esc(a.marketplace) + "</span>";
          }).join("") +
          " <button type='button' class='bm-mini' data-manage='" + b.id + "'>Manage</button></div>" +
          "</div>";
      }).join("");
    }

    $all("[data-manage]").forEach(function (btn) {
      btn.addEventListener("click", function () { toggleManage(Number(btn.getAttribute("data-manage"))); });
    });

    var sel = $("#sb-brand");
    sel.innerHTML = brands.length
      ? brands.map(function (b) { return "<option value='" + b.id + "'>" + esc(b.name) + "</option>"; }).join("")
      : "<option value=''>Add a brand first</option>";

    if (openManageBrandId) renderManage(openManageBrandId);
  }

  function toggleManage(brandId) {
    openManageBrandId = openManageBrandId === brandId ? null : brandId;
    var box = $("#brand-manage");
    box.hidden = !openManageBrandId;
    if (openManageBrandId) renderManage(openManageBrandId);
  }

  function renderManage(brandId) {
    var brands = (summary && summary.brands) || [];
    var accounts = (summary && summary.accounts) || [];
    var b = brands.find(function (x) { return x.id === brandId; });
    var box = $("#brand-manage");
    if (!b) { box.hidden = true; openManageBrandId = null; return; }

    var accs = accounts.filter(function (a) { return a.brandId === brandId; });
    box.innerHTML =
      "<div class='bm-head'><b>" + esc(b.name) + "</b><span class='chip chip-dim'>BRAND</span></div>" +
      "<div class='bm-actions'>" +
        "<input type='text' id='bm-rename' placeholder='New brand name…' />" +
        "<button type='button' class='bm-mini' id='bm-rename-btn'>Rename</button>" +
        "<button type='button' class='bm-mini danger' id='bm-delete-btn'>Delete Brand</button>" +
      "</div>" +
      "<div class='bm-head' style='margin-top:14px'><b>Seller accounts</b></div>" +
      (accs.length ? accs.map(function (a) {
        return "<div class='brand-row acc-row'><div class='b-name'>" + esc(a.sellerAccountLabel || a.marketplace) + "</div>" +
          "<div class='b-mps'><span class='mp-tag'>" + esc(a.marketplace) + "</span>" +
          "<button type='button' class='bm-mini deact' data-deact='" + a.id + "'>Deactivate</button></div></div>";
      }).join("") : "<div class='empty' style='padding:8px 0'>No accounts attached.</div>") +
      "<div class='bm-head' style='margin-top:14px'><b>SKUs</b><button type='button' class='bm-mini' id='bm-skus-btn'>Show SKUs</button></div>" +
      "<div class='bm-skus' id='bm-skus' hidden></div>" +
      "<div id='bm-result' class='result' hidden></div>";

    function bmMsg(kind, msg) {
      var el = $("#bm-result");
      el.className = "result " + kind;
      el.textContent = msg;
      el.hidden = false;
    }

    // Bulk SKU add — paste list, existing skipped, new auto-mapped.
    $("#bm-bulk-btn").addEventListener("click", function () {
      var codes = $("#bm-bulk-codes").value.trim();
      if (!codes) { bmMsg("err", "Paste at least one SKU code."); return; }
      api("/skus/bulk", { method: "POST", body: { brandId: brandId, codes: codes } }).then(function (r) {
        if (!r.ok) { bmMsg("err", (r.data && r.data.error) || "Bulk add failed."); return; }
        var d = r.data;
        bmMsg(d.created ? "ok" : "err",
          d.created + " SKU(s) added" + (d.skipped && d.skipped.length ? ", " + d.skipped.length + " already existed (skipped)" : "") +
          (d.mapped ? " · " + d.mapped + " account mappings ensured" : ""));
        $("#bm-bulk-codes").value = "";
        loadSummary();
      });
    });

    $("#bm-rename-btn").addEventListener("click", function () {
      var name = $("#bm-rename").value.trim();
      if (name.length < 2) { bmMsg("err", "Name needs 2+ characters."); return; }
      api("/companies/me/brands/" + brandId, { method: "PATCH", body: { name: name } }).then(function (r) {
        if (!r.ok) { bmMsg("err", (r.data && r.data.error) || "Rename failed."); return; }
        bmMsg("ok", "Renamed.");
        loadSummary();
      });
    });

    $("#bm-delete-btn").addEventListener("click", function () {
      if (!confirm("Delete brand \"" + b.name + "\"? This also removes its accounts and SKUs. Brands with orders cannot be deleted.")) return;
      api("/companies/me/brands/" + brandId, { method: "DELETE" }).then(function (r) {
        if (r.status === 204) {
          bmMsg("ok", "Brand deleted.");
          openManageBrandId = null;
          box.hidden = true;
          loadSummary();
        } else {
          bmMsg("err", (r.data && r.data.error) || "Delete failed.");
        }
      });
    });

    $all("[data-deact]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var accId = Number(btn.getAttribute("data-deact"));
        api("/companies/me/marketplace-accounts/" + accId, { method: "PATCH", body: { isActive: false } }).then(function (r) {
          if (r.status === 204) { bmMsg("ok", "Account deactivated — it no longer appears in upload selects."); loadSummary(); }
          else bmMsg("err", (r.data && r.data.error) || "Failed.");
        });
      });
    });

    $("#bm-skus-btn").addEventListener("click", function () {
      var pane = $("#bm-skus");
      if (!pane.hidden) { pane.hidden = true; return; }
      api("/companies/me/brands/" + brandId + "/skus").then(function (r) {
        if (!r.ok || !Array.isArray(r.data)) { bmMsg("err", "Could not load SKUs."); return; }
        pane.innerHTML = r.data.length
          ? r.data.map(function (s) {
              return "<div class='bm-sku-row'><b>" + esc(s.code) + "</b><span>" + esc(s.productTitle) + (s.size ? " · " + esc(s.size) : "") + "</span></div>";
            }).join("")
          : "<div class='empty' style='padding:8px 0'>No SKUs yet — add via SKU API or ask support for the bulk importer.</div>";
        pane.hidden = false;
      });
    });
  }

  // ---------- parties & stock in (purchase bills) ----------
  function renderParties() {
    api("/suppliers").then(function (r) {
      if (!r.ok || !Array.isArray(r.data)) return;
      var sel = $("#sup-list");
      sel.innerHTML = r.data.length
        ? "<option value=''>— pick party (optional) —</option>" + r.data.map(function (s) {
            return "<option value='" + s.id + "'>" + esc(s.name) + "</option>";
          }).join("")
        : "<option value=''>No parties yet — add above</option>";
    });
  }

  function renderSkuPicker() {
    api("/skus").then(function (r) {
      if (!r.ok || !Array.isArray(r.data)) return;
      var sel = $("#pi-sku");
      sel.innerHTML = r.data.length
        ? r.data.map(function (s) {
            return "<option value='" + s.id + "'>" + esc(s.code) + (s.productTitle && s.productTitle !== s.code ? " — " + esc(s.productTitle) : "") + "</option>";
          }).join("")
        : "<option value=''>No SKUs yet — add via Brands panel</option>";
    });
  }

  $("#sup-add-btn").addEventListener("click", function () {
    var name = $("#sup-name").value.trim();
    if (name.length < 2) { showSetup("err", "Party name needs 2+ characters."); return; }
    api("/suppliers", { method: "POST", body: { name: name } }).then(function (r) {
      if (!r.ok) { showSetup("err", (r.data && r.data.error) || "Could not add party."); return; }
      $("#sup-name").value = "";
      showSetup("ok", "Party added.");
      renderParties();
    });
  });

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

  // ---------- workspace setup (brands + marketplace accounts) ----------
  function showSetup(kind, msg) {
    var box = $("#setup-result");
    box.className = "result " + kind;
    box.textContent = msg;
    box.hidden = false;
  }

  $("#sb-brand-btn").addEventListener("click", function () {
    var nameEl = $("#sb-brand-name");
    var name = nameEl.value.trim();
    if (name.length < 2) { showSetup("err", "Brand name needs at least 2 characters."); return; }
    api("/companies/me/brands", { method: "POST", body: { name: name } }).then(function (r) {
      if (!r.ok) { showSetup("err", (r.data && r.data.error) || "Could not add brand."); return; }
      nameEl.value = "";
      showSetup("ok", "Brand added.");
      loadSummary();
    });
  });

  $("#sb-account-btn").addEventListener("click", function () {
    var brandId = Number($("#sb-brand").value);
    var mp = $("#sb-mp").value;
    var label = $("#sb-label").value.trim();
    if (!brandId) { showSetup("err", "Pick (or add) a brand first."); return; }
    if (!label) { showSetup("err", "Give the seller account a label, e.g. \"Vardhamiti Official\"."); return; }
    api("/companies/me/marketplace-accounts", {
      method: "POST",
      body: { brandId: brandId, marketplace: mp, sellerAccountLabel: label },
    }).then(function (r) {
      if (!r.ok) { showSetup("err", (r.data && r.data.error) || "Could not attach account."); return; }
      $("#sb-label").value = "";
      showSetup("ok", "Seller account attached — it now appears in the upload form.");
      loadSummary();
    });
  });

  // ---------- trend ----------
  function renderTrend() {
    var chart = $("#trend-chart");
    var trend = (summary && summary.trend) || [];
    var byDay = {};
    trend.forEach(function (t) { byDay[t.day] = t; });

    var days = [];
    for (var i = 13; i >= 0; i--) {
      var d = new Date();
      d.setDate(d.getDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }
    var counts = days.map(function (day) { return (byDay[day] && byDay[day].count) || 0; });
    var max = Math.max.apply(null, counts.concat([1]));

    chart.innerHTML = days.map(function (day, idx) {
      var h = Math.max(3, Math.round((counts[idx] / max) * 100));
      return "<div class='bar' title='" + day + ": " + counts[idx] + " orders' style='height:" + h + "%;animation-delay:" + (idx * 40) + "ms'></div>";
    }).join("");

    var total14 = counts.reduce(function (a, b) { return a + b; }, 0);
    var rev14 = days.reduce(function (a, day) {
      return a + Number((byDay[day] && byDay[day].revenue) || 0);
    }, 0);
    $("#trend-foot").innerHTML = "<b>" + num(total14) + "</b> orders in 14 days &middot; <b>" + money(rev14) + "</b> revenue";
  }

  // ---------- recent orders ----------
  function loadOrders() {
    api("/orders").then(function (r) {
      if (!r.ok || !Array.isArray(r.data)) return;
      var rows = r.data.slice(0, 20);
      var accounts = (summary && summary.accounts) || [];
      var accMap = {};
      accounts.forEach(function (a) { accMap[a.id] = a.marketplace; });

      var tb = $("#orders-table tbody");
      $("#orders-empty").style.display = rows.length ? "none" : "block";
      tb.innerHTML = rows.map(function (o) {
        var dt = o.orderedAt ? new Date(o.orderedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";
        return "<tr>" +
          "<td><b>" + esc(o.marketplaceOrderId) + "</b></td>" +
          "<td>" + esc(accMap[o.marketplaceAccountId] || "—") + "</td>" +
          "<td><span class='status st-" + esc(o.status) + "'>" + esc(o.status.replace(/_/g, " ")) + "</span></td>" +
          "<td>—</td>" +
          "<td>" + dt + "</td></tr>";
      }).join("");
    });
  }

  // ---------- boot ----------
  loadSummary();
  loadOrders();
  renderParties();
  renderSkuPicker();
})();
