/* NCR-OMS — Company & Setup page: company profile (view/edit + bank
 * accounts + access list + delete) and brand / seller-account management.
 * Split out of app.js into its own page by Claude (Anthropic) 2026-09-11.
 * Redesigned 2026-09-19 per user request ("jaha dilogbox se kam ho jaye
 * vaha dilogbox se kaam me lo lekin attractive banao") — Bank Accounts and
 * Brand management (add + per-brand manage) now happen in modal dialogs
 * (window.NcrModal, public/modal.js) instead of inline accordions, and the
 * brand list renders as a proper row list. See BRAIN.md. Same session guard
 * pattern as the other secondary pages. */
(function () {
  "use strict";

  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  // ---------- auth guard (same session as dashboard) ----------
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

  var summary = null;

  // ==================== COMPANY PROFILE ====================
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

    $("#cp-summary-name").textContent = c.displayName || c.legalName || "Unnamed company";
    var metaBits = [];
    metaBits.push(c.gstin ? "GSTIN " + c.gstin : "GSTIN —");
    metaBits.push(c.phone ? c.phone : "Phone —");
    metaBits.push(c.city ? c.city : "City —");
    $("#cp-summary-meta").textContent = metaBits.join(" · ");
  }

  var cpDetails = $("#cp-details");
  var cpToggle = $("#cp-summary-toggle");
  cpToggle.addEventListener("click", function () {
    var open = cpDetails.hidden; // currently hidden -> about to open
    cpDetails.hidden = !open;
    cpToggle.setAttribute("aria-expanded", String(open));
    $("#cp-summary-cta").textContent = open ? "Hide Profile ▴" : "View Profile ▾";
    if (open) {
      loadCompanyAccessList();
      cpDetails.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });

  // "Who can access this company" — reuses the same /users endpoint the
  // Team & Roles page uses (session already company-scoped), read-only
  // here. Gated OWNER/ADMIN server-side, same as Team & Roles.
  var cpAccessLoaded = false;
  function loadCompanyAccessList() {
    if (cpAccessLoaded) return;
    cpAccessLoaded = true;
    api("/users").then(function (r) {
      if (!r.ok || !Array.isArray(r.data)) {
        $("#cp-access-list").textContent = "Sirf OWNER/ADMIN ye list dekh sakte hain.";
        return;
      }
      var rows = r.data.filter(function (u) { return u.isActive !== false; });
      if (rows.length === 0) {
        $("#cp-access-list").textContent = "Koi user nahi mila.";
        return;
      }
      $("#cp-access-list").innerHTML = rows.map(function (u) {
        return "<div style='display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:6px 10px;padding:4px 0;border-bottom:1px solid var(--line)'>" +
          "<span style='min-width:0;overflow-wrap:anywhere'>" + esc(u.displayName || u.email) + " <span style='color:var(--muted)'>(" + esc(u.email) + ")</span></span>" +
          "<span class='pill pill-ok' style='flex:none'>" + esc(u.role) + "</span>" +
          "</div>";
      }).join("");
    }).catch(function () {
      $("#cp-access-list").textContent = "Access list load nahi ho payi.";
    });
  }

  // ---------- delete company (OWNER-only, server enforces the real guards) ----------
  if (auth.role === "OWNER") {
    $("#cp-danger-block").hidden = false;
    $("#cp-delete-btn").addEventListener("click", function () {
      var name = $("#cp-summary-name").textContent || "is company";
      if (!window.confirm("Pakka delete karna hai \"" + name + "\"? Yeh sirf tabhi hoga jab isme koi order/purchase/expense history na ho. Yeh action undo nahi ho sakta.")) return;
      var btn = $("#cp-delete-btn");
      btn.disabled = true;
      api("/companies/me", { method: "DELETE" }).then(function (r) {
        if (r.ok && r.data && r.data.token) {
          var next = Object.assign({}, auth, {
            token: r.data.token,
            companyId: r.data.companyId,
            role: r.data.role || auth.role,
            displayName: r.data.displayName || auth.displayName,
            companyName: r.data.companyName,
            permissions: r.data.permissions || [],
          });
          sessionStorage.setItem("ncr_auth", JSON.stringify(next));
          window.alert((r.data.deletedCompanyName || "Company") + " delete ho gayi. Ab \"" + (r.data.companyName || "") + "\" workspace khul raha hai.");
          window.location.href = "/setup";
        } else {
          btn.disabled = false;
          cpMsg("err", (r.data && r.data.error) || "Delete nahi ho payi.");
        }
      }).catch(function () {
        btn.disabled = false;
        cpMsg("err", "Network issue — dobara try karein.");
      });
    });
  }

  function loadCompanyProfile() {
    api("/companies/me").then(function (r) {
      if (!r.ok || !r.data) return;
      var c = r.data;
      fillCompanyProfile(c);
      renderBanks(c.bankAccounts || []);
    });
  }

  function renderBanks(banks) {
    var box = $("#cp-banks");
    box.innerHTML = banks.length
      ? banks.map(function (b) {
          return "<div class='list-row'>" +
            "<div class='list-row-main'>" +
              "<div class='list-row-title'>" + esc(b.label || "Account") + (b.isPrimary ? " <span class='pill pill-ok' style='margin-left:6px'>PRIMARY</span>" : "") + "</div>" +
              "<div class='list-row-sub'>" + esc(b.bankName || "") + " · " + esc(b.ifsc || "") + " · A/C " + esc(b.accountNumberMasked || "••••") + " · AD Code " + esc(b.adCode || "—") + "</div>" +
            "</div></div>";
        }).join("")
      : "<div class='empty-state'>No bank account yet — invoice auto-fill ke liye “+ Add Bank Account” se add karo.</div>";
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

  // ---------- Add Bank Account — modal dialog ----------
  $("#bk-open-btn").addEventListener("click", function () {
    if (!canEditCompany) { cpMsg("err", "Sirf OWNER/ADMIN bank account add kar sakte hain."); return; }
    var m = window.NcrModal.open({
      title: "Add Bank Account",
      bodyHtml:
        "<form id='bk-form' class='fgrid fgrid-tight' style='grid-template-columns:1fr'>" +
          "<label>Label <input id='bk-label' type='text' placeholder='PNB Primary' /></label>" +
          "<label>Holder Name <input id='bk-holder' type='text' /></label>" +
          "<label>Account Number <input id='bk-number' type='text' /></label>" +
          "<label>IFSC <input id='bk-ifsc' type='text' maxlength='11' placeholder='PUNB0614300' style='text-transform:uppercase' /></label>" +
          "<label>Bank Name <input id='bk-bank' type='text' placeholder='PNB BANK' /></label>" +
          "<label>AD Code <input id='bk-adcode' type='text' placeholder='0304993/PUNB0614300' /></label>" +
          "<div id='bk-modal-result' class='result' hidden></div>" +
          "<button type='submit' class='btn'>Add Bank Account</button>" +
        "</form>",
    });
    function bkMsg(kind, msg) {
      var box = m.body.querySelector("#bk-modal-result");
      box.className = "result " + kind;
      box.textContent = msg;
      box.hidden = false;
    }
    m.body.querySelector("#bk-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var body = {
        label: m.body.querySelector("#bk-label").value.trim(),
        accountHolderName: m.body.querySelector("#bk-holder").value.trim(),
        accountNumber: m.body.querySelector("#bk-number").value.trim(),
        ifsc: m.body.querySelector("#bk-ifsc").value.trim().toUpperCase(),
        bankName: m.body.querySelector("#bk-bank").value.trim(),
        adCode: m.body.querySelector("#bk-adcode").value.trim() || undefined,
      };
      if (!body.label || !body.accountHolderName || !body.accountNumber || body.ifsc.length !== 11 || !body.bankName) {
        bkMsg("err", "Poora bharo — IFSC 11 characters ka hona chahiye.");
        return;
      }
      api("/companies/me/bank-accounts", { method: "POST", body: body }).then(function (r) {
        if (r.status === 201) {
          cpMsg("ok", "Bank account added ✓ (number encrypted store hua)");
          loadCompanyProfile();
          m.close();
        } else bkMsg("err", (r.data && r.data.error) || "Bank account add failed.");
      });
    });
  });

  // ==================== BRANDS & SETUP ====================
  function loadSummary() {
    return api("/dashboard/summary").then(function (r) {
      if (!r.ok || !r.data) return;
      summary = r.data;
      renderBrands();
    });
  }

  function renderBrands() {
    var list = $("#brand-list");
    var brands = (summary && summary.brands) || [];
    var accounts = (summary && summary.accounts) || [];
    $("#brand-count").textContent = String(brands.length);
    list.innerHTML = brands.length
      ? brands.map(function (b) {
          var mps = accounts.filter(function (a) { return a.brandId === b.id; });
          var sub = mps.length ? mps.map(function (a) { return "<span class='mp-tag'>" + esc(a.marketplace) + "</span>"; }).join(" ") : "No seller accounts yet";
          return "<div class='list-row'>" +
            "<div class='list-row-main'><div class='list-row-title'>" + esc(b.name) + "</div><div class='list-row-sub'>" + sub + "</div></div>" +
            "<div class='list-row-actions'><button type='button' class='bm-mini' data-manage='" + b.id + "'>Manage</button></div>" +
            "</div>";
        }).join("")
      : "<div class='empty-state'>No brands yet — click “+ Add Brand / Seller Account” above.</div>";

    $all("[data-manage]").forEach(function (btn) {
      btn.addEventListener("click", function () { openManageModal(Number(btn.getAttribute("data-manage"))); });
    });
  }

  // ---------- Add Brand / Seller Account — modal dialog ----------
  $("#sb-open-btn").addEventListener("click", function () {
    var brands = (summary && summary.brands) || [];
    var m = window.NcrModal.open({
      title: "Add Brand / Seller Account",
      bodyHtml:
        "<div class='fgrid fgrid-tight' style='grid-template-columns:1fr'>" +
          "<label>New Brand Name <input id='sb-brand-name' type='text' placeholder='e.g. Vardhamiti' /></label>" +
          "<button type='button' id='sb-brand-btn' class='btn ghostbtn2'>Add Brand</button>" +
        "</div>" +
        "<div class='fgrid fgrid-tight' style='grid-template-columns:1fr;margin-top:16px;padding-top:16px;border-top:1px solid var(--line)'>" +
          "<div class='fgrid-title'>Attach Seller Account</div>" +
          "<label>Brand <select id='sb-brand'>" + (brands.length ? brands.map(function (b) { return "<option value='" + b.id + "'>" + esc(b.name) + "</option>"; }).join("") : "<option value=''>Add a brand first</option>") + "</select></label>" +
          "<label>Marketplace <select id='sb-mp'>" +
            "<option value='FLIPKART'>Flipkart</option><option value='MEESHO'>Meesho</option><option value='SNAPDEAL'>Snapdeal</option>" +
            "<option value='AMAZON_IN'>Amazon IN</option><option value='MYNTRA'>Myntra</option><option value='AJIO'>AJIO</option>" +
          "</select></label>" +
          "<label>Seller Account Label <input id='sb-label' type='text' placeholder='e.g. Vardhamiti Official' /></label>" +
          "<button type='button' id='sb-account-btn' class='btn'>Attach Seller Account</button>" +
        "</div>" +
        "<div id='sb-modal-result' class='result' hidden></div>",
    });

    function sbMsg(kind, msg) {
      var box = m.body.querySelector("#sb-modal-result");
      box.className = "result " + kind;
      box.textContent = msg;
      box.hidden = false;
    }

    m.body.querySelector("#sb-brand-btn").addEventListener("click", function () {
      var nameEl = m.body.querySelector("#sb-brand-name");
      var name = nameEl.value.trim();
      if (name.length < 2) { sbMsg("err", "Brand name needs at least 2 characters."); return; }
      api("/companies/me/brands", { method: "POST", body: { name: name } }).then(function (r) {
        if (!r.ok) { sbMsg("err", (r.data && r.data.error) || "Could not add brand."); return; }
        nameEl.value = "";
        sbMsg("ok", "Brand added — pick it above to attach a seller account, or close this and use “Manage” on the list.");
        loadSummary().then(function () {
          var sel = m.body.querySelector("#sb-brand");
          var brandsNow = (summary && summary.brands) || [];
          sel.innerHTML = brandsNow.length ? brandsNow.map(function (b) { return "<option value='" + b.id + "'>" + esc(b.name) + "</option>"; }).join("") : "<option value=''>Add a brand first</option>";
        });
      });
    });

    m.body.querySelector("#sb-account-btn").addEventListener("click", function () {
      var brandId = Number(m.body.querySelector("#sb-brand").value);
      var mp = m.body.querySelector("#sb-mp").value;
      var label = m.body.querySelector("#sb-label").value.trim();
      if (!brandId) { sbMsg("err", "Pick (or add) a brand first."); return; }
      if (!label) { sbMsg("err", "Give the seller account a label, e.g. \"Vardhamiti Official\"."); return; }
      api("/companies/me/marketplace-accounts", {
        method: "POST",
        body: { brandId: brandId, marketplace: mp, sellerAccountLabel: label },
      }).then(function (r) {
        if (!r.ok) { sbMsg("err", (r.data && r.data.error) || "Could not attach account."); return; }
        sbMsg("ok", "Seller account attached — it now appears in the upload form on the Dashboard.");
        m.body.querySelector("#sb-label").value = "";
        loadSummary();
      });
    });
  });

  // ---------- Manage a brand — modal dialog (rename / delete / accounts / SKUs) ----------
  function openManageModal(brandId) {
    var brands = (summary && summary.brands) || [];
    var accounts = (summary && summary.accounts) || [];
    var b = brands.find(function (x) { return x.id === brandId; });
    if (!b) return;
    var accs = accounts.filter(function (a) { return a.brandId === brandId; });

    var m = window.NcrModal.open({
      title: "Manage — " + b.name,
      wide: true,
      bodyHtml:
        "<div class='bm-actions'>" +
          "<input type='text' id='bm-rename' placeholder='New brand name…' />" +
          "<button type='button' class='bm-mini' id='bm-rename-btn'>Rename</button>" +
          "<button type='button' class='bm-mini danger' id='bm-delete-btn'>Delete Brand</button>" +
        "</div>" +
        "<div class='bm-head' style='margin-top:16px'><b>Seller accounts</b></div>" +
        (accs.length ? accs.map(function (a) {
          var active = a.isActive !== false;
          return "<div class='list-row'><div class='list-row-main'><div class='list-row-title'>" + esc(a.sellerAccountLabel || a.marketplace) +
            (active ? "" : " <span class='pill pill-red' style='margin-left:6px'>OFF</span>") + "</div>" +
            "<div class='list-row-sub'><span class='mp-tag'>" + esc(a.marketplace) + "</span></div></div>" +
            "<div class='list-row-actions'><button type='button' class='bm-mini deact' data-deact='" + a.id + "' data-next='" + (active ? "false" : "true") + "'>" + (active ? "Deactivate" : "Activate") + "</button></div></div>";
        }).join("") : "<div class='empty-state'>No accounts attached.</div>") +
        "<div class='bm-head' style='margin-top:16px'><b>SKUs</b><button type='button' class='bm-mini' id='bm-skus-btn'>Show SKUs</button></div>" +
        "<div class='bm-skus' id='bm-skus' hidden></div>" +
        "<div class='bm-head' style='margin-top:16px'><b>Add SKUs (bulk paste)</b></div>" +
        "<textarea id='bm-bulk-codes' rows='3' placeholder='Ek line me ek SKU code…\nJK-1001-A\nJK-1001-B' style='width:100%;background:var(--bg2);border:1.5px solid var(--line2);color:var(--text);border-radius:10px;padding:10px 12px;font:inherit;font-size:13px;outline:none'></textarea>" +
        "<button type='button' class='bm-mini' id='bm-bulk-btn' style='margin-top:8px'>Add SKUs</button>" +
        "<div id='bm-result' class='result' hidden></div>",
    });

    function bmMsg(kind, msg) {
      var el = m.body.querySelector("#bm-result");
      el.className = "result " + kind;
      el.textContent = msg;
      el.hidden = false;
    }
    function on(sel, fn) {
      var el = m.body.querySelector(sel);
      if (el) el.addEventListener("click", fn);
    }

    on("#bm-bulk-btn", function () {
      var codes = m.body.querySelector("#bm-bulk-codes").value.trim();
      if (!codes) { bmMsg("err", "Paste at least one SKU code."); return; }
      api("/skus/bulk", { method: "POST", body: { brandId: brandId, codes: codes } }).then(function (r) {
        if (!r.ok) { bmMsg("err", (r.data && r.data.error) || "Bulk add failed."); return; }
        var d = r.data;
        bmMsg(d.created ? "ok" : "err",
          d.created + " SKU(s) added" + (d.skipped && d.skipped.length ? ", " + d.skipped.length + " already existed (skipped)" : "") +
          (d.mapped ? " · " + d.mapped + " account mappings ensured" : ""));
        m.body.querySelector("#bm-bulk-codes").value = "";
        loadSummary();
      });
    });

    on("#bm-rename-btn", function () {
      var name = m.body.querySelector("#bm-rename").value.trim();
      if (name.length < 2) { bmMsg("err", "Name needs 2+ characters."); return; }
      api("/companies/me/brands/" + brandId, { method: "PATCH", body: { name: name } }).then(function (r) {
        if (!r.ok) { bmMsg("err", (r.data && r.data.error) || "Rename failed."); return; }
        bmMsg("ok", "Renamed.");
        loadSummary();
        m.close();
      });
    });

    on("#bm-delete-btn", function () {
      if (!confirm("Delete brand \"" + b.name + "\"? This also removes its accounts and SKUs. Brands with orders cannot be deleted.")) return;
      api("/companies/me/brands/" + brandId, { method: "DELETE" }).then(function (r) {
        if (r.status === 204) {
          loadSummary();
          m.close();
        } else {
          bmMsg("err", (r.data && r.data.error) || "Delete failed.");
        }
      });
    });

    Array.prototype.slice.call(m.body.querySelectorAll("[data-deact]")).forEach(function (btn) {
      btn.addEventListener("click", function () {
        var accId = Number(btn.getAttribute("data-deact"));
        var next = btn.getAttribute("data-next") === "true";
        api("/companies/me/marketplace-accounts/" + accId, { method: "PATCH", body: { isActive: next } }).then(function (r) {
          if (r.status === 204) {
            bmMsg("ok", next ? "Account activated — upload selects me wapas aa gaya." : "Account deactivated — upload selects se hat gaya.");
            loadSummary();
            m.close();
          }
          else bmMsg("err", (r.data && r.data.error) || "Failed.");
        });
      });
    });

    on("#bm-skus-btn", function () {
      var pane = m.body.querySelector("#bm-skus");
      if (!pane.hidden) { pane.hidden = true; return; }
      api("/companies/me/brands/" + brandId + "/skus").then(function (r) {
        if (!r.ok || !Array.isArray(r.data)) { bmMsg("err", "Could not load SKUs."); return; }
        pane.innerHTML = r.data.length
          ? r.data.map(function (s) {
              return "<div class='bm-sku-row'><b>" + esc(s.code) + "</b><span>" + esc(s.productTitle) + (s.size ? " · " + esc(s.size) : "") + "</span></div>";
            }).join("")
          : "<div class='empty' style='padding:8px 0'>No SKUs yet — add via SKU API or the bulk importer below.</div>";
        pane.hidden = false;
      });
    });
  }

  // ---------- boot ----------
  loadCompanyProfile();
  loadSummary();
})();
