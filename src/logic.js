// Pure helpers and the agents' prompts. No DOM, no network: everything here is unit-tested.

export const CATS = ["outerwear", "suit", "top", "knit", "bottom", "shoes", "accessory", "other"];

/** Wardrobe as text lines Claude can read. Items are referred to as i1, i2, … by position. */
export const catalog = list => list.map((it, i) =>
  `i${i + 1} | ${it.cat} | ${it.name} | ${it.color || "-"} | warmth ${it.warmth || "?"}/5 | ${it.formality || "-"} | ${it.notes || ""}`).join("\n");

/** "i3" → list[2]; anything else → undefined. */
export const resolveRef = (ref, list) => {
  const m = /^i(\d+)$/.exec(String(ref).trim());
  return m ? list[+m[1] - 1] : undefined;
};

/** Normalise a tag reply from Claude into safe, bounded fields. */
export function cleanTag(t) {
  return {
    name: String(t?.name || "Untitled item").slice(0, 60),
    cat: CATS.includes(t?.cat) ? t.cat : "other",
    color: String(t?.color || "").slice(0, 30),
    warmth: Math.min(5, Math.max(1, Math.round(Number(t?.warmth) || 3))),
    formality: String(t?.formality || "").slice(0, 20),
    notes: String(t?.notes || "").slice(0, 120),
  };
}

/** Read one JSON value from a reply: whole text, a ``` fence, or the outermost {…}/[…]. */
export function parseJson(text) {
  const t = String(text).trim();
  const candidates = [t];
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fence) candidates.push(fence[1]);
  const starts = ["{", "["].map(c => t.indexOf(c)).filter(i => i >= 0);
  if (starts.length) candidates.push(t.slice(Math.min(...starts), Math.max(t.lastIndexOf("}"), t.lastIndexOf("]")) + 1));
  for (const c of candidates) { try { return JSON.parse(c); } catch {} }
  throw Object.assign(new Error("invalid_json"), { code: "invalid_json" });
}

/** Past Liked / Not me ratings, so every agent respects them. */
export const feedbackText = (feedback = []) => feedback.length
  ? "\n\nMy past feedback on outfits (respect it):\n" + feedback.slice(-15).map(x => `- ${x.verdict}: ${x.items.join(" + ")} (for: ${x.ask})`).join("\n")
  : "";

const SCORE_FIELDS = ["weather", "occasion", "colour", "suits"];

/** Merge the Judge's scores into the outfits and choose the winner (Judge's pick, else highest total). */
export function scoreOutfits(outfits, judge) {
  const scored = outfits.map((o, n) => {
    const s = (judge?.scores || []).find(x => +x.n === n + 1) || {};
    const scores = SCORE_FIELDS.map(f => Math.max(0, Math.min(10, Math.round(+s[f] || 0))));
    return { ...o, note: String(s.note || ""), scores, total: scores.reduce((a, b) => a + b, 0) };
  });
  const best = scored.reduce((b, o, n) => (o.total > scored[b].total ? n : b), 0);
  const pick = +judge?.winner;
  const winner = pick >= 1 && pick <= scored.length ? pick - 1 : best;
  return { outfits: scored, winner };
}

/* ---------------- prompts ---------------- */

export const STYLE_PROMPT = notes => `These are photos of me from different angles. Act as a frank, experienced personal stylist.
Write a compact style profile I can reuse for outfit planning. Plain text, short labelled lines, no markdown, under 180 words. Cover:
build and proportions; skin, hair and eye colouring and which colours flatter me vs wash me out; fits and silhouettes that work vs don't; collars, trouser rise and lengths to prefer; two things to avoid.
If notes from me follow, keep every fact in them.${notes ? "\n\nMy notes:\n" + notes : ""}`;

export const TAG_PROMPT = `This photo shows one clothing item, pair of shoes or accessory. Reply with only JSON:
{"name":"navy wool overcoat","cat":"outerwear|suit|top|knit|bottom|shoes|accessory|other","color":"navy","warmth":1-5,"formality":"casual|smart casual|semi-formal|formal","notes":"fabric, fit, notable details, under 12 words"}`;

export const CURATOR_PROMPT = (ctx, lines) => `You are the CURATOR on a styling team. From my wardrobe, keep every item that could suit today's occasion, dress code and weather, and drop the rest. Keep enough tops, bottoms, shoes, layers and accessories for several different outfits.

${ctx}

Wardrobe (ref | category | name | colour | warmth | formality | notes):
${lines}

Reply with only JSON: {"keep":["i1","i4"],"note":"one sentence on what you kept and dropped"}`;

export const COMBINER_PROMPT = (ctx, lines) => `You are the COMBINER on a styling team. Build 6 distinct, complete outfits using ONLY these items: a top and bottom (or a suit), shoes, plus an outer layer, knit or accessories when the weather or occasion calls for it. Vary the colour stories and the level of formality within the dress code.

${ctx}

Items (ref | category | name | colour | warmth | formality | notes):
${lines}

Reply with only JSON: {"outfits":[{"name":"Navy and grey, quietly smart","items":["i3","i7","i12"],"idea":"one sentence"}]}`;

export const JUDGE_PROMPT = (ctx, outfitLines, photoRefs) => `You are the JUDGE on a styling team: a strict, honest stylist. Score each outfit from 1 to 10 on: weather (warm/dry enough), occasion (right dress code), colour (palette works together), suits (flatters me, per my profile). Then pick the single best one.

${ctx}

Outfits:
${outfitLines}
${photoRefs.length ? `\nPhotos attached, in this order: ${photoRefs.join(", ")}. Trust the photos over the text where they differ.` : ""}

Reply with only JSON: {"scores":[{"n":1,"weather":8,"occasion":9,"colour":7,"suits":8,"note":"short verdict"}],"winner":1,"why":"two sentences","tweak":"one small styling tip for the winner"}`;

export const TRIP_PROMPT = (about, trip, lines, today) => `You are my personal stylist. Plan what I wear and pack using ONLY items from my wardrobe list.

About me:
${about}

Trip:
- Where: ${trip.where}
- How long: ${trip.length}
- Weather: ${trip.weather || `unknown; assume typical for the place and time of year (today is ${today})`}
- What I'm doing: ${trip.plans}
- Luggage: ${trip.bag}

My wardrobe (ref | category | name | colour | warmth | formality | notes):
${lines}

Rules: one outfit per real part of the trip (travel there, each day, each evening plan, travel back). Re-wear pieces sensibly to pack light for the luggage given. Layer for the weather. Favour colours and fits that suit me. Outfits must be coherent in colour and formality. If something essential is missing (e.g. no warm coat), say so in "missing".
Reply with only JSON:
{"summary":"two sentences","outfits":[{"when":"Day 1 · travel & dinner","items":["i3","i7"],"why":"one sentence"}],"pack":[{"ref":"i3","why":"few words"}],"leave":[{"ref":"i9","why":"few words"}],"missing":["short"],"tips":["short"]}
"pack" lists every item to bring, including what I wear while travelling. "leave" lists at most 8 items I might be tempted to bring but shouldn't.`;
