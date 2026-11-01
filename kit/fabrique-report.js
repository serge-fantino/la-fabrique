/*! FabriqueReport 1.3.0 — report a defect from the page, to La Fabrique extraordinaire.
 * Copy this file (and fabrique-report.css) into your project and serve it yourself: it
 * talks only to your own server (the relay), never to La Fabrique, and holds no token.
 * Documentation: https://github.com/serge-fantino/la-fabrique/blob/main/docs/report-kit.md
 * License: Apache-2.0 (La Fabrique extraordinaire).
 */
(function () {
  "use strict";
  if (window.FabriqueReport && window.FabriqueReport.version) return;

  var VERSION = "1.3.0";
  var QUEUE_KEY = "fabrique-report-queue";
  var MAX_IMAGE_BYTES = 2 * 1024 * 1024;
  var PREFIX = "fab-rep";

  var WORDS = {
    en: {
      report: "Report a defect",
      test: "Test",
      toTest: "Stories to test",
      noStories: "Nothing to test on this environment.",
      testFailed: "The stories to test could not be read.",
      previous: "Previous",
      next: "Next",
      storyOf: "Story {n} of {total}",
      forCard: "Card",
      criteria: "Acceptance criteria",
      noCriteria: "This story lists no criteria.",
      notValidated: "Not validated yet",
      validatedBy: "Validated by",
      pick: "Touch or click the part of the page that is wrong.",
      chosen: "This part?",
      wider: "Wider",
      thisOne: "This one",
      cancel: "Cancel",
      whole: "The whole page",
      title: "In a few words",
      seen: "What I see",
      expected: "What I expected",
      screenshot: "Attach a screenshot of this part",
      capturing: "Taking the screenshot…",
      noCapture: "No screenshot could be taken.",
      attach: "Attach an image",
      context: "Sent with the report",
      page: "Page",
      screen: "Screen",
      component: "Part",
      errors: "Recent errors",
      none: "none",
      send: "Send",
      sending: "Sending…",
      sent: "Reported",
      story: "linked to story",
      triage: "Your account has no role in La Fabrique: the report will be triaged.",
      close: "Close",
      queued: "No network: the report is kept on this device and will be sent when the network is back.",
      expired: "The link with La Fabrique is no longer valid.",
      relink: "Link again",
      disabled: "Reporting is off on this environment.",
      noAccess: "Your account cannot report on this project.",
      cap: "Too many reports today: try again tomorrow.",
      invalid: "Something is missing: ",
      failed: "The report could not be sent.",
      required: "Required",
      about: "It is about",
      unknown: "I don't know",
      onInt: "on int",
      older: "Earlier versions",
      search: "Search a version, a change, a story…",
    },
    fr: {
      report: "Signaler un défaut",
      test: "Tester",
      toTest: "Stories à tester",
      noStories: "Rien à tester sur cet environnement.",
      testFailed: "Les stories à tester n'ont pas pu être lues.",
      previous: "Précédente",
      next: "Suivante",
      storyOf: "Story {n} sur {total}",
      forCard: "Fiche",
      criteria: "Critères d'acceptation",
      noCriteria: "Cette story n'a pas de critères.",
      notValidated: "Pas encore validée",
      validatedBy: "Validée par",
      pick: "Touchez ou cliquez la partie de la page qui ne va pas.",
      chosen: "Cette partie ?",
      wider: "Plus large",
      thisOne: "Celle-ci",
      cancel: "Annuler",
      whole: "Toute la page",
      title: "En quelques mots",
      seen: "Ce que je vois",
      expected: "Ce que j'attendais",
      screenshot: "Joindre une capture de cette partie",
      capturing: "Capture en cours…",
      noCapture: "La capture n'a pas pu être faite.",
      attach: "Joindre une image",
      context: "Envoyé avec le signalement",
      page: "Page",
      screen: "Écran",
      component: "Partie",
      errors: "Erreurs récentes",
      none: "aucune",
      send: "Envoyer",
      sending: "Envoi…",
      sent: "Signalé",
      story: "relié à la story",
      triage: "Votre compte n'a pas de rôle dans La Fabrique : le signalement sera trié.",
      close: "Fermer",
      queued: "Pas de réseau : le signalement est gardé sur l'appareil et partira au retour du réseau.",
      expired: "La liaison avec La Fabrique n'est plus valable.",
      relink: "Relier à nouveau",
      disabled: "Le signalement est fermé sur cet environnement.",
      noAccess: "Votre compte ne peut pas signaler sur ce projet.",
      cap: "Trop de signalements aujourd'hui : réessayez demain.",
      invalid: "Il manque quelque chose : ",
      failed: "Le signalement n'a pas pu partir.",
      required: "Obligatoire",
      about: "Ça concerne",
      unknown: "Je ne sais pas",
      onInt: "sur int",
      older: "Versions précédentes",
      search: "Chercher une version, un changement, une story…",
    },
  };

  var options = {
    endpoint: null,
    lang: null,
    headers: null,
    captureScript: null,
    capture: null,
    environment: null,
    version: null,
    deployment: null,
    button: false,
  };
  var linkUrl = null;

  // --- Errors of the page -------------------------------------------------
  // fabrique-report-early.js fills this list before the kit loads.
  var errors = (window.FabriqueReportErrors = window.FabriqueReportErrors || []);
  function keepError(message) {
    errors.push(String(message).slice(0, 500));
    if (errors.length > 20) errors.shift();
  }
  if (!errors.__listening) {
    errors.__listening = true;
    window.addEventListener("error", function (event) {
      keepError((event.message || "Error") + (event.filename ? " (" + event.filename + ":" + event.lineno + ")" : ""));
    });
    window.addEventListener("unhandledrejection", function (event) {
      var reason = event.reason;
      keepError("Unhandled rejection: " + ((reason && reason.message) || reason));
    });
  }

  // --- Helpers ------------------------------------------------------------
  function words() {
    var lang = options.lang || (document.documentElement.lang || "en").slice(0, 2).toLowerCase();
    return WORDS[lang] || WORDS.en;
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === "text") node.textContent = attrs[key];
      else if (key === "className") node.className = attrs[key];
      else if (key.slice(0, 2) === "on") node.addEventListener(key.slice(2), attrs[key]);
      else if (attrs[key] !== null && attrs[key] !== undefined && attrs[key] !== false) node.setAttribute(key, attrs[key] === true ? "" : attrs[key]);
    });
    (children || []).forEach(function (child) {
      if (child) node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return node;
  }

  function cls(name) {
    return PREFIX + "-" + name;
  }

  function isOurs(node) {
    return Boolean(node && node.closest && node.closest("." + PREFIX));
  }

  function headers(extra) {
    var base = typeof options.headers === "function" ? options.headers() : options.headers || {};
    var all = {};
    Object.keys(base || {}).forEach(function (key) {
      all[key] = base[key];
    });
    Object.keys(extra || {}).forEach(function (key) {
      all[key] = extra[key];
    });
    return all;
  }

  function escapeIdent(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  // A selector a developer can find the part with: an id, a data attribute,
  // classes, and the position among its siblings, up to five levels.
  function selectorOf(node) {
    var parts = [];
    var current = node;
    for (var depth = 0; current && current.nodeType === 1 && current !== document.body && current !== document.documentElement && depth < 5; depth++) {
      if (current.id) {
        parts.unshift("#" + escapeIdent(current.id));
        break;
      }
      var part = current.tagName.toLowerCase();
      for (var i = 0; i < current.attributes.length; i++) {
        var attr = current.attributes[i];
        if (/^data-[a-z-]+$/.test(attr.name) && attr.value && attr.value.length <= 40) {
          part += "[" + attr.name + '="' + attr.value.replace(/"/g, '\\"') + '"]';
          break;
        }
      }
      var classes = Array.prototype.filter
        .call(current.classList, function (name) {
          return name.indexOf(PREFIX) !== 0;
        })
        .slice(0, 2);
      if (classes.length) part += "." + classes.map(escapeIdent).join(".");
      var parent = current.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (child) {
          return child.tagName === current.tagName;
        });
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(current) + 1) + ")";
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ") || "body";
  }

  function describe(node) {
    var box = node.getBoundingClientRect();
    return {
      selector: selectorOf(node),
      text: (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200),
      box: {
        x: Math.round(box.left + window.scrollX),
        y: Math.round(box.top + window.scrollY),
        w: Math.round(box.width),
        h: Math.round(box.height),
      },
    };
  }

  // --- Picking a part of the page -------------------------------------------
  function pick() {
    return new Promise(function (resolve) {
      var t = words();
      var chosen = null;
      var frame = el("div", { className: PREFIX + " " + cls("frame"), "aria-hidden": "true" });
      var label = el("p", { className: cls("bar-text"), "aria-live": "polite", text: t.pick });
      var wider = el("button", { type: "button", className: cls("button") + " " + cls("quiet"), text: t.wider, disabled: true });
      var confirm = el("button", { type: "button", className: cls("button"), text: t.thisOne, disabled: true });
      var whole = el("button", { type: "button", className: cls("button") + " " + cls("quiet"), text: t.whole });
      var cancel = el("button", { type: "button", className: cls("button") + " " + cls("quiet"), text: t.cancel });
      var bar = el("div", { className: PREFIX + " " + cls("bar"), role: "toolbar", "aria-label": t.report }, [
        label,
        el("div", { className: cls("bar-buttons") }, [wider, confirm, whole, cancel]),
      ]);
      document.body.appendChild(frame);
      document.body.appendChild(bar);
      document.documentElement.classList.add(cls("picking"));

      function show(node) {
        if (!node) {
          frame.style.display = "none";
          return;
        }
        var box = node.getBoundingClientRect();
        frame.style.display = "block";
        frame.style.top = box.top - 3 + "px";
        frame.style.left = box.left - 3 + "px";
        frame.style.width = box.width + 6 + "px";
        frame.style.height = box.height + 6 + "px";
      }

      function choose(node) {
        chosen = node;
        show(node);
        var text = (node.innerText || "").replace(/\s+/g, " ").trim().slice(0, 60);
        label.textContent = t.chosen + " " + node.tagName.toLowerCase() + (text ? " « " + text + " »" : "");
        wider.disabled = !node.parentElement || node.parentElement === document.documentElement;
        confirm.disabled = false;
        confirm.focus();
      }

      function target(event) {
        var point = event.touches && event.touches[0] ? event.touches[0] : event;
        var node = document.elementFromPoint(point.clientX, point.clientY);
        return node && !isOurs(node) ? node : null;
      }

      function onMove(event) {
        if (chosen || event.pointerType === "touch") return;
        show(target(event));
      }

      // The page does not see presses while picking (no button fires, no
      // gesture starts); scrolling still works, and the click that follows
      // chooses the part.
      function swallow(event) {
        if (isOurs(event.target)) return;
        event.stopPropagation();
      }

      function onClick(event) {
        if (isOurs(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        var node = target(event);
        if (node) choose(node);
      }

      function onKey(event) {
        if (event.key === "Escape") finish(null);
      }

      function onScroll() {
        show(chosen);
      }

      function finish(node) {
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("click", onClick, true);
        ["pointerdown", "mousedown", "touchstart", "pointerup", "mouseup", "touchend"].forEach(function (name) {
          window.removeEventListener(name, swallow, true);
        });
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("scroll", onScroll, true);
        document.documentElement.classList.remove(cls("picking"));
        frame.remove();
        bar.remove();
        resolve(node);
      }

      wider.addEventListener("click", function () {
        if (chosen && chosen.parentElement && chosen.parentElement !== document.documentElement) choose(chosen.parentElement);
      });
      confirm.addEventListener("click", function () {
        finish(chosen);
      });
      whole.addEventListener("click", function () {
        finish(document.body);
      });
      cancel.addEventListener("click", function () {
        finish(null);
      });
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("click", onClick, true);
      ["pointerdown", "mousedown", "touchstart", "pointerup", "mouseup", "touchend"].forEach(function (name) {
        window.addEventListener(name, swallow, true);
      });
      window.addEventListener("keydown", onKey, true);
      window.addEventListener("scroll", onScroll, true);
      cancel.focus();
    });
  }

  // --- Screenshot -----------------------------------------------------------
  var captureLoading = null;
  function loadCapture() {
    if (options.capture) return Promise.resolve(options.capture);
    if (window.html2canvas) return Promise.resolve(html2canvasCapture);
    if (!options.captureScript) return Promise.resolve(null);
    if (!captureLoading) {
      captureLoading = new Promise(function (resolve) {
        var script = el("script", { src: options.captureScript, async: true });
        script.addEventListener("load", function () {
          resolve(window.html2canvas ? html2canvasCapture : null);
        });
        script.addEventListener("error", function () {
          resolve(null);
        });
        document.head.appendChild(script);
      });
    }
    return captureLoading;
  }

  // What the screen shows, cropped to the chosen part with a margin around
  // it, the part outlined.
  function html2canvasCapture(node) {
    var box = node.getBoundingClientRect();
    return window
      .html2canvas(document.documentElement, {
        x: window.scrollX,
        y: window.scrollY,
        width: window.innerWidth,
        height: window.innerHeight,
        windowWidth: document.documentElement.clientWidth,
        windowHeight: window.innerHeight,
        scale: Math.min(window.devicePixelRatio || 1, 2),
        logging: false,
        useCORS: true,
        ignoreElements: isOurs,
      })
      .then(function (screen) {
        if (node === document.body) return fitImage(screen);
        var scale = screen.width / window.innerWidth;
        var margin = 24;
        var left = Math.max(0, box.left - margin);
        var top = Math.max(0, box.top - margin);
        var right = Math.min(window.innerWidth, box.right + margin);
        var bottom = Math.min(window.innerHeight, box.bottom + margin);
        if (right - left < 8 || bottom - top < 8) return fitImage(screen);
        var crop = document.createElement("canvas");
        crop.width = Math.round((right - left) * scale);
        crop.height = Math.round((bottom - top) * scale);
        var context = crop.getContext("2d");
        context.drawImage(screen, left * scale, top * scale, crop.width, crop.height, 0, 0, crop.width, crop.height);
        context.strokeStyle = "#C23D17";
        context.lineWidth = 3 * scale;
        context.strokeRect((box.left - left) * scale, (box.top - top) * scale, box.width * scale, box.height * scale);
        return fitImage(crop);
      });
  }

  function dataUrlBytes(dataUrl) {
    var base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    return Math.floor((base64.length * 3) / 4);
  }

  // PNG when small enough, else JPEG, smaller and smaller, under 2 MB.
  function fitImage(canvas) {
    var png = canvas.toDataURL("image/png");
    if (dataUrlBytes(png) <= MAX_IMAGE_BYTES) return png;
    var current = canvas;
    for (var attempt = 0; attempt < 6; attempt++) {
      var jpeg = current.toDataURL("image/jpeg", 0.82);
      if (dataUrlBytes(jpeg) <= MAX_IMAGE_BYTES) return jpeg;
      var smaller = document.createElement("canvas");
      smaller.width = Math.round(current.width * 0.75);
      smaller.height = Math.round(current.height * 0.75);
      smaller.getContext("2d").drawImage(current, 0, 0, smaller.width, smaller.height);
      current = smaller;
    }
    return null;
  }

  function readImage(file) {
    return new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onload = function () {
        var image = new Image();
        image.onload = function () {
          var canvas = document.createElement("canvas");
          var scale = Math.min(1, 2400 / Math.max(image.width, image.height));
          canvas.width = Math.round(image.width * scale);
          canvas.height = Math.round(image.height * scale);
          canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve(fitImage(canvas));
        };
        image.onerror = function () {
          resolve(null);
        };
        image.src = String(reader.result);
      };
      reader.onerror = function () {
        resolve(null);
      };
      reader.readAsDataURL(file);
    });
  }

  // --- The stories to test ----------------------------------------------------
  // The relay answers GET {endpoint}?to-test=1 with La Fabrique's
  // GET /api/projects/{project}/to-test; read only.
  function loadStoriesToTest() {
    var address = options.endpoint + (options.endpoint.indexOf("?") >= 0 ? "&" : "?") + "to-test=1";
    return fetch(address, { credentials: "same-origin", headers: headers({ accept: "application/json" }) })
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .then(function (data) {
        return data && Array.isArray(data.stories) ? data.stories : null;
      })
      .catch(function () {
        return null;
      });
  }

  var testing = false;
  // A panel with the stories one at a time, each with its criteria.
  function testPanel() {
    if (testing || !options.endpoint) return Promise.resolve(null);
    testing = true;
    var t = words();
    return new Promise(function (resolve) {
      var index = 0;
      var stories = [];
      var body = el("div", { className: cls("test-body"), "aria-live": "polite", text: "…" });
      var previous = el("button", { type: "button", className: cls("button") + " " + cls("quiet"), text: t.previous });
      var next = el("button", { type: "button", className: cls("button") + " " + cls("quiet"), text: t.next });
      var close = el("button", { type: "button", className: cls("button"), text: t.close });
      var sheet = el("div", { className: cls("sheet") + " " + cls("test") }, [
        el("h2", { className: cls("heading"), text: t.toTest }),
        body,
        el("div", { className: cls("actions") }, [previous, next, close]),
      ]);
      var dialog = el("div", { className: PREFIX + " " + cls("dialog"), role: "dialog", "aria-modal": "true", "aria-label": t.toTest }, [sheet]);
      document.body.appendChild(dialog);
      close.focus();

      function show() {
        body.textContent = "";
        previous.disabled = index === 0;
        next.disabled = index >= stories.length - 1;
        previous.hidden = next.hidden = stories.length < 2;
        var story = stories[index];
        if (!story) return;
        var criteria = story.criteria || [];
        body.appendChild(el("p", { className: cls("note"), text: t.storyOf.replace("{n}", index + 1).replace("{total}", stories.length) }));
        body.appendChild(el("h3", { className: cls("story-title") }, [el("span", { className: cls("tag"), text: "#" + story.number }), " " + story.title]));
        if (story.card) body.appendChild(el("p", { className: cls("note"), text: t.forCard + " C" + story.card.id + " · " + story.card.title }));
        body.appendChild(
          el("p", { className: cls("note") }, [
            story.validated ? t.validatedBy + " @" + story.validated.by + (story.validated.version ? " · " + story.validated.version : "") : t.notValidated,
          ]),
        );
        body.appendChild(el("h4", { className: cls("criteria-title"), text: t.criteria }));
        body.appendChild(
          criteria.length
            ? el(
                "ul",
                { className: cls("criteria") },
                criteria.map(function (criterion) {
                  return el("li", { className: criterion.done ? cls("done-criterion") : "" }, [(criterion.done ? "☑ " : "☐ ") + criterion.text]);
                }),
              )
            : el("p", { className: cls("note"), text: t.noCriteria }),
        );
      }
      previous.addEventListener("click", function () {
        index = Math.max(0, index - 1);
        show();
      });
      next.addEventListener("click", function () {
        index = Math.min(stories.length - 1, index + 1);
        show();
      });
      function finish() {
        document.removeEventListener("keydown", onKey, true);
        dialog.remove();
        testing = false;
        resolve(stories);
      }
      function onKey(event) {
        if (event.key === "Escape") finish();
      }
      document.addEventListener("keydown", onKey, true);
      close.addEventListener("click", finish);
      loadStoriesToTest().then(function (found) {
        if (!dialog.isConnected) return;
        if (!found) {
          body.textContent = t.testFailed;
          previous.hidden = next.hidden = true;
          return;
        }
        stories = found;
        if (!stories.length) {
          body.textContent = t.noStories;
          previous.hidden = next.hidden = true;
          return;
        }
        show();
      });
    });
  }

  // --- What the report is about ---------------------------------------------------
  // The relay answers GET {endpoint}?targets=1 with La Fabrique's targets: the
  // versions on int, then those released, each with its stories.
  function loadTargets() {
    if (!options.endpoint) return Promise.resolve(null);
    var address = options.endpoint + (options.endpoint.indexOf("?") >= 0 ? "&" : "?") + "targets=1";
    return fetch(address, { credentials: "same-origin", headers: headers({ accept: "application/json" }) })
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .then(function (data) {
        return data && Array.isArray(data.versions) ? data.versions : null;
      })
      .catch(function () {
        return null;
      });
  }

  var choiceCount = 0;
  function choice(value, labelChildren, checked, className) {
    var id = cls("about-" + ++choiceCount);
    var input = el("input", { type: "radio", name: cls("about"), id: id, value: value, checked: checked });
    return el("div", { className: cls("choice") + (className ? " " + className : "") }, [input, el("label", { for: id }, labelChildren)]);
  }

  // The list of versions and stories, with a search; the versions on int and
  // the two latest released first, the others on demand or when searched.
  function aboutPicker(versions) {
    var t = words();
    var shown = 2;
    var first = versions.filter(function (version) {
      return version.on_int;
    })[0];
    var preset = first && first.stories && first.stories.length === 1 ? "s:" + first.stories[0].number + ":" + first.version : "";
    var search = el("input", { type: "search", className: cls("search"), placeholder: t.search, "aria-label": t.search });
    var list = el("div", { className: cls("choices") });
    var more = el("button", { type: "button", className: cls("link"), text: t.older });
    var showAll = false;
    var unknown = choice("", [t.unknown], preset === "");

    var blocks = versions.map(function (version, index) {
      var released = versions.filter(function (other, at) {
        return !other.on_int && at <= index;
      }).length;
      var text = [version.version, version.title || ""].join(" ").toLowerCase();
      // The release note in detail: each change can be chosen, then the
      // stories the version declares.
      var changes = (version.changes || []).map(function (change, at) {
        var value = "c:" + at + ":" + version.version;
        return { node: choice(value, [change], false, cls("change")), text: change.toLowerCase() };
      });
      var stories = (version.stories || []).map(function (story) {
        var value = "s:" + story.number + ":" + version.version;
        return {
          node: choice(value, ["#" + story.number + (story.title ? " " + story.title : "")], preset === value, cls("story")),
          text: ("#" + story.number + " " + story.title).toLowerCase(),
        };
      });
      var head = choice(
        "v:" + version.version,
        [
          el("strong", { text: version.version }),
          version.title ? " " + version.title : "",
          version.on_int ? el("span", { className: cls("tag"), text: t.onInt }) : version.date ? el("span", { className: cls("date"), text: version.date }) : "",
        ],
        false,
        cls("version-choice"),
      );
      var items = changes.concat(stories);
      var node = el("div", { className: cls("version") }, [head].concat(
        items.map(function (item) {
          return item.node;
        }),
      ));
      return { node: node, text: text, items: items, early: version.on_int || released <= shown };
    });

    function render() {
      var query = search.value.trim().toLowerCase();
      var hidden = 0;
      blocks.forEach(function (block) {
        var matches = !query || block.text.indexOf(query) >= 0;
        var itemMatches = 0;
        block.items.forEach(function (item) {
          var visible = !query || matches || item.text.indexOf(query) >= 0;
          item.node.hidden = !visible;
          if (visible) itemMatches++;
        });
        var visible = query ? matches || itemMatches > 0 : showAll || block.early;
        block.node.hidden = !visible;
        if (!visible && !query) hidden++;
      });
      more.hidden = Boolean(query) || hidden === 0;
    }

    list.appendChild(unknown);
    blocks.forEach(function (block) {
      list.appendChild(block.node);
    });
    search.addEventListener("input", render);
    more.addEventListener("click", function () {
      showAll = true;
      render();
    });
    render();

    var fieldset = el("fieldset", { className: cls("about") }, [el("legend", { text: t.about }), search, list, more]);
    return {
      node: fieldset,
      // The story and the version chosen.
      value: function () {
        var checked = fieldset.querySelector("input[type=radio]:checked");
        var value = checked ? checked.value : "";
        if (value.indexOf("s:") === 0) {
          var parts = value.split(":");
          return { story: Number(parts[1]), release: parts.slice(2).join(":") === "int" ? null : parts.slice(2).join(":") };
        }
        if (value.indexOf("c:") === 0) {
          var change = value.split(":");
          var of = change.slice(2).join(":");
          return { story: null, release: of === "int" ? null : of, change: Number(change[1]) };
        }
        if (value.indexOf("v:") === 0) return { story: null, release: value.slice(2) === "int" ? null : value.slice(2) };
        return { story: null, release: null };
      },
    };
  }

  // --- The form ---------------------------------------------------------------
  function context(node) {
    return {
      page: location.pathname + location.search + location.hash,
      component: node === document.body ? null : describe(node),
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
      user_agent: navigator.userAgent,
      errors: errors.slice(-20),
    };
  }

  function field(id, labelText, input, required) {
    return el("div", { className: cls("field") }, [
      el("label", { for: id }, [labelText, required ? el("span", { className: cls("required"), text: " *", title: words().required }) : null]),
      input,
    ]);
  }

  function form(node) {
    return new Promise(function (resolve) {
      var t = words();
      var facts = context(node);
      var image = null;
      var titleInput = el("input", { id: cls("title"), type: "text", maxlength: "200", required: true, autocomplete: "off" });
      var seenInput = el("textarea", { id: cls("seen"), rows: "3", maxlength: "4000", required: true });
      var expectedInput = el("textarea", { id: cls("expected"), rows: "2", maxlength: "4000" });
      var preview = el("img", { className: cls("preview"), alt: "", hidden: true });
      var captureNote = el("p", { className: cls("note"), "aria-live": "polite" });
      var captureBox = el("input", { type: "checkbox", id: cls("capture") });
      var captureLine = el("div", { className: cls("check"), hidden: true }, [captureBox, el("label", { for: cls("capture"), text: t.screenshot })]);
      var fileInput = el("input", { type: "file", id: cls("file"), accept: "image/png,image/jpeg,image/*" });
      var fileLine = el("div", { className: cls("field") }, [el("label", { for: cls("file"), text: t.attach }), fileInput]);
      var status = el("p", { className: cls("status"), role: "status", "aria-live": "polite" });
      var aboutHolder = el("div", { className: cls("about-holder") });
      var picker = null;
      var send = el("button", { type: "submit", className: cls("button"), text: t.send });
      var cancel = el("button", { type: "button", className: cls("button") + " " + cls("quiet"), text: t.cancel });

      var details = el("details", { className: cls("context") }, [
        el("summary", { text: t.context }),
        el("dl", {}, [
          el("dt", { text: t.page }),
          el("dd", { text: facts.page }),
          el("dt", { text: t.component }),
          el("dd", { text: facts.component ? facts.component.selector : t.whole }),
          el("dt", { text: t.screen }),
          el("dd", { text: facts.viewport.w + " × " + facts.viewport.h + " @" + facts.viewport.dpr + "x" }),
          el("dt", { text: t.errors }),
          el("dd", { text: facts.errors.length ? String(facts.errors.length) : t.none }),
        ]),
      ]);

      var sheet = el("form", { className: cls("sheet"), novalidate: true }, [
        el("h2", { className: cls("heading"), text: t.report }),
        field(cls("title"), t.title, titleInput, true),
        field(cls("seen"), t.seen, seenInput, true),
        field(cls("expected"), t.expected, expectedInput, false),
        aboutHolder,
        captureLine,
        fileLine,
        captureNote,
        preview,
        details,
        status,
        el("div", { className: cls("actions") }, [send, cancel]),
      ]);
      var dialog = el("div", { className: PREFIX + " " + cls("dialog"), role: "dialog", "aria-modal": "true", "aria-label": t.report }, [sheet]);
      document.body.appendChild(dialog);
      titleInput.focus();

      function showImage(dataUrl) {
        image = dataUrl;
        preview.hidden = !dataUrl;
        if (dataUrl) preview.src = dataUrl;
        else preview.removeAttribute("src");
      }

      loadTargets().then(function (versions) {
        if (!versions || !versions.length || !dialog.isConnected) return;
        picker = aboutPicker(versions);
        aboutHolder.appendChild(picker.node);
      });

      loadCapture().then(function (capture) {
        if (!capture) return;
        captureLine.hidden = false;
        captureBox.checked = true;
        takeCapture(capture);
        captureBox.addEventListener("change", function () {
          if (captureBox.checked) takeCapture(capture);
          else showImage(null);
        });
      });

      function takeCapture(capture) {
        captureNote.textContent = t.capturing;
        dialog.classList.add(cls("hidden"));
        Promise.resolve()
          .then(function () {
            return capture(node);
          })
          .then(function (dataUrl) {
            captureNote.textContent = dataUrl ? "" : t.noCapture;
            if (captureBox.checked) showImage(dataUrl || null);
          })
          .catch(function () {
            captureNote.textContent = t.noCapture;
          })
          .then(function () {
            dialog.classList.remove(cls("hidden"));
          });
      }

      fileInput.addEventListener("change", function () {
        var file = fileInput.files && fileInput.files[0];
        if (!file) return;
        captureBox.checked = false;
        readImage(file).then(showImage);
      });

      function close(result) {
        dialog.remove();
        document.removeEventListener("keydown", onKey, true);
        resolve(result);
      }

      function onKey(event) {
        if (event.key === "Escape" && !send.disabled) close(null);
      }
      document.addEventListener("keydown", onKey, true);
      cancel.addEventListener("click", function () {
        close(null);
      });

      sheet.addEventListener("submit", function (event) {
        event.preventDefault();
        var missing = [titleInput, seenInput].filter(function (input) {
          return !input.value.trim();
        });
        [titleInput, seenInput].forEach(function (input) {
          input.setAttribute("aria-invalid", missing.indexOf(input) >= 0 ? "true" : "false");
        });
        if (missing.length) {
          missing[0].focus();
          return;
        }
        var body = {
          title: titleInput.value.trim(),
          seen: seenInput.value.trim(),
          expected: expectedInput.value.trim(),
          page: facts.page,
          component: facts.component,
          viewport: facts.viewport,
          user_agent: facts.user_agent,
          errors: facts.errors,
        };
        if (options.environment) body.environment = options.environment;
        if (options.version) body.version = options.version;
        if (options.deployment) body.deployment = options.deployment;
        if (image) body.screenshot = image;
        if (picker) {
          var about = picker.value();
          if (about.story) body.story = about.story;
          if (about.release) body.release = about.release;
          if (typeof about.change === "number") body.change = about.change;
        }
        send.disabled = true;
        cancel.disabled = true;
        status.textContent = t.sending;
        submit(body).then(function (outcome) {
          send.disabled = false;
          cancel.disabled = false;
          if (outcome.done) {
            showResult(sheet, outcome);
            sheet.querySelector("button").addEventListener("click", function () {
              close(outcome);
            });
            return;
          }
          status.textContent = outcome.message;
          if (outcome.link) {
            status.appendChild(document.createTextNode(" "));
            status.appendChild(el("a", { href: outcome.link, text: t.relink }));
          }
        });
      });
    });
  }

  function showResult(sheet, outcome) {
    var t = words();
    var lines = [el("h2", { className: cls("heading"), text: outcome.queued ? t.report : t.sent })];
    if (outcome.queued) lines.push(el("p", { text: t.queued }));
    else {
      var result = outcome.result || {};
      var issue = result.issue || {};
      lines.push(
        el("p", { className: cls("done") }, [
          issue.url ? el("a", { href: issue.url, target: "_blank", rel: "noopener noreferrer", text: "#" + issue.number }) : "#" + issue.number,
          result.story ? " · " + t.story + " #" + result.story.number : "",
        ]),
      );
      if (result.triage) lines.push(el("p", { className: cls("note"), text: t.triage }));
    }
    lines.push(el("div", { className: cls("actions") }, [el("button", { type: "button", className: cls("button"), text: t.close })]));
    sheet.replaceChildren.apply(sheet, lines);
    sheet.querySelector("button").focus();
  }

  // --- Sending ------------------------------------------------------------------
  function post(body) {
    return fetch(options.endpoint, {
      method: "POST",
      credentials: "same-origin",
      headers: headers({ "content-type": "application/json", accept: "application/json" }),
      body: JSON.stringify(body),
    });
  }

  function readQueue() {
    try {
      return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
    } catch (error) {
      return [];
    }
  }

  function writeQueue(queue) {
    try {
      if (queue.length) localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
      else localStorage.removeItem(QUEUE_KEY);
      return true;
    } catch (error) {
      return false;
    }
  }

  // Kept on the device when the network is down; the screenshot is dropped
  // if the device has no room for it.
  function keep(body) {
    var queue = readQueue();
    queue.push({ body: body, at: new Date().toISOString() });
    if (writeQueue(queue)) return;
    var light = {};
    Object.keys(body).forEach(function (key) {
      if (key !== "screenshot") light[key] = body[key];
    });
    queue[queue.length - 1] = { body: light, at: new Date().toISOString() };
    writeQueue(queue);
  }

  function submit(body) {
    var t = words();
    return post(body)
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            return {};
          })
          .then(function (data) {
            if (response.status === 201 || response.ok) return { done: true, result: data };
            if (response.status === 401) return { done: false, message: t.expired, link: data.link_url || linkUrl };
            if (response.status === 403) return { done: false, message: data.error === "reporting_disabled" ? t.disabled : t.noAccess };
            if (response.status === 429) return { done: false, message: t.cap };
            if (response.status === 400) return { done: false, message: t.invalid + ((data.fields || []).join(", ") || data.message || "") };
            return { done: false, message: t.failed + (data.message ? " " + data.message : "") };
          });
      })
      .catch(function () {
        keep(body);
        return { done: true, queued: true };
      });
  }

  // Reports kept while offline go when the network is back.
  function flush() {
    if (!options.endpoint) return Promise.resolve(0);
    var queue = readQueue();
    if (!queue.length || !navigator.onLine) return Promise.resolve(0);
    var left = [];
    var sent = 0;
    return queue
      .reduce(function (chain, item) {
        return chain.then(function () {
          return post(item.body)
            .then(function (response) {
              if (response.ok) sent++;
              else if (response.status >= 500) left.push(item);
            })
            .catch(function () {
              left.push(item);
            });
        });
      }, Promise.resolve())
      .then(function () {
        writeQueue(left);
        return sent;
      });
  }

  // --- Public API ---------------------------------------------------------------
  function configure(next) {
    Object.keys(next || {}).forEach(function (key) {
      if (key in options) options[key] = next[key];
    });
    return api;
  }

  // What the relay says: linked or not, allowed to report or not.
  function status() {
    if (!options.endpoint) return Promise.resolve({ linked: false, can_report: false, can_test: false });
    return fetch(options.endpoint, { credentials: "same-origin", headers: headers({ accept: "application/json" }) })
      .then(function (response) {
        return response.ok ? response.json() : { linked: false, can_report: false };
      })
      .then(function (data) {
        linkUrl = data.link_url || null;
        return data;
      })
      .catch(function () {
        return { linked: false, can_report: false, offline: true };
      });
  }

  var running = false;
  function start(next) {
    configure(next);
    if (running || !options.endpoint) return Promise.resolve(null);
    running = true;
    return pick()
      .then(function (node) {
        return node ? form(node) : null;
      })
      .then(
        function (result) {
          running = false;
          return result;
        },
        function (error) {
          running = false;
          throw error;
        },
      );
  }

  function showButton() {
    if (document.querySelector("." + cls("launch"))) return;
    var button = el("button", { type: "button", className: PREFIX + " " + cls("launch"), text: words().report });
    button.addEventListener("click", function () {
      button.hidden = true;
      start().then(function () {
        button.hidden = false;
      });
    });
    document.body.appendChild(button);
  }

  function showTestButton() {
    if (document.querySelector("." + cls("test-launch"))) return;
    var button = el("button", { type: "button", className: PREFIX + " " + cls("launch") + " " + cls("test-launch"), text: words().test });
    button.addEventListener("click", function () {
      testPanel();
    });
    document.body.appendChild(button);
  }

  var api = {
    version: VERSION,
    configure: configure,
    status: status,
    start: start,
    test: testPanel,
    flush: flush,
    errors: function () {
      return errors.slice();
    },
  };
  window.FabriqueReport = api;

  // Settings from the script tag: data-endpoint, data-lang, data-capture-script,
  // data-environment, data-button.
  var tag = document.currentScript;
  if (tag && tag.dataset) {
    configure({
      endpoint: tag.dataset.endpoint || null,
      lang: tag.dataset.lang || null,
      captureScript: tag.dataset.captureScript || null,
      environment: tag.dataset.environment || null,
      button: tag.dataset.button === "true",
    });
  }

  function ready() {
    flush();
    if (options.button)
      status().then(function (data) {
        if (data.can_report) showButton();
        if (data.can_test) showTestButton();
      });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready);
  else ready();
  window.addEventListener("online", flush);
})();
