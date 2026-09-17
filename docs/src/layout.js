// Chrome shared by every page: the grouped navigation, the period badge, the
// stale-consolidation banner, and the small building blocks pages use for their own headers
// and busy states.
//
// Centralized here so no individual page render can forget the banner — the same reasoning as
// src/web/deps.py's _inject_period_status on the Python side. The Python app keeps its flat
// nav; per PLAN_PHASE8 §2 the UI refresh is browser-only, and base.html's nav is Jinja rather
// than JS so there is nothing to share but the stylesheet.
import { html, render } from "../vendor/lit-html.js";
import * as periodRepo from "./db/period-repo.js";

// Eleven flat links had outgrown the topbar and gave no sense of the workflow. Grouped by
// what you are doing rather than alphabetically: get data in, work on it, read the results,
// check the machinery. Dashboard stays a plain link because it is the way back to the start.
const NAV_GROUPS = [
  { label: "Data", items: [["/import", "Import TB"]] },
  {
    label: "Work",
    items: [
      ["/mapping", "Mapping"],
      ["/stock", "Stock"],
      ["/adjustments", "Adjustments"],
    ],
  },
  {
    label: "Reports",
    items: [
      ["/pl", "P&L"],
      ["/bs", "BS"],
      ["/consolidated", "Consolidated TB"],
      ["/retained-earnings", "Retained Earnings"],
    ],
  },
  {
    label: "System",
    items: [
      ["/validation", "Validation"],
      ["/audit", "Audit Log"],
    ],
  },
];

// The path suffix after /periods/<period>, e.g. "/mapping". "" on the dashboard.
function activeSuffix(periodStr) {
  const path = location.hash.slice(1) || "/";
  const prefix = `/periods/${periodStr}`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

function closeAllMenus(except = null) {
  for (const el of document.querySelectorAll("details.nav-group[open]")) {
    if (el !== except) el.open = false;
  }
}

let menuDismissWired = false;

// A <details> menu stays open until something closes it: it has no idea the pointer left, and
// following a link inside it does not re-render the topbar. Wire the ways out once.
//
// Only one menu may be open at a time. <details> knows nothing about its siblings, so opening
// a second group left the first one open and the two panels overlapped — which is what you
// see after clicking along the nav. Each click closes every group except the one clicked; the
// browser then applies its own toggle to that one, so clicking an open group still shuts it.
function wireMenuDismissal() {
  if (menuDismissWired) return;
  menuDismissWired = true;

  document.addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target : null;
    // A link inside a menu closes everything, its own group included: choosing the page you
    // are already on fires no hashchange, so nothing else would close it.
    if (target && target.closest(".nav-menu a")) {
      closeAllMenus();
      return;
    }
    closeAllMenus(target ? target.closest("details.nav-group") : null);
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeAllMenus();
  });

  // Tabbing out of an open menu leaves it hanging over the page with focus somewhere else.
  // relatedTarget is where focus went — null when it left the window entirely, which is not a
  // reason to close.
  document.addEventListener("focusout", (ev) => {
    const next = ev.relatedTarget;
    if (next instanceof Element) closeAllMenus(next.closest("details.nav-group"));
  });

  window.addEventListener("hashchange", () => closeAllMenus());
}

export function updateNav(periodStr) {
  const navEl = document.getElementById("nav-links");
  const badgeEl = document.getElementById("period-badge");
  const staleEl = document.getElementById("stale-banner");

  wireMenuDismissal();
  // Every page calls updateNav first, so resetting here means a wide page cannot leak its
  // width onto the next narrow one; pages that want the extra width call setPageWidth after.
  setPageWidth("default");

  if (!periodStr) {
    render(html`<a class="nav-link is-active" href="#/">Dashboard</a>`, navEl);
    badgeEl.style.display = "none";
    render("", staleEl);
    return;
  }

  const suffix = activeSuffix(periodStr);
  const href = (s) => `#/periods/${periodStr}${s}`;

  render(
    html`
      <a class="nav-link ${suffix === "" ? "is-active" : ""}" href=${href("")}>Dashboard</a>
      ${NAV_GROUPS.map((group) => {
        const active = group.items.some(([s]) => s === suffix);
        return html`
          <details class="nav-group ${active ? "is-active" : ""}">
            <summary>${group.label}<span class="caret" aria-hidden="true">▾</span></summary>
            <div class="nav-menu">
              ${group.items.map(
                ([s, label]) => html`<a class=${s === suffix ? "is-active" : ""} href=${href(s)}>${label}</a>`
              )}
            </div>
          </details>
        `;
      })}
    `,
    navEl
  );

  const period = periodRepo.getByStr(periodStr);
  badgeEl.style.display = "";
  badgeEl.textContent = period ? `${periodStr} · ${period.status}` : periodStr;

  render(
    period && periodRepo.isConsolidationStale(period.period_id)
      ? html`<div class="flash flash-warn">Adjustments changed since the last consolidation. Re-run Consolidate.</div>`
      : "",
    staleEl
  );
}

// Statement and matrix pages need the extra width for their columns; forms and lists read
// better narrow. Set on <body> so the topbar lines up with the content beneath it.
export function setPageWidth(mode) {
  document.body.classList.toggle("page-wide", mode === "wide");
}

// Title, optional subtitle, right-aligned actions — the header every page now shares, instead
// of each one hand-rolling an <h1> and hoping the buttons land somewhere sensible.
export function pageHead({ title, subtitle, actions }) {
  return html`
    <div class="page-head">
      <div>
        <h1>${title}</h1>
        ${subtitle ? html`<p class="subtitle">${subtitle}</p>` : ""}
      </div>
      ${actions ? html`<div class="head-actions">${actions}</div>` : ""}
    </div>
  `;
}

let toastTimer = null;

// A transient confirmation that does not push the page around.
//
// Saving on Mapping used to insert a banner above a 150-row table, which moved everything the
// reader was looking at. A toast says the same thing without reflowing anything. Errors still
// belong in an inline flash — those need to stay on screen until they are dealt with.
export function toast(message, kind = "success") {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.className = `toast toast-${kind} is-visible`;
  el.textContent = message;
  el.setAttribute("role", "status");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("is-visible"), 3200);
}

// Radio-style filter pills with counts, e.g. All 152 / Unmapped 3 / Split 6.
export function filterPills(options, active, onPick) {
  return html`
    <div class="pills" role="group">
      ${options.map(
        (o) => html`
          <button
            type="button"
            class="pill ${o.key === active ? "is-active" : ""}"
            ?disabled=${o.count === 0 && o.key !== active}
            @click=${() => onPick(o.key)}
          >
            ${o.label}<span class="pill-count">${o.count}</span>
          </button>
        `
      )}
    </div>
  `;
}

// Run `fn` once the busy state has had a chance to reach the screen.
//
// Consolidate and the Excel export are synchronous and block the main thread for their whole
// run, so calling them straight after a re-render means the spinner is never painted. A frame
// of delay fixes that. Deliberately setTimeout rather than requestAnimationFrame: rAF does not
// fire at all while the tab is hidden, which would leave the button stuck on "Consolidating…"
// forever for anyone who switched away — caught exactly that way while testing.
export function afterPaint(fn) {
  setTimeout(fn, 16);
}

// A button that shows it is working. Long operations (consolidate, export, import) otherwise
// look like nothing happened, which invites a second click on an action that is already
// running.
export function busyButton({ label, busyLabel, busy, onClick, kind = "btn", disabled = false }) {
  return html`
    <button
      class="${kind} ${busy ? "is-busy" : ""}"
      type="button"
      ?disabled=${busy || disabled}
      @click=${onClick}
    >
      ${busy ? html`<span class="spinner"></span>${busyLabel || label}` : label}
    </button>
  `;
}
