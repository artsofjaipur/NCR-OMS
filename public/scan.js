/* NCR-OMS Scan Station — pack scan, return sheet upload, return receive. */
(function () {
  "use strict";

  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  // ---------- auth guard (same session as dashboard) ----------
  var auth = null;
  try { auth = JSON.parse(sessionStorage.getItem("ncr_auth") || "null"); } catch (e) { auth = null; }
  if (!auth || !auth.token) { window.location.replace("/login.html"); return; }

  // VIEWER role is read-only — scans and imports change state.
  if (auth.role === "VIEWER") {
    document.body.innerHTML = "<div style='padding:60px;text-align:center;color:#98a2b3;font-family:Inter,sans-serif'>Your role (VIEWER) is read-only. Ask an OWNER/ADMIN for scan access.</div>";
    return;
  }

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

  $("#logout-btn").addEventListener("click", function () {
    sessionStorage.removeItem("ncr_auth");
    window.location.href = "/login.html";
  });

  // ---------- beep feedback ----------
  var actx = null;
  function beep(kind) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      var o = actx.createOscillator(), g = actx.createGain();
      o.connect(g); g.connect(actx.destination);
      o.type = "sine";
      if (kind === "ok") { o.frequency.value = 880; g.gain.value = 0.08; o.start(); o.stop(actx.currentTime + 0.12); }
      else if (kind === "dup") { o.frequency.value = 660; g.gain.value = 0.06; o.start(); o.stop(actx.currentTime + 0.18); }
      else { o.frequency.value = 220; g.gain.value = 0.09; o.start(); o.stop(actx.currentTime + 0.35); }
    } catch (e) { /* audio optional */ }
  }

  // ---------- feed ----------
  var feed = $("#feed");
  function addFeed(kind, title, sub, tag) {
    var row = document.createElement("div");
    row.className = "scanrow " + kind;
    row.innerHTML =
      "<div class='sr-main'><div class='sr-title'>" + esc(title) + "</div>" +
      (sub ? "<div class='sr-sub'>" + esc(sub) + "</div>" : "") + "</div>" +
      (tag ? "<span class='sr-tag tag-" + kind + "'>" + esc(tag) + "</span>" : "");
    feed.insertBefore(row, feed.firstChild);
    while (feed.children.length > 30) feed.removeChild(feed.lastChild);
  }

  // ---------- tabs ----------
  $all(".tabs button").forEach(function (b) {
    b.addEventListener("click", function () {
      $all(".tabs button").forEach(function (x) { x.classList.remove("sel"); });
      b.classList.add("sel");
      ["pack", "retsheet", "retrcv"].forEach(function (t) {
        $("#tab-" + t).hidden = t !== b.getAttribute("data-tab");
      });
    });
  });

  // ---------- pack scan ----------
  $("#pack-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var input = $("#pack-code");
    var code = input.value.trim();
    if (code.length < 3) return;
    $("#pack-btn").disabled = true;
    api("/dispatch/scan", { method: "POST", body: { code: code } }).then(function (r) {
      $("#pack-btn").disabled = false;
      input.value = "";
      input.focus();
      if (!r.ok) { beep("err"); addFeed("err", code, (r.data && r.data.error) || "Scan failed", "NOT FOUND"); return; }
      if (r.data.alreadyPacked) {
        beep("dup");
        addFeed("dup", r.data.order + " — " + r.data.brand, r.data.marketplace + " · " + r.data.courier + " · packed earlier", "ALREADY PACKED");
      } else {
        beep("ok");
        addFeed("ok", r.data.order + " — " + r.data.brand, r.data.marketplace + " · " + r.data.sellerAccount + " · " + r.data.courier, "PACKED → READY");
      }
    }).catch(function () { $("#pack-btn").disabled = false; beep("err"); addFeed("err", code, "Network error", "ERROR"); });
  });

  // ---------- return sheet upload ----------
  var rsFile = null;
  var rsDrop = $("#rs-drop");
  var rsInput = $("#rs-file");
  rsInput.addEventListener("change", function () { if (rsInput.files.length) setRs(rsInput.files[0]); });
  ["dragenter", "dragover"].forEach(function (ev) { rsDrop.addEventListener(ev, function (e) { e.preventDefault(); rsDrop.classList.add("drag"); }); });
  ["dragleave", "drop"].forEach(function (ev) { rsDrop.addEventListener(ev, function (e) { e.preventDefault(); rsDrop.classList.remove("drag"); }); });
  rsDrop.addEventListener("drop", function (e) { var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) setRs(f); });
  function setRs(f) {
    if (!/\.csv$/i.test(f.name)) { addFeed("err", f.name, "Only .csv accepted", "ERROR"); return; }
    rsFile = f;
    $("#rs-name").textContent = f.name + " (" + (f.size / 1024).toFixed(1) + " KB)";
  }

  $("#rs-btn").addEventListener("click", function () {
    if (!rsFile) { addFeed("err", "No file", "Choose the return sheet CSV first", "ERROR"); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var btn = $("#rs-btn");
      btn.disabled = true; btn.classList.add("loading");
      api("/returns/import", { method: "POST", body: { csv: String(reader.result) } }).then(function (r) {
        btn.disabled = false; btn.classList.remove("loading");
        if (!r.ok) { beep("err"); addFeed("err", "Import failed", (r.data && r.data.error) || "Try again", "ERROR"); return; }
        var d = r.data || {};
        beep(d.failed ? "dup" : "ok");
        addFeed(d.failed ? "err" : "ok",
          d.imported + " return" + (d.imported === 1 ? "" : "s") + " recorded" + (d.failed ? ", " + d.failed + " failed" : ""),
          "From " + rsFile.name,
          "SHEET DONE");
        (d.results || []).filter(function (x) { return x.error; }).slice(0, 8).forEach(function (x) {
          addFeed("err", "Row " + x.row, x.error, "SKIPPED");
        });
        rsFile = null;
        $("#rs-name").textContent = "Choose or drop the return sheet (.csv)";
        rsInput.value = "";
      }).catch(function () { btn.disabled = false; btn.classList.remove("loading"); beep("err"); });
    };
    reader.readAsText(rsFile);
  });

  // ---------- return receive scan ----------
  $("#rcv-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var input = $("#rcv-code");
    var code = input.value.trim();
    if (code.length < 3) return;
    $("#rcv-btn").disabled = true;
    api("/returns/scan", { method: "POST", body: { code: code } }).then(function (r) {
      $("#rcv-btn").disabled = false;
      input.value = "";
      input.focus();
      if (!r.ok) { beep("err"); addFeed("err", code, (r.data && r.data.error) || "Scan failed", "NOT FOUND"); return; }
      beep("ok");
      addFeed("ok", r.data.order + " — " + r.data.brand, r.data.marketplace + (r.data.sku ? " · " + r.data.sku : "") + " · next: QC → restock", "RECEIVED");
    }).catch(function () { $("#rcv-btn").disabled = false; beep("err"); addFeed("err", code, "Network error", "ERROR"); });
  });
})();
