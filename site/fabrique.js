// Shared by every page: the loading bar at the top while the next page is
// on its way, and the reference branch menu of a project's header. Pages
// work the same without it.
(() => {
  // Loading bar: shown after a short delay so fast pages do not flash it.
  const bar = document.querySelector("[data-loading]");
  let timer = 0;
  const start = () => {
    if (!bar || timer) return;
    timer = window.setTimeout(() => bar.classList.add("visible"), 150);
  };
  const stop = () => {
    window.clearTimeout(timer);
    timer = 0;
    if (bar) bar.classList.remove("visible");
  };

  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link || link.target || link.hasAttribute("download")) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin) return;
    if (url.pathname === location.pathname && url.search === location.search && url.hash) return;
    start();
  });
  document.addEventListener("submit", (event) => {
    if (!event.defaultPrevented) start();
  });
  // Back and forward restore the page from the cache, bar included.
  window.addEventListener("pageshow", stop);

  // Branch menu: the full list is read once, when the menu first opens,
  // then filtered as one types.
  const menu = document.querySelector("[data-branch-menu]");
  if (!menu) return;
  const search = menu.querySelector("[data-branch-search]");
  const list = menu.querySelector("[data-branch-list]");
  const path = menu.getAttribute("data-path") || location.pathname;
  const production = menu.getAttribute("data-production") || "";
  const integration = menu.getAttribute("data-integration") || "";
  const current = menu.getAttribute("data-current") || production;
  let branches = [...list.querySelectorAll("code")].map((code) => code.textContent);
  let loaded = false;

  // The datalist is for pages without this script; the list replaces it.
  if (search) search.removeAttribute("list");

  const item = (branch) => {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = `${path}?ref=${branch === production ? "" : encodeURIComponent(branch)}`;
    if (branch === current) a.setAttribute("aria-current", "true");
    const code = document.createElement("code");
    code.textContent = branch;
    a.append(code);
    const tag = branch === production ? ["ok", "production"] : branch === integration ? ["warn", "integration"] : null;
    if (tag) {
      const pill = document.createElement("span");
      pill.className = `pill ${tag[0]}`;
      pill.textContent = tag[1];
      a.append(" ", pill);
    }
    li.append(a);
    return li;
  };

  const render = () => {
    const words = (search ? search.value : "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    const shown = branches.filter((branch) => words.every((word) => branch.toLowerCase().includes(word)));
    list.replaceChildren(...shown.slice(0, 200).map(item));
    if (!shown.length) {
      const empty = document.createElement("li");
      empty.className = "muted branch-empty";
      empty.textContent = loaded ? "No branch matches. Press Enter to try this name." : "No branch matches yet.";
      list.append(empty);
    }
  };

  const load = async () => {
    if (loaded) return;
    loaded = true;
    menu.setAttribute("aria-busy", "true");
    try {
      const response = await fetch(menu.getAttribute("data-branches"), { headers: { accept: "application/json" } });
      const data = await response.json();
      if (Array.isArray(data.branches) && data.branches.length) branches = data.branches;
    } catch {
      // The branches already listed stay.
    }
    menu.removeAttribute("aria-busy");
    render();
  };

  menu.addEventListener("toggle", () => {
    if (!menu.open) return;
    load();
    if (search) search.focus();
  });
  if (search) search.addEventListener("input", render);
  menu.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    menu.open = false;
    menu.querySelector("summary").focus();
  });
  document.addEventListener("click", (event) => {
    if (menu.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
  });
})();
