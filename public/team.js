/* NCR-OMS — Team & Roles page: add users, toggle status, edit
 * name/email/password/role/section-permissions. Split out of app.js into
 * its own page by Claude (Anthropic) 2026-09-11, per user request — see
 * BRAIN.md. Same session guard pattern as the other secondary pages. */
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

  function loadTeam() {
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
  loadTeam();
})();
