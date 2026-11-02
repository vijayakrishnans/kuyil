import { parsePgArray, pgArray } from "@saas/db/social";

describe("Postgres array literals (fetch_types: false)", () => {
  it("round-trips quotes, backslashes, commas and spaces", () => {
    const values = ['he said "hi"', "back\\slash", "a,b", "two words", "%like%"];
    expect(parsePgArray(pgArray(values))).toEqual(values);
  });
  it("parses what Postgres returns unquoted", () => {
    expect(parsePgArray("{politics,nsfw}")).toEqual(["politics", "nsfw"]);
    expect(parsePgArray("{}")).toEqual([]);
    expect(parsePgArray(["already", "parsed"])).toEqual(["already", "parsed"]);
  });
});
