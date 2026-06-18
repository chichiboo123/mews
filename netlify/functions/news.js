/* =========================================================
   뮤스 (Mews) — 뉴스 목록 함수
   여러 시간대 변형 쿼리로 구글 뉴스 RSS를 병렬 수집하여
   중복을 제거하고 JSON 배열로 반환합니다. (최대 100개/피드 한계 보완)
   ========================================================= */

const BASE = "https://news.google.com/rss/search";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/rss+xml, application/xml, text/xml, */*",
  "Accept-Language": "ko,en;q=0.8",
};

// HTML 엔티티 / CDATA 정리 (&amp; 는 마지막에)
function decode(str) {
  return String(str || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

function tag(chunk, name) {
  const m = chunk.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1].trim() : "";
}

function parseItems(xml) {
  const items = [];
  const chunks = xml.split("<item>").slice(1);
  for (const raw of chunks) {
    const chunk = raw.split("</item>")[0];
    const title = decode(tag(chunk, "title"));
    if (!title) continue;
    items.push({
      title,
      link: tag(chunk, "link"),
      pubDate: tag(chunk, "pubDate"),
      source: decode(tag(chunk, "source")),
    });
  }
  return items;
}

function buildUrl(q, extra) {
  const params = new URLSearchParams({
    q: extra ? `${q} ${extra}` : q,
    hl: "ko",
    gl: "KR",
    ceid: "KR:ko",
  });
  return `${BASE}?${params}`;
}

async function fetchFeed(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) return [];
  return parseItems(await res.text());
}

function json(statusCode, body, maxAge = 0) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-store",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  const q = (event.queryStringParameters?.q || "").trim();
  if (!q) return json(400, { error: "검색어가 필요합니다." });

  // 기본 + 시간대 변형으로 더 많은 기사 확보 (피드당 100개 한계 보완)
  const variants = ["", "when:1y", "when:5y"];

  try {
    const lists = await Promise.all(
      variants.map((v) => fetchFeed(buildUrl(q, v)).catch(() => []))
    );

    const seen = new Set();
    const articles = [];
    for (const list of lists) {
      for (const item of list) {
        const key = item.link || item.title;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        articles.push(item);
      }
    }

    return json(200, { count: articles.length, articles }, 300);
  } catch (err) {
    return json(500, { error: err.message });
  }
};
