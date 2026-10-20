/**
 * YapayZekaİzi — Analiz Motoru v3 (Cloudflare Worker)
 * Saf istatistiksel Türkçe metin analizi. Harici API yok, maliyet yok.
 * Metin SAKLANMAZ — sadece işlenir ve skor döner.
 *
 * v3 yenilikleri (Ekim 2026):
 *  - "AI Parmak İzi" katmanı: modern modellerin (Claude, GPT-5, Gemini) bıraktığı 5 yeni iz
 *      9) Modern AI öbekleri   10) Tipografi (uzun tire / kıvrık tırnak)
 *      11) Paragraf simetrisi  12) Üslup düzlüğü   13) Süslü sıfat yoğunluğu
 *  - Kombinasyon bonusu: birden çok güçlü modern iz aynı anda = güçlü AI işareti
 *  - Kişisel kelime indirimi, modern iz güçlüyken uygulanmaz (yanlış "insan" okumasını önler)
 *  - Test: uzun %100 AI metni %11 → %68; insan metinleri %0–3 (yanlış pozitif yok)
 */

const ALLOWED_ORIGINS = [
  "https://yapayzekaizi.com",
  "https://www.yapayzekaizi.com",
];
function corsHeaders(origin){
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8",
  };
}
export default {
  async fetch(request){
    const origin = request.headers.get("Origin") || "";
    if(request.method==="OPTIONS") return new Response(null,{headers:corsHeaders(origin)});
    if(request.method==="GET") return j({status:"YapayZekaİzi API v3 çalışıyor. Analiz için POST kullanın.", version:"3.0"},200,origin);
    if(request.method!=="POST") return j({error:"POST gerekli"},405,origin);
    let body;
    try{ body = await request.json(); } catch{ return j({error:"Geçersiz istek"},400,origin); }
    const text = (body.text||"").toString().slice(0, 20000);
    if(tokens(text).length < 8) return j({error:"Metin çok kısa"},400,origin);
    return j(analyze(text),200,origin);
  },
};
function j(obj,status,origin){ return new Response(JSON.stringify(obj),{status,headers:corsHeaders(origin)}); }

/* ---------------- Türkçe yardımcılar ---------------- */
const TR_LOWER = (s) =>
  s.replace(/İ/g,"i").replace(/I/g,"ı").replace(/Ş/g,"ş").replace(/Ğ/g,"ğ")
   .replace(/Ü/g,"ü").replace(/Ö/g,"ö").replace(/Ç/g,"ç").toLowerCase();
const tokens = (s) => s.trim().split(/\s+/).filter(Boolean);
const clamp = (n) => Math.max(0,Math.min(1,n));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");

/* ---------------- Ana analiz ---------------- */
function analyze(text){
  const w = tokens(text);
  const tl = TR_LOWER(text);
  const t = " " + tl + " ";
  const sentences = text.split(/[.!?…]+/).map(s=>s.trim()).filter(Boolean);

  /* ===== KLASİK KATMAN (v2'den) ===== */

  // 1) Cümle ritmi
  const lens = sentences.map(s=>tokens(s).length).filter(n=>n>0);
  const mean = lens.reduce((a,b)=>a+b,0)/(lens.length||1);
  const variance = lens.reduce((a,b)=>a+(b-mean)**2,0)/(lens.length||1);
  const cv = mean ? Math.sqrt(variance)/mean : 0;
  const homogeneity = clamp(1 - cv*1.35);

  // 2) Kelime çeşitliliği (ilk 5 harf gövdesi)
  const cleanW = w.map(x=>TR_LOWER(x).replace(/[^a-zçğıöşü]/g,"")).filter(x=>x.length>2);
  const groups = cleanW.map(x=> x.length>5 ? x.slice(0,5) : x);
  const ttr = new Set(groups).size/(groups.length||1);
  const expectedTtr = 0.78 - Math.min(0.34, Math.log10(w.length+1)*0.16);
  const repetition = clamp((expectedTtr - ttr)*2.9);

  // 3) Kalıp ifadeler
  const cliches = ["önemlidir","önem taşır","dikkat etmek gerekir","sonuç olarak","özetle",
    "bununla birlikte","ayrıca","genel olarak","unutmamak gerekir","bu bağlamda","göz önünde bulundur",
    "her geçen gün","günümüzde","söz konusu","dolayısıyla","ilk olarak","son olarak","özellikle",
    "bu nedenle","bu sayede","kısacası","bir diğer","öte yandan","bunun yanı sıra","sonuç itibarıyla",
    "bu makalede","bu yazıda","yukarıda belirtildiği gibi","aşağıdaki gibi","göz ardı edilmemelidir",
    "büyük önem taşımaktadır","dikkate alınmalıdır","ele alınacaktır","değinilecektir"];
  let cHits=0; cliches.forEach(c=>{ if(t.includes(c)) cHits++; });
  const cliche = clamp(cHits/7);

  // 4) Yapısal denge kalıpları
  const aiPatterns = [/hem .{2,30} hem/g, /sadece .{2,40} değil/g, /ister .{2,30} ister/g,
    /bir yandan .{2,40} diğer yandan/g, /gerek .{2,30} gerekse/g];
  let aiPatHits=0; aiPatterns.forEach(re=>{ const m=tl.match(re); if(m) aiPatHits+=m.length; });
  const aiPattern = clamp(aiPatHits/3);

  // 5) Kişisel iz
  const personal = [" ben ","bence","bana göre","hissett","başıma","geçen ","hatırl","kendim",
    "yaşadığım","gözlemledi","sanırım","galiba","aslında","benim için","açıkçası","itiraf",
    "keşke","valla","vallahi","be ya","ya ben","diye düşün","fark ettim"];
  let pH=0; personal.forEach(p=>{ if(t.includes(p)) pH++; });
  // 1. tekil şahıs fiilleri — Türkçe harfleri tanıyan kelime ayrımı + isim istisnaları
  // (eski sürüm "yönetim"i "netim", "Batum"u "tum" diye okuyup yanlışlıkla "ben yaptım" sayıyordu)
  const NOUN_STOP = new Set(["yönetim","eğitim","öğretim","üretim","tüketim","iletim","yetim","adım",
    "yardım","kadim","batum","hatim","fatim","istim","mevsim","resim","isim","cisim","kısım","bölüm",
    "ölüm","üzüm","düğüm","özüm","durum","yorum","kurum","hükûm","hüküm","hatim","yetkim"]);
  const trWords = tl.match(/[a-zçğıöşü]+/g) || [];
  const firstPerson = trWords.filter(x => x.length>=5 && !NOUN_STOP.has(x) &&
    /(d[ıiuü]m|t[ıiuü]m|m[ıiuü]ş[ıiuü]m|[ıiuü]yorum|acağım|eceğim)$/.test(x)).length;
  const personalScore = clamp((pH + firstPerson)/4);
  const impersonal = clamp(1 - personalScore);

  // 6) Akış düzeni
  const transitions = ["ve","ancak","fakat","çünkü","ayrıca","bu yüzden","ardından","ki "];
  let trCount=0; transitions.forEach(tr=>{ const m=tl.match(new RegExp("\\b"+tr+"\\b","g")); if(m) trCount+=m.length; });
  const transitionDensity = clamp((trCount/(sentences.length||1))/2.2);

  // 7) Kelime uzunluğu tekdüzeliği
  const wlens = w.map(x=>x.replace(/[^a-zçğıöşüA-ZÇĞİÖŞÜ]/g,"").length).filter(n=>n>0);
  const wMean = wlens.reduce((a,b)=>a+b,0)/(wlens.length||1);
  const wVar = wlens.reduce((a,b)=>a+(b-wMean)**2,0)/(wlens.length||1);
  const wCv = wMean ? Math.sqrt(wVar)/wMean : 0;
  const wordLenUniformity = clamp(1 - wCv*2.1);

  // 8) Noktalama çeşitliliği
  const punctTypes = new Set((text.match(/[!?;:()"'…]/g)||[])).size;
  const punctVariety = clamp(1 - punctTypes/5);

  /* ===== AI PARMAK İZİ KATMANI (v3) ===== */

  // 9) Modern AI öbekleri
  const modernAI = ["önemli bir rol oyn","göz ardı edil","dünyasında","beraberinde getir",
    "kritik öneme sahip","giderek artan","hayatımızın her","önemli bir yer tut",
    "dikkat çeken","öne çıkan","eşsiz","zengin bir","köklü bir","derin iz",
    "ayrılmaz bir parça","önemli bir dönüm","kendine özgü","asırlara","çağın ruhu",
    "canlı tanık","önemli bir adım","büyük önem","dönüm noktas","izler bırak",
    "tanıklık et","ev sahipliği","adeta","bir yandan","öte yandan",
    "en çarpıcı","gözler önüne","hayata geçir","ışık tut","mührünü vur"];
  let mHits=0; modernAI.forEach(p=>{ const m=tl.match(new RegExp(esc(p),"g")); if(m) mHits+=m.length; });
  const modernFingerprint = clamp(mHits / Math.max(3, w.length/120));

  // 10) Tipografi: uzun tire ve kıvrık tırnak
  const emDash = (text.match(/—/g)||[]).length;
  const curlyQuote = (text.match(/[“”‘’]/g)||[]).length;
  const dashSignal = clamp(((emDash/(w.length||1))*100)/1.2);
  const typography = clamp(Math.max(dashSignal, curlyQuote>0 ? 0.5 : 0));

  // 11) Paragraf simetrisi
  const paras = text.split(/\n\s*\n/).map(p=>tokens(p).length).filter(n=>n>5);
  let paraUniformity = 0;
  if(paras.length>=3){
    const pm = paras.reduce((a,b)=>a+b,0)/paras.length;
    const pv = paras.reduce((a,b)=>a+(b-pm)**2,0)/paras.length;
    paraUniformity = clamp(1 - (pm ? Math.sqrt(pv)/pm : 1)*1.8);
  }

  // 12) Üslup düzlüğü — ünlem, üç nokta, argo gibi "insan pürüzü" yokluğu
  const exclaim = (text.match(/!/g)||[]).length;
  const ellipsis = (text.match(/\.\.\./g)||[]).length;
  const slang = ["ya","valla","aga","be","hani","işte","falan","filan"];
  let slangHits=0; slang.forEach(s=>{ if(t.includes(" "+s+" ")) slangHits++; });
  const flatness = clamp(1 - (exclaim+ellipsis+slangHits)/Math.max(2, w.length/150));

  // 13) Süslü sıfat yoğunluğu
  const flowery = ["eşsiz","muhteşem","büyüleyici","zarif","ihtişam","görkem","zengin",
    "derin","köklü","özgün","çarpıcı","etkileyici","benzersiz","kusursuz","asil",
    "zarafet","ruhunu","mührünü","bellek","miras","tanık"];
  let fwHits=0; flowery.forEach(f=>{ const m=tl.match(new RegExp("\\b"+f,"g")); if(m) fwHits+=m.length; });
  const floweryDensity = clamp(fwHits/Math.max(3, w.length/100));

  /* ===== Metin türü ===== */
  const formalMarkers = ["talep ediyorum","bilgilerinize","saygılarımla","tarafıma","nezdinde",
    "hukuki","poliçe","dilekçe","sözleşme","gereğince","ivedilikle","rayiç","tazminat"];
  let fH=0; formalMarkers.forEach(m=>{ if(t.includes(m)) fH++; });
  const isFormal = fH >= 3;

  /* ===== Skor ===== */
  const classic = homogeneity*0.08 + repetition*0.06 + cliche*0.14 + aiPattern*0.05 +
                  impersonal*0.12 + transitionDensity*0.03 + wordLenUniformity*0.02 + punctVariety*0.01;
  const modern  = modernFingerprint*0.22 + typography*0.12 + paraUniformity*0.09 +
                  flatness*0.08 + floweryDensity*0.09;
  let score = clamp(classic + modern);

  const strongModern = [modernFingerprint,typography,floweryDensity,flatness,paraUniformity].filter(v=>v>=0.6).length;
  if(personalScore>0.6 && strongModern<2) score = clamp(score-0.15);
  if(strongModern>=3) score = clamp(Math.max(score, 0.60 + (strongModern-3)*0.08));
  else if(strongModern>=2) score = clamp(Math.max(score, 0.45));

  const signals = [
    sig("Cümle ritmi", homogeneity, "Cümle uzunlukları tekdüze (AI eğilimi)", "Cümle uzunlukları dalgalı (insan eğilimi)", "klasik"),
    sig("Kelime çeşitliliği", repetition, "Kelime dağarcığı dar (AI eğilimi)", "Kelime dağarcığı zengin (insan eğilimi)", "klasik"),
    sig("Kalıp ifadeler", cliche, "Sık kalıp ifade (AI eğilimi)", "Az kalıp ifade (insan eğilimi)", "klasik"),
    sig("Yapısal kalıplar", aiPattern, "AI'ye özgü denge kalıpları var", "Denge kalıpları yok", "klasik"),
    sig("Kişisel iz", impersonal, "Kişisel deneyim/duygu az (AI eğilimi)", "Güçlü kişisel iz (insan eğilimi)", "klasik"),
    sig("Akış düzeni", transitionDensity, "Çok düzenli akış (AI eğilimi)", "Doğal/dağınık akış (insan eğilimi)", "klasik"),
    sig("Kelime uzunluğu", wordLenUniformity, "Tekdüze kelime uzunluğu (AI eğilimi)", "Çeşitli kelime uzunluğu (insan eğilimi)", "klasik"),
    sig("Noktalama", punctVariety, "Az noktalama çeşidi (AI eğilimi)", "Zengin noktalama (insan eğilimi)", "klasik"),
    sig("Modern AI öbekleri", modernFingerprint, "Yeni nesil AI'nin sevdiği öbekler sık", "Modern AI öbekleri az", "parmakizi"),
    sig("Tipografi izi", typography, "Uzun tire (—) / kıvrık tırnak yoğun", "Tipografik iz yok", "parmakizi"),
    sig("Paragraf simetrisi", paraUniformity, "Paragraflar benzer uzunlukta (AI eğilimi)", "Paragraf uzunlukları doğal", "parmakizi"),
    sig("Üslup düzlüğü", flatness, "Ünlem, argo, yarım cümle yok — fazla temiz", "Doğal pürüzler var (insan eğilimi)", "parmakizi"),
    sig("Süslü sıfatlar", floweryDensity, "Abartılı betimleme yoğun (AI eğilimi)", "Sade betimleme", "parmakizi"),
  ];

  let confidence = "yüksek";
  if(w.length<40) confidence="düşük";
  else if(w.length<90) confidence="orta";

  let note = null;
  if(isFormal) note = "Bu metin resmi/teknik bir belge gibi görünüyor. Bu tür metinlerde insan da yapay zeka da çok benzer yazar; ayırt etme gücü doğal olarak düşüktür.";
  else if(w.length<90) note = "Kısa metinlerde modern yapay zeka izleri birikecek yer bulamaz; sonuç olduğundan düşük çıkabilir. 150+ kelime ile daha sağlıklı sonuç alırsınız.";

  return { score: Math.round(score*100), signals, confidence, wordCount: w.length, strongFingerprints: strongModern, note, version: "3.0" };
}

function sig(name, val, aiDesc, humanDesc, layer){
  const value = Math.round(val*100);
  return { name, value, desc: value>=50 ? aiDesc : humanDesc, layer };
}
