/**
 * Guard: every row type in the trading desk must render exactly as many columns
 * as the colgroup declares.
 *
 * A row with MORE cells than the colgroup silently forces the table to create an
 * extra column. In a fixed-layout table that phantom column is auto-width, so it
 * SPLITS the leftover space with the real auto column (Instrument) — the
 * instrument stays narrow and dead space appears after the last real column.
 * Nothing errors; it just looks like a CSS problem somewhere else entirely.
 *
 *   node scripts/check_desk_columns.mjs
 */
import { readFileSync } from "fs";

const read = (p) => readFileSync(new URL(`../client/src/components/${p}`, import.meta.url), "utf8");

const desk = read("TradingDesk.tsx");
const colgroup = desk.slice(desk.indexOf("<colgroup>"), desk.indexOf("</colgroup>"));
const thead = desk.slice(desk.indexOf("<thead"), desk.indexOf("</thead>"));
const cols = (colgroup.match(/<col\s/g) ?? []).length;
const ths = (thead.match(/<th\s/g) ?? []).length;

/** Cells a row renders, counting colSpan. */
function effectiveColumns(src) {
  const tds = (src.match(/<td[\s>]/g) ?? []).length;
  const spans = [...src.matchAll(/colSpan=\{(\d+)\}/g)].map((m) => Number(m[1]));
  return tds - spans.length + spans.reduce((a, b) => a + b, 0);
}

const rows = {
  FutureRow: effectiveColumns(read("FutureRow.tsx")),
  PastRow: effectiveColumns(read("PastRow.tsx")),
  TodayTradeRow: effectiveColumns(read("TodayTradeRow.tsx")),
};

console.log(`colgroup <col> : ${cols}`);
console.log(`header   <th>  : ${ths}`);
for (const [name, n] of Object.entries(rows)) console.log(`${name.padEnd(15)}: ${n}`);

const bad = [
  ...(ths !== cols ? [`header has ${ths}, colgroup has ${cols}`] : []),
  ...Object.entries(rows).filter(([, n]) => n !== cols).map(([name, n]) => `${name} has ${n}, colgroup has ${cols}`),
];

if (bad.length) {
  console.error("\nMISMATCH:\n  " + bad.join("\n  "));
  process.exit(1);
}
console.log("\nAll row types agree with the colgroup.");
