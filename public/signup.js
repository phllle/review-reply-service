(function() {
  var lightbox = document.getElementById("pro-showcase-lightbox");
  var contentBox = document.getElementById("pro-showcase-lightbox-content");
  var img = document.getElementById("pro-showcase-lightbox-img");
  var caption = document.getElementById("pro-showcase-lightbox-caption");
  var cloneEl = document.getElementById("pro-showcase-lightbox-clone");
  var closeBtn = lightbox && lightbox.querySelector(".pro-showcase-lightbox-close");

  function open(src, cap) {
    if (!lightbox || !img) return;
    if (contentBox) contentBox.classList.remove("has-clone");
    img.src = src;
    img.alt = cap || "";
    if (caption) caption.textContent = cap || "";
    if (cloneEl) cloneEl.innerHTML = "";
    lightbox.classList.add("open");
    document.body.style.overflow = "hidden";
  }

  function openWithContent(html) {
    if (!lightbox || !cloneEl) return;
    if (contentBox) contentBox.classList.add("has-clone");
    cloneEl.innerHTML = html;
    img.src = "";
    if (caption) caption.textContent = "";
    lightbox.classList.add("open");
    document.body.style.overflow = "hidden";
  }

  function close() {
    if (!lightbox) return;
    lightbox.classList.remove("open");
    if (contentBox) contentBox.classList.remove("has-clone");
    if (cloneEl) cloneEl.innerHTML = "";
    document.body.style.overflow = "";
  }

  if (lightbox) {
    lightbox.addEventListener("click", function(e) {
      if (e.target === lightbox) close();
    });
    if (closeBtn) closeBtn.addEventListener("click", close);
    document.addEventListener("keydown", function(e) {
      if (e.key === "Escape") close();
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
