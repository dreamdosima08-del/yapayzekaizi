/**
 * YapayZekaİzi — Görsel Derin Analiz (Cloudflare Worker)
 * Tarayıcıdan gelen (küçültülmüş) görseli Sightengine "genai" modeline iletir.
 * Görsel SAKLANMAZ; ne Worker'da ne KV'de tutulur. KV'de yalnızca sayaçlar durur.
 *
 * Maliyet koruması: Sightengine ücretsiz paketi aylık 2.000 işlem.
 * Kota görsel sayısıyla değil, Sightengine'in her cevapta bildirdiği gerçek
 * "operations" değeriyle sayılır. Sınırlar aşılırsa istek Sightengine'e hiç gitmez.
 */

import { DurableObject } from "cloudflare:workers";

const VERSION = "1.1";
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
    "Access-Control-Allow-Headers": "Content-Type, X-Odul",
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
  const perUserReward = parseInt(env.REWARD_USER_DAILY || "10", 10); // uygulamada reklam izleyerek
  return { monthly, daily, perUser, perUserReward };
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
  const [userCount, rewardCount] = await Promise.all([
    num(kv, "u:" + today() + ":" + uKey), num(kv, "ur:" + today() + ":" + uKey),
  ]);
  const est = perOp || 5; // görsel başına tahmini işlem (ilk cevaptan sonra gerçeği öğrenilir)
  return { L, dayOps, monthOps, est, uKey, userCount, rewardCount,
    rewardLeft: Math.max(0, L.perUserReward - rewardCount),
    imagesLeftToday: Math.max(0, Math.floor(Math.min(L.daily - dayOps, L.monthly - monthOps) / est)),
    userLeft: Math.max(0, L.perUser - userCount) };
}

/* ---------- Ödüllü reklam: AdMob sunucu tarafı doğrulama (SSV) ----------
 * Uygulama reklamı gösterirken rastgele bir "fiş" (nonce) verir. Reklam sonuna kadar
 * izlenince Google, imzalı bir istekle /odul adresine bu fişi bildirir. İmza Google'ın
 * açık anahtarlarıyla doğrulanır ve fiş kasaya (Durable Object) yazılır. Analiz isteği
 * fişi getirirse ve kasada varsa tek seferlik kullanılır. */
const FIS_RE = /^[a-f0-9-]{20,64}$/i;
const b64ToBytes = (b64) => {
  let s = b64.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
};
function derToRaw(der) {
  // ECDSA DER (30 .. 02 r 02 s) -> r||s (her biri 32 bayt)
  let i = 2; if (der[1] & 0x80) i = 2 + (der[1] & 0x7f);
  const part = () => { if (der[i++] !== 0x02) throw new Error("DER"); const len = der[i++]; const v = der.slice(i, i + len); i += len;
    let x = v; while (x.length > 32 && x[0] === 0) x = x.slice(1); const out = new Uint8Array(32); out.set(x, 32 - x.length); return out; };
  const r = part(), s = part(); const raw = new Uint8Array(64); raw.set(r, 0); raw.set(s, 32); return raw;
}
async function admobKeys() {
  const r = await fetch("https://www.gstatic.com/admob/reward/verifier-keys.json", { cf: { cacheTtl: 86400, cacheEverything: true } });
  const d = await r.json(); return d.keys || [];
}
async function verifySSV(url) {
  const q = url.search.slice(1);
  const i = q.indexOf("&signature=");
  if (i < 0) return null;
  const message = q.slice(0, i);
  const tail = new URLSearchParams(q.slice(i + 1));
  const sig = tail.get("signature"), keyId = tail.get("key_id");
  if (!sig || !keyId) return null;
  const key = (await admobKeys()).find(k => String(k.keyId) === String(keyId));
  if (!key) return null;
  const pub = await crypto.subtle.importKey("spki", b64ToBytes(key.base64), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, derToRaw(b64ToBytes(sig)), new TextEncoder().encode(message));
  return ok ? new URLSearchParams(message) : null;
}
const kasa = (env) => env.ODUL.get(env.ODUL.idFromName("kasa"));

export class OdulKasasi extends DurableObject {
  async ekle(fis) {
    const now = Date.now();
    await this.ctx.storage.put("f:" + fis, now);
    if (Math.random() < 0.1) { // eski fişleri temizle (2 saatten eski)
      const all = await this.ctx.storage.list({ prefix: "f:" });
      const old = [...all].filter(([, t]) => now - t > 7200000).map(([k]) => k);
      if (old.length) await this.ctx.storage.delete(old.slice(0, 128));
    }
    return true;
  }
  async kullan(fis) {
    const t = await this.ctx.storage.get("f:" + fis);
    if (!t || Date.now() - t > 7200000) return false;
    await this.ctx.storage.delete("f:" + fis);
    return true;
  }
}

async function fisKullan(env, fis) {
  if (!env.ODUL || !fis || !FIS_RE.test(fis)) return false;
  // Google'ın bildirimi birkaç saniye gecikebilir: kısa aralıklarla bekle.
  for (let k = 0; k < 6; k++) {
    try { if (await kasa(env).kullan(fis)) return true; } catch (e) { /* tekrar dene */ }
    await new Promise(r => setTimeout(r, 1200));
  }
  return false;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(origin) });

    const configured = !!(env.SIGHTENGINE_API_USER && env.SIGHTENGINE_API_SECRET);

    const url = new URL(request.url);
    if (url.pathname === "/odul") {
      // AdMob sunucu doğrulama geri çağrısı (Google'dan gelir; Origin yoktur)
      if (!url.searchParams.has("signature")) return new Response("ok", { status: 200 }); // AdMob'un adres testi
      try {
        const p = await verifySSV(url);
        if (!p) return new Response("imza gecersiz", { status: 400 });
        const fis = p.get("custom_data") || "";
        if (FIS_RE.test(fis) && env.ODUL) await kasa(env).ekle(fis);
        return new Response("ok", { status: 200 });
      } catch (e) {
        return new Response("hata", { status: 500 });
      }
    }

    if (request.method === "GET") {
      let q = null;
      if (env.KOTA) { const s = await quotaState(env, request); q = { imagesLeftToday: s.imagesLeftToday, userLeft: s.userLeft, rewardLeft: s.rewardLeft }; }
      return json({ status: "YapayZekaİzi görsel analiz API çalışıyor.", version: VERSION, configured, kv: !!env.KOTA, odul: !!env.ODUL, quota: q }, 200, origin);
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
    const fis = request.headers.get("X-Odul") || "";
    let odullu = false;
    if (fis) {
      if (s.rewardCount >= s.L.perUserReward) return json({ error: "Bugün reklamla alınabilecek derin analiz sınırına ulaştınız (günde " + s.L.perUserReward + "). Yarın tekrar deneyebilirsiniz.", reason: "odul-kisi" }, 429, origin);
      odullu = await fisKullan(env, fis);
    }
    if (!odullu && s.userCount >= s.L.perUser) return json({ error: "Bugünkü kişisel derin analiz hakkınız doldu (günde " + s.L.perUser + "). Yarın tekrar deneyebilirsiniz.", reason: "kisi" }, 429, origin);
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
      odullu
        ? kv.put("ur:" + today() + ":" + s.uKey, String(s.rewardCount + 1), { expirationTtl: 172800 })
        : kv.put("u:" + today() + ":" + s.uKey, String(s.userCount + 1), { expirationTtl: 172800 }),
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
      odullu,
      quota: { imagesLeftToday: leftAfter,
        userLeft: Math.max(0, s.L.perUser - s.userCount - (odullu ? 0 : 1)),
        rewardLeft: Math.max(0, s.L.perUserReward - s.rewardCount - (odullu ? 1 : 0)) },
      version: VERSION,
    }, 200, origin);
  },
};
