(function () {
  if (location.pathname.replace(/\/$/, "") !== "/pro") return;
  var app = document.getElementById("pro-app");
  var accountId = (app && app.getAttribute("data-account-id")) || "";
  if (!accountId) {
    var m = location.search.match(/[?&]accountId=([^&]+)/);
    accountId = m ? decodeURIComponent(m[1]) : "";
  }
  if (!accountId) return;
  var wrapper = document.querySelector(".wrapper");
  if (!wrapper) return;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c];
    });
  }
  function displayName(name) {
    var n = String(name || "").trim();
    if (!n) return "No name";
    if (/^[;=?\-0-9]+$/.test(n)) return "No name";
    if (/^;/.test(n)) return "No name";
    return n;
  }
  function api(path, opts) {
    return fetch(path, Object.assign({ credentials: "same-origin" }, opts)).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, data: d }; }).catch(function () { return { ok: false, data: null }; });
    });
  }
  var qs = "accountId=" + encodeURIComponent(accountId);

  var root = document.createElement("div");
  root.id = "review-requests-root";
  root.className = "rr-wrap";
  wrapper.insertBefore(root, wrapper.firstChild);

  var state = { today: [], preview: "", sms: null };

  function smsLine() {
    if (!state.sms) return "";
    return "SMS this month: " + state.sms.used + "/" + state.sms.included + " · " + state.sms.remaining + " left";
  }

  function render() {
    root.innerHTML =
      '<h2>Ask for reviews</h2>' +
      '<p class="rr-sub">Add customers as they visit, then send a one-tap Google review request to everyone who came in today.</p>' +
      '<div class="rr-grid">' +
        '<div class="rr-card">' +
          '<h3>Add a customer</h3>' +
          '<label class="rr-field">First name<input id="rr-first" type="text" placeholder="Maria" autocomplete="off"></label>' +
          '<label class="rr-field">Phone<input id="rr-phone" type="tel" placeholder="(555) 123-4567" autocomplete="off"></label>' +
          '<label class="rr-field">Email (optional)<input id="rr-email" type="email" placeholder="maria@example.com" autocomplete="off"></label>' +
          '<label class="rr-field">Birthday (optional)<input id="rr-birthday" type="text" placeholder="YYYY-MM-DD or MM/DD" autocomplete="off"></label>' +
          '<label class="rr-check"><input id="rr-perm" type="checkbox"> <span>They agreed to receive messages from this business.</span></label>' +
          '<button type="button" id="rr-add" class="btn btn-primary">Add &amp; mark today</button>' +
          '<p id="rr-add-msg" class="rr-msg" aria-live="polite"></p>' +
        '</div>' +
        '<div class="rr-card">' +
          '<h3>Came in today (' + state.today.length + ')</h3>' +
          '<div id="rr-today">' + renderToday() + '</div>' +
          '<div class="rr-bar">' +
            '<span class="rr-muted">' + esc(smsLine()) + '</span>' +
            '<button type="button" id="rr-send" class="btn btn-primary"' + (state.today.length ? "" : " disabled") + '>Send review requests</button>' +
          '</div>' +
          '<p id="rr-send-msg" class="rr-msg" aria-live="polite"></p>' +
        '</div>' +
      '</div>';
    wire();
  }

  function renderToday() {
    if (!state.today.length) return '<p class="rr-muted">No one marked yet today. Add a customer to include them in today\'s send.</p>';
    return state.today.map(function (c) {
      return '<div class="rr-row"><span>' + esc(displayName(c.firstName)) +
        ' <span class="rr-muted">' + esc(c.phone || c.email || "") + '</span></span>' +
        '<button type="button" class="btn rr-unmark" data-id="' + esc(c.id) + '" title="Remove from today">&times;</button></div>';
    }).join("");
  }

  function load() {
    return api("/pro/review-requests?" + qs).then(function (res) {
      if (!res.ok || !res.data || res.data.error) {
        root.innerHTML = '<div class="rr-card"><p class="rr-muted">' + esc((res.data && res.data.error) || "Could not load review requests.") + "</p></div>";
        return;
      }
      state.today = res.data.today || [];
      state.preview = res.data.preview || "";
      state.sms = res.data.sms || null;
      render();
    });
  }

  function setVisit(id, on) {
    return api("/pro/review-requests/visit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: accountId, contactId: id, on: on })
    }).then(load);
  }

  function wire() {
    var addBtn = document.getElementById("rr-add");
    if (addBtn) addBtn.addEventListener("click", onAdd);
    var sendBtn = document.getElementById("rr-send");
    if (sendBtn) sendBtn.addEventListener("click", openConfirm);
    bindRowButtons();
  }

  function bindRowButtons() {
    Array.prototype.forEach.call(document.querySelectorAll(".rr-unmark"), function (b) {
      b.onclick = function () { setVisit(b.getAttribute("data-id"), false); };
    });
  }

  function onAdd() {
    var msg = document.getElementById("rr-add-msg");
    var perm = document.getElementById("rr-perm");
    var phone = document.getElementById("rr-phone").value.trim();
    var email = document.getElementById("rr-email").value.trim();
    msg.textContent = "";
    if (!perm.checked) { msg.textContent = "Please confirm consent first."; return; }
    if (!phone && !email) { msg.textContent = "Add a phone or email."; return; }
    var payload = {
      accountId: accountId,
      firstName: document.getElementById("rr-first").value.trim(),
      phone: phone,
      email: email,
      birthday: document.getElementById("rr-birthday").value.trim(),
      permission: true,
      markToday: true
    };
    var btn = document.getElementById("rr-add");
    btn.disabled = true;
    api("/pro/review-requests/contacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (res) {
      btn.disabled = false;
      if (!res.ok || !res.data || res.data.error) {
        msg.textContent = (res.data && res.data.error) || "Could not add.";
        return;
      }
      load();
    });
  }

  function openConfirm() {
    if (!state.today.length) return;
    var bg = document.createElement("div");
    bg.className = "rr-modal-bg";
    bg.innerHTML =
      '<div class="rr-modal">' +
        '<h3>Send review requests</h3>' +
        '<p class="rr-muted">Unchecked people will be skipped. We won\'t re-ask anyone messaged in the last 90 days.</p>' +
        '<div class="rr-preview">' + esc(state.preview) + '</div>' +
        '<div id="rr-people">' + state.today.map(function (c) {
          return '<label class="rr-check"><input type="checkbox" class="rr-send-check" data-id="' + esc(c.id) + '" checked> <span>' +
            esc(displayName(c.firstName)) + ' <span class="rr-muted">' + esc(c.phone || "") + '</span></span></label>';
        }).join("") + '</div>' +
        '<div class="rr-bar">' +
          '<button type="button" class="btn" id="rr-cancel">Cancel</button>' +
          '<button type="button" class="btn btn-primary" id="rr-confirm">Send now</button>' +
        '</div>' +
        '<p id="rr-modal-msg" class="rr-msg" aria-live="polite"></p>' +
      '</div>';
    document.body.appendChild(bg);
    bg.addEventListener("click", function (e) { if (e.target === bg) document.body.removeChild(bg); });
    document.getElementById("rr-cancel").onclick = function () { document.body.removeChild(bg); };
    document.getElementById("rr-confirm").onclick = function () {
      var excludeIds = [];
      Array.prototype.forEach.call(document.querySelectorAll(".rr-send-check"), function (chk) {
        if (!chk.checked) excludeIds.push(chk.getAttribute("data-id"));
      });
      var mm = document.getElementById("rr-modal-msg");
      var cbtn = document.getElementById("rr-confirm");
      cbtn.disabled = true;
      mm.textContent = "Sending…";
      api("/pro/review-requests/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: accountId, excludeIds: excludeIds })
      }).then(function (res) {
        if (!res.ok || !res.data || res.data.error) {
          cbtn.disabled = false;
          mm.textContent = (res.data && res.data.error) || "Send failed.";
          return;
        }
        if (document.body.contains(bg)) document.body.removeChild(bg);
        load().then(function () {
          var sm = document.getElementById("rr-send-msg");
          if (sm) sm.textContent = "Sent " + res.data.sent + (res.data.failed ? (", " + res.data.failed + " failed") : "") + ".";
        });
      });
    };
  }

  load();
})();
