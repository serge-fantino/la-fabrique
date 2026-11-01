// Shared by every page: the loading bar, the way pages follow one another,
// and the reference branch menu of a project's header. Pages work the same
// without it.
(() => {
  const thisScript = document.currentScript;
  document.documentElement.classList.add("js");
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
  // Only the site's own scripts count: a host may add its own (analytics),
  // which the security policy blocks anyway.
  const ownScripts = (doc) =>
    [...doc.querySelectorAll("script[src]")]
      .map((script) => script.getAttribute("src") || "")
      .filter((src) => src.startsWith("/") && !src.startsWith("//"));
  const onlyThisScript = (doc) => {
    const scripts = ownScripts(doc);
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
    if (!link || link.target || link.hasAttribute("download") || link.hasAttribute("data-update")) return;
    const url = new URL(link.href, location.href);
    if (!followable(url)) return;
    if (withoutHash(url.href) === shown && url.hash) return;
    event.preventDefault();
    visit(url.href, true);
  });

  // A criterion ticked in To test: at once on the page, sent in the
  // background, one after another (each tick rewrites the issue's text: two
  // at once would undo each other); GitHub's answer confirms it, or the tick
  // goes back with why. Validate waits until every tick is saved.
  let ticks = Promise.resolve();
  let pendingTicks = 0;
  const refreshValidate = (story) => {
    const validate = story && story.querySelector("[data-validate]");
    if (!validate) return;
    const all = [...story.querySelectorAll("button.criterion")].every((criterion) => criterion.getAttribute("aria-pressed") === "true");
    const ready = all && pendingTicks === 0;
    validate.disabled = !ready;
    validate.classList.toggle("quiet", !ready);
    if (pendingTicks > 0 && all) validate.setAttribute("title", "Saving the ticks…");
    else validate.removeAttribute("title");
  };
  document.addEventListener(
    "submit",
    (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || !form.hasAttribute("data-criterion")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (form.dataset.pending) return;
      const data = new FormData(form);
      const done = form.elements.namedItem("done");
      const button = form.querySelector("button.criterion");
      const box = button && button.querySelector(".box");
      const item = form.closest("li");
      const story = form.closest(".test-story");
      const show = (on) => {
        if (button) button.setAttribute("aria-pressed", String(on));
        if (box) box.textContent = on ? "✓" : "";
        if (item) item.classList.toggle("done", on);
        if (done instanceof HTMLInputElement) done.value = on ? "0" : "1";
        refreshValidate(story);
      };
      const wanted = data.get("done") === "1";
      const old = story && story.querySelector("[data-criterion-error]");
      if (old) old.remove();
      form.dataset.pending = "1";
      form.setAttribute("aria-busy", "true");
      pendingTicks++;
      show(wanted);
      ticks = ticks.then(async () => {
        try {
          const response = await fetch(form.action, { method: "POST", body: data, headers: { accept: "application/json" } });
          const answer = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(answer.error || "The tick was not saved.");
        } catch (error) {
          show(!wanted);
          if (story) {
            const note = document.createElement("p");
            note.className = "notice error";
            note.setAttribute("role", "alert");
            note.setAttribute("data-criterion-error", "");
            note.textContent = error instanceof Error && error.message ? error.message : "The tick was not saved: reload the page.";
            (form.closest("ul") || story).before(note);
          }
        } finally {
          pendingTicks--;
          delete form.dataset.pending;
          form.removeAttribute("aria-busy");
          refreshValidate(story);
        }
      });
    },
    true,
  );

  // Reordering a list by drag and drop (pointer: mouse, pen or touch), or by
  // the arrow keys on an item's handle (la-fabrique#181). The new order is
  // sent at once; refused, the page is read again.
  const sortItems = (list) => [...list.children].filter((child) => child.hasAttribute("data-sort-id"));
  const orderOf = (list) => sortItems(list).map((child) => child.getAttribute("data-sort-id")).join(",");
  const saveOrder = async (list) => {
    const body = new URLSearchParams({ csrf: list.dataset.csrf || "", action: list.dataset.sortable || "", order: orderOf(list) });
    if (list.dataset.sortCard) body.set("card", list.dataset.sortCard);
    try {
      const response = await fetch(list.dataset.sortUrl || location.href, { method: "POST", body, headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("refused");
    } catch {
      location.reload();
    }
  };
  // The item of this list under a point (not a nested list's).
  const itemAt = (list, x, y) => {
    let node = document.elementFromPoint(x, y);
    while (node && node !== list) {
      if (node.parentElement === list && node.hasAttribute("data-sort-id")) return node;
      node = node.parentElement;
    }
    return null;
  };
  let dragging = null;
  document.addEventListener("pointerdown", (event) => {
    const handle = event.target instanceof Element ? event.target.closest("[data-sort-handle]") : null;
    if (!handle || event.button !== 0) return;
    const item = handle.closest("[data-sort-id]");
    const list = item && item.parentElement;
    if (!list || !list.hasAttribute("data-sortable")) return;
    event.preventDefault();
    dragging = { item, list, before: orderOf(list) };
    item.classList.add("sorting");
  });
  document.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    event.preventDefault();
    const over = itemAt(dragging.list, event.clientX, event.clientY);
    if (!over || over === dragging.item) return;
    const box = over.getBoundingClientRect();
    dragging.list.insertBefore(dragging.item, event.clientY > box.top + box.height / 2 ? over.nextSibling : over);
  });
  const endDrag = () => {
    if (!dragging) return;
    const { item, list, before } = dragging;
    dragging = null;
    item.classList.remove("sorting");
    if (orderOf(list) !== before) saveOrder(list);
  };
  document.addEventListener("pointerup", endDrag);
  document.addEventListener("pointercancel", endDrag);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const handle = event.target instanceof Element ? event.target.closest("[data-sort-handle]") : null;
    const item = handle && handle.closest("[data-sort-id]");
    const list = item && item.parentElement;
    if (!list || !list.hasAttribute("data-sortable")) return;
    event.preventDefault();
    const items = sortItems(list);
    const at = items.indexOf(item);
    const to = event.key === "ArrowUp" ? at - 1 : at + 1;
    if (to < 0 || to >= items.length) return;
    list.insertBefore(item, event.key === "ArrowUp" ? items[to] : items[to].nextSibling);
    handle.focus();
    saveOrder(list);
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

  // A select that sends its form when changed (the button is for pages
  // without this script).
  document.addEventListener("change", (event) => {
    const field = event.target;
    const toggles = field instanceof HTMLSelectElement || (field instanceof HTMLInputElement && field.type === "checkbox");
    if (toggles && field.hasAttribute("data-autosubmit") && field.form) field.form.requestSubmit();
  });

  window.addEventListener("popstate", () => {
    if (withoutHash(location.href) === shown) return;
    visit(location.href, false);
  });
  // Back and forward may restore a page from the cache, bar included.
  window.addEventListener("pageshow", (event) => {
    stop();
    // A page back from the cache: its busy forms can be sent again.
    if (event.persisted) for (const form of document.querySelectorAll("form[data-sent]")) unbusy(form);
  });

  // A panel that unfolds a form puts the cursor in its first field.
  document.addEventListener(
    "toggle",
    (event) => {
      const panel = event.target;
      if (panel instanceof HTMLDetailsElement && panel.open && panel.hasAttribute("data-autofocus")) {
        panel.querySelector("textarea, input:not([type=hidden])")?.focus();
      }
    },
    true,
  );

  // "Cancel" folds the panel back into its button.
  document.addEventListener("click", (event) => {
    const close = event.target instanceof Element ? event.target.closest("[data-panel-close]") : null;
    const panel = close?.closest("details");
    if (panel) panel.open = false;
  });

  // A form sent once: the button pressed says it is on its way.
  const unbusy = (form) => {
    delete form.dataset.sent;
    form.removeAttribute("aria-busy");
    const button = form.querySelector("button[data-label]");
    if (button && button.dataset.label) {
      button.textContent = button.dataset.label;
      button.removeAttribute("aria-disabled");
    }
  };
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.hasAttribute("data-busy") || event.defaultPrevented) return;
    if (form.dataset.sent) {
      event.preventDefault();
      return;
    }
    form.dataset.sent = "1";
    form.setAttribute("aria-busy", "true");
    const button = event.submitter instanceof HTMLButtonElement ? event.submitter : form.querySelector('button[type="submit"]');
    if (button) {
      button.dataset.label = button.textContent;
      button.textContent = form.getAttribute("data-busy");
      button.setAttribute("aria-disabled", "true");
    }
  });

  // A menu in the header closes when one clicks elsewhere.
  document.addEventListener("click", (event) => {
    for (const menu of document.querySelectorAll("details[data-menu][open]")) {
      if (event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
    }
  });

  // Update, under the (i) next to the name: reloads when another version
  // is deployed than the one this page came from; says so otherwise.
  document.addEventListener("click", async (event) => {
    const link = event.target instanceof Element ? event.target.closest("[data-update]") : null;
    if (!link) return;
    event.preventDefault();
    try {
      const response = await fetch("/api/version", { cache: "no-store", headers: { accept: "application/json" } });
      const latest = await response.json();
      if (latest.commit && latest.commit !== link.getAttribute("data-commit")) {
        location.reload();
        return;
      }
      link.textContent = `Up to date (${latest.numero ?? "?"})`;
    } catch {
      location.reload();
    }
  });

  // The sprint follows Claude's runs: GitHub tells La Fabrique when one
  // starts or ends, and La Fabrique tells the open page, which reloads.
  let sprintLive = null;
  function setUpSprintLive() {
    if (sprintLive) sprintLive.stop();
    sprintLive = null;
    const line = document.querySelector("[data-sprint-live]");
    if (!line || !("WebSocket" in window)) return;
    let socket = null;
    let stopped = false;
    let tries = 0;
    const connect = () => {
      if (stopped) return;
      const url = new URL(line.getAttribute("data-sprint-live"), location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url);
      socket.addEventListener("open", () => {
        tries = 0;
      });
      socket.addEventListener("message", (message) => {
        let event = null;
        try {
          event = JSON.parse(message.data);
        } catch {
          return;
        }
        // What happened before the page was shown is already on it.
        if (!event || (event.kind !== "claude_run" && event.kind !== "pull_request") || event.replay) return;
        stop();
        location.reload();
      });
      socket.addEventListener("close", () => {
        if (stopped || !line.isConnected) return;
        tries++;
        setTimeout(connect, Math.min(30000, 1000 * 2 ** tries));
      });
    };
    const stop = () => {
      stopped = true;
      if (socket) socket.close();
    };
    connect();
    sprintLive = { stop };
  }

  // What each page needs once it is shown.
  function setUp() {
    document.querySelector('.tabs [aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "center" });
    setUpFragments();
    setUpDiagnostic();
    setUpRefresh();
    setUpBranchMenu();
    setUpSprintLive();
    setUpAboutPicker();
    setUpLive();
  }

  // Claude's job on a card, live: the page listens to the card's
  // connection (/live), which pushes what the job does; nothing is asked
  // again and again. The time runs here. When the job ends, the page comes
  // back with the spec. Without this script, the page says where the job
  // was when it was read.
  let live = null;
  function setUpLive() {
    if (live) live.stop();
    live = null;
    const widget = document.querySelector("[data-live]");
    if (!widget || !("WebSocket" in window)) return;
    const job = Number(widget.getAttribute("data-job"));
    const since = Date.parse(widget.getAttribute("data-since") || "");
    const label = widget.querySelector("[data-job-label]");
    const elapsed = widget.querySelector("[data-job-elapsed]");
    const log = widget.querySelector("[data-job-log]");
    let socket = null;
    let stopped = false;
    let tries = 0;

    const tick = () => {
      if (!elapsed || Number.isNaN(since)) return;
      const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));
      elapsed.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    };
    tick();
    const timer = setInterval(tick, 1000);

    const connect = () => {
      if (stopped) return;
      const url = new URL(widget.getAttribute("data-live"), location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url);
      socket.addEventListener("open", () => {
        tries = 0;
      });
      socket.addEventListener("message", (message) => {
        let event = null;
        try {
          event = JSON.parse(message.data);
        } catch {
          return;
        }
        if (!event || event.job !== job) return;
        if (label && event.label) label.textContent = event.label;
        if (log && event.text && !log.lastElementChild?.textContent?.endsWith(event.text)) {
          const line = document.createElement("li");
          const time = document.createElement("span");
          time.className = "mono muted";
          time.textContent = (event.at || "").slice(11, 19);
          line.append(time, ` ${event.text}`);
          log.append(line);
        }
        if (event.status === "done" || event.status === "failed") {
          stop();
          // The spec (or what went wrong), as the server says it now.
          location.replace(`${location.pathname}${location.search}#${event.status === "done" ? "spec" : "claude-job"}`);
          location.reload();
        }
      });
      socket.addEventListener("close", () => {
        if (stopped || !widget.isConnected) return;
        tries++;
        setTimeout(connect, Math.min(30000, 1000 * 2 ** tries));
      });
    };
    const stop = () => {
      stopped = true;
      clearInterval(timer);
      try {
        socket?.close();
      } catch {}
    };
    live = { stop };
    connect();
  }

  // What a defect is about (triage): the same list as the report kit's form
  // (each version's changes and stories), with its search, and the older versions on demand. Without this script,
  // every version is shown.
  function setUpAboutPicker() {
    for (const picker of document.querySelectorAll("[data-about-picker]")) {
      const search = picker.querySelector("[data-about-search]");
      const more = picker.querySelector("[data-about-more]");
      const blocks = [...picker.querySelectorAll("[data-about-block]")];
      let showAll = false;
      const render = () => {
        const query = search.value.trim().toLowerCase();
        let hidden = 0;
        for (const block of blocks) {
          const matches = !query || (block.getAttribute("data-text") || "").includes(query);
          let items = 0;
          for (const item of block.querySelectorAll("[data-about-item]")) {
            const visible = !query || matches || (item.getAttribute("data-text") || "").includes(query);
            item.hidden = !visible;
            if (visible) items++;
          }
          const early = block.hasAttribute("data-early") || Boolean(block.querySelector("input:checked"));
          const visible = query ? matches || items > 0 : showAll || early;
          block.hidden = !visible;
          if (!visible && !query) hidden++;
        }
        more.hidden = Boolean(query) || hidden === 0;
      };
      search.hidden = false;
      search.addEventListener("input", render);
      // Enter in the search must not send the triage.
      search.addEventListener("keydown", (event) => {
        if (event.key === "Enter") event.preventDefault();
      });
      more.addEventListener("click", () => {
        showAll = true;
        render();
      });
      render();
      // The current choice in sight, the page itself not scrolled.
      const list = picker.querySelector(".about-choices");
      const current = picker.querySelector("input:checked")?.closest(".about-choice");
      if (list && current instanceof HTMLElement && current.offsetTop > list.clientHeight - 60) list.scrollTop = current.offsetTop - 40;
    }
  }

  // Parts of a page read once it is shown (slow GitHub reads): the loading
  // light runs meanwhile; on failure, the link to the whole page stays.
  let parts = 0;
  function setUpFragments() {
    for (const holder of document.querySelectorAll("[data-fragment]")) {
      parts++;
      start();
      fetch(holder.getAttribute("data-fragment"), { headers: { accept: "text/html" } })
        .then((response) => (response.ok ? response.text() : Promise.reject(new Error(String(response.status)))))
        .then((text) => {
          if (!holder.isConnected) return;
          const part = new DOMParser().parseFromString(text, "text/html").body;
          holder.replaceWith(...[...part.childNodes].map((node) => document.adoptNode(node)));
        })
        .catch(() => {
          if (!holder.isConnected) return;
          holder.removeAttribute("aria-busy");
          holder.querySelector(".skeleton")?.remove();
          const fallback = holder.querySelector("[data-fragment-fallback]");
          if (fallback) fallback.textContent = "Could not read it here: open the whole page";
        })
        .finally(() => {
          parts--;
          if (!parts && !pending) stop();
        });
    }
  }

  // Settings: what this device runs, against what the page expects.
  function setUpDiagnostic() {
    const diagnostic = document.querySelector("[data-diagnostic]");
    if (!diagnostic) return;
    const scriptOk = scriptSrc === diagnostic.getAttribute("data-expected-script");
    const loading = document.querySelector(".loading");
    const stylesOk = Boolean(loading && getComputedStyle(loading).getPropertyValue("--scanner").trim());
    const others = [...document.querySelectorAll("script[src]")]
      .map((script) => script.getAttribute("src") || "")
      .filter((src) => src !== scriptSrc);
    diagnostic.textContent = `Script ${scriptOk ? "up to date" : `old copy (${scriptSrc ?? "unknown"})`}; stylesheet ${
      stylesOk ? "up to date" : "old copy"
    }; pages ${onlyThisScript(document) ? "follow in place" : "load normally"}${
      others.length ? ` (other scripts: ${others.join(", ")})` : ""
    }; ${navigator.userAgent}.`;
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
