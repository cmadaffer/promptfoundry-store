// Validates and normalizes library.json (no LLMs, no network).
import { readFile, writeFile } from "node:fs/promises";

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (!seen.has(k)) { seen.add(k); out.push(x); }
  }
  return out;
}

async function main() {
  let raw = "[]";
  try { raw = await readFile("library.json", "utf8"); } catch {}
  let data = [];
  try { data = JSON.parse(raw); } catch (e) {
    throw new Error("library.json is not valid JSON: " + e.message);
  }
  if (!Array.isArray(data)) {
    // allow {items:[...]}
    data = Array.isArray(data.items) ? data.items : [];
  }

  // Basic schema guard + tidy
  const cleaned = data.map((it, i) => ({
    id: String(it.id || `id-${i}`),
    category: String(it.category || "General"),
    title: String(it.title || "Untitled"),
    tags: Array.isArray(it.tags) ? it.tags.map(String) : [],
    rating: Number.isFinite(it.rating) ? it.rating : 5,
    price: Number.isFinite(it.price) ? it.price : 99,
    buyUrl: String(it.buyUrl || "").trim(),
    prompt: String(it.prompt || "").trim(),
  }));

  // Drop empties, de-dupe by (title+prompt)
  const nonEmpty = cleaned.filter(x => x.title && x.prompt);
  const deduped = uniqBy(nonEmpty, x => (x.title + "::" + x.prompt).toLowerCase());

  // Stable sort by category then title
  deduped.sort((a,b) =>
    String(a.category).localeCompare(String(b.category)) ||
    String(a.title).localeCompare(String(b.title))
  );

  await writeFile("library.json", JSON.stringify(deduped, null, 2));
  console.log(`✅ library.json OK — ${deduped.length} items`);
}

main().catch(e => { console.error(e); process.exit(1); });
