// netlify/functions/parse-recipe.js
//
// THE CORE OF THE APP.
// Takes the text we extracted from a video (spoken transcript + on-screen caption)
// and returns a clean, structured recipe as JSON — exactly the shape the frontend renders.
//
// This function does NOT fetch the video. That is a separate step (see notes at bottom).
// It only does the "make sense of the text → recipe" part, which is the real magic
// and works no matter where the text came from.
//
// Deploy: drop this in netlify/functions/ and set ANTHROPIC_API_KEY in Netlify env vars.
// Call it from the frontend with a POST { transcript, caption, mode }.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-haiku-4-5-20251001"; // cheap + fast, perfect for structured extraction

// The JSON shape we want back — matches what the Reelicious frontend already expects.
const RECIPE_SCHEMA_HINT = `
Return ONLY valid JSON (no markdown, no backticks, no commentary) in exactly this shape:
{
  "title": "string — short, appetising recipe name",
  "servings": number,           // how many people it serves (best guess if unstated)
  "totalMinutes": number,       // rough total time in minutes
  "cuisine": "string",          // e.g. "Italian", "Korean" — best guess
  "ingredients": [
    { "name": "string", "amount": number|null, "unit": "string" }
    // amount is null for things like "salt to taste"; unit is "" for whole items (e.g. 2 eggs)
  ],
  "steps": [
    { "text": "string — one clear instruction", "timestamp": number|null }
    // timestamp = seconds into the video this step happens, or null if unknown
  ],
  "nutrition": { "kcal": number, "protein": number, "carbs": number, "fat": number },
  "confidence": "high" | "medium" | "low"  // how sure you are the recipe is accurate
}
`;

exports.handler = async (event) => {
  // CORS + method guard
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors(), body: "" };
  }
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }
  if (!ANTHROPIC_API_KEY) {
    return json(500, { error: "Server missing ANTHROPIC_API_KEY" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const transcript = (body.transcript || "").trim();
  const caption = (body.caption || "").trim();
  const mode = body.mode === "visual" ? "visual" : "recipe";

  if (!transcript && !caption && mode !== "visual") {
    return json(400, { error: "Nothing to parse — provide transcript or caption." });
  }

  // Build the instruction depending on whether we have real recipe text
  // or we're recreating from a food-only video.
  const system =
    mode === "visual"
      ? `You are a recipe expert. The user watched a short food video that has NO spoken recipe — ` +
        `just footage of a finished dish. From the description of what the dish looks like, ` +
        `RECREATE a plausible recipe. Amounts are your best estimate. Set "confidence" to "low" ` +
        `and never invent a video timestamp (all timestamps must be null).\n\n` +
        RECIPE_SCHEMA_HINT
      : `You are a recipe extraction engine. Convert the creator's spoken transcript and on-screen ` +
        `caption into a clean, structured recipe. Use the creator's real quantities and steps — ` +
        `do not swap in a generic web recipe. If the transcript mentions timings, map each step to ` +
        `its approximate timestamp in seconds. If a detail is genuinely missing, make a sensible ` +
        `estimate and lower "confidence".\n\n` +
        RECIPE_SCHEMA_HINT;

  const userContent =
    mode === "visual"
      ? `The video shows this dish:\n\n${caption || transcript || "a plated dish"}\n\n` +
        `Recreate the most likely recipe as JSON.`
      : `TRANSCRIPT (spoken by the creator):\n${transcript || "(none)"}\n\n` +
        `CAPTION (on-screen / description text):\n${caption || "(none)"}\n\n` +
        `Extract the recipe as JSON.`;

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
        messages: [{ role: "user", content: userContent }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return json(502, { error: "AI request failed", detail: errText.slice(0, 500) });
    }

    const data = await res.json();
    const raw = (data.content || [])
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();

    // Strip accidental code fences, then parse.
    const clean = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();

    let recipe;
    try {
      recipe = JSON.parse(clean);
    } catch {
      return json(422, {
        error: "AI returned unparseable recipe",
        raw: clean.slice(0, 800),
      });
    }

    // Minimal sanity check so the frontend never gets garbage.
    if (!recipe.title || !Array.isArray(recipe.ingredients) || !Array.isArray(recipe.steps)) {
      return json(422, { error: "Recipe missing required fields", recipe });
    }

    return json(200, { recipe });
  } catch (err) {
    return json(500, { error: "Unexpected server error", detail: String(err).slice(0, 300) });
  }
};

// ---- helpers ----
function cors() {
  return {
    "Access-Control-Allow-Origin": "*", // tighten to your domain in production
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}
function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "content-type": "application/json", ...cors() },
    body: JSON.stringify(obj),
  };
}

/*
─────────────────────────────────────────────────────────────────────────────
WHERE THE TEXT COMES FROM (the step BEFORE this function)
─────────────────────────────────────────────────────────────────────────────
This function is the brain. It needs `transcript` and/or `caption` as input.
Getting those from a TikTok/IG URL is a separate service you build next:

  1. SAFEST (recommended to start): the CAPTION route.
     Many recipe reels put the full recipe in the caption. You can read a post's
     caption via the official oEmbed / Graph API (IG) without downloading video.
     Pass that caption in as `caption`, leave transcript empty. Cheapest + safest.

  2. TRANSCRIPT route (more powerful, more sensitive):
     - get the video's audio, run it through Whisper (OpenAI audio API),
     - pass the result as `transcript`.
     Fetching the raw audio from TikTok/IG is the legally grey part — confirm
     each platform's ToS before shipping. Do NOT re-host their video.

  3. VISUAL route (food-only videos):
     - grab a few frames, send them to Claude's vision API to identify the dish,
     - pass the dish description in as `caption` with mode:"visual".

Build route #1 first — it proves the whole product with the least risk.
─────────────────────────────────────────────────────────────────────────────
*/
