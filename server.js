// 용산구 부동산 대시보드 서버 (의존성 없음, Node 18+)
// 실행: node server.js  →  http://localhost:8080
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const KEY = cfg.dataGoKrKey;
const LAWD = "11170"; // 서울 용산구
const UA = "hanaruem-yongsan-dashboard/1.0";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8")); } catch { return d; } };
const writeJson = (f, o) => fs.writeFileSync(path.join(ROOT, f), JSON.stringify(o));

/* ---------- 국토부 실거래가 (매매/전월세) ---------- */
const EP = {
  trade: "https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade",
  rent: "https://apis.data.go.kr/1613000/RTMSDataSvcAptRent/getRTMSDataSvcAptRent"
};
const tag = (x, t) => { const m = x.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)); return m ? m[1].trim() : ""; };
const num = s => Number(String(s).replace(/,/g, "")) || 0;
const monthCache = new Map(); // "type:YYYYMM" -> {t, items}

async function fetchMonth(type, ym) {
  const ck = type + ":" + ym;
  const hit = monthCache.get(ck);
  const curYm = new Date().toISOString().slice(0, 7).replace("-", "");
  const ttl = ym >= curYm ? 30 * 60e3 : 12 * 3600e3;
  if (hit && Date.now() - hit.t < ttl) return hit.items;
  const items = [];
  for (let page = 1; page <= 10; page++) {
    const url = `${EP[type]}?serviceKey=${KEY}&LAWD_CD=${LAWD}&DEAL_YMD=${ym}&numOfRows=1000&pageNo=${page}`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    const xml = await res.text();
    const code = tag(xml, "resultCode");
    if (code && code !== "000" && code !== "00") throw new Error(`API ${code} ${tag(xml, "resultMsg")}`);
    if (!code) throw new Error(tag(xml, "returnAuthMsg") || tag(xml, "errMsg") || "API error");
    const chunk = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    for (const it of chunk) {
      if (type === "trade" && tag(it, "cdealType").trim()) continue; // 해제 건 제외
      const y = tag(it, "dealYear"), m = tag(it, "dealMonth").padStart(2, "0"), d = tag(it, "dealDay").padStart(2, "0");
      const base = {
        apt: tag(it, "aptNm"), dong: tag(it, "umdNm"), jibun: tag(it, "jibun"),
        area: Number(tag(it, "excluUseAr")) || 0, floor: Number(tag(it, "floor")) || 0,
        built: Number(tag(it, "buildYear")) || 0, date: `${y}-${m}-${d}`
      };
      if (type === "trade") items.push({ ...base, price: num(tag(it, "dealAmount")) });
      else items.push({ ...base, deposit: num(tag(it, "deposit")), monthly: num(tag(it, "monthlyRent")) });
    }
    const total = num(tag(xml, "totalCount"));
    if (page * 1000 >= total) break;
  }
  monthCache.set(ck, { t: Date.now(), items });
  return items;
}

async function deals(type, from, to) {
  const months = [];
  const [fy, fm] = from.split("-").map(Number), [ty, tm] = to.split("-").map(Number);
  for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m++) { if (m > 12) { m = 1; y++; } months.push(`${y}${String(m).padStart(2, "0")}`); if (months.length > 36) break; }
  const out = [];
  for (const ym of months) out.push(...await fetchMonth(type, ym));
  return out.filter(d => d.date >= from && d.date <= to);
}

/* ---------- 지오코딩 (OSM Nominatim, 캐시) ---------- */
const GEO_FILE = "geo-cache.json";
const geoCache = readJson(GEO_FILE, {});
let geoChain = Promise.resolve();
const inYongsan = (lat, lng) => lat > 37.49 && lat < 37.57 && lng > 126.94 && lng < 127.03;
async function nominatim(q) {
  await sleep(1100);
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`, { headers: { "User-Agent": UA } });
  const j = await r.json();
  return j[0] ? { lat: Number(j[0].lat), lng: Number(j[0].lon) } : null;
}
function geocode(apt, dong, jibun) {
  const key = `${apt}|${dong}`;
  if (geoCache[key]) return Promise.resolve(geoCache[key]);
  const job = geoChain.then(async () => {
    if (geoCache[key]) return geoCache[key];
    const tries = [
      [`${apt} 용산구 서울`, "exact"],
      [`${apt.replace(/아파트$/, "")}아파트 ${dong} 용산구`, "exact"],
      [`서울특별시 용산구 ${dong} ${jibun}`, "address"],
      [`${dong} 용산구 서울`, "dong"]
    ];
    for (const [q, prec] of tries) {
      try {
        const p = await nominatim(q);
        if (p && inYongsan(p.lat, p.lng)) return (geoCache[key] = { ...p, precision: prec }, writeJson(GEO_FILE, geoCache), geoCache[key]);
      } catch { /* 다음 시도 */ }
    }
    return null;
  });
  geoChain = job.catch(() => {});
  return job;
}

/* ---------- 입지 정보 (OSM Overpass, 캐시) ---------- */
const POI_FILE = "poi-cache.json";
const poiCache = readJson(POI_FILE, {});
const rad = d => d * Math.PI / 180;
const dist = (a, b, c, d) => { const R = 6371000, dl = rad(c - a), dg = rad(d - b); const x = Math.sin(dl / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(dg / 2) ** 2; return Math.round(2 * R * Math.asin(Math.sqrt(x))); };
const KTX = [
  { name: "서울역 (KTX·공항철도)", lat: 37.5547, lng: 126.9707 },
  { name: "용산역 (KTX·ITX)", lat: 37.5299, lng: 126.9647 }
];
async function overpass(lat, lng) {
  const q = `[out:json][timeout:30];(
    nwr["railway"="station"](around:2000,${lat},${lng});
    nwr["station"="subway"](around:2000,${lat},${lng});
    node["highway"="bus_stop"](around:500,${lat},${lng});
    nwr["amenity"="school"](around:2000,${lat},${lng});
    nwr["shop"~"^(supermarket|department_store|mall)$"](around:1500,${lat},${lng});
    nwr["amenity"="cafe"](around:500,${lat},${lng});
    nwr["office"="government"](around:2000,${lat},${lng});
    nwr["amenity"~"^(townhall|police|fire_station|post_office)$"](around:1500,${lat},${lng});
    nwr["amenity"~"^(hospital|clinic)$"](around:1500,${lat},${lng});
  );out tags center 400;`;
  const r = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(q) });
  if (!r.ok) throw new Error("overpass " + r.status);
  return (await r.json()).elements || [];
}
function classify(els, lat, lng) {
  const out = { subway: [], bus: [], school: { 초등: [], 중등: [], 고등: [] }, mart: [], dept: [], cafe: [], gov: [], hospital: [] };
  const seen = new Set();
  for (const e of els) {
    const t = e.tags || {}, name = t["name:ko"] || t.name; if (!name) continue;
    const la = e.lat ?? e.center?.lat, lo = e.lon ?? e.center?.lon; if (la == null) continue;
    const d = dist(lat, lng, la, lo), item = { name, dist: d, lat: la, lng: lo };
    const k = (n, c) => { const id = n + "|" + c; if (seen.has(id)) return false; seen.add(id); return true; };
    if ((t.railway === "station" || t.station === "subway") && t.railway !== "halt") { if (k(name, "s")) out.subway.push({ ...item, line: t.line || t.network || "" }); }
    else if (t.highway === "bus_stop") { if (k(name, "b")) out.bus.push(item); }
    else if (t.amenity === "school") {
      const lvl = /초등/.test(name) ? "초등" : /고등|여자고|과학고|외고|예고/.test(name) ? "고등" : /중학|여자중/.test(name) ? "중등" : null;
      if (lvl && k(name, "sc")) out.school[lvl].push(item);
    }
    else if (t.shop === "department_store" || t.shop === "mall") { if (k(name, "d")) out.dept.push(item); }
    else if (t.shop === "supermarket") { if (k(name, "m")) out.mart.push(item); }
    else if (t.amenity === "cafe") { if (k(name, "c")) out.cafe.push(item); }
    else if (t.amenity === "hospital" || t.amenity === "clinic") { if (k(name, "h")) out.hospital.push(item); }
    else if (t.office === "government" || ["townhall", "police", "fire_station", "post_office"].includes(t.amenity)) { if (k(name, "g")) out.gov.push(item); }
  }
  const by = (a, n) => a.sort((x, y) => x.dist - y.dist).slice(0, n);
  return {
    subway: by(out.subway, 4), busCount: out.bus.length, bus: by(out.bus, 8),
    school: { 초등: by(out.school.초등, 3), 중등: by(out.school.중등, 3), 고등: by(out.school.고등, 3) },
    mart: by(out.mart, 3), dept: by(out.dept, 3), cafeCount: out.cafe.length, cafe: by(out.cafe, 4),
    gov: by(out.gov, 3), hospital: by(out.hospital, 3),
    ktx: KTX.map(s => ({ name: s.name, dist: dist(lat, lng, s.lat, s.lng) }))
  };
}
async function poi(lat, lng) {
  const key = "v2:" + lat.toFixed(4) + "," + lng.toFixed(4); // v2: 좌표 포함
  if (poiCache[key]) return poiCache[key];
  let els, err;
  for (let i = 0; i < 2 && !els; i++) { try { els = await overpass(lat, lng); } catch (e) { err = e; await sleep(1500); } }
  if (!els) throw err;
  return (poiCache[key] = classify(els, lat, lng), writeJson(POI_FILE, poiCache), poiCache[key]);
}

/* ---------- 한국부동산원 R-ONE (키가 있을 때만) ---------- */
let roneCache = null;
async function roneSeries(id) {
  const c = cfg.rone;
  const url = `https://www.reb.or.kr/r-one/openapi/SttsApiTblData.do?KEY=${encodeURIComponent(c.key)}&Type=json&STATBL_ID=${id}&DTACYCLE_CD=WK&CLS_ID=${c.clsId}&pIndex=1&pSize=1000`;
  const j = await (await fetch(url, { headers: { "User-Agent": UA } })).json();
  if (j.RESULT) throw new Error(j.RESULT.MESSAGE);
  const rows = (j.SttsApiTblData || []).find(x => x.row)?.row || [];
  return rows.map(r => ({ t: r.WRTTIME_DESC, v: Number(r.DTA_VAL) })).filter(r => r.v).sort((x, y) => x.t.localeCompare(y.t)).slice(-110);
}
async function roneRows(id, cy, cls, itm) {
  const c = cfg.rone;
  const url = `https://www.reb.or.kr/r-one/openapi/SttsApiTblData.do?KEY=${encodeURIComponent(c.key)}&Type=json&STATBL_ID=${id}&DTACYCLE_CD=${cy}&CLS_ID=${cls}&pIndex=1&pSize=1000`;
  const j = await (await fetch(url, { headers: { "User-Agent": UA } })).json();
  if (j.RESULT) throw new Error(j.RESULT.MESSAGE);
  const rows = (j.SttsApiTblData || []).find(x => x.row)?.row || [];
  return rows.filter(r => !itm || r.ITM_NM === itm).map(r => ({ t: r.WRTTIME_DESC || String(r.WRTTIME_IDTFR_ID), k: String(r.WRTTIME_IDTFR_ID), v: Number(r.DTA_VAL) })).filter(r => Number.isFinite(r.v)).sort((x, y) => x.k.localeCompare(y.k));
}
const safe = p => p.catch(() => []);
async function rone() {
  const c = cfg.rone || {};
  if (!c.key) return { enabled: false };
  if (roneCache && Date.now() - roneCache.at < 6 * 3600e3) return roneCache.data;
  const [trade, jeonse, unsoldY, unsoldS, volume, dTrade, dTradeS, dJeonse, dJeonseS] = await Promise.all([
    roneSeries(c.tradeStatblId), roneSeries(c.jeonseStatblId),
    safe(roneRows("T237973129847263", "MM", 50023, "미분양현황")), safe(roneRows("T237973129847263", "MM", 50018, "미분양현황")),
    safe(roneRows("A_2024_00554", "MM", 510005, "동(호)수")),
    safe(roneRows("T248163133074619", "WK", 50010)), safe(roneRows("T248163133074619", "WK", 50008)),
    safe(roneRows("T245423133086632", "WK", 50010)), safe(roneRows("T245423133086632", "WK", 50008))
  ]);
  const data = { enabled: true, name: c.clsName, trade, jeonse,
    unsold: { yongsan: unsoldY.slice(-24), seoul: unsoldS.slice(-24) },
    volume: volume.slice(-24),
    demand: { trade: dTrade.slice(-52), tradeSeoul: dTradeS.slice(-52), jeonse: dJeonse.slice(-52), jeonseSeoul: dJeonseS.slice(-52) } };
  roneCache = { at: Date.now(), data };
  return data;
}

/* ---------- 지도 타일 프록시 (OSM, 디스크 캐시) ---------- */
const TILE_DIR = path.join(ROOT, "tiles");
const tileLimit = (z, x, y) => { // 용산구 일대(서울 중심부)만 허용
  const n = 2 ** z, lon = x / n * 360 - 180, lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
  return z >= 10 && z <= 18 && lon > 126.8 && lon < 127.15 && lat > 37.4 && lat < 37.65;
};
async function tile(z, x, y) {
  const f = path.join(TILE_DIR, String(z), String(x), y + ".png");
  if (fs.existsSync(f)) return fs.readFileSync(f);
  const r = await fetch(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`, { headers: { "User-Agent": UA + " (+tel:02-703-7070)", "Referer": "http://localhost:" + cfg.port + "/" } });
  if (!r.ok) throw new Error("tile " + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf);
  return buf;
}

/* ---------- HTTP ---------- */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };
const send = (res, code, body, type = "application/json; charset=utf-8") => { res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "");

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  try {
    if (u.pathname === "/api/deals") {
      const type = u.searchParams.get("type"), from = u.searchParams.get("from"), to = u.searchParams.get("to");
      if (!EP[type] || !isDate(from) || !isDate(to)) return send(res, 400, { error: "bad params" });
      return send(res, 200, { items: await deals(type, from, to) });
    }
    if (u.pathname === "/api/geo") {
      const g = await geocode(u.searchParams.get("apt") || "", u.searchParams.get("dong") || "", u.searchParams.get("jibun") || "");
      return send(res, 200, { geo: g });
    }
    if (u.pathname === "/api/poi") {
      const lat = Number(u.searchParams.get("lat")), lng = Number(u.searchParams.get("lng"));
      if (!inYongsan(lat, lng)) return send(res, 400, { error: "bad coords" });
      return send(res, 200, await poi(lat, lng));
    }
    const tm = u.pathname.match(/^\/tile\/(\d+)\/(\d+)\/(\d+)\.png$/);
    if (tm) {
      const [z, x, y] = tm.slice(1).map(Number);
      if (!tileLimit(z, x, y)) return send(res, 404, "out of range", "text/plain");
      const buf = await tile(z, x, y);
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" });
      return res.end(buf);
    }
    if (u.pathname === "/api/rone") return send(res, 200, await rone());
    // 정적 파일 (config.json·server.js 등 민감 파일 제외)
    let p = decodeURIComponent(u.pathname); if (p === "/") p = "/한아름부동산 index.html";
    const f = path.join(ROOT, p);
    const allowed = ["/한아름부동산 index.html"].includes(p) || p.startsWith("/public/");
    if (!allowed || !f.startsWith(ROOT) || !fs.existsSync(f)) return send(res, 404, "Not found", "text/plain");
    send(res, 200, fs.readFileSync(f), MIME[path.extname(f)] || "application/octet-stream");
  } catch (e) {
    send(res, 502, { error: String(e.message || e) });
  }
}).listen(cfg.port, () => console.log(`용산구 대시보드: http://localhost:${cfg.port}`));
