/* Shared auth logic for NCR-OMS pages. Vanilla JS — no build step needed. */
(function () {
  "use strict";

  // ---------- rotating quote under the 3D brand cube ----------
  var quotes = document.querySelectorAll(".sc-quotes blockquote");
  if (quotes.length) {
    var qi = 0;
    quotes[0].classList.add("on");
    setInterval(function () {
      quotes[qi].classList.remove("on");
      qi = (qi + 1) % quotes.length;
      quotes[qi].classList.add("on");
    }, 4200);
  }

  // ---------- helpers ----------
  function $(sel) { return document.querySelector(sel); }

  function showAlert(kind, msg) {
    var el = $("#alert");
    if (!el) return;
    el.className = "alert show " + kind;
    el.textContent = msg;
  }

  function hideAlert() {
    var el = $("#alert");
    if (el) el.className = "alert";
  }

  function setLoading(btn, on) {
    if (!btn) return;
    btn.disabled = on;
    btn.classList.toggle("loading", on);
  }

  function validEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }

  function markInvalid(input, bad) {
    if (input) input.classList.toggle("invalid", bad);
    return bad;
  }

  function api(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
    });
  }

  // expose for page scripts
  window.ncrAuth = { $: $, showAlert: showAlert, hideAlert: hideAlert, setLoading: setLoading, validEmail: validEmail, markInvalid: markInvalid, api: api };

  // ---------- LOGIN ----------
  var loginForm = $("#login-form");
  if (loginForm) {
    // Brand quick-pick just decorates the workspace field visually.
    var picked = null;
    document.querySelectorAll(".brandpick button").forEach(function (b) {
      b.addEventListener("click", function () {
        document.querySelectorAll(".brandpick button").forEach(function (x) { x.classList.remove("sel"); });
        b.classList.add("sel");
        picked = b.getAttribute("data-name");
      });
    });

    loginForm.addEventListener("submit", function (e) {
      e.preventDefault();
      hideAlert();
      var email = $("#email");
      var pass = $("#password");
      var ws = $("#workspaceId");
      var bad = false;
      bad = markInvalid(email, !validEmail(email.value.trim())) || bad;
      bad = markInvalid(pass, pass.value.length === 0) || bad;
      if (bad) { showAlert("err", "Please enter a valid email and password."); return; }

      var payload = { email: email.value.trim(), password: pass.value };
      if (ws && ws.value.trim() !== "") {
        var n = Number(ws.value.trim());
        if (!Number.isInteger(n) || n <= 0) {
          showAlert("err", "Workspace ID must be a number — leave it empty if you don't have one.");
          return;
        }
        payload.companyId = n;
      }

      setLoading($("#login-btn"), true);
      api("/auth/login", payload).then(function (r) {
        if (r.ok) {
          try { sessionStorage.setItem("ncr_auth", JSON.stringify(r.data)); } catch (err) {}
          showAlert("ok", "Signed in. Taking you to your workspace…");
          setTimeout(function () { window.location.href = "/app.html"; }, 500);
        } else {
          setLoading($("#login-btn"), false);
          showAlert("err", r.data && r.data.error ? r.data.error : "Sign-in failed. Try again.");
        }
      }).catch(function () {
        setLoading($("#login-btn"), false);
        showAlert("err", "Network error — is the server running?");
      });
    });
  }

  // ---------- REGISTER ----------
  var regForm = $("#register-form");
  if (regForm) {
    regForm.addEventListener("submit", function (e) {
      e.preventDefault();
      hideAlert();
      var company = $("#company");
      var email = $("#email");
      var pass = $("#password");
      var pass2 = $("#password2");
      var bad = false;
      bad = markInvalid(company, company.value.trim().length < 2) || bad;
      bad = markInvalid(email, !validEmail(email.value.trim())) || bad;
      bad = markInvalid(pass, pass.value.length < 8) || bad;
      if (pass2 && pass2.value !== pass.value) {
        markInvalid(pass2, true); bad = true;
      }
      if (bad) {
        showAlert("err", pass.value.length < 8
          ? "Password must be at least 8 characters."
          : (pass2 && pass2.value !== pass.value ? "Passwords do not match." : "Please fill all fields correctly."));
        return;
      }

      setLoading($("#register-btn"), true);
      api("/auth/register", {
        companyName: company.value.trim(),
        email: email.value.trim(),
        password: pass.value,
      }).then(function (r) {
        if (r.ok) {
          try { sessionStorage.setItem("ncr_auth", JSON.stringify(r.data)); } catch (err) {}
          showAlert("ok", "Workspace created! Setting things up…");
          setTimeout(function () { window.location.href = "/app.html"; }, 700);
        } else {
          setLoading($("#register-btn"), false);
          showAlert("err", r.data && r.data.error ? r.data.error : "Registration failed. Try again.");
        }
      }).catch(function () {
        setLoading($("#register-btn"), false);
        showAlert("err", "Network error — is the server running?");
      });
    });
  }

  // ---------- FORGOT PASSWORD ----------
  var forgotForm = $("#forgot-form");
  if (forgotForm) {
    forgotForm.addEventListener("submit", function (e) {
      e.preventDefault();
      hideAlert();
      var email = $("#email");
      if (markInvalid(email, !validEmail(email.value.trim()))) {
        showAlert("err", "Please enter a valid email address.");
        return;
      }
      setLoading($("#forgot-btn"), true);
      api("/auth/forgot-password", { email: email.value.trim() }).then(function (r) {
        setLoading($("#forgot-btn"), false);
        if (!r.ok) {
          showAlert("err", r.data && r.data.error ? r.data.error : "Something went wrong. Try again.");
          return;
        }
        var box = $("#reset-instructions");
        if (box) {
          box.classList.add("show");
          $("#forgot-form").style.display = "none";
          var rt = $("#dev-token");
          if (rt && r.data && r.data.resetToken) {
            rt.textContent = r.data.resetToken;
            var dn = $("#dev-note");
            if (dn) dn.style.display = "block";
          }
        } else {
          showAlert("ok", r.data && r.data.message ? r.data.message : "Check your email for the reset link.");
        }
      }).catch(function () {
        setLoading($("#forgot-btn"), false);
        showAlert("err", "Network error — is the server running?");
      });
    });

    var fillBtn = $("#use-token");
    if (fillBtn) {
      fillBtn.addEventListener("click", function () {
        var t = ($("#dev-token").textContent || "").trim();
        if (t) { $("#token").value = t; $("#newPassword").focus(); }
      });
    }
  }

  // ---------- RESET PASSWORD ----------
  var resetForm = $("#reset-form");
  if (resetForm) {
    resetForm.addEventListener("submit", function (e) {
      e.preventDefault();
      hideAlert();
      var token = $("#token");
      var p1 = $("#newPassword");
      var p2 = $("#newPassword2");
      var bad = false;
      bad = markInvalid(token, token.value.trim().length < 10) || bad;
      bad = markInvalid(p1, p1.value.length < 8) || bad;
      if (p2 && p2.value !== p1.value) { markInvalid(p2, true); bad = true; }
      if (bad) {
        showAlert("err", p1.value.length < 8
          ? "New password must be at least 8 characters."
          : (p2 && p2.value !== p1.value ? "Passwords do not match." : "Please paste the reset token from your email."));
        return;
      }
      setLoading($("#reset-btn"), true);
      api("/auth/reset-password", { token: token.value.trim(), newPassword: p1.value }).then(function (r) {
        setLoading($("#reset-btn"), false);
        if (r.ok) {
          showAlert("ok", r.data && r.data.message ? r.data.message : "Password updated!");
          setTimeout(function () { window.location.href = "/login.html"; }, 1200);
        } else {
          showAlert("err", r.data && r.data.error ? r.data.error : "Reset failed — the link may have expired.");
        }
      }).catch(function () {
        setLoading($("#reset-btn"), false);
        showAlert("err", "Network error — is the server running?");
      });
    });
  }
})();
