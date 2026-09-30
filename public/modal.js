/* NCR-OMS — shared modal/dialog helper. Used by Company & Setup, Party
 * Master, Single Entry and Team & Roles to turn "add / edit a thing" flows
 * into attractive dialog boxes instead of inline accordions or expanding
 * table rows. Claude (Anthropic) 2026-09-19, per user request: "jaha
 * dilogbox se kam ho jaye vaha dilogbox se kaam me lo lekin attractive
 * banao." Deliberately tiny and dependency-free — include after your page
 * script (or before; order doesn't matter, it only defines window.NcrModal).
 */
(function () {
  "use strict";

  var openCount = 0;

  function open(opts) {
    opts = opts || {};
    var backdrop = document.createElement("div");
    backdrop.className = "ncr-modal-backdrop";

    var box = document.createElement("div");
    box.className = "ncr-modal-box" + (opts.wide ? " ncr-modal-wide" : "");
    box.innerHTML =
      "<div class='ncr-modal-head'>" +
        "<h3 class='serif'></h3>" +
        "<button type='button' class='ncr-modal-close' aria-label='Close'>&times;</button>" +
      "</div>" +
      "<div class='ncr-modal-body'></div>";
    box.querySelector(".ncr-modal-head h3").textContent = opts.title || "";
    var bodyEl = box.querySelector(".ncr-modal-body");
    if (opts.bodyHtml != null) bodyEl.innerHTML = opts.bodyHtml;
    else if (opts.bodyEl) bodyEl.appendChild(opts.bodyEl);

    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
    openCount++;
    document.body.classList.add("ncr-modal-open");

    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      backdrop.classList.remove("open");
      backdrop.classList.add("closing");
      document.removeEventListener("keydown", onKey);
      setTimeout(function () {
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        openCount = Math.max(0, openCount - 1);
        if (openCount === 0) document.body.classList.remove("ncr-modal-open");
        if (opts.onClose) opts.onClose();
      }, 160);
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    box.querySelector(".ncr-modal-close").addEventListener("click", close);
    backdrop.addEventListener("mousedown", function (e) { if (e.target === backdrop) close(); });

    // next frame so the CSS transition actually animates in
    requestAnimationFrame(function () { backdrop.classList.add("open"); });

    var firstField = bodyEl.querySelector("input, select, textarea");
    if (firstField) setTimeout(function () { firstField.focus(); }, 80);

    return { backdrop: backdrop, box: box, body: bodyEl, close: close };
  }

  window.NcrModal = { open: open };
})();
