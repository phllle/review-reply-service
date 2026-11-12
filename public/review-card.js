// Print-button wiring for the QR review-card page (/review-card).
// This lives in an external file because the site's Content-Security-Policy
// (helmet defaults) blocks inline event handlers such as onclick — the
// button silently did nothing while the handler was inline in the HTML.
document.getElementById("rcPrintBtn")?.addEventListener("click", () => window.print());
