// Theme (Auto / Light / Dark). External file, not inline: the CSP is script-src 'self'. Loaded synchronously from <head> so
// data-theme is set before first paint (no flash). Also exposes window.vcTheme for the app (single source of truth).
(function () {
  var KEY = "vc-theme", COLORS = { light: "#F7F8FA", dark: "#0F1115" };
  function read() { try { var v = localStorage.getItem(KEY); return v === "light" || v === "dark" ? v : "auto"; } catch (e) { return "auto"; } }
  function apply(mode) {
    var d = document.documentElement;
    if (mode === "light" || mode === "dark") d.setAttribute("data-theme", mode); else d.removeAttribute("data-theme");
    // theme-color: with an explicit mode both media variants carry that mode's colour, so the OS preference cannot win; Auto restores the pair.
    var m = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < m.length; i++) {
      var own = m[i].getAttribute("data-scheme") === "dark" ? "dark" : "light";
      m[i].setAttribute("content", COLORS[mode === "light" || mode === "dark" ? mode : own]);
    }
  }
  function set(mode) {
    try { if (mode === "light" || mode === "dark") localStorage.setItem(KEY, mode); else localStorage.removeItem(KEY); } catch (e) { /* storage blocked: still applies for this page */ }
    apply(mode);
  }
  window.vcTheme = { get: read, set: set, apply: apply };
  apply(read());
})();
