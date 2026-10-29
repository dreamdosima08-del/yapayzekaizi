/**
 * YapayZekaİzi — Görsel Derin Analiz (Cloudflare Worker)
 * Tarayıcıdan gelen (küçültülmüş) görseli Sightengine "genai" modeline iletir.
 * Görsel SAKLANMAZ; ne Worker'da ne KV'de tutulur. KV'de yalnızca sayaçlar durur.
 *
 * Maliyet koruması: Sightengine ücretsiz paketi aylık 2.000 işlem.
 * Kota görsel sayısıyla değil, Sightengine'in her cevapta bildirdiği gerçek
 * "operations" değeriyle sayılır. Sınırlar aşılırsa istek Sightengine'e hiç gitmez.
 */

const VERSION = "1.0";
const ALLOWED_ORIGINS = ["https://yapayzekaizi.com", "https://www.yapayzekaizi.com"];
const MAX_BYTES = 4 * 1024 * 1024;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];

const GENERATOR_NAMES = {
  cosmos: "NVIDIA Cosmos", dalle: "DALL·E", firefly: "Adobe Firefly", flux: "Flux", gan: "GAN (eski nesil)",
  gpt: "ChatGPT / GPT görsel", grok: "Grok", hidream: "HiDream", higgsfield: "Higgsfield", hunyuan: "Hunyuan",
  ideogram: "Ideogram", kling: "Kling", imagen: "Google Imagen / Gemini", krea: "Krea", mai: "Microsoft MAI",
  midjourney: "Midjourney", qwen: "Qwen", recraft: "Recraft", reve: "Reve", seedream: "Seedream",
  stable_diffusion: "Stable Diffusion", vidu: "Vidu", wan: "Wan", z_image: "Z-Image", other: "Diğer bir üretici",
};

function cors(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin",
  };
}
const json = (obj, status, origin) => new Response(JSON.stringify(obj), { status, headers: cors(origin) });

function limits(env) {
  const monthly = parseInt(env.MONTHLY_OPS || "1900", 10);   // 2.000'den biraz az: güvenlik payı
  const daily = parseInt(env.DAILY_OPS || "60", 10);          // ≈ aylık / 31
  const perUser = parseInt(env.PER_USER_DAILY || "3", 10);    // kişi başı günlük derin analiz
  return { monthly, daily, perUser };
}
const today = () => new Date().toISOString().slice(0, 10);    // UTC (TR saatiyle 03:00'te sıfırlanır)
const thisMonth = () => new Date().toISOString().slice(0, 7);

async function userKey(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  // IP saklanmaz; günlük değişen tuzla özetlenir, 2 gün sonra kendiliğinden silinir.
  const data = new TextEncoder().encode(ip + "|" + today() + "|yzi");
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].slice(0, 10).map(b => b.toString(16).padStart(2, "0")).join("");
}
const num = async (kv, key) => parseInt((await kv.get(key)) || "0", 10);

async function quotaState(env, request) {
  const L = limits(env);
  const kv = env.KOTA;
  const [dayOps, monthOps, perOp, uKey] = await Promise.all([
    num(kv, "ops:d:" + today()), num(kv, "ops:m:" + thisMonth()), num(kv, "ops:per"), userKey(request),
  ]);
  const userCount = await num(kv, "u:" + today() + ":" + uKey);
  const est = perOp || 5; // görsel başına tahmini işlem (ilk cevaptan sonra gerçeği öğrenilir)
  return { L, dayOps, monthOps, est, uKey, userCount,
    imagesLeftToday: Math.max(0, Math.floor(Math.min(L.daily - dayOps, L.monthly - monthOps) / est)),
    userLeft: Math.max(0, L.perUser - userCount) };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(origin) });

    const configured = !!(env.SIGHTENGINE_API_USER && env.SIGHTENGINE_API_SECRET);

    if (request.method === "GET") {
      let q = null;
      if (env.KOTA) { const s = await quotaState(env, request); q = { imagesLeftToday: s.imagesLeftToday, userLeft: s.userLeft }; }
      return json({ status: "YapayZekaİzi görsel analiz API çalışıyor.", version: VERSION, configured, kv: !!env.KOTA, quota: q }, 200, origin);
    }
    if (request.method !== "POST") return json({ error: "POST gerekli" }, 405, origin);
    if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: "Bu servis yalnızca yapayzekaizi.com üzerinden kullanılabilir." }, 403, origin);
    if (!configured || !env.KOTA) return json({ error: "Derin analiz şu an yapılandırılmamış." }, 503, origin);

    const type = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
    if (!ALLOWED_TYPES.includes(type)) return json({ error: "Desteklenmeyen dosya türü. JPG, PNG veya WebP gönderin." }, 415, origin);
    const len = parseInt(request.headers.get("Content-Length") || "0", 10);
    if (len > MAX_BYTES) return json({ error: "Görsel çok büyük (en fazla 4 MB)." }, 413, origin);

    // ---- Kota kontrolü (Sightengine'e gitmeden önce) ----
    const s = await quotaState(env, request);
    if (s.userCount >= s.L.perUser) return json({ error: "Bugünkü kişisel derin analiz hakkınız doldu (günde " + s.L.perUser + "). Yarın tekrar deneyebilirsiniz.", reason: "kisi" }, 429, origin);
    if (s.monthOps + s.est > s.L.monthly) return json({ error: "Bu ayın ücretsiz derin analiz kotası doldu. Etiket kontrolü çalışmaya devam ediyor.", reason: "aylik" }, 429, origin);
    if (s.dayOps + s.est > s.L.daily) return json({ error: "Bugünün ücretsiz derin analiz kotası doldu. Yarın tekrar deneyebilirsiniz; etiket kontrolü çalışmaya devam ediyor.", reason: "gunluk" }, 429, origin);

    const buf = await request.arrayBuffer();
    if (buf.byteLength === 0) return json({ error: "Boş dosya." }, 400, origin);
    if (buf.byteLength > MAX_BYTES) return json({ error: "Görsel çok büyük (en fazla 4 MB)." }, 413, origin);

    const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
    const form = new FormData();
    form.append("media", new File([buf], "gorsel." + ext, { type }));
    form.append("models", "genai");
    form.append("api_user", env.SIGHTENGINE_API_USER.trim());
    form.append("api_secret", env.SIGHTENGINE_API_SECRET.trim());

    let data;
    try {
      const r = await fetch("https://api.sightengine.com/1.0/check.json", { method: "POST", body: form });
      data = await r.json();
    } catch (e) {
      return json({ error: "Analiz servisine şu an ulaşılamıyor. Biraz sonra tekrar deneyin." }, 502, origin);
    }
    if (!data || data.status !== "success" || !data.type || typeof data.type.ai_generated !== "number") {
      const msg = data && data.error && data.error.message ? data.error.message : "bilinmeyen hata";
      return json({ error: "Analiz servisi bu görseli işleyemedi.", detail: msg }, 502, origin);
    }

    // ---- Gerçek işlem sayısını kaydet ----
    const ops = Math.max(1, parseInt(data.request && data.request.operations, 10) || s.est);
    const kv = env.KOTA;
    await Promise.all([
      kv.put("ops:d:" + today(), String(s.dayOps + ops), { expirationTtl: 172800 }),
      kv.put("ops:m:" + thisMonth(), String(s.monthOps + ops), { expirationTtl: 3456000 }),
      kv.put("u:" + today() + ":" + s.uKey, String(s.userCount + 1), { expirationTtl: 172800 }),
      ops !== s.est ? kv.put("ops:per", String(ops)) : Promise.resolve(),
    ]);

    const gens = Object.entries(data.type.ai_generators || {})
      .filter(([, v]) => typeof v === "number" && v >= 0.10)
      .sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, v]) => ({ name: GENERATOR_NAMES[k] || k, score: Math.round(v * 100) }));

    const leftAfter = Math.max(0, Math.floor(Math.min(s.L.daily - s.dayOps - ops, s.L.monthly - s.monthOps - ops) / ops));
    return json({
      ok: true,
      aiProbability: Math.round(data.type.ai_generated * 100),
      generators: gens,
      quota: { imagesLeftToday: leftAfter, userLeft: Math.max(0, s.L.perUser - s.userCount - 1) },
      version: VERSION,
    }, 200, origin);
  },
};
