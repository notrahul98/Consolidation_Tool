// Port of src/importers/column_detector.py — locates the Tally TB header block by
// searching for known marker text rather than assuming a fixed row/column position.

function norm(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim().toLowerCase();
}

function cellAt(ws, row, col) {
  return ws.getRow(row).getCell(col);
}

export function detect(ws) {
  const maxRow = ws.rowCount;
  const maxCol = ws.columnCount;

  let particularsRow = null;
  let particularsCol = null;
  outer: for (let row = 1; row <= Math.min(maxRow, 30); row++) {
    for (let col = 1; col <= Math.min(maxCol, 15); col++) {
      if (norm(cellAt(ws, row, col).value) === "particulars") {
        particularsRow = row;
        particularsCol = col;
        break outer;
      }
    }
  }
  if (particularsRow === null) {
    throw new Error("Could not locate a 'Particulars' header cell in this workbook");
  }

  // ExcelJS mirrors a merged cell's value across every cell in the merge range (openpyxl
  // only populates the anchor cell, leaving the rest None) — so a match must only be taken
  // the first time, otherwise a two-column "Transactions" merge overwrites periodStartCol
  // with its second half instead of its (correct) anchor/leftmost column.
  let openingCol = null;
  let periodStartCol = null;
  let closingCol = null;
  const markerRow = particularsRow + 1;
  for (let col = 1; col <= Math.min(maxCol, 20); col++) {
    const val = norm(cellAt(ws, markerRow, col).value);
    if (val === "opening" && openingCol === null) openingCol = col;
    else if (val === "transactions" && periodStartCol === null) periodStartCol = col;
    else if (val === "closing" && closingCol === null) closingCol = col;
  }
  if (!openingCol || !periodStartCol || !closingCol) {
    throw new Error(`Could not locate Opening/Transactions/Closing markers on row ${markerRow}`);
  }

  let debitCol = null;
  let creditCol = null;
  const subMarkerRow = particularsRow + 2;
  for (let col = periodStartCol; col < closingCol; col++) {
    const val = norm(cellAt(ws, subMarkerRow, col).value);
    if (val === "debit" && debitCol === null) debitCol = col;
    else if (val === "credit" && creditCol === null) creditCol = col;
  }
  if (!debitCol || !creditCol) {
    throw new Error(`Could not locate Debit/Credit markers on row ${subMarkerRow}`);
  }

  return {
    particularsCol,
    openingCol,
    periodDebitCol: debitCol,
    periodCreditCol: creditCol,
    closingCol,
    dataStartRow: particularsRow + 3,
  };
}
