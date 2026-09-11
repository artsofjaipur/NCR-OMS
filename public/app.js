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

  // ---------- live analog clock + date (topbar) — Claude (Anthropic) 2026-09-11 ----------
  // Pure client-side (uses the browser's own local time — no server round-trip),
  // so it keeps ticking even on a slow connection. See BRAIN.md 2026-09-11.
  (function initLiveClock() {
    var svgNS = "http://www.w3.org/2000/svg";
    var ticks = $("#tb-clock-ticks");
    var hourHand = $("#tb-clock-hour");
    var minHand = $("#tb-clock-min");
    var secHand = $("#tb-clock-sec");
    var digital = $("#tb-clock-digital");
    var dateEl = $("#tb-clock-date");
    if (!ticks || !hourHand || !minHand || !secHand || !digital || !dateEl) return;

    // 12 tick marks around the face, drawn once.
    for (var i = 0; i < 12; i++) {
      var angle = i * 30;
      var isMajor = i % 3 === 0; // 12/3/6/9 get a slightly longer tick
      var line = document.createElementNS(svgNS, "line");
      line.setAttribute("x1", "50");
      line.setAttribute("y1", isMajor ? "6" : "8");
      line.setAttribute("x2", "50");
      line.setAttribute("y2", "13");
      line.setAttribute("transform", "rotate(" + angle + " 50 50)");
      if (isMajor) line.style.strokeWidth = "3";
      ticks.appendChild(line);
    }

    function pad(n) { return n < 10 ? "0" + n : String(n); }
    var DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    function tick() {
      var now = new Date();
      var h = now.getHours() % 12;
      var m = now.getMinutes();
      var s = now.getSeconds();

      hourHand.style.transform = "rotate(" + (h * 30 + m * 0.5) + "deg)";
      minHand.style.transform = "rotate(" + (m * 6 + s * 0.1) + "deg)";
      secHand.style.transform = "rotate(" + (s * 6) + "deg)";

      var h12 = now.getHours() % 12 || 12;
      var ampm = now.getHours() < 12 ? "AM" : "PM";
      digital.textContent = pad(h12) + ":" + pad(m) + ":" + pad(s) + " " + ampm;
      dateEl.textContent = DOW[now.getDay()] + ", " + now.getDate() + " " + MON[now.getMonth()] + " " + now.getFullYear();
    }
    tick();
    setInterval(tick, 1000);
  })();

  $("#logout-btn").addEventListener("click", function () {
    sessionStorage.removeItem("ncr_auth");
    window.location.href = "/login.html";
  });

  // ---------- state ----------
  var summary = null;
  var selectedFile = null;
  var myPermissions = (auth && auth.permissions) || [];

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
      var selAcc = $("#up-account").selectedOptions && $("#up-account").selectedOptions[0];
      var mp = selAcc && selAcc.getAttribute("data-mp") ? selAcc.getAttribute("data-mp").toLowerCase() : "flipkart";
      api("/orders/import/" + mp, {
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
      fillEntrySelects();
    });
  }

  // ---------- company profile (view/edit + bank accounts) ----------
  var canEditCompany = auth.role === "OWNER" || auth.role === "ADMIN";

  function cpMsg(kind, msg) {
    var box = $("#cp-result");
    box.className = "result " + kind;
    box.textContent = msg;
    box.hidden = false;
    setTimeout(function () { box.hidden = true; }, 6000);
  }

  function fillCompanyProfile(c) {
    $("#tb-company").textContent = c.displayName || "";
    $("#cp-prefix-chip").textContent = c.orderReferencePrefix || "set prefix";
    $("#cp-legal").value = c.legalName || "";
    $("#cp-display").value = c.displayName || "";
    $("#cp-prefix").value = c.orderReferencePrefix || "";
    $("#cp-gstin").value = c.gstin || "";
    $("#cp-iec").value = c.iec || c.pan || "";
    $("#cp-phone").value = c.phone || "";
    $("#cp-whatsapp").value = c.whatsapp || "";
    $("#cp-email").value = c.email || "";
    $("#cp-addr1").value = c.addressLine1 || "";
    $("#cp-city").value = c.city || "";
    $("#cp-state").value = c.state || "";
    $("#cp-pincode").value = c.pincode || "";
    if (!canEditCompany) {
      ["cp-legal","cp-display","cp-prefix","cp-gstin","cp-iec","cp-phone","cp-whatsapp","cp-email","cp-addr1","cp-city","cp-state","cp-pincode"].forEach(function (id) { $("#" + id).disabled = true; });
      $("#cp-save-btn").disabled = true;
      $("#cp-readonly-note").hidden = false;
    }
  }

  function loadCompanyProfile() {
    api("/companies/me").then(function (r) {
      if (!r.ok || !r.data) return;
      var c = r.data;
      fillCompanyProfile(c);
      var banks = (c.bankAccounts || []).map(function (b) {
        return "<div class='bm-card'>" +
          "<div><b>" + esc(b.label || "Account") + "</b>" + (b.isPrimary ? " <span class='pill pill-ok'>PRIMARY</span>" : "") + "</div>" +
          "<div class='small'>" + esc(b.bankName || "") + " · " + esc(b.ifsc || "") + "</div>" +
          "<div class='small'>A/C: " + esc(b.accountNumberMasked || "••••") + "</div>" +
          "<div class='small'>AD Code: " + esc(b.adCode || "—") + "</div>" +
          "</div>";
      }).join("");
      $("#cp-banks").innerHTML = banks || "<div class='small' style='color:var(--muted)'>No bank account yet — invoice auto-fill ke liye add karo.</div>";
    });
  }

  $("#cp-form").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!canEditCompany) return;
    var body = {
      legalName: $("#cp-legal").value.trim() || undefined,
      displayName: $("#cp-display").value.trim() || undefined,
      orderReferencePrefix: $("#cp-prefix").value.trim() || undefined,
      gstin: $("#cp-gstin").value.trim().length === 15 ? $("#cp-gstin").value.trim() : undefined,
      iec: $("#cp-iec").value.trim() || undefined,
      phone: $("#cp-phone").value.trim() || undefined,
      whatsapp: $("#cp-whatsapp").value.trim() || undefined,
      email: $("#cp-email").value.trim() || undefined,
      addressLine1: $("#cp-addr1").value.trim() || undefined,
      city: $("#cp-city").value.trim() || undefined,
      state: $("#cp-state").value.trim() || undefined,
      pincode: $("#cp-pincode").value.trim().length === 6 ? $("#cp-pincode").value.trim() : undefined,
    };
    api("/companies/me", { method: "PATCH", body: body }).then(function (r) {
      if (r.status === 204) { cpMsg("ok", "Company profile saved ✓"); loadCompanyProfile(); }
      else cpMsg("err", (r.data && r.data.error) || "Save failed — check GSTIN (15) / PIN (6) / email format.");
    });
  });

  $("#bk-add-btn").addEventListener("click", function () {
    if (!canEditCompany) return;
    var body = {
      label: $("#bk-label").value.trim(),
      accountHolderName: $("#bk-holder").value.trim(),
      accountNumber: $("#bk-number").value.trim(),
      ifsc: $("#bk-ifsc").value.trim().toUpperCase(),
      bankName: $("#bk-bank").value.trim(),
      adCode: $("#bk-adcode").value.trim() || undefined,
    };
    if (!body.label || !body.accountHolderName || !body.accountNumber || body.ifsc.length !== 11 || !body.bankName) {
      cpMsg("err", "Bank form poora bharo — IFSC 11 characters ka hona chahiye.");
      return;
    }
    api("/companies/me/bank-accounts", { method: "POST", body: body }).then(function (r) {
      if (r.status === 201) {
        cpMsg("ok", "Bank account added ✓ (number encrypted store hua)");
        ["bk-label","bk-holder","bk-number","bk-ifsc","bk-bank","bk-adcode"].forEach(function (id) { $("#" + id).value = ""; });
        loadCompanyProfile();
      } else cpMsg("err", (r.data && r.data.error) || "Bank account add failed.");
    });
  });

  loadCompanyProfile();

  // ---------- selects ----------
  // Seller account IS the selector — its marketplace auto-detected and shown
  // as a badge (user request: "seller account ke according marketplace change
  // ho jane chahiye").
  function fillAccountSelect() {
    var sel = $("#up-account");
    var accounts = ((summary && summary.accounts) || []).filter(function (a) { return a.isActive !== false; });
    sel.innerHTML = accounts.length
      ? accounts.map(function (a) {
          return "<option value=\"" + a.id + "\" data-mp=\"" + esc(a.marketplace) + "\">" +
            esc(a.sellerAccountLabel || a.marketplace + " #" + a.id) + " — " + esc(a.marketplace) +
            (a.brand ? " (" + esc(a.brand) + ")" : "") + "</option>";
        }).join("")
      : "<option value=\"\">No seller account yet — add under Brands &amp; Setup</option>";
    updateMpBadge();
  }

  function updateMpBadge() {
    var sel = $("#up-account");
    var opt = sel.selectedOptions && sel.selectedOptions[0];
    var badge = $("#up-mp-badge");
    if (badge) badge.textContent = opt && opt.getAttribute("data-mp") ? opt.getAttribute("data-mp") : "—";
  }

  function renderAccounts() { fillAccountSelect(); }
  $("#up-account").addEventListener("change", updateMpBadge);

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
        var active = a.isActive !== false;
        return "<div class='brand-row acc-row'><div class='b-name'>" + esc(a.sellerAccountLabel || a.marketplace) +
          (active ? "" : " <span class='pill pill-red' style='margin-left:6px'>OFF</span>") + "</div>" +
          "<div class='b-mps'><span class='mp-tag'>" + esc(a.marketplace) + "</span>" +
          "<button type='button' class='bm-mini deact' data-deact='" + a.id + "' data-next='" + (active ? "false" : "true") + "'>" + (active ? "Deactivate" : "Activate") + "</button></div></div>";
      }).join("") : "<div class='empty' style='padding:8px 0'>No accounts attached.</div>") +
      "<div class='bm-head' style='margin-top:14px'><b>SKUs</b><button type='button' class='bm-mini' id='bm-skus-btn'>Show SKUs</button></div>" +
      "<div class='bm-skus' id='bm-skus' hidden></div>" +
      "<div class='bm-head' style='margin-top:14px'><b>Add SKUs (bulk paste)</b></div>" +
      "<textarea id='bm-bulk-codes' rows='3' placeholder='Ek line me ek SKU code…\nJK-1001-A\nJK-1001-B' style='width:100%;background:var(--bg2);border:1.5px solid var(--line2);color:var(--text);border-radius:10px;padding:10px 12px;font:inherit;font-size:13px;outline:none'></textarea>" +
      "<button type='button' class='bm-mini' id='bm-bulk-btn' style='margin-top:8px'>Add SKUs</button>" +
      "<div id='bm-result' class='result' hidden></div>";

    function bmMsg(kind, msg) {
      var el = $("#bm-result");
      el.className = "result " + kind;
      el.textContent = msg;
      el.hidden = false;
    }

    function on(sel, fn) {
      var el = $(sel);
      if (el) el.addEventListener("click", fn);
    }

    // Bulk SKU add — paste list, existing skipped, new auto-mapped.
    on("#bm-bulk-btn", function () {
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

    on("#bm-rename-btn", function () {
      var name = $("#bm-rename").value.trim();
      if (name.length < 2) { bmMsg("err", "Name needs 2+ characters."); return; }
      api("/companies/me/brands/" + brandId, { method: "PATCH", body: { name: name } }).then(function (r) {
        if (!r.ok) { bmMsg("err", (r.data && r.data.error) || "Rename failed."); return; }
        bmMsg("ok", "Renamed.");
        loadSummary();
      });
    });

    on("#bm-delete-btn", function () {
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
        var next = btn.getAttribute("data-next") === "true";
        api("/companies/me/marketplace-accounts/" + accId, { method: "PATCH", body: { isActive: next } }).then(function (r) {
          if (r.status === 204) {
            bmMsg("ok", next ? "Account activated — upload selects me wapas aa gaya." : "Account deactivated — upload selects se hat gaya.");
            loadSummary();
          }
          else bmMsg("err", (r.data && r.data.error) || "Failed.");
        });
      });
    });

    on("#bm-skus-btn", function () {
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

  // ---------- single entry (order + return) ----------
  function entryMsg(kind, msg) {
    var box = $("#entry-result");
    box.className = "result " + kind;
    box.textContent = msg;
    box.hidden = false;
    setTimeout(function () { box.hidden = true; }, 7000);
  }

  function fillEntrySelects() {
    var accounts = ((summary && summary.accounts) || []).filter(function (a) { return a.isActive !== false; });
    var opts = accounts.map(function (a) {
      return "<option value='" + a.id + "'>" + esc(a.sellerAccountLabel || a.marketplace) + " — " + esc(a.marketplace) + "</option>";
    }).join("");
    $("#so-account").innerHTML = opts || "<option value=''>No seller account</option>";
    var whs = ((summary && summary.warehouses) || []);
    var wopts = whs.map(function (w) { return "<option value='" + w.id + "'>" + esc(w.name) + "</option>"; }).join("");
    $("#so-warehouse").innerHTML = wopts || "<option value=''>No warehouse</option>";
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
      loadOrders(); loadSummary();
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

  // ---------- team & permissions ----------
  var SECTIONS = ["orders", "scan", "inventory", "dispatch", "returns", "finance", "reports", "setup", "team"];
  var canManageTeam = myPermissions.indexOf("team") !== -1 || auth.role === "OWNER" || auth.role === "ADMIN";

  var SECTION_LABELS = {
    orders: "Orders", scan: "Scan", inventory: "Inventory", dispatch: "Dispatch",
    returns: "Returns", finance: "Finance", reports: "Reports", setup: "Setup", team: "Team"
  };

  function loadTeam() {
    if (!canManageTeam) return;
    $("#team-panel").hidden = false;
    api("/users").then(function (r) {
      if (!r.ok || !Array.isArray(r.data)) return;
      $("#team-count").textContent = String(r.data.length);
      var tb = $("#team-table tbody");
      var iAmOwner = auth.role === "OWNER";
      tb.innerHTML = r.data.map(function (u) {
        var perms = u.role === "OWNER" || u.role === "ADMIN"
          ? "<span class='pill pill-ok'>ALL (role)</span>"
          : (u.permissions && u.permissions.length
            ? u.permissions.map(function (p) { return "<span class='mp-tag'>" + esc(p) + "</span>"; }).join(" ")
            : "<span class='pill pill-pend'>role defaults</span>");
        var actions = "";
        // OWNER row editable only by OWNER (self/other owner); everyone else by OWNER/ADMIN.
        if (u.role !== "OWNER" || iAmOwner) {
          actions += "<button type='button' class='bm-mini' data-u-edit='" + u.id + "'>Edit</button> ";
        }
        if (u.role !== "OWNER") {
          actions += "<button type='button' class='bm-mini' data-u-toggle='" + u.id + "'>" + (u.isActive ? "Deactivate" : "Activate") + "</button>" +
            " <button type='button' class='bm-mini danger' data-u-del='" + u.id + "'>Revoke all</button>";
        }
        return "<tr data-u-row='" + u.id + "'>" +
          "<td><b>" + esc(u.displayName || u.email) + "</b><div style='font-size:11px;color:var(--muted)'>" + esc(u.email) + "</div></td>" +
          "<td><span class='mp-tag'>" + esc(u.role) + "</span></td>" +
          "<td>" + (u.isActive ? "<span class='pill pill-ok'>ACTIVE</span>" : "<span class='pill pill-red'>OFF</span>") + "</td>" +
          "<td style='white-space:normal'>" + perms + "</td>" +
          "<td>" + actions + "</td></tr>";
      }).join("");

      $all("[data-u-toggle]").forEach(function (b) {
        b.addEventListener("click", function () {
          var id = b.getAttribute("data-u-toggle");
          var row = r.data.find(function (x) { return String(x.id) === String(id); });
          api("/users/" + id, { method: "PATCH", body: { isActive: !row.isActive } }).then(function (res) {
            if (res.status === 204) loadTeam(); else entryMsg("err", (res.data && res.data.error) || "Failed.");
          });
        });
      });
      $all("[data-u-del]").forEach(function (b) {
        b.addEventListener("click", function () {
          var id = b.getAttribute("data-u-del");
          if (!confirm("Remove ALL section access for this user? (user stays, all sections revoked)")) return;
          api("/users/" + id, { method: "PATCH", body: { permissions: [] } }).then(function (res) {
            if (res.status === 204) { loadTeam(); entryMsg("ok", "All sections revoked — user falls back to minimal read-only."); }
            else entryMsg("err", (res.data && res.data.error) || "Failed.");
          });
        });
      });

      // ---- inline Edit drawer: name / email / password / role / sections ----
      $all("[data-u-edit]").forEach(function (b) {
        b.addEventListener("click", function () {
          var id = b.getAttribute("data-u-edit");
          var u = r.data.find(function (x) { return String(x.id) === String(id); });
          if (!u) return;
          var existing = document.getElementById("u-edit-" + id);
          if (existing) { existing.remove(); return; } // toggle closed
          $all("tr[data-edit-row]").forEach(function (x) { x.remove(); });

          var isOwnerTarget = u.role === "OWNER";
          var isRoleUser = !isOwnerTarget && u.role !== "ADMIN"; // sections UI only for OPS/VIEWER
          var mode = u.permissions == null ? "defaults" : (u.permissions.length ? "custom" : "none");

          var boxes = SECTIONS.map(function (s) {
            var on = Array.isArray(u.permissions) && u.permissions.indexOf(s) !== -1;
            return "<label style='display:inline-flex;align-items:center;gap:5px;margin:2px 10px 2px 0;font-size:12px;color:var(--text)'>" +
              "<input type='checkbox' class='u-sec' data-sec='" + s + "'" + (on ? " checked" : "") + "/> " + esc(SECTION_LABELS[s] || s) + "</label>";
          }).join("");

          var html =
            "<tr data-edit-row data-edit-id='" + id + "'><td colspan='5'>" +
            "<div style='display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:10px'>" +
            "<label style='font-size:12px;color:var(--muted)'>Name<input class='u-name' type='text' value='" + esc(u.displayName || "") + "' style='margin-top:4px'/></label>" +
            "<label style='font-size:12px;color:var(--muted)'>Email<input class='u-email' type='email' value='" + esc(u.email) + "' style='margin-top:4px'/></label>" +
            "<label style='font-size:12px;color:var(--muted)'>New Password <span style='opacity:.6'>(blank = no change)</span><input class='u-pass' type='password' placeholder='min 8 chars' style='margin-top:4px'/></label>" +
            (isOwnerTarget ? "" :
              "<label style='font-size:12px;color:var(--muted)'>Role<select class='u-role' style='margin-top:4px'>" +
              ["OPS", "ADMIN", "VIEWER"].map(function (ro) { return "<option" + (u.role === ro ? " selected" : "") + ">" + ro + "</option>"; }).join("") +
              "</select></label>") +
            "</div>" +
            (isRoleUser
              ? "<div style='margin-bottom:10px'><div style='font-size:12px;color:var(--muted);margin-bottom:4px'>Sections access (tick = allow)</div>" + boxes +
                "<div style='font-size:11px;color:var(--muted);margin-top:4px'>" +
                "<label style='margin-right:12px'><input type='radio' name='umode-" + id + "' value='custom'" + (mode === "custom" ? " checked" : "") + " class='u-mode'/> Custom (upar tick kiye)</label>" +
                "<label style='margin-right:12px'><input type='radio' name='umode-" + id + "' value='defaults'" + (mode === "defaults" ? " checked" : "") + " class='u-mode'/> Role defaults</label>" +
                "<label><input type='radio' name='umode-" + id + "' value='none'" + (mode === "none" ? " checked" : "") + " class='u-mode'/> None (read-only)</label></div></div>"
              : (isOwnerTarget ? "<div style='font-size:12px;color:var(--muted);margin-bottom:10px'>OWNER — sab sections by role. Sirf naam/email/password edit hoga.</div>" : "")) +
            "<button type='button' class='btn u-save' style='padding:7px 16px'>Save Changes</button>" +
            "</td></tr>";
          var row = document.querySelector("tr[data-u-row='" + id + "']");
          if (row && row.insertAdjacentHTML) row.insertAdjacentHTML("afterend", html);

          var editRow = document.querySelector("tr[data-edit-id='" + id + "']");
          if (!editRow) return;
          editRow.querySelector(".u-save").addEventListener("click", function () {
            var body = {};
            var name = editRow.querySelector(".u-name").value.trim();
            var email = editRow.querySelector(".u-email").value.trim();
            var pass = editRow.querySelector(".u-pass").value;
            if (name && name !== (u.displayName || "")) body.displayName = name;
            if (email && email !== u.email) body.email = email;
            if (pass) {
              if (pass.length < 8) { entryMsg("err", "Password min 8 characters ka hona chahiye."); return; }
              body.password = pass;
            }
            var roleSel = editRow.querySelector(".u-role");
            if (roleSel && roleSel.value !== u.role) body.role = roleSel.value;
            var modeEl = editRow.querySelector(".u-mode:checked");
            if (modeEl) {
              if (modeEl.value === "custom") body.permissions = Array.prototype.slice.call(editRow.querySelectorAll(".u-sec:checked")).map(function (c) { return c.getAttribute("data-sec"); });
              else if (modeEl.value === "defaults") body.permissions = null;
              else body.permissions = [];
            }
            if (!Object.keys(body).length) { entryMsg("err", "Kuch change nahi kiya."); return; }
            api("/users/" + id, { method: "PATCH", body: body }).then(function (res) {
              if (res.status === 204) { entryMsg("ok", "User updated ✓"); loadTeam(); }
              else entryMsg("err", (res.data && res.data.error) || "Update failed.");
            });
          });
        });
      });
    });
  }

  $("#tu-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var body = {
      email: $("#tu-email").value.trim(),
      password: $("#tu-pass").value,
      displayName: $("#tu-name").value.trim(),
      role: $("#tu-role").value,
    };
    var btn = $("#tu-btn");
    btn.disabled = true;
    api("/users", { method: "POST", body: body }).then(function (r) {
      btn.disabled = false;
      if (!r.ok) { entryMsg("err", (r.data && r.data.error) || "Could not add user."); return; }
      entryMsg("ok", "User added ✓ — ab permissions set karo (neeche table me)");
      ["#tu-name", "#tu-email", "#tu-pass"].forEach(function (s) { $(s).value = ""; });
      loadTeam();
    }).catch(function () { btn.disabled = false; });
  });

  // ---------- boot ----------
  loadSummary();
  loadOrders();
  renderParties();
  renderSkuPicker();
  loadTeam();
})();
