import { describe, expect, it } from "vitest";
import { parseMcxLotsFromHtml } from "./mcxLots";

// Minimal page shaped like the real dhan.co/commodities-lot-size __NEXT_DATA__:
// props.pageProps.listData[] = { sym, fo_dt:[{ls,exp_dt}], opt_dt:[...] }
const HTML = `<html><body>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: {
    pageProps: {
      listData: [
        { sym: "CRUDEOIL", fo_dt: [{ ls: "100 BBL", exp_dt: "18 Jun 2026" }], opt_dt: [] },
        { sym: "NATURALGAS", fo_dt: [{ ls: "1250 mmBtu", exp_dt: "25 Jun 2026" }], opt_dt: [] },
        { sym: "CRUDEOILM", fo_dt: [{ ls: "10 BBL", exp_dt: "18 Jun 2026" }], opt_dt: [] },
        { sym: "GOLD", fo_dt: [], opt_dt: [{ ls: "1 KGS", exp_dt: "5 Jun 2026" }] },
        { sym: "SILVER100", fo_dt: [{ ls: "NA" }], opt_dt: [] }, // unparseable → skipped
      ],
    },
  },
})}</script></body></html>`;

describe("parseMcxLotsFromHtml", () => {
  it("extracts the leading integer lot per commodity", () => {
    const lots = parseMcxLotsFromHtml(HTML);
    expect(lots.get("CRUDEOIL")).toBe(100);
    expect(lots.get("NATURALGAS")).toBe(1250);
    expect(lots.get("CRUDEOILM")).toBe(10);
  });

  it("falls back to opt_dt when fo_dt is empty", () => {
    expect(parseMcxLotsFromHtml(HTML).get("GOLD")).toBe(1);
  });

  it("skips entries with an unparseable lot ('NA')", () => {
    expect(parseMcxLotsFromHtml(HTML).has("SILVER100")).toBe(false);
  });

  it("throws if __NEXT_DATA__ is missing (layout change is loud, not silent)", () => {
    expect(() => parseMcxLotsFromHtml("<html>no data</html>")).toThrowError(/__NEXT_DATA__/);
  });

  it("throws if no lots parse at all", () => {
    const empty = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { listData: [] } },
    })}</script>`;
    expect(() => parseMcxLotsFromHtml(empty)).toThrowError(/no lot sizes/i);
  });
});
