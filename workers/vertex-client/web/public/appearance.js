// Reading appearance (transcript font size / font, code font, code line wrapping). External file, not inline: the CSP is script-src 'self'.
// Loaded synchronously from <head> so the choices are on <html> as data-* attributes before first paint (no flash). styles.css maps each
// value to CSS variables (--t-size, --t-font, --c-font ...), so nothing here touches inline styles. Also exposes window.vcAppearance.
(function () {
  var KEY = "vc-appearance";
  var DEFAULTS = { fs: 3, tf: "system", cf: "system", wrap: false };
  var TF = ["system", "serif", "mono"], CF = ["system", "sf"];
  function clean(o) {
    o = o && typeof o === "object" ? o : {};
    var fs = Number(o.fs);
    return {
      fs: fs >= 1 && fs <= 5 && Math.floor(fs) === fs ? fs : DEFAULTS.fs,
      tf: TF.indexOf(o.tf) >= 0 ? o.tf : DEFAULTS.tf,
      cf: CF.indexOf(o.cf) >= 0 ? o.cf : DEFAULTS.cf,
      wrap: o.wrap === true,
    };
  }
  function read() { try { return clean(JSON.parse(localStorage.getItem(KEY) || "null")); } catch (e) { return clean(null); } }
  function apply(a) {
    var d = document.documentElement;
    d.setAttribute("data-fs", String(a.fs)); d.setAttribute("data-tf", a.tf); d.setAttribute("data-cf", a.cf);
    if (a.wrap) d.setAttribute("data-wrap", "1"); else d.removeAttribute("data-wrap");
  }
  function set(patch) {
    var a = clean(Object.assign(read(), patch));
    try { localStorage.setItem(KEY, JSON.stringify(a)); } catch (e) { /* storage blocked: still applies for this page */ }
    apply(a);
    return a;
  }
  window.vcAppearance = { get: read, set: set, apply: apply, DEFAULTS: DEFAULTS };
  apply(read());
})();
