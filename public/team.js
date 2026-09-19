/* NCR-OMS — Team & Roles page: add users, toggle status, edit
 * name/email/password/role/section-permissions. Split out of app.js into
 * its own page by Claude (Anthropic) 2026-09-11. Redesigned 2026-09-19 per
 * user request ("dilogbox se kaam me lo... attractive banao") — Add User
 * and per-user Edit both now open modal dialogs (window.NcrModal,
 * public/modal.js) instead of an always-visible form and an inline
 * expanding table row. See BRAIN.md. Same session guard pattern as the
 * other secondary pages. */
(function () {
  "use strict";

  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  var auth = null;
  try { auth = JSON.parse(sessionStorage.getItem("ncr_auth") || "null"); } catch (e) { auth = null; }
  if (!auth || !auth.token) { window.location.replace("/login.html"); return; }

  var myPermissions = (auth && auth.permissions) || [];
  var canManageTeam = myPermissions.indexOf("team") !== -1 || auth.role === "OWNER" || auth.role === "ADMIN";
  if (!canManageTeam) {
    $("#team-panel").hidden = true;
    $("#team-noaccess").hidden = false;
  }

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

  if (!canManageTeam) return; // nothing left to wire up on this page

  var SECTIONS = ["orders", "scan", "inventory", "dispatch", "returns", "finance", "reports", "setup", "team"];
  var SECTION_LABELS = {
    orders: "Orders", scan: "Scan", inventory: "Inventory", dispatch: "Dispatch",
    returns: "Returns", finance: "Finance", reports: "Reports", setup: "Setup", team: "Team"
  };

  var teamRows = [];

  function loadTeam() {
    return api("/users").then(function (r) {
      if (!r.ok || !Array.isArray(r.data)) return;
      teamRows = r.data;
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
      $all("[data-u-edit]").forEach(function (b) {
        b.addEventListener("click", function () { openEditModal(Number(b.getAttribute("data-u-edit"))); });
      });
    });
  }

  // ---------- Edit user — modal dialog ----------
  function openEditModal(id) {
    var u = teamRows.find(function (x) { return x.id === id; });
    if (!u) return;
    var isOwnerTarget = u.role === "OWNER";
    var isRoleUser = !isOwnerTarget && u.role !== "ADMIN"; // sections UI only for OPS/VIEWER
    var mode = u.permissions == null ? "defaults" : (u.permissions.length ? "custom" : "none");

    var boxes = SECTIONS.map(function (s) {
      var on = Array.isArray(u.permissions) && u.permissions.indexOf(s) !== -1;
      return "<label style='display:inline-flex;align-items:center;gap:5px;margin:2px 10px 2px 0;font-size:12px;color:var(--text)'>" +
        "<input type='checkbox' class='u-sec' data-sec='" + s + "'" + (on ? " checked" : "") + "/> " + esc(SECTION_LABELS[s] || s) + "</label>";
    }).join("");

    var m = window.NcrModal.open({
      title: "Edit — " + (u.displayName || u.email),
      wide: true,
      bodyHtml:
        "<div style='display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:14px'>" +
        "<label style='font-size:12px;color:var(--muted)'>Name<input class='u-name' type='text' value='" + esc(u.displayName || "") + "' style='margin-top:4px'/></label>" +
        "<label style='font-size:12px;color:var(--muted)'>Email<input class='u-email' type='email' value='" + esc(u.email) + "' style='margin-top:4px'/></label>" +
        "<label style='font-size:12px;color:var(--muted)'>New Password <span style='opacity:.6'>(blank = no change)</span><input class='u-pass' type='password' placeholder='min 8 chars' style='margin-top:4px'/></label>" +
        (isOwnerTarget ? "" :
          "<label style='font-size:12px;color:var(--muted)'>Role<select class='u-role' style='margin-top:4px'>" +
          ["OPS", "ADMIN", "VIEWER"].map(function (ro) { return "<option" + (u.role === ro ? " selected" : "") + ">" + ro + "</option>"; }).join("") +
          "</select></label>") +
        "</div>" +
        (isRoleUser
          ? "<div style='margin-bottom:14px'><div style='font-size:12px;color:var(--muted);margin-bottom:6px'>Sections access (tick = allow)</div>" + boxes +
            "<div style='font-size:11px;color:var(--muted);margin-top:8px'>" +
            "<label style='margin-right:12px'><input type='radio' name='umode' value='custom'" + (mode === "custom" ? " checked" : "") + " class='u-mode'/> Custom (upar tick kiye)</label>" +
            "<label style='margin-right:12px'><input type='radio' name='umode' value='defaults'" + (mode === "defaults" ? " checked" : "") + " class='u-mode'/> Role defaults</label>" +
            "<label><input type='radio' name='umode' value='none'" + (mode === "none" ? " checked" : "") + " class='u-mode'/> None (read-only)</label></div></div>"
          : (isOwnerTarget ? "<p class='small' style='color:var(--muted);margin-bottom:14px'>OWNER — sab sections by role. Sirf naam/email/password edit hoga.</p>" : "")) +
        "<div id='u-modal-result' class='result' hidden></div>" +
        "<button type='button' class='btn u-save'>Save Changes</button>",
    });

    function uMsg(kind, msg) {
      var box = m.body.querySelector("#u-modal-result");
      box.className = "result " + kind;
      box.textContent = msg;
      box.hidden = false;
    }

    m.body.querySelector(".u-save").addEventListener("click", function () {
      var body = {};
      var name = m.body.querySelector(".u-name").value.trim();
      var email = m.body.querySelector(".u-email").value.trim();
      var pass = m.body.querySelector(".u-pass").value;
      if (name && name !== (u.displayName || "")) body.displayName = name;
      if (email && email !== u.email) body.email = email;
      if (pass) {
        if (pass.length < 8) { uMsg("err", "Password min 8 characters ka hona chahiye."); return; }
        body.password = pass;
      }
      var roleSel = m.body.querySelector(".u-role");
      if (roleSel && roleSel.value !== u.role) body.role = roleSel.value;
      var modeEl = m.body.querySelector(".u-mode:checked");
      if (modeEl) {
        if (modeEl.value === "custom") body.permissions = Array.prototype.slice.call(m.body.querySelectorAll(".u-sec:checked")).map(function (c) { return c.getAttribute("data-sec"); });
        else if (modeEl.value === "defaults") body.permissions = null;
        else body.permissions = [];
      }
      if (!Object.keys(body).length) { uMsg("err", "Kuch change nahi kiya."); return; }
      api("/users/" + id, { method: "PATCH", body: body }).then(function (res) {
        if (res.status === 204) { entryMsg("ok", "User updated ✓"); loadTeam(); m.close(); }
        else uMsg("err", (res.data && res.data.error) || "Update failed.");
      });
    });
  }

  // ---------- Add User — modal dialog ----------
  $("#tu-open-btn").addEventListener("click", function () {
    var m = window.NcrModal.open({
      title: "＋ Add User",
      bodyHtml:
        "<form id='tu-form' class='fgrid fgrid-tight' style='grid-template-columns:1fr'>" +
          "<label>Name <input id='tu-name' type='text' required placeholder='Ramesh Kumar' /></label>" +
          "<label>Email <input id='tu-email' type='email' required placeholder='ramesh@company.com' /></label>" +
          "<label>Password <input id='tu-pass' type='password' required minlength='8' placeholder='min 8 chars' /></label>" +
          "<label>Role<select id='tu-role'>" +
            "<option value='OPS'>OPS (operations)</option>" +
            "<option value='ADMIN'>ADMIN</option>" +
            "<option value='VIEWER'>VIEWER (read-only)</option>" +
          "</select></label>" +
          "<div id='tu-modal-result' class='result' hidden></div>" +
          "<button type='submit' class='btn' id='tu-btn'>＋ Add User</button>" +
        "</form>",
    });
    function tuMsg(kind, msg) {
      var box = m.body.querySelector("#tu-modal-result");
      box.className = "result " + kind;
      box.textContent = msg;
      box.hidden = false;
    }
    m.body.querySelector("#tu-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var body = {
        email: m.body.querySelector("#tu-email").value.trim(),
        password: m.body.querySelector("#tu-pass").value,
        displayName: m.body.querySelector("#tu-name").value.trim(),
        role: m.body.querySelector("#tu-role").value,
      };
      var btn = m.body.querySelector("#tu-btn");
      btn.disabled = true;
      api("/users", { method: "POST", body: body }).then(function (r) {
        btn.disabled = false;
        if (!r.ok) { tuMsg("err", (r.data && r.data.error) || "Could not add user."); return; }
        entryMsg("ok", "User added ✓ — ab “Edit” se permissions set karo.");
        loadTeam();
        m.close();
      }).catch(function () { btn.disabled = false; });
    });
  });

  // ---------- boot ----------
  loadTeam();
})();
