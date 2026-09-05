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
  var SEARCH_MIN = 2;
  var SEARCH_MAX = 25;

  var root = document.createElement("div");
  root.id = "review-requests-root";
  root.className = "rr-wrap";
  wrapper.insertBefore(root, wrapper.firstChild);

  var state = { today: [], contacts: [], preview: "", sms: null, query: "" };

  function smsLine() {
    if (!state.sms) return "";
    return "SMS this month: " + state.sms.used + "/" + state.sms.included + " · " + state.sms.remaining + " left";
  }

  function matchesQuery(c, q) {
    return ((c.firstName || "") + " " + (c.phone || "") + " " + (c.email || "")).toLowerCase().indexOf(q) !== -1;
  }

  function filteredContacts() {
    var q = (state.query || "").trim().toLowerCase();
    if (q.length < SEARCH_MIN) return [];
    var out = [];
    for (var i = 0; i < state.contacts.length && out.length < SEARCH_MAX; i++) {
      if (matchesQuery(state.contacts[i], q)) out.push(state.contacts[i]);
    }
    return out;
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
      '</div>' +
      '<div class="rr-card" style="margin-top:14px">' +
        '<h3>Find a customer</h3>' +
        '<p class="rr-muted">' + state.contacts.length + ' on file. Type at least 2 letters or digits of a name, phone, or email.</p>' +
        '<input id="rr-search" class="rr-search" type="text" placeholder="Search name, phone, or email" value="' + esc(state.query) + '">' +
        '<div id="rr-all">' + renderAll(filteredContacts()) + '</div>' +
      '</div>';
    wire();
  }

  function renderToday() {
    if (!state.today.length) return '<p class="rr-muted">No one marked yet today.</p>';
    return state.today.map(function (c) {
      return '<div class="rr-row"><span>' + esc(displayName(c.firstName)) +
        ' <span class="rr-muted">' + esc(c.phone || c.email || "") + '</span></span>' +
        '<button type="button" class="btn rr-unmark" data-id="' + esc(c.id) + '" title="Remove from today">&times;</button></div>';
    }).join("");
  }

  function renderAll(list) {
    var q = (state.query || "").trim();
    if (q.length < SEARCH_MIN) {
      return '<p class="rr-muted">Search to mark someone who is already on your list.</p>';
    }
    if (!list.length) return '<p class="rr-muted">No matches.</p>';
    var extra = "";
    var totalHits = 0;
    var ql = q.toLowerCase();
    for (var i = 0; i < state.contacts.length; i++) {
      if (matchesQuery(state.contacts[i], ql)) totalHits++;
    }
    if (totalHits > list.length) extra = '<p class="rr-muted">Showing ' + list.length + ' of ' + totalHits + '. Narrow the search.</p>';
    return extra + '<table class="rr-table"><thead><tr><th>Name</th><th>Contact</th><th>Status</th><th></th></tr></thead><tbody>' +
      list.map(function (c) {
        var status = c.visitedToday ? '<span class="rr-chip">Today</span>' : (c.requestedAt ? '<span class="rr-muted">Requested</span>' : "");
        var action = c.visitedToday
          ? '<button type="button" class="btn rr-unmark" data-id="' + esc(c.id) + '">Remove</button>'
          : '<button type="button" class="btn rr-mark" data-id="' + esc(c.id) + '">Came in today</button>';
        var nameClass = displayName(c.firstName) === "No name" ? "rr-muted" : "";
        return '<tr><td class="' + nameClass + '">' + esc(displayName(c.firstName)) + '</td><td class="rr-muted">' +
          esc(c.phone || c.email || "") + '</td><td>' + status + '</td><td>' + action + '</td></tr>';
      }).join("") +
      '</tbody></table>';
  }

  function load() {
    var keep = state.query;
    return api("/pro/review-requests?" + qs).then(function (res) {
      if (!res.ok || !res.data || res.data.error) {
        root.innerHTML = '<div class="rr-card"><p class="rr-muted">' + esc((res.data && res.data.error) || "Could not load review requests.") + "</p></div>";
        return;
      }
      state.today = res.data.today || [];
      state.contacts = res.data.contacts || [];
      state.preview = res.data.preview || "";
      state.sms = res.data.sms || null;
      state.query = keep || "";
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
    var search = document.getElementById("rr-search");
    if (search) {
      search.addEventListener("input", function () {
        state.query = search.value;
        document.getElementById("rr-all").innerHTML = renderAll(filteredContacts());
        bindRowButtons();
      });
    }
    var sendBtn = document.getElementById("rr-send");
    if (sendBtn) sendBtn.addEventListener("click", openConfirm);
    bindRowButtons();
  }

  function bindRowButtons() {
    Array.prototype.forEach.call(document.querySelectorAll(".rr-mark"), function (b) {
      b.onclick = function () { setVisit(b.getAttribute("data-id"), true); };
    });
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
