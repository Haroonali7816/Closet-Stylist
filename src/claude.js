// All calls to Claude go through here, using Anthropic's official JS SDK straight from the browser.
// The user brings their own API key; there is no server in between.
import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.3.0/+esm";
import { parseJson } from "./logic.js";

export const MODELS = { smart: "claude-opus-5-5", fast: "claude-haiku-5-5" };
const KEY = "closet-stylist.apiKey";

export const getKey = () => { try { return localStorage.getItem(KEY) || ""; } catch { return ""; } };
export const setKey = k => { try { localStorage.setItem(KEY, k.trim()); } catch {} };

const toBase64 = blob => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1]);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

const fail = (code, message = code) => Object.assign(new Error(message), { code });

/**
 * Ask Claude one question, optionally with photos. Returns the reply text.
 * fast: true uses the small model (tagging, filtering); otherwise the most capable one.
 */
export async function ask(prompt, { images = [], fast = false, effort, signal } = {}) {
  const apiKey = getKey();
  if (!apiKey) throw fail("no_key");
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const content = [
    ...(await Promise.all(images.map(async b => ({
      type: "image", source: { type: "base64", media_type: b.type || "image/jpeg", data: await toBase64(b) } })))),
    { type: "text", text: prompt },
  ];
  const params = {
    model: fast ? MODELS.fast : MODELS.smart,
    max_tokens: 16000,
    messages: [{ role: "user", content }],
    output_config: { effort: effort || (fast ? "low" : "medium") },
  };
  let res;
  try {
    res = fast
      ? await client.messages.create(params, { signal })
      // If the main model declines, the API retries on a suitable fallback model by itself.
      : await client.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }, { signal });
  } catch (e) {
    if (e instanceof Anthropic.APIUserAbortError) throw fail("cancelled");
    if (e instanceof Anthropic.AuthenticationError) throw fail("bad_key");
    if (e instanceof Anthropic.RateLimitError) throw fail("rate_limited");
    if (e instanceof Anthropic.APIConnectionError) throw fail("offline");
    if (e instanceof Anthropic.APIError) throw fail("api_error", e.message);
    throw e;
  }
  if (res.stop_reason === "refusal") throw fail("refused");
  return res.content.filter(b => b.type === "text").map(b => b.text).join("");
}

export const askJson = async (prompt, opts) => parseJson(await ask(prompt, opts));
