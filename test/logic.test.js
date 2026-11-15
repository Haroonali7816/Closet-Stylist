import { test } from "node:test";
import assert from "node:assert/strict";
import { catalog, resolveRef, cleanTag, parseJson, scoreOutfits, feedbackText } from "../src/logic.js";

test("resolveRef maps i1.. to list positions and rejects anything else", () => {
  const list = [{ a: 1 }, { b: 2 }];
  assert.equal(resolveRef("i2", list), list[1]);
  assert.equal(resolveRef(" i1 ", list), list[0]);
  assert.equal(resolveRef("i9", list), undefined);
  assert.equal(resolveRef("x1", list), undefined);
});

test("catalog numbers items in order", () => {
  const out = catalog([{ cat: "top", name: "White oxford", color: "white", warmth: 2, formality: "smart casual" }]);
  assert.match(out, /^i1 \| top \| White oxford \| white \| warmth 2\/5 \| smart casual/);
});

test("cleanTag bounds and defaults every field", () => {
  const t = cleanTag({ name: "x".repeat(100), cat: "spaceship", warmth: 9 });
  assert.equal(t.name.length, 60);
  assert.equal(t.cat, "other");
  assert.equal(t.warmth, 5);
  assert.equal(cleanTag(null).warmth, 3);
});

test("parseJson reads plain, fenced and wrapped replies", () => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJson('Here:\n```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(parseJson('Sure! {"a":3} Hope that helps.'), { a: 3 });
  assert.throws(() => parseJson("no json here"), e => e.code === "invalid_json");
});

test("scoreOutfits clamps scores and falls back to the highest total", () => {
  const outfits = [{ name: "A" }, { name: "B" }];
  const r = scoreOutfits(outfits, { scores: [{ n: 1, weather: 3 }, { n: 2, weather: 12, occasion: 9 }], winner: 7 });
  assert.deepEqual(r.outfits[1].scores, [10, 9, 0, 0]);
  assert.equal(r.winner, 1);
  assert.equal(scoreOutfits(outfits, { winner: 1 }).winner, 0);
});

test("feedbackText is empty without feedback and lists recent ratings", () => {
  assert.equal(feedbackText([]), "");
  assert.match(feedbackText([{ verdict: "liked", items: ["Navy blazer", "Grey trousers"], ask: "seminar" }]), /liked: Navy blazer \+ Grey trousers \(for: seminar\)/);
});
