// Canlı motora bilinen metinleri gönderir, skorların beklenen aralıkta olduğunu doğrular.
// Kullanım: node smoke-test.mjs <worker-url>
import { readFileSync } from "fs";
const url = process.argv[2];
const samples = JSON.parse(readFileSync(new URL("./test-samples.json", import.meta.url), "utf-8"));
let fail = 0;
for (const s of samples) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://yapayzekaizi.com" }, body: JSON.stringify({ text: s.metin }) });
  const d = await r.json();
  const ok = (s.min === undefined || d.score >= s.min) && (s.max === undefined || d.score <= s.max);
  const hedef = s.min !== undefined ? `≥${s.min}` : `≤${s.max}`;
  const line = `${s.ad}: %${d.score} (hedef ${hedef}, sürüm ${d.version})`;
  if (ok) console.log(`::notice::✓ ${line}`); else { console.log(`::error::✗ ${line}`); fail++; }
}
process.exit(fail ? 1 : 0);
