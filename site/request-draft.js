// Keeps an unsent request on this device (localStorage) and clears it once
// the request is sent. The form works the same without it.
(() => {
  const clear = document.querySelector("[data-draft-clear]");
  if (clear) {
    try {
      localStorage.removeItem(clear.getAttribute("data-draft-clear"));
    } catch {}
  }

  const form = document.querySelector("form[data-draft-key]");
  if (!form) return;
  const key = form.getAttribute("data-draft-key");
  const status = form.querySelector("[data-draft-status]");
  const fields = () =>
    [...form.querySelectorAll("input[name], textarea[name]")].filter((field) => field.type !== "hidden");

  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(key) || "null");
  } catch {}
  if (saved && typeof saved === "object") {
    let restored = false;
    for (const field of fields()) {
      if (!field.value && typeof saved[field.name] === "string" && saved[field.name]) {
        field.value = saved[field.name];
        restored = true;
      }
    }
    if (restored && status) status.textContent = "Draft restored from this device.";
  }

  form.addEventListener("input", () => {
    const data = {};
    for (const field of fields()) data[field.name] = field.value;
    try {
      localStorage.setItem(key, JSON.stringify(data));
      if (status) status.textContent = "Draft saved on this device.";
    } catch {}
  });
})();
