(function() {
  var lightbox = document.getElementById("pro-showcase-lightbox");
  var contentBox = document.getElementById("pro-showcase-lightbox-content");
  var img = document.getElementById("pro-showcase-lightbox-img");
  var caption = document.getElementById("pro-showcase-lightbox-caption");
  var cloneEl = document.getElementById("pro-showcase-lightbox-clone");
  var closeBtn = lightbox && lightbox.querySelector(".pro-showcase-lightbox-close");

  // Focus state captured at open time so we can restore it on close.
  var lastFocused = null;

  function focusableInLightbox() {
    if (!contentBox) return [];
    return Array.prototype.slice.call(
      contentBox.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')
    ).filter(function(el) {
      return el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement;
    });
  }

  function onOpen() {
    lastFocused = document.activeElement;
    lightbox.classList.add("open");
    document.body.style.overflow = "hidden";
    if (closeBtn && typeof closeBtn.focus === "function") {
      // Defer so the lightbox is painted before focus moves.
      setTimeout(function() { closeBtn.focus(); }, 0);
    }
  }

  function open(src, cap) {
    if (!lightbox || !img) return;
    if (contentBox) contentBox.classList.remove("has-clone");
    img.src = src;
    img.alt = cap || "";
    if (caption) caption.textContent = cap || "";
    if (cloneEl) cloneEl.innerHTML = "";
    onOpen();
  }

  function openWithContent(html) {
    if (!lightbox || !cloneEl) return;
    if (contentBox) contentBox.classList.add("has-clone");
    cloneEl.innerHTML = html;
    img.src = "";
    if (caption) caption.textContent = "";
    onOpen();
  }

  function close() {
    if (!lightbox) return;
    var wasOpen = lightbox.classList.contains("open");
    lightbox.classList.remove("open");
    if (contentBox) contentBox.classList.remove("has-clone");
    if (cloneEl) cloneEl.innerHTML = "";
    document.body.style.overflow = "";
    if (wasOpen && lastFocused && typeof lastFocused.focus === "function") {
      lastFocused.focus();
    }
    lastFocused = null;
  }

  if (lightbox) {
    lightbox.addEventListener("click", function(e) {
      if (e.target === lightbox) close();
    });
    if (closeBtn) closeBtn.addEventListener("click", close);
    document.addEventListener("keydown", function(e) {
      if (!lightbox.classList.contains("open")) return;
      if (e.key === "Escape") { close(); return; }
      if (e.key !== "Tab") return;
      var items = focusableInLightbox();
      if (items.length === 0) {
        e.preventDefault();
        if (closeBtn) closeBtn.focus();
        return;
      }
      var first = items[0];
      var last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }

  var items = document.querySelectorAll(".pro-showcase-item");
  items.forEach(function(item) {
    var im = item.querySelector("img");
    var cap = item.querySelector(".pro-showcase-caption");
    if (!im) return;
    function show() {
      open(im.src, cap ? cap.textContent : "");
    }
    item.addEventListener("click", show);
    item.addEventListener("keydown", function(e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        show();
      }
    });
  });

  var reviewsWrap = document.getElementById("reviews-showcase-wrap");
  if (reviewsWrap) {
    function showReviews() {
      var label = reviewsWrap.querySelector(".section-label");
      var grid = document.getElementById("reviews-grid");
      var html = (label ? label.outerHTML : "") + (grid ? grid.outerHTML : "");
      openWithContent(html);
    }
    reviewsWrap.addEventListener("click", showReviews);
    reviewsWrap.addEventListener("keydown", function(e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        showReviews();
      }
    });
  }
})();
