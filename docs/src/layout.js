// Mirrors base.html's conditional nav + period badge (src/web/templates/base.html), plus
// the stale-consolidation banner (src/web/deps.py's _inject_period_status, extended for
// workstream D) -- centralized here so every page that calls updateNav() gets it, and no
// individual page render can forget it, matching the reasoning in the Python source.
import * as periodRepo from "./db/period-repo.js";

const NAV_LINKS = [
  ["", "Dashboard"],
  ["/import", "Import TB"],
  ["/mapping", "Mapping"],
  ["/stock", "Stock"],
  ["/adjustments", "Adjustments"],
  ["/consolidated", "Consolidated TB"],
  ["/pl", "P&L"],
  ["/bs", "BS"],
  ["/retained-earnings", "Retained Earnings"],
  ["/validation", "Validation"],
  ["/audit", "Audit Log"],
];

export function updateNav(periodStr) {
  const navEl = document.getElementById("nav-links");
  const badgeEl = document.getElementById("period-badge");
  const staleEl = document.getElementById("stale-banner");

  if (!periodStr) {
    navEl.innerHTML = `<a href="#/">Dashboard</a>`;
    badgeEl.style.display = "none";
    staleEl.innerHTML = "";
    return;
  }

  navEl.innerHTML = NAV_LINKS.map(
    ([suffix, label]) => `<a href="#/periods/${periodStr}${suffix}">${label}</a>`
  ).join("");

  const period = periodRepo.getByStr(periodStr);
  badgeEl.style.display = "";
  badgeEl.textContent = period ? `${periodStr} · ${period.status}` : periodStr;

  staleEl.innerHTML =
    period && periodRepo.isConsolidationStale(period.period_id)
      ? `<div class="flash flash-warn">Adjustments changed since the last consolidation. Re-run Consolidate.</div>`
      : "";
}
