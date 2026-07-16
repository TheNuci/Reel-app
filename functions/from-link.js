// netlify/functions/from-link.js
//
// STEP 2: turn a pasted TikTok/Instagram URL into a recipe.
//
// Flow:
//   1. take the URL the user pasted
//   2. pull the post's CAPTION using the platform's official oEmbed endpoint
//      (free, no API key, no video download — the safe route)
//   3. hand that caption to the recipe brain (parse-recipe logic)
//   4. return a structured recipe
//
// oEmbed gives us the caption inside its "title" field. For many recipe reels the
// full recipe is right there in the caption, so this alone produces a real recipe.
// If a caption is too thin, that's when you'd later add the Whisper transcript route.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-haiku-4-5-20251001";

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors(), body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  if (!ANTHROPIC_API_KEY) return json(500, { error: "Server missing ANTHROPIC_API_KEY" });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return json(400, { error: "Invalid JSON body" }); }

  const url = (body.url || "").trim();
  if (!url) return json(400, { error: "No url provided" });

  const platform = detectPlatform(url);
  if (!platform) return json(400, { error: "Only TikTok or Instagram links are supported." });

  // ---- 1 + 2: fetch the caption via oEmbed ----
  let caption = "";
  let author = "";
  let thumbnail = "";
  try {
    const oembedUrl =
      platform === "tiktok"
        ? `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`
        : `https://api.instagram.com/oembed/?url=${encodeURIComponent(url)}`; // IG basic oEmbed

    const r = await fetch(oembedUrl, { headers: { "user-agent": "Mozilla/5.0" } });
    if (r.ok) {
      const o = await r.json();
      caption = (o.title || "").trim();       // the caption text lives here
      author = (o.author_name || "").trim();
      thumbnail = (o.thumbnail_url || "").trim();
    }
  } catch {
    // fall through — we'll handle "no caption" below
  }

  if (!caption) {
    return json(422, {
      error: "Couldn't read a recipe from this link's caption.",
      hint: "This post may not have the recipe in its caption. The transcript route (Whisper) would be the next step for videos like this.",
    });
  }

  // ---- 3: decide mode. If the caption clearly lists ingredients/steps, it's a real recipe.
  // Otherwise treat it as a food-only clip and recreate. (Simple heuristic; the model does the rest.)
  const looksLikeRecipe = /\d\s?(g|ml|cup|tbsp|tsp|oz|clove|egg|min)/i.test(caption) ||
                          /ingredient|recipe|step|method|serves/i.test(caption);
  const mode = looksLikeRecipe ? "recipe" : "visual";

  // ---- 4: parse into a structured recipe ----
  const recipe = await parseRecipe({ caption, mode });
  if (recipe.error) return json(recipe.status || 502, recipe);

  // attach source info the frontend can show
  recipe.recipe.source = { platform, author, thumbnail, url };
  return json(200, recipe);
};

// ── recipe brain (same logic as parse-recipe.js) ──
async function parseRecipe({ caption, mode }) {
  const schema = `Return ONLY valid JSON (no markdown/backticks) in this shape:
{"title":"string","servings":number,"totalMinutes":number,"cuisine":"string",
"ingredients":[{"name":"string","amount":number|null,"unit":"string"}],
"steps":[{"text":"string","timestamp":number|null}],
"nutrition":{"kcal":number,"protein":number,"carbs":number,"fat":number},
"confidence":"high"|"medium"|"low"}`;

  const system = mode === "visual"
    ? `You are a recipe expert. The caption below describes a food video with no explicit recipe. Recreate a plausible recipe. Amounts are estimates, set confidence "low", all timestamps null.\n\n${schema}`
    : `You are a recipe extraction engine. Turn the caption below into a clean structured recipe using its real quantities and steps. Estimate missing details and lower confidence accordingly.\n\n${schema}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        system,
        messages: [{ role: "user", content: `CAPTION:\n${caption}\n\nExtract the recipe as JSON.` }],
      }),
    });
    if (!res.ok) return { error: "AI request failed", status: 502, detail: (await res.text()).slice(0, 300) };

    const data = await res.json();
    const raw = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    const clean = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();

    let recipe;
    try { recipe = JSON.parse(clean); }
    catch { return { error: "AI returned unparseable recipe", status: 422, raw: clean.slice(0, 500) }; }

    if (!recipe.title || !Array.isArray(recipe.ingredients) || !Array.isArray(recipe.steps)) {
      return { error: "Recipe missing required fields", status: 422, recipe };
    }
    return { recipe };
  } catch (err) {
    return { error: "Unexpected server error", status: 500, detail: String(err).slice(0, 200) };
  }
}

// ── helpers ──
function detectPlatform(url) {
  if (/tiktok\.com/i.test(url)) return "tiktok";
  if (/instagram\.com/i.test(url)) return "instagram";
  return null;
}
function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}
function json(statusCode, obj) {
  return { statusCode, headers: { "content-type": "application/json", ...cors() }, body: JSON.stringify(obj) };
}

/*
─────────────────────────────────────────────────────────────────────────────
NOTES
─────────────────────────────────────────────────────────────────────────────
• TikTok oEmbed (https://www.tiktok.com/oembed?url=...) is free, needs no key,
  and returns the caption in "title". This is the safe, official route.

• Instagram's public oEmbed is more restricted now (often needs a Facebook app
  token for reliable results). Start with TikTok to prove the flow; add IG once
  you have a Facebook developer app + token.

• When a caption doesn't contain a real recipe, this falls back to "visual"
  (recreate) mode. Later, for spoken-only recipes, add a Whisper transcript step
  and pass BOTH caption + transcript to the model for the best result.

• Test:
  curl -X POST http://localhost:8888/.netlify/functions/from-link \
    -H "content-type: application/json" \
    -d '{"url":"https://www.tiktok.com/@somechef/video/1234567890"}'
─────────────────────────────────────────────────────────────────────────────
*/
