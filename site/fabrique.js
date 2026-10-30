// Shared by every page: the loading bar, the way pages follow one another,
// and the reference branch menu of a project's header. Pages work the same
// without it.
(() => {
  const thisScript = document.currentScript;
  const scriptSrc = thisScript ? thisScript.getAttribute("src") : null;

  // Loading bar: the stylesheet waits a moment before showing it, so fast
  // pages do not flash it.
  const start = () => document.querySelector("[data-loading]")?.classList.add("visible");
  const stop = () => document.querySelector("[data-loading]")?.classList.remove("visible");

  // Pages follow one another without leaving the current one: it stays
  // alive, with its loading bar moving, until the next one is read (some
  // browsers, Safari among them, stop drawing a page as soon as it is left).
  // The server still renders every page; only the body is swapped. A page
  // with its own script or another stylesheet is loaded by the browser.
  const stylesheetOf = (doc) => doc.querySelector('link[rel="stylesheet"][href^="/styles.css"]')?.getAttribute("href") ?? null;
  const onlyThisScript = (doc) => {
    const scripts = [...doc.querySelectorAll("script[src]")].map((script) => script.getAttribute("src"));
    return scripts.length === 1 && scripts[0] === scriptSrc;
  };
  const withoutHash = (href) => href.split("#")[0];
  let shown = withoutHash(location.href);
  let pending = null;

  const followable = (url) =>
    url.origin === location.origin && !url.pathname.startsWith("/auth/") && !url.pathname.startsWith("/api/");

  const visit = async (href, push) => {
    if (!scriptSrc || !onlyThisScript(document)) return location.assign(href);
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    start();
    try {
      const response = await fetch(href, { headers: { accept: "text/html" }, signal: controller.signal });
      if (!(response.headers.get("content-type") || "").includes("text/html")) throw new Error("not a page");
      const next = new DOMParser().parseFromString(await response.text(), "text/html");
      if (controller.signal.aborted) return;
      if (stylesheetOf(next) !== stylesheetOf(document) || !onlyThisScript(next)) throw new Error("other assets");

      const hash = new URL(href, location.href).hash;
      const address = response.url + (new URL(response.url).hash ? "" : hash);
      if (push) {
        history.replaceState({ ...(history.state || {}), scroll: window.scrollY }, "");
        history.pushState({ scroll: 0 }, "", address);
      } else if (withoutHash(address) !== withoutHash(location.href)) {
        history.replaceState(history.state, "", address);
      }
      shown = withoutHash(location.href);
      document.title = next.title;
      document.body.replaceWith(document.adoptNode(next.body));
      setUp();

      const target = hash ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
      if (target) target.scrollIntoView();
      else window.scrollTo(0, push ? 0 : (history.state?.scroll ?? 0));
      const main = document.querySelector("main");
      if (main) {
        main.setAttribute("tabindex", "-1");
        main.focus({ preventScroll: true });
      }
    } catch (error) {
      if (error?.name === "AbortError") return;
      location.assign(href);
    } finally {
      if (pending === controller) pending = null;
    }
  };

  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link || link.target || link.hasAttribute("download")) return;
    const url = new URL(link.href, location.href);
    if (!followable(url)) return;
    if (withoutHash(url.href) === shown && url.hash) return;
    event.preventDefault();
    visit(url.href, true);
  });

  document.addEventListener("submit", (event) => {
    if (event.defaultPrevented) return;
    const form = event.target;
    const method = (form.getAttribute("method") || "get").toLowerCase();
    const url = new URL(form.getAttribute("action") || location.href, location.href);
    if (method !== "get" || !followable(url)) {
      start();
      return;
    }
    event.preventDefault();
    url.search = new URLSearchParams(new FormData(form)).toString();
    visit(url.href, true);
  });

  window.addEventListener("popstate", () => {
    if (withoutHash(location.href) === shown) return;
    visit(location.href, false);
  });
  // Back and forward may restore a page from the cache, bar included.
  window.addEventListener("pageshow", stop);

  document.addEventListener("click", (event) => {
    const menu = document.querySelector("[data-branch-menu]");
    if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
  });

  // What each page needs once it is shown.
  function setUp() {
    setUpDiagnostic();
    setUpRefresh();
    setUpBranchMenu();
  }

  // Settings: what this device runs, against what the page expects.
  function setUpDiagnostic() {
    const diagnostic = document.querySelector("[data-diagnostic]");
    if (!diagnostic) return;
    const scriptOk = scriptSrc === diagnostic.getAttribute("data-expected-script");
    const loading = document.querySelector(".loading");
    const stylesOk = Boolean(loading && getComputedStyle(loading).getPropertyValue("--scanner").trim());
    diagnostic.textContent = `Script ${scriptOk ? "up to date" : `old copy (${scriptSrc ?? "unknown"})`}; stylesheet ${
      stylesOk ? "up to date" : "old copy"
    }.`;
  }

  // Reload everything: also empty the Cache Storage, where there is one.
  function setUpRefresh() {
    const refresh = document.querySelector("form[data-refresh]");
    if (!refresh) return;
    refresh.addEventListener("submit", async (event) => {
      if (!("caches" in window)) return;
      event.preventDefault();
      start();
      try {
        await Promise.all((await caches.keys()).map((key) => caches.delete(key)));
      } catch {}
      refresh.submit();
    });
  }

  // Branch menu: the full list is read once, when the menu first opens,
  // then filtered as one types.
  function setUpBranchMenu() {
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
      const matching = branches.filter((branch) => words.every((word) => branch.toLowerCase().includes(word)));
      list.replaceChildren(...matching.slice(0, 200).map(item));
      if (!matching.length) {
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
  }

  setUp();
})();
