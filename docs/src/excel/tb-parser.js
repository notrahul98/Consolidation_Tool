// Port of src/importers/tally_tb_parser.py — parses a Tally trial balance Excel export.
//
// Key real-data findings this parser encodes (ported verbatim from the Python original):
// - Opening/Closing are single columns, but each cell's Dr/Cr side is tagged in that
//   cell's number format string (e.g. '"#,000" Dr"'), not in the value or a separate
//   column, and not reliably inferable from the ledger's parent group.
// - A row is a group/subtotal ("skip for ledger import") if its Particulars cell is bold;
//   a real postable ledger is not bold. Indent level is not a reliable leaf/group signal.
// - The bold, indent-0 ancestor name is tracked as a mapping hint only, never for sign.

import { detect } from "./column-detector.js";

const TOLERANCE_IDR = 1;
const DRCR_RE = /"\s*(Dr|Cr)"\s*$/;

export function extractDrCr(numberFormat) {
  if (!numberFormat) return null;
  const m = DRCR_RE.exec(numberFormat);
  return m ? m[1].toUpperCase() : null;
}

function toFloat(value) {
  if (value === null || value === undefined || value === "") return 0.0;
  if (typeof value === "number") return value;
  return parseFloat(String(value).replace(/,/g, "").trim()) || 0.0;
}

function signed(value, side) {
  if (!value || side === null) return 0.0;
  return side === "DR" ? value : -value;
}

function readLine(name, row, openingCell, debitCell, creditCell, closingCell, tallyPrimaryGroup, warnings) {
  const openingVal = toFloat(openingCell.value);
  const openingSide = extractDrCr(openingCell.numFmt);
  const closingVal = toFloat(closingCell.value);
  const closingSide = extractDrCr(closingCell.numFmt);
  const periodDr = toFloat(debitCell.value);
  const periodCr = toFloat(creditCell.value);

  const openingDr = openingSide === "DR" ? openingVal : 0.0;
  const openingCr = openingSide === "CR" ? openingVal : 0.0;
  const closingDr = closingSide === "DR" ? closingVal : 0.0;
  const closingCr = closingSide === "CR" ? closingVal : 0.0;

  if (openingVal && openingSide === null) {
    warnings.push(`Row ${row} (${name}): opening balance has no Dr/Cr tag`);
  }
  if (closingVal && closingSide === null) {
    warnings.push(`Row ${row} (${name}): closing balance has no Dr/Cr tag`);
  }

  const signedOpening = signed(openingVal, openingSide);
  const signedClosing = signed(closingVal, closingSide);
  const impliedClosing = signedOpening + periodDr - periodCr;
  const tieWarning = Math.abs(impliedClosing - signedClosing) > TOLERANCE_IDR;
  if (tieWarning) {
    warnings.push(`Row ${row} (${name}): implied closing ${impliedClosing} vs exported ${signedClosing}`);
  }

  return {
    entityLedgerName: name,
    tallyPrimaryGroup: tallyPrimaryGroup,
    openingDr,
    openingCr,
    periodDr,
    periodCr,
    closingDr,
    closingCr,
    closingTieWarning: tieWarning,
  };
}

async function sha256Hex(buffer) {
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// A bold row is normally a group/subtotal that gets skipped in favor of its (non-bold)
// children. But Tally sometimes gives a group its own balance with *zero* children
// underneath it — skipping those loses real money. A pending bold row is only discarded
// once an actual child row confirms it was a genuine subtotal; if the next thing seen is
// another bold row or Grand Total instead, the pending row is emitted as a leaf in its
// own right, using its own name as the ledger name.
export async function parseFile(arrayBuffer, sourceFilename) {
  const checksum = await sha256Hex(arrayBuffer);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(arrayBuffer);
  const ws = workbook.worksheets[0];
  const layout = detect(ws);

  const result = {
    sourceFilename,
    checksum,
    lines: [],
    grandTotalPeriodDr: 0.0,
    grandTotalPeriodCr: 0.0,
    warnings: [],
  };

  let currentTopGroup = null;
  let pendingGroup = null; // {name, row, openingCell, debitCell, creditCell, closingCell, groupCtx}

  function resolvePendingAsLeaf() {
    if (pendingGroup === null) return;
    const { name, row, openingCell, debitCell, creditCell, closingCell, groupCtx } = pendingGroup;
    result.lines.push(readLine(name, row, openingCell, debitCell, creditCell, closingCell, groupCtx, result.warnings));
  }

  const maxRow = ws.rowCount;
  for (let row = layout.dataStartRow; row <= maxRow; row++) {
    const nameCell = ws.getRow(row).getCell(layout.particularsCol);
    let name = nameCell.value;
    if (name === null || name === undefined || String(name).trim() === "") continue;
    name = String(name).trim();

    const openingCell = ws.getRow(row).getCell(layout.openingCol);
    const debitCell = ws.getRow(row).getCell(layout.periodDebitCol);
    const creditCell = ws.getRow(row).getCell(layout.periodCreditCol);
    const closingCell = ws.getRow(row).getCell(layout.closingCol);

    const isBold = !!(nameCell.font && nameCell.font.bold);
    const indent = (nameCell.alignment && nameCell.alignment.indent) || 0;

    if (name.toLowerCase() === "grand total") {
      resolvePendingAsLeaf();
      pendingGroup = null;
      result.grandTotalPeriodDr = toFloat(debitCell.value);
      result.grandTotalPeriodCr = toFloat(creditCell.value);
      continue;
    }

    if (isBold) {
      resolvePendingAsLeaf(); // previous pending group had no children after all
      const groupCtxForPending = indent !== 0 ? currentTopGroup : name;
      pendingGroup = { name, row, openingCell, debitCell, creditCell, closingCell, groupCtx: groupCtxForPending };
      if (indent === 0) currentTopGroup = name;
      continue;
    }

    pendingGroup = null; // this leaf confirms the last bold row was a genuine subtotal
    result.lines.push(readLine(name, row, openingCell, debitCell, creditCell, closingCell, currentTopGroup, result.warnings));
  }

  resolvePendingAsLeaf(); // file ended with a still-pending childless group
  return result;
}
