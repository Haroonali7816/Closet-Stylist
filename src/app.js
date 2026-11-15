import * as store from "./store.js";
import { ask, askJson, getKey, setKey } from "./claude.js";
import {
  CATS, catalog, resolveRef, cleanTag, feedbackText, scoreOutfits,
  STYLE_PROMPT, TAG_PROMPT, CURATOR_PROMPT, COMBINER_PROMPT, JUDGE_PROMPT, TRIP_PROMPT,
} from "./logic.js";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MAX_IMAGES = 20; // photos per request; keeps each request well under the API's size limit

// App state, mirrored to IndexedDB. Items are stored under their own id ("item-…").
const S = { profile: {}, items: [], today: null, plan: null };
let ctl = null;

const say = (sel, msg, kind = "") => { const n = $(sel); n.textContent = msg; n.dataset.kind = kind; };
const banner = msg => { const b = $("#banner"); b.textContent = msg; b.hidden = !msg; };
function errCopy(e) {
  const map = {
    no_key: "Add your Anthropic API key in Settings at the top first.",
    bad_key: "Your API key was rejected. Check it in Settings.",
    rate_limited: "Too many requests right now. Wait a minute, then try again.",
    offline: "Couldn't reach Anthropic. Check your connection.",
    refused: "Claude declined that request. Reword it and try again.",
    invalid_json: "The answer came back incomplete. Try again.",
    cancelled: "Stopped.",
    few_items: "Too few of your clothes fit that request. Add more pieces or loosen it.",
  };
  return map[e?.code] || `Something went wrong${e?.message ? `: ${e.message}` : ""}. Try again.`;
}

// Shrinks a phone photo to ≤1400px JPEG so storage and requests stay small.
async function shrink(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const s = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error("encode"))), "image/jpeg", 0.85));
}

// Two clicks to delete: the first arms the button, the second confirms.
function armed(btn) {
  if (btn.dataset.armed) return true;
  btn.dataset.armed = "1"; const old = btn.textContent; btn.textContent = "Sure?";
  setTimeout(() => { delete btn.dataset.armed; btn.textContent = old; }, 3000);
  return false;
}

async function saveProfile(patch) { S.profile = { ...S.profile, ...patch }; await store.putDoc("profile", S.profile); render(); }
async function saveItem(it) {
  const i = S.items.findIndex(x => x.id === it.id);
  if (i < 0) S.items.push(it); else S.items[i] = it;
  await store.putDoc(it.id, it); render();
}
const ready = () => S.items.filter(i => i.name !== "Tagging…");
const about = () => $("#about").value.trim() || "(no profile yet)";

/* ---------- 1. You ---------- */
async function addSelf(files) {
  let failed = 0;
  for (const [i, f] of files.entries()) {
    say("#youStatus", `Saving ${i + 1} of ${files.length}…`);
    try {
      const id = await store.putPhoto(await shrink(f));
      // Append to the current list each time, so a parallel batch or a deletion isn't overwritten.
      await saveProfile({ photos: [...(S.profile.photos || []), id] });
    } catch { failed++; }
  }
  say("#youStatus", failed ? `${failed} photo(s) couldn't be read. iPhone HEIC photos need exporting as JPEG.` : `${(S.profile.photos || []).length} photos of you saved.`, failed ? "err" : "ok");
}

async function readStyle() {
  const ids = (S.profile.photos || []).slice(-MAX_IMAGES);
  if (!ids.length) return say("#youStatus", "Add a few photos of yourself first.", "err");
  $("#readBtn").disabled = true; say("#youStatus", "Looking at your photos… (about a minute)");
  try {
    const blobs = (await Promise.all(ids.map(store.getPhoto))).filter(Boolean);
    const text = await ask(STYLE_PROMPT($("#about").value.trim()), { images: blobs });
    $("#about").value = text;
    await saveProfile({ about: text });
    say("#youStatus", `Profile written from ${blobs.length} photos. Edit it freely.`, "ok");
  } catch (e) { say("#youStatus", errCopy(e), "err"); }
  finally { $("#readBtn").disabled = false; }
}

/* ---------- 2. Wardrobe ---------- */
async function addItems(files) {
  let failed = 0, tagErr = null;
  for (const [i, f] of files.entries()) {
    say("#closetStatus", `Adding ${i + 1} of ${files.length}…`);
    let blob, item;
    try {
      blob = await shrink(f);
      const photo = await store.putPhoto(blob);
      item = { id: "item-" + photo, photo, name: "Tagging…", cat: "other", added: Date.now() };
      await saveItem(item);
    } catch { failed++; continue; }
    // Save the tag onto the item as it is now: skip it if it was removed meanwhile, keep a name the user typed.
    const finish = patch => {
      const cur = S.items.find(x => x.id === item.id);
      return cur && saveItem({ ...cur, ...patch, ...(cur.name !== "Tagging…" && { name: cur.name }) });
    };
    try { await finish(cleanTag(await askJson(TAG_PROMPT, { images: [blob], fast: true }))); }
    catch (e) { tagErr = e; await finish({ name: "Untitled item" }); }
  }
  if (failed) say("#closetStatus", `${failed} photo(s) couldn't be read. iPhone HEIC photos need exporting as JPEG.`, "err");
  else if (tagErr) say("#closetStatus", `Saved, but auto-tagging failed: ${errCopy(tagErr)} Name the items yourself.`, "err");
  else say("#closetStatus", `Added ${files.length}. Check the names and fix any that are off.`, "ok");
}

async function removeItem(id) {
  const it = S.items.find(x => x.id === id); if (!it) return;
  S.items = S.items.filter(x => x.id !== id);
  await store.delDoc(id);
  await store.delPhoto(it.photo).catch(() => {});
  render();
}

/* ---------- 3. Dress me: Curator → Combiner → Judge ---------- */
function setAgent(n, state, text) { const li = $("#ag" + n); li.dataset.state = state; li.querySelector("small").textContent = text; }

async function dressMe(ev) {
  ev.preventDefault();
  const list = ready();
  if (list.length < 3) return say("#dressStatus", "Add at least a few clothes in step 2 first.", "err");
  const askText = $("#ask").value.trim();
  if (!askText) return say("#dressStatus", "Say where you're going first.", "err");
  const weather = $("#dWeather").value.trim() || `unknown; assume typical for ${new Date().toDateString()}`;
  const ctx = `About me:\n${about()}\n\nToday: ${askText}\nWeather: ${weather}${feedbackText(S.profile.feedback)}`;
  const lines = catalog(list).split("\n");
  const refOf = it => "i" + (list.indexOf(it) + 1);
  ctl = new AbortController(); const signal = ctl.signal;
  $("#dressBtn").disabled = true; $("#dStop").hidden = false; $("#agents").hidden = false;
  [1, 2, 3].forEach(n => setAgent(n, "wait", "Waiting"));
  say("#dressStatus", "");
  let stage = 1;
  try {
    // Agent 1, Curator (fast model): narrow the wardrobe to what fits the dress code and weather.
    setAgent(1, "run", "Going through your wardrobe…");
    const c = await askJson(CURATOR_PROMPT(ctx, lines.join("\n")), { fast: true, signal });
    const kept = [...new Set((c.keep || []).map(r => resolveRef(r, list)).filter(Boolean))];
    if (kept.length < 2) throw { code: "few_items" };
    setAgent(1, "done", `Kept ${kept.length} of ${list.length}. ${c.note || ""}`);

    // Agent 2, Combiner: build distinct complete outfits from the kept pieces only.
    stage = 2; setAgent(2, "run", "Trying combinations…");
    const k = await askJson(COMBINER_PROMPT(ctx, lines.filter((_, i) => kept.includes(list[i])).join("\n")), { signal });
    const outfits = (k.outfits || []).map(o => ({ name: String(o.name || "Outfit"), idea: String(o.idea || ""),
      items: [...new Set((o.items || []).map(r => resolveRef(r, list)).filter(Boolean))] })).filter(o => o.items.length >= 2).slice(0, 8);
    if (!outfits.length) throw { code: "few_items" };
    setAgent(2, "done", `${outfits.length} combinations built.`);

    // Agent 3, Judge: looks at the actual photos, scores every outfit, picks one.
    stage = 3; setAgent(3, "run", "Looking at the photos and scoring…");
    const pics = [...new Set(outfits.flatMap(o => o.items))].slice(0, MAX_IMAGES);
    const blobs = await Promise.all(pics.map(it => store.getPhoto(it.photo)));
    const outfitLines = outfits.map((o, n) => `${n + 1}. ${o.name}: ${o.items.map(it => `${refOf(it)} ${it.name}`).join(" + ")}`).join("\n");
    const j = await askJson(JUDGE_PROMPT(ctx, outfitLines, pics.map(refOf)), { images: blobs.filter(Boolean), effort: "high", signal });
    const { outfits: scored, winner } = scoreOutfits(outfits.map(o => ({ ...o, items: o.items.map(it => it.id) })), j);
    setAgent(3, "done", `Picked "${scored[winner].name}".`);
    S.today = { ask: askText, weather: $("#dWeather").value.trim(), outfits: scored, winner,
      why: String(j.why || ""), tweak: String(j.tweak || ""), at: Date.now() };
    await store.putDoc("today", S.today); render();
  } catch (e) {
    setAgent(stage, "err", e?.code === "cancelled" ? "Stopped." : "Failed.");
    say("#dressStatus", errCopy(e), e?.code === "cancelled" ? "" : "err");
  } finally { $("#dressBtn").disabled = false; $("#dStop").hidden = true; }
}

/* ---------- 4. Trip ---------- */
const tripFromForm = () => ({ where: $("#where").value.trim(), length: $("#length").value.trim(),
  weather: $("#weather").value.trim(), plans: $("#plans").value.trim(), bag: $("#bag").value });

async function makePlan(ev) {
  ev.preventDefault();
  const list = ready();
  if (!list.length) return say("#tripStatus", "Add some clothes in step 2 first.", "err");
  const trip = tripFromForm();
  ctl = new AbortController();
  $("#planBtn").disabled = true; $("#stopBtn").hidden = false;
  say("#tripStatus", "Thinking through your outfits… (up to a minute or two)");
  try {
    const r = await askJson(TRIP_PROMPT(about() + feedbackText(S.profile.feedback), trip, catalog(list), new Date().toDateString()), { signal: ctl.signal });
    const id = ref => resolveRef(ref, list)?.id;
    const refs = arr => (arr || []).map(p => ({ id: id(p.ref), why: String(p.why || "") })).filter(p => p.id);
    S.plan = { trip, at: Date.now(), result: {
      summary: String(r.summary || ""),
      outfits: (r.outfits || []).map(o => ({ when: String(o.when || ""), why: String(o.why || ""), items: (o.items || []).map(id).filter(Boolean) })),
      pack: refs(r.pack), leave: refs(r.leave),
      missing: (r.missing || []).map(String), tips: (r.tips || []).map(String) } };
    await store.putDoc("plan", S.plan); render();
    say("#tripStatus", "Done. Saved in this browser.", "ok");
  } catch (e) { say("#tripStatus", errCopy(e), e?.code === "cancelled" ? "" : "err"); }
  finally { $("#planBtn").disabled = false; $("#stopBtn").hidden = true; }
}

/* ---------- render ---------- */
const byId = () => Object.fromEntries(S.items.map(i => [i.id, i]));
const mini = it => `<figure class="mini"><img src="${store.photoUrl(it.photo)}" alt=""><figcaption>${esc(it.name)}</figcaption></figure>`;
const when = t => new Date(t).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

function render() {
  const ph = S.profile.photos || [];
  $("#selfStrip").innerHTML = ph.map(id => `<div class="self"><img src="${store.photoUrl(id)}" alt="Photo of you" loading="lazy">
    <button class="x" data-self="${esc(id)}" type="button" aria-label="Remove photo">✕</button></div>`).join("")
    || `<p class="empty">No photos of you yet.</p>`;
  if (document.activeElement !== $("#about") && S.profile.about !== undefined) $("#about").value = S.profile.about;

  const sorted = [...S.items].sort((a, b) => CATS.indexOf(a.cat) - CATS.indexOf(b.cat) || (a.added || 0) - (b.added || 0));
  $("#count").textContent = S.items.length ? `${S.items.length} pieces` : "";
  $("#grid").innerHTML = sorted.map(it => `<article class="tag">
      <img src="${store.photoUrl(it.photo)}" alt="${esc(it.name)}" loading="lazy">
      <div class="tag-body">
        <input class="name" type="text" id="n-${esc(it.id)}" data-item="${esc(it.id)}" value="${esc(it.name)}" aria-label="Item name">
        <p class="mono">${esc([it.cat, it.color, it.formality].filter(Boolean).join(" · "))}</p>
        ${it.warmth ? `<p class="warm" title="Warmth ${it.warmth} of 5">${"●".repeat(it.warmth)}${"○".repeat(5 - it.warmth)}</p>` : ""}
        <button class="x" data-del="${esc(it.id)}" type="button">Remove</button>
      </div></article>`).join("")
    || `<p class="empty">Your wardrobe is empty. Add photos of your clothes and shoes to start.</p>`;

  renderToday();
  renderPlan();
}

function renderToday() {
  const el = $("#today"), T = S.today;
  if (!T?.outfits?.length) { el.innerHTML = `<p class="empty">Your best outfit appears here, with the runners-up and their scores.</p>`; return; }
  const items = byId();
  const minis = ids => ids.map(id => items[id]).filter(Boolean).map(mini).join("");
  const score = o => `<p class="mono">Weather ${o.scores[0]} · Occasion ${o.scores[1]} · Colour ${o.scores[2]} · Suits you ${o.scores[3]} · ${o.total}/40</p>`;
  const fb = n => {
    const done = (S.profile.feedback || []).find(x => x.src === `${T.at}:${n}`);
    return done ? `<p class="status" data-kind="ok">You said: ${done.verdict === "liked" ? "liked it" : "not me"}. The agents will remember.</p>`
      : `<div class="row"><button class="btn sm" type="button" data-fb="liked" data-k="${n}">Liked it</button><button class="btn sm" type="button" data-fb="disliked" data-k="${n}">Not me</button></div>`;
  };
  const w = T.outfits[T.winner] || T.outfits[0];
  const rest = T.outfits.map((o, n) => [o, n]).filter(([, n]) => n !== T.winner).sort((a, b) => b[0].total - a[0].total);
  el.innerHTML = `<p class="mono">${esc(T.ask)} · picked ${esc(when(T.at))}</p>
    <div class="outfit best"><p class="lbl">Wear this</p><h3>${esc(w.name)}</h3><div class="minis">${minis(w.items)}</div>${score(w)}
      <p>${esc(T.why)}</p>${T.tweak ? `<p><strong>Tip:</strong> ${esc(T.tweak)}</p>` : ""}${fb(T.winner)}</div>
    ${rest.length ? `<p class="lbl">Runners-up</p><div class="outfits">${rest.map(([o, n]) => `<div class="outfit"><h3>${esc(o.name)}</h3>
      <div class="minis">${minis(o.items)}</div>${score(o)}<p>${esc(o.note || o.idea)}</p>${fb(n)}</div>`).join("")}</div>` : ""}`;
}

function renderPlan() {
  const el = $("#plan"), P = S.plan;
  if (!P?.result) { el.innerHTML = `<p class="empty">Your outfits, packing list and what to leave at home appear here.</p>`; return; }
  const items = byId(), R = P.result;
  const line = (p, check) => { const it = items[p.id]; if (!it) return "";
    const body = `<img src="${store.photoUrl(it.photo)}" alt=""><span>${esc(it.name)}<small>${esc(p.why)}</small></span>`;
    return check ? `<li><label class="check"><input type="checkbox" id="pk-${esc(p.id)}">${body}</label></li>` : `<li>${body}</li>`; };
  const bullets = arr => arr.map(m => `<li><span>${esc(m)}</span></li>`).join("");
  el.innerHTML = `
    <p class="mono">${esc(P.trip.where)} · ${esc(P.trip.length)} · planned ${esc(when(P.at))}</p>
    ${R.summary ? `<p class="summary">${esc(R.summary)}</p>` : ""}
    <div class="outfits">${R.outfits.map(o => `<div class="outfit"><h3>${esc(o.when)}</h3>
      <div class="minis">${o.items.map(id => items[id]).filter(Boolean).map(mini).join("")}</div><p>${esc(o.why)}</p></div>`).join("")}</div>
    <div class="cols">
      <div><p class="lbl">Pack · ${R.pack.length} pieces</p><ul>${R.pack.map(p => line(p, true)).join("")}</ul></div>
      <div><p class="lbl">Leave at home</p><ul>${R.leave.map(p => line(p)).join("") || "<li>Nothing flagged.</li>"}</ul></div>
      ${R.missing.length || R.tips.length ? `<div>
        ${R.missing.length ? `<p class="lbl">Missing from your wardrobe</p><ul>${bullets(R.missing)}</ul>` : ""}
        ${R.tips.length ? `<p class="lbl" style="margin-top:16px">Tips</p><ul>${bullets(R.tips)}</ul>` : ""}
      </div>` : ""}
    </div>`;
}

/* ---------- wiring ---------- */
$("#apiKey").value = getKey();
$("#settings").open = !getKey();
$("#saveKey").onclick = () => { setKey($("#apiKey").value); $("#settings").open = false; banner(""); };
$("#selfBtn").onclick = () => $("#selfIn").click();
$("#itemBtn").onclick = () => $("#itemIn").click();
$("#selfIn").onchange = e => { const f = [...e.target.files]; e.target.value = ""; if (f.length) addSelf(f); };
$("#itemIn").onchange = e => { const f = [...e.target.files]; e.target.value = ""; if (f.length) addItems(f); };
$("#readBtn").onclick = readStyle;
$("#dressForm").onsubmit = dressMe;
$("#tripForm").onsubmit = makePlan;
$("#stopBtn").onclick = () => ctl?.abort();
$("#dStop").onclick = () => ctl?.abort();
$("#about").addEventListener("change", () => saveProfile({ about: $("#about").value }));
document.addEventListener("change", e => {
  const id = e.target.dataset?.item, it = id && S.items.find(x => x.id === id);
  if (it) saveItem({ ...it, name: e.target.value.trim().slice(0, 60) || "Untitled item" });
});
document.addEventListener("click", async e => {
  const f = e.target.closest("button[data-fb]");
  if (f && S.today) {
    const n = +f.dataset.k, o = S.today.outfits[n];
    const names = o.items.map(id => S.items.find(i => i.id === id)?.name).filter(Boolean);
    await saveProfile({ feedback: [...(S.profile.feedback || []),
      { verdict: f.dataset.fb, items: names, ask: S.today.ask, src: `${S.today.at}:${n}`, at: Date.now() }].slice(-40) });
    return;
  }
  const b = e.target.closest("button[data-del], button[data-self]"); if (!b || !armed(b)) return;
  if (b.dataset.del) await removeItem(b.dataset.del);
  else {
    const id = b.dataset.self;
    await saveProfile({ photos: (S.profile.photos || []).filter(x => x !== id) });
    await store.delPhoto(id).catch(() => {});
  }
});

(async () => {
  render();
  try {
    const docs = await store.getAllDocs();
    S.profile = docs.profile || {}; S.today = docs.today || null; S.plan = docs.plan || null;
    // An item still "Tagging…" at load time was interrupted (tab closed mid-upload); make it usable.
    S.items = Object.entries(docs).filter(([k]) => k.startsWith("item-"))
      .map(([, v]) => (v.name === "Tagging…" ? { ...v, name: "Untitled item" } : v));
    if (S.plan?.trip) for (const k of ["where", "length", "weather", "plans", "bag"]) if (S.plan.trip[k]) $("#" + k).value = S.plan.trip[k];
    await store.loadPhotoUrls([...(S.profile.photos || []), ...S.items.map(i => i.photo)]);
    store.persist();
  } catch { banner("This browser blocked local storage (private window?). Your wardrobe won't be saved."); }
  if (!getKey()) banner("Add your Anthropic API key in Settings to turn on tagging and styling.");
  render();
})();
