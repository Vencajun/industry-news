// 매일 산업 뉴스를 모아 news.json 을 갱신합니다.
// ANTHROPIC_API_KEY 가 있으면 AI 요약, 없으면 무료 모드(제목, 언론사, 링크, 같은 소식 묶기)로 동작합니다.
// 외부 라이브러리 없이 Node.js 20 이상에서 동작합니다.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(ROOT, "config.json");
const DATA_PATH = path.join(ROOT, "news.json");

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decode(s = "") {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
      if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}
export const kstDate = (d = new Date()) => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
export const titleKey = t => t.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase().slice(0, 40);
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

/* ---------- 수집 ---------- */
export function parseGoogleRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const get = tag => { const r = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`)); return r ? r[1] : ""; };
    const source = decode(get("source"));
    let title = decode(get("title"));
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)).trim();
    const pub = new Date(decode(get("pubDate")));
    const url = decode(get("link"));
    if (!title || !url || isNaN(pub)) continue;
    items.push({ title, url, source: source || hostOf(url), published: pub.toISOString(), snippet: "" });
  }
  return items;
}
export function parseNaver(json) {
  return (json.items || []).map(it => {
    const url = it.originallink || it.link;
    const pub = new Date(it.pubDate);
    return { title: decode(it.title), url, source: hostOf(url), published: isNaN(pub) ? null : pub.toISOString(), snippet: decode(it.description) };
  }).filter(i => i.title && i.url && i.published);
}
async function fetchGoogle(q) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:2d")}&hl=ko&gl=KR&ceid=KR:ko`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 industry-news-bot" } });
  if (!res.ok) throw new Error(`Google 뉴스 ${res.status}`);
  return parseGoogleRss(await res.text());
}
async function fetchNaver(q) {
  const id = process.env.NAVER_CLIENT_ID, secret = process.env.NAVER_CLIENT_SECRET;
  if (!id || !secret) return [];
  const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(q)}&display=100&sort=date`;
  const res = await fetch(url, { headers: { "X-Naver-Client-Id": id, "X-Naver-Client-Secret": secret } });
  if (!res.ok) throw new Error(`네이버 뉴스 ${res.status}`);
  return parseNaver(await res.json());
}
export async function collect(cfg, seen) {
  const all = [];
  for (const q of cfg.queries) {
    for (const [name, fn] of [["google", fetchGoogle], ["naver", fetchNaver]]) {
      try { all.push(...(await fn(q)).map(a => ({ ...a, q }))); } catch (e) { console.warn(`[${name}] "${q}" 수집 실패: ${e.message}`); }
    }
  }
  return filterArticles(all, cfg, seen);
}
export function filterArticles(all, cfg, seen, now = Date.now()) {
  const since = now - (cfg.lookbackHours || 36) * 3600e3;
  const ex = (cfg.exclude || []).map(w => w.toLowerCase());
  const keys = new Set(seen.keys), urls = new Set(seen.urls), out = [];
  for (const a of [...all].sort((x, y) => y.published.localeCompare(x.published))) {
    const t = new Date(a.published).getTime();
    if (t < since || t > now + 3600e3) continue;
    if (ex.some(w => a.title.toLowerCase().includes(w))) continue;
    const k = titleKey(a.title);
    if (keys.has(k) || urls.has(a.url)) continue;
    keys.add(k); urls.add(a.url); out.push(a);
  }
  return out.slice(0, 150);
}

/* ---------- 요약 ---------- */
export function buildPrompt(cfg, articles) {
  const list = articles.map((a, i) => `[${i}] ${a.title} | ${a.source} | ${a.published}${a.snippet ? ` | 발췌: ${a.snippet.slice(0, 200)}` : ""}`).join("\n");
  return `너는 "${cfg.industry}" 산업을 매일 지켜보는 뉴스 편집자다. 아래는 최근 수집된 기사 목록이다(제목, 언론사, 발행 시각, 일부는 짧은 발췌).

할 일:
1. ${cfg.industry} 산업과 직접 관련 있고 의미 있는 소식만 골라 최대 ${cfg.maxPerDay}개로 정리한다. 같은 사건을 다룬 기사는 하나로 묶는다.
2. 각 소식마다 한국어로 짧게 쓴다.

규칙:
- 제목과 발췌에 있는 내용만 근거로 쓴다. 없는 수치나 사실을 지어내지 않는다.
- 기사 문장을 그대로 옮기지 말고 너의 말로 새로 쓴다.
- 특정 종목을 사라, 팔라, 오른다, 내린다 같은 투자 판단이나 전망은 쓰지 않는다.
- 광고, 행사 홍보, 단순 인사 기사는 뺀다.

JSON 하나로만 답한다. 다른 말이나 코드 블록 표시는 쓰지 않는다.
{"brief":["오늘 ${cfg.industry} 산업의 흐름을 보여주는 한 줄, 최대 3개"],
 "items":[{"ids":[묶은 기사 번호들, 대표 기사를 맨 앞에],"summary":"무슨 일인지 1~2문장, 80자 이내","why":"산업에 왜 중요한지 한 줄, 50자 이내","tags":["짧은 분류 1~2개"],"importance":1~3 정수, 3이 가장 중요}]}

기사 목록:
${list}`;
}
export function parseJson(text) {
  const s = text.replace(/```json|```/g, "").trim();
  const start = s.indexOf("{"), end = s.lastIndexOf("}");
  return JSON.parse(s.slice(start, end + 1));
}
async function summarize(cfg, articles) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY 가 설정되지 않았습니다. 저장소 Settings > Secrets 에 등록하세요.");
  const prompt = buildPrompt(cfg, articles);
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: cfg.model, max_tokens: 4000, messages: [{ role: "user", content: prompt }] })
    });
    if (!res.ok) { console.warn(`Claude API 응답 ${res.status}: ${await res.text()}`); continue; }
    const data = await res.json();
    const text = (data.content || []).map(c => c.type === "text" ? c.text : "").join("");
    try { return parseJson(text); } catch { console.warn("요약 결과를 읽지 못해 다시 시도합니다."); }
  }
  throw new Error("요약에 실패했습니다. 위 로그의 Claude API 응답을 확인하세요.");
}
export function toItems(result, articles) {
  return (result.items || []).map(it => {
    const ids = (it.ids || []).filter(i => Number.isInteger(i) && articles[i]);
    if (!ids.length) return null;
    const main = articles[ids[0]];
    return {
      title: main.title, url: main.url, source: main.source, published: main.published,
      related: ids.slice(1, 4).map(i => ({ title: articles[i].title, url: articles[i].url, source: articles[i].source })),
      summary: String(it.summary || "").slice(0, 200), why: String(it.why || "").slice(0, 120),
      tags: (it.tags || []).slice(0, 2).map(String), importance: Math.min(3, Math.max(1, parseInt(it.importance, 10) || 1))
    };
  }).filter(Boolean).sort((a, b) => b.importance - a.importance);
}

/* ---------- 무료 모드: 같은 소식 묶기 ---------- */
const words = t => new Set(t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(w => w.length >= 2));
const similar = (a, b) => { let n = 0; a.forEach(w => { if (b.has(w)) n++; }); return n / Math.max(1, Math.min(a.size, b.size)); };
export function freeItems(articles, cfg) {
  const groups = [];
  for (const a of articles) {
    const w = words(a.title);
    const g = groups.find(g => g.lead.source !== a.source && similar(g.w, w) >= 0.6);
    if (g) { if (!g.rest.some(r => r.source === a.source)) g.rest.push(a); }
    else groups.push({ lead: a, w, rest: [] });
  }
  return groups.map(({ lead, rest }) => ({
    title: lead.title, url: lead.url, source: lead.source, published: lead.published,
    related: rest.slice(0, 4).map(r => ({ title: r.title, url: r.url, source: r.source })),
    summary: "", why: "", tags: lead.q ? [lead.q] : [],
    importance: rest.length >= 2 ? 3 : rest.length === 1 ? 2 : 1
  })).sort((a, b) => b.importance - a.importance || b.published.localeCompare(a.published))
    .slice(0, (cfg.maxPerDay || 12) * 3);
}

/* ---------- 저장 ---------- */
export function merge(data, today, brief, items, keepDays) {
  const days = data.days.filter(d => d.date !== today);
  const prev = data.days.find(d => d.date === today);
  const merged = prev ? [...prev.items, ...items.filter(i => !prev.items.some(p => p.url === i.url))] : items;
  if (merged.length) days.push({ date: today, brief: brief.length ? brief : (prev?.brief || []), items: merged });
  days.sort((a, b) => b.date.localeCompare(a.date));
  return { updated: new Date().toISOString(), days: days.slice(0, keepDays) };
}
export function seenFrom(data) {
  const seen = { keys: [], urls: [] };
  data.days.forEach(d => d.items.forEach(i => {
    seen.keys.push(titleKey(i.title)); seen.urls.push(i.url);
    (i.related || []).forEach(r => { seen.keys.push(titleKey(r.title)); seen.urls.push(r.url); });
  }));
  return seen;
}
async function main() {
  const cfg = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  let data = { updated: null, days: [] };
  try { data = JSON.parse(await readFile(DATA_PATH, "utf8")); } catch {}
  const articles = await collect(cfg, seenFrom(data));
  console.log(`새 기사 ${articles.length}건 수집`);
  let brief = [], items = [];
  if (articles.length) {
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const result = await summarize(cfg, articles);
        brief = (result.brief || []).slice(0, 3).map(String);
        items = toItems(result, articles);
        console.log(`AI 요약 ${items.length}건`);
      } catch (e) { console.warn(`AI 요약 실패, 무료 모드로 저장합니다: ${e.message}`); }
    }
    if (!items.length) { items = freeItems(articles, cfg); console.log(`무료 모드 ${items.length}건`); }
  }
  const next = merge(data, kstDate(), brief, items, cfg.days || 7);
  await writeFile(DATA_PATH, JSON.stringify(next, null, 2) + "\n");
  console.log("news.json 저장 완료");
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
