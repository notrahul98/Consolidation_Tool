// Mirrors base.html's conditional nav + period badge (src/web/templates/base.html).
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
  ["/validation", "Validation"],
  ["/audit", "Audit Log"],
];

export function updateNav(periodStr) {
  const navEl = document.getElementById("nav-links");
  const badgeEl = document.getElementById("period-badge");

  if (!periodStr) {
    navEl.innerHTML = `<a href="#/">Dashboard</a>`;
    badgeEl.style.display = "none";
    return;
  }

  navEl.innerHTML = NAV_LINKS.map(
    ([suffix, label]) => `<a href="#/periods/${periodStr}${suffix}">${label}</a>`
  ).join("");

  const period = periodRepo.getByStr(periodStr);
  badgeEl.style.display = "";
  badgeEl.textContent = period ? `${periodStr} · ${period.status}` : periodStr;
}
