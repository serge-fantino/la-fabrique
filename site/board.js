// The board of cards (la-fabrique#78): move a card by its handle, with the
// pointer or the keyboard; it takes the values of the place it is dropped
// in. Remembers the arrangement on this device. Without it, a card's tags
// change from its own page.
(() => {
  const board = document.querySelector("[data-board]");
  const arrange = document.querySelector("form[data-board-arrange]");
  const status = document.querySelector("[data-board-status]");

  // The arrangement and filters in use, kept on this device; the board's
  // tab, opened bare, comes back to them.
  if (arrange) {
    const key = `lf-board:${location.pathname}`;
    const params = new URLSearchParams(location.search);
    params.delete("notice");
    try {
      if (params.has("by")) localStorage.setItem(key, params.toString());
      else if (!location.search) {
        const saved = localStorage.getItem(key);
        if (saved) {
          location.replace(`${location.pathname}?${saved}${location.hash}`);
          return;
        }
      }
    } catch {}
    arrange.addEventListener("change", (event) => {
      const field = event.target;
      if (field instanceof HTMLInputElement && field.type === "checkbox" && field.hasAttribute("data-autosubmit")) arrange.requestSubmit();
    });
  }
  if (!board) return;

  const say = (text) => {
    if (status) status.textContent = text;
  };
  const cardsIn = (cell) => [...cell.children].filter((child) => child.matches(".fiche"));
  const cells = () => [...board.querySelectorAll("[data-cell]")];
  const by = board.getAttribute("data-by") || "none";
  const then = board.getAttribute("data-then") || "none";

  // Counts in the heads follow the cards.
  const recount = () => {
    for (const counter of board.querySelectorAll("[data-count-column], [data-count-row]")) {
      const column = counter.hasAttribute("data-count-column");
      const axis = column ? by : then;
      const value = counter.getAttribute(column ? "data-count-column" : "data-count-row");
      const total = cells()
        .filter((cell) => cell.getAttribute(`data-set-${axis}`) === value)
        .reduce((sum, cell) => sum + cardsIn(cell).length, 0);
      counter.textContent = String(total);
    }
  };

  // Sends the card's new place; the server answers the card as it is now.
  const send = async (card, origin) => {
    const cell = card.parentElement;
    const siblings = cardsIn(cell);
    const index = siblings.indexOf(card);
    const data = new FormData();
    data.set("csrf", board.getAttribute("data-csrf") || "");
    data.set("action", "move");
    data.set("card", card.getAttribute("data-card") || "");
    data.set("before", siblings[index + 1]?.getAttribute("data-card") || "");
    data.set("after", siblings[index - 1]?.getAttribute("data-card") || "");
    for (const attribute of cell.attributes) {
      if (attribute.name.startsWith("data-set-")) data.set(`set_${attribute.name.slice("data-set-".length)}`, attribute.value);
    }
    card.setAttribute("aria-busy", "true");
    try {
      const response = await fetch(board.getAttribute("data-move"), {
        method: "POST",
        body: data,
        headers: { accept: "application/json" },
      });
      const answer = await response.json();
      if (!response.ok || !answer.html) throw new Error(answer.error || "The move was not saved.");
      const next = new DOMParser().parseFromString(answer.html, "text/html").body.firstElementChild;
      const focused = card.contains(document.activeElement);
      if (next) {
        card.replaceWith(document.adoptNode(next));
        if (focused) next.querySelector("[data-grip]")?.focus();
      }
      recount();
      say(`${next?.querySelector(".fiche-id")?.textContent || "Card"} moved.`);
    } catch (error) {
      origin.parent.insertBefore(card, origin.next && origin.next.parentElement === origin.parent ? origin.next : null);
      card.removeAttribute("aria-busy");
      recount();
      say(error instanceof Error && error.message ? error.message : "The move was not saved: reload the board.");
    }
  };

  const unchanged = (card, origin) => card.parentElement === origin.parent && card.nextElementSibling === origin.next;

  // ---- With the pointer: drag the handle.
  let drag = null;

  const placeholderAt = (x, y) => {
    const hit = document.elementFromPoint(x, y);
    const cell = hit instanceof Element ? hit.closest("[data-cell]") : null;
    if (!cell || !board.contains(cell)) return;
    const free = cell.parentElement?.classList.contains("board-free");
    const before = cardsIn(cell).find((other) => {
      if (other === drag.card) return false;
      const box = other.getBoundingClientRect();
      return free ? y < box.top || (y < box.bottom && x < box.left + box.width / 2) : y < box.top + box.height / 2;
    });
    if (before) cell.insertBefore(drag.placeholder, before);
    else cell.append(drag.placeholder);
  };

  const autoScroll = (x, y) => {
    const edge = 56;
    if (y < edge) window.scrollBy(0, -14);
    else if (y > window.innerHeight - edge) window.scrollBy(0, 14);
    const scroller = board.closest(".board-scroll");
    if (!scroller) return;
    const box = scroller.getBoundingClientRect();
    if (x < box.left + edge) scroller.scrollLeft -= 14;
    else if (x > box.right - edge) scroller.scrollLeft += 14;
  };

  board.addEventListener("pointerdown", (event) => {
    const grip = event.target instanceof Element ? event.target.closest("[data-grip]") : null;
    if (!grip || event.button !== 0 || drag) return;
    const card = grip.closest(".fiche");
    if (!card || card.hasAttribute("aria-busy")) return;
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    drag = { card, grip, startX: event.clientX, startY: event.clientY, moving: false, origin: { parent: card.parentElement, next: card.nextElementSibling } };
  });

  document.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const { card } = drag;
    if (!drag.moving) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
      const box = card.getBoundingClientRect();
      drag.moving = true;
      drag.offsetX = drag.startX - box.left;
      drag.offsetY = drag.startY - box.top;
      drag.placeholder = document.createElement("div");
      drag.placeholder.className = "fiche-placeholder";
      drag.placeholder.style.height = `${box.height}px`;
      card.before(drag.placeholder);
      card.style.width = `${box.width}px`;
      // The card stays where it is in the page (moving it would end the
      // pointer capture) and floats above it.
      card.classList.add("dragging");
    }
    card.style.left = `${event.clientX - drag.offsetX}px`;
    card.style.top = `${event.clientY - drag.offsetY}px`;
    placeholderAt(event.clientX, event.clientY);
    autoScroll(event.clientX, event.clientY);
  });

  const endDrag = (cancelled) => {
    if (!drag) return;
    const { card, placeholder, origin, moving } = drag;
    drag = null;
    if (!moving) return;
    card.classList.remove("dragging");
    card.style.removeProperty("left");
    card.style.removeProperty("top");
    card.style.removeProperty("width");
    if (cancelled || !placeholder.parentElement) {
      placeholder.remove();
      return;
    }
    placeholder.replaceWith(card);
    if (!unchanged(card, origin)) send(card, origin);
  };

  document.addEventListener("pointerup", () => endDrag(false));
  document.addEventListener("pointercancel", () => endDrag(true));

  // ---- With the keyboard: Space on the handle picks the card up, the
  // arrows move it (up and down in its place, left and right from place to
  // place), Space drops it, Escape puts it back.
  let picked = null;

  const columnsPerRow = (cell) => {
    const row = cell.closest(".board-row");
    return row ? row.querySelectorAll("[data-cell]").length : Infinity;
  };

  const moveToCell = (card, cell, atStart) => {
    if (!cell) return;
    const first = cardsIn(cell)[0];
    if (atStart && first) cell.insertBefore(card, first);
    else cell.append(card);
  };

  const describePlace = (card) => {
    const cell = card.parentElement;
    const parts = [...cell.attributes]
      .filter((attribute) => attribute.name.startsWith("data-set-"))
      .map((attribute) => `${attribute.name.slice("data-set-".length)} ${attribute.value || "not set"}`);
    const index = cardsIn(cell).indexOf(card) + 1;
    return `${parts.join(", ") || "board"}, position ${index} of ${cardsIn(cell).length}`;
  };

  board.addEventListener("keydown", (event) => {
    const grip = event.target instanceof Element ? event.target.closest("[data-grip]") : null;
    if (!grip) return;
    const card = grip.closest(".fiche");
    if (!card) return;
    const key = event.key;
    if (!picked) {
      if (key !== " " && key !== "Enter") return;
      event.preventDefault();
      picked = { card, origin: { parent: card.parentElement, next: card.nextElementSibling } };
      card.classList.add("picked");
      say(`Picked up. Arrow keys to move, Space to drop, Escape to cancel. ${describePlace(card)}.`);
      return;
    }
    if (picked.card !== card) return;
    const all = cells();
    const cell = card.parentElement;
    const index = all.indexOf(cell);
    const siblings = cardsIn(cell);
    const at = siblings.indexOf(card);
    if (key === "ArrowUp" || key === "ArrowDown") {
      event.preventDefault();
      if (key === "ArrowUp" && at > 0) cell.insertBefore(card, siblings[at - 1]);
      else if (key === "ArrowDown" && at < siblings.length - 1) cell.insertBefore(card, siblings[at + 1].nextElementSibling);
      else {
        const step = columnsPerRow(cell);
        moveToCell(card, all[key === "ArrowUp" ? index - step : index + step], key === "ArrowDown");
      }
    } else if (key === "ArrowLeft" || key === "ArrowRight") {
      event.preventDefault();
      moveToCell(card, all[key === "ArrowLeft" ? index - 1 : index + 1], false);
    } else if (key === " " || key === "Enter") {
      event.preventDefault();
      const { origin } = picked;
      picked = null;
      card.classList.remove("picked");
      if (unchanged(card, origin)) say("Dropped where it was.");
      else send(card, origin);
      grip.focus();
      return;
    } else if (key === "Escape") {
      event.preventDefault();
      picked.origin.parent.insertBefore(card, picked.origin.next);
      picked = null;
      card.classList.remove("picked");
      grip.focus();
      say("Put back.");
      return;
    } else return;
    grip.focus();
    say(describePlace(card));
  });

  board.addEventListener("focusout", (event) => {
    if (!picked || !(event.relatedTarget instanceof Node) || picked.card.contains(event.relatedTarget)) return;
    picked.origin.parent.insertBefore(picked.card, picked.origin.next);
    picked.card.classList.remove("picked");
    picked = null;
    say("Put back.");
  });
})();
