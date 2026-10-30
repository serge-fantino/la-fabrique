/*! FabriqueReport 1.0.0 — early error catcher. Load it first, on every page, so a
 * report also carries the errors that happened before the kit was loaded. */
(function () {
  "use strict";
  var errors = (window.FabriqueReportErrors = window.FabriqueReportErrors || []);
  if (errors.__listening) return;
  errors.__listening = true;
  function keep(message) {
    errors.push(String(message).slice(0, 500));
    if (errors.length > 20) errors.shift();
  }
  window.addEventListener("error", function (event) {
    keep((event.message || "Error") + (event.filename ? " (" + event.filename + ":" + event.lineno + ")" : ""));
  });
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason;
    keep("Unhandled rejection: " + ((reason && reason.message) || reason));
  });
})();
