(function () {
  function starChars(n) {
    var s = "";
    for (var i = 1; i <= 5; i++) s += i <= n ? "★" : "☆";
    return s;
  }
  function timeAgo(iso) {
    if (!iso) return "";
    var t = new Date(iso).getTime();
    if (!t) return "";
    var mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    var days = Math.round(hrs / 24);
    if (days < 30) return days + "d ago";
    return new Date(iso).toLocaleDateString();
  }
  function holdLabel(iso) {
    if (!iso) return "Holding";
    var mins = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000));
    if (mins <= 0) return "Posting soon";
    return "Holding " + mins + " min";
  }
  function esc(s) {
    return String(s || "").replace(/[&<>"]/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c];
    });
  }
  var root = document.querySelector("[data-account-id]");
  var accountId = root ? root.getAttribute("data-account-id") : "";
  var list = document.getElementById("reviews-list");
  if (!list || !accountId) return;
  fetch("/reviews?accountId=" + encodeURIComponent(accountId), { credentials: "same-origin" })
    .then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, data: d }; });
    })
    .then(function (res) {
      if (!res.ok || !res.data || res.data.error) {
        list.innerHTML = '<p class="reviews-error">' + esc((res.data && res.data.error) || "Could not load reviews.") + "</p>";
        return;
      }
      var items = res.data.reviews || [];
      if (!items.length) {
        list.innerHTML = '<p class="reviews-empty">No reviews yet. When customers leave one, it will show up here.</p>';
        return;
      }
      list.innerHTML = items.map(function (item) {
        var pillClass = item.status === "posted" ? "status-posted" : item.status === "holding" ? "status-holding" : "status-unreplied";
        var pillText = item.status === "posted" ? "Posted" : item.status === "holding" ? holdLabel(item.holdUntil) : "Unreplied";
        var reply = item.replyComment
          ? '<div class="review-reply"><strong>Owner reply</strong> — ' + esc(item.replyComment.slice(0, 180)) + (item.replyComment.length > 180 ? "…" : "") + "</div>"
          : '<div class="review-reply"><strong>Owner reply</strong> — waiting</div>';
        return '<div class="review-row"><div class="review-row-top"><span class="review-stars">' +
          starChars(item.rating || 0) + '</span><span class="review-name">' + esc(item.reviewerName) +
          '</span><span class="review-time">' + esc(timeAgo(item.createTime)) + "</span></div>" +
          '<p class="review-comment">' + esc((item.comment || "").slice(0, 220)) +
          ((item.comment || "").length > 220 ? "…" : "") + "</p>" +
          '<div class="review-row-bottom">' + reply + '<span class="status-pill ' + pillClass + '">' +
          esc(pillText) + "</span></div></div>";
      }).join("");
    })
    .catch(function () {
      list.innerHTML = '<p class="reviews-error">Could not load reviews.</p>';
    });
})();
