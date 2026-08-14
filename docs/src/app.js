import { persistence } from "./db/persistence.js";
import { router } from "./router.js";
import { initBackupControls } from "./backup-controls.js";
import { renderDashboardHome, renderPeriodDashboard } from "./pages/dashboard.js";
import { renderImportTb } from "./pages/import-tb.js";
import { renderMapping } from "./pages/mapping.js";
import { renderStock } from "./pages/stock.js";
import { renderConsolidatedTb } from "./pages/consolidated-tb.js";
import { renderAdjustmentsList } from "./pages/adjustments-list.js";
import { renderAdjustmentForm } from "./pages/adjustment-form.js";
import { renderValidation } from "./pages/validation.js";
import { renderPl, renderBs } from "./pages/statement.js";
import { renderAuditLog } from "./pages/audit-log.js";
import { renderRetainedEarnings } from "./pages/retained-earnings.js";

const mount = document.getElementById("app");
const statusEl = document.getElementById("boot-status");

window.__persistence = persistence; // debug/console access

async function main() {
  try {
    await persistence.init("");
  } catch (err) {
    statusEl.textContent = `Failed to start: ${err.message}`;
    statusEl.className = "flash flash-error";
    console.error(err);
    return;
  }
  statusEl.remove();
  initBackupControls();

  router.register("/", renderDashboardHome);
  router.register("/periods/:period", renderPeriodDashboard);
  router.register("/periods/:period/import", renderImportTb);
  router.register("/periods/:period/mapping", renderMapping);
  router.register("/periods/:period/stock", renderStock);
  router.register("/periods/:period/consolidated", renderConsolidatedTb);
  router.register("/periods/:period/adjustments/new", renderAdjustmentForm);
  router.register("/periods/:period/adjustments/:ref/edit", renderAdjustmentForm);
  router.register("/periods/:period/adjustments", renderAdjustmentsList);
  router.register("/periods/:period/validation", renderValidation);
  router.register("/periods/:period/pl", renderPl);
  router.register("/periods/:period/bs", renderBs);
  router.register("/periods/:period/retained-earnings", renderRetainedEarnings);
  router.register("/periods/:period/audit", renderAuditLog);
  router.setNotFound((el) => {
    el.innerHTML = `<div class="empty">Page not found.</div>`;
  });
  router.start(mount);
}

main();
