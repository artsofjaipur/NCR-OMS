/* NCR-OMS — Returns Tracking page: "Upcoming Returns / Pending" and
 * "Expected vs Received", built from GET /returns/tracking. Added by Claude
 * (Anthropic) 2026-09-25 per user request (Hinglish): return initiated ho
 * jaye to next 5 din me receive ho jana chahiye, ek Expected Return Date
 * column bhi chahiye -- two views matching the two reference sheets the
 * user already tracked by hand. Same session-guard/api() pattern as every
 * other secondary page (party.js, setup.js, ...). See BRAIN.md. */
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

  function fmtDate(v) {
    if (!v) return "—";
    var d = new Date(v);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  }

  var DUE_LABELS = {
    DUE: "Due",
    OVERDUE: "Overdue",
    RECEIVED_ON_TIME: "Received — on time",
    RECEIVED_LATE: "Received — late",
  };

  // ---------------- tabs ----------------
  $all(".ret-tabs button").forEach(function (b) {
    b.addEventListener("click", function () {
      $all(".ret-tabs button").forEach(function (x) { x.classList.remove("sel"); });
      b.classList.add("sel");
      var tab = b.getAttribute("data-tab");
      $("#tab-pending").hidden = tab !== "pending";
      $("#tab-all").hidden = tab !== "all";
    });
  });

  // ---------------- pending tab ----------------
  var pendingRows = [];
  function loadPending() {
    api("/returns/tracking?pending=1").then(function (r) {
      if (!r.ok || !Array.isArray(r.data)) return;
      pendingRows = r.data;
      $("#pending-count").textContent = pendingRows.length + " pending";
      var tb = $("#pending-table tbody");
      $("#pending-empty").style.display = pendingRows.length ? "none" : "block";
      tb.innerHTML = pendingRows.map(function (row) {
        var code = row.returnAwb || row.orderNo;
        return "<tr>" +
          "<td><b>" + esc(code) + "</b></td>" +
          "<td>" + esc(row.orderNo) + "</td>" +
          "<td>" + esc(row.brand) + " / " + esc(row.marketplace) + "</td>" +
          "<td>" + fmtDate(row.initiatedAt) + "</td>" +
          "<td>" + fmtDate(row.expectedReturnDate) + "</td>" +
          "<td><span class='status due-" + esc(row.dueStatus) + "'>" + esc(DUE_LABELS[row.dueStatus] || row.dueStatus) + "</span></td>" +
          "</tr>";
      }).join("");
    });
  }

  // ---------------- expected vs received tab ----------------
  var allRows = [];
  function matchesAllFilters(row) {
    var q = ($("#all-search").value || "").trim().toLowerCase();
    var statusFilter = $("#all-status-filter").value;
    if (statusFilter && row.dueStatus !== statusFilter) return false;
    if (!q) return true;
    var hay = [row.orderNo, row.dispatchAwb, row.returnAwb].join(" ").toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  function renderAllTable() {
    var visible = allRows.filter(matchesAllFilters);
    var tb = $("#all-table tbody");
    $("#all-empty").style.display = visible.length ? "none" : "block";
    tb.innerHTML = visible.map(function (row) {
      return "<tr>" +
        "<td><b>#" + row.id + "</b></td>" +
        "<td>" + esc(row.orderNo) + "</td>" +
        "<td>" + esc(row.marketplace) + "</td>" +
        "<td>" + esc(row.dispatchAwb || "—") + "</td>" +
        "<td>" + esc(row.returnAwb || "—") + "</td>" +
        "<td>" + fmtDate(row.expectedReturnDate) + "</td>" +
        "<td>" + fmtDate(row.deliveredAt) + "</td>" +
        "<td><span class='status due-" + esc(row.dueStatus) + "'>" + esc(DUE_LABELS[row.dueStatus] || row.dueStatus) + "</span></td>" +
        "</tr>";
    }).join("");
  }

  function loadAll() {
    api("/returns/tracking").then(function (r) {
      if (!r.ok || !Array.isArray(r.data)) return;
      allRows = r.data;
      $("#all-count").textContent = allRows.length + " total";
      renderAllTable();
    });
  }

  $("#all-search").addEventListener("input", renderAllTable);
  $("#all-status-filter").addEventListener("change", renderAllTable);

  loadPending();
  loadAll();
})();
