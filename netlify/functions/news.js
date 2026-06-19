/* =========================================================
   뮤스 (Mews) — 뉴스 목록 함수 (하이브리드)
   1) 구글 뉴스 RSS 검색으로 폭넓게 후보를 모으고(제목·링크·날짜),
   2) 국내 신문사 공식 RSS(문화·연예 섹션)에서 "신문사가 직접 배포한
      요약(description)"을 가져와 결과를 보강합니다.
   - 신문사 RSS와 일치하는 기사는 공식 요약 + 원문 직링크로 대체
   - 신문사 RSS에만 있는 관련 기사도 추가(검색 누락 보완)
   본문을 직접 크롤링하지 않으므로 신문사가 공개·배포한 정보만 사용합니다.
   ========================================================= */

const GOOGLE_BASE = "https://news.google.com/rss/search";

// ── 국내 신문사 공식 RSS (문화/연예/공연 섹션) ──────────────
// 매체가 syndication(배포) 목적으로 스스로 공개한 피드만 사용합니다.
// 일부 매체는 피드 주소를 변경/중단할 수 있어, 실패해도 나머지로 동작하도록
// allSettled + 타임아웃으로 내결함성을 둡니다. 자유롭게 추가/삭제하세요.
const PUBLISHER_FEEDS = [
  { source: "경향신문", url: "https://www.khan.co.kr/rss/rssdata/culture_news.xml" },
  { source: "경향신문", url: "https://www.khan.co.kr/rss/rssdata/entertain_news.xml" },
  { source: "한겨레", url: "https://www.hani.co.kr/rss/culture/" },
  { source: "동아일보", url: "https://rss.donga.com/culture.xml" },
  { source: "동아일보", url: "https://rss.donga.com/entertainment.xml" },
  { source: "한국경제", url: "https://www.hankyung.com/feed/culture" },
  { source: "한국경제", url: "https://www.hankyung.com/feed/entertainment" },
  { source: "서울신문", url: "https://www.seoul.co.kr/xml/rss/rss_culture.xml" },
  { source: "헤럴드경제", url: "http://biz.heraldcorp.com/rss/010100000000.xml" },
];

const HEADERS = {
  "User-Agent": "MewsBot/1.0 (+https://github.com/chichiboo123/mews; musical news reader)",
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
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

function tag(chunk, name) {
  const m = chunk.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1].trim() : "";
}

// 신문사가 RSS로 배포한 요약(description) 정제 — 태그 제거 후 200자로 컷
function cleanSummary(raw) {
  let t = decode(raw)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > 200) t = t.slice(0, 197).trimEnd() + "…";
  return t;
}

// 제목 비교/중복 제거용 키: 끝의 " - 언론사" 제거 후 기호·공백 제거
function normKey(title) {
  return String(title || "")
    .replace(/\s+[-–—|·]\s+[^-–—|·]+$/, "")
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]/g, "");
}

// 타임아웃이 적용된 텍스트 fetch (느린 피드가 함수 전체를 막지 않도록)
async function fetchText(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ── 구글 뉴스 RSS (검색 백본: 제목·링크·날짜만 사용) ──────────
function parseGoogleItems(xml) {
  const items = [];
  for (const raw of xml.split("<item>").slice(1)) {
    const chunk = raw.split("</item>")[0];
    const title = decode(tag(chunk, "title"));
    if (!title) continue;
    items.push({
      title,
      link: tag(chunk, "link"),
      pubDate: tag(chunk, "pubDate"),
      source: decode(tag(chunk, "source")),
      summary: "", // 본문 크롤링 제거 — 요약은 신문사 RSS로만 보강
    });
  }
  return items;
}

function buildGoogleUrl(q, extra) {
  const params = new URLSearchParams({
    q: extra ? `${q} ${extra}` : q,
    hl: "ko",
    gl: "KR",
    ceid: "KR:ko",
  });
  return `${GOOGLE_BASE}?${params}`;
}

async function fetchGoogle(q) {
  const variants = ["", "when:1y", "when:1m"];
  const settled = await Promise.allSettled(
    variants.map((v) => fetchText(buildGoogleUrl(q, v), 7000).then(parseGoogleItems))
  );
  const out = [];
  for (const r of settled) if (r.status === "fulfilled") out.push(...r.value);
  return out;
}

// ── 신문사 공식 RSS (제목 + 공식 요약 + 직링크) ──────────────
function parsePublisherItems(xml, source) {
  const items = [];
  for (const raw of xml.split(/<item[\s>]/i).slice(1)) {
    const chunk = raw.split(/<\/item>/i)[0];
    const title = decode(tag(chunk, "title"));
    if (!title) continue;
    const link = decode(tag(chunk, "link")) || decode(tag(chunk, "guid"));
    const summary = cleanSummary(tag(chunk, "description"));
    const pubDate = tag(chunk, "pubDate") || tag(chunk, "dc:date");
    items.push({ title, link, summary, pubDate, source });
  }
  return items;
}

async function fetchPublishers() {
  const settled = await Promise.allSettled(
    PUBLISHER_FEEDS.map((f) =>
      fetchText(f.url, 5000).then((xml) => parsePublisherItems(xml, f.source))
    )
  );
  const out = [];
  for (const r of settled) if (r.status === "fulfilled") out.push(...r.value);
  return out;
}

// 작품 키워드(끝의 "뮤지컬" 등 일반어 제외)가 제목/요약에 모두 포함되는지
function makeMatcher(q) {
  const STOP = new Set(["뮤지컬", "musical", "공연"]);
  const terms = q
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^0-9a-z가-힣]/g, ""))
    .filter((t) => t.length >= 2 && !STOP.has(t));
  if (terms.length === 0) return () => false;
  return (item) => {
    const hay = `${item.title} ${item.summary}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  };
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

  try {
    const [googleItems, publisherPool] = await Promise.all([
      fetchGoogle(q).catch(() => []),
      fetchPublishers().catch(() => []),
    ]);

    if (googleItems.length === 0 && publisherPool.length === 0) {
      return json(502, { error: "뉴스를 가져올 수 없습니다." });
    }

    // 신문사 RSS에서 키워드와 일치하는 기사(공식 요약 + 직링크) 선별
    const matches = makeMatcher(q);
    const publisherMatched = publisherPool.filter(matches);

    const seen = new Set();
    const articles = [];

    // 1) 신문사 RSS 매칭분 우선 — 공식 요약과 원문 직링크를 갖는 가장 깔끔한 결과
    for (const item of publisherMatched) {
      const key = normKey(item.title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      articles.push(item);
    }

    // 2) 구글 뉴스 결과로 폭 보완 — 같은 기사는 위에서 이미 추가되었으면 건너뜀
    for (const item of googleItems) {
      const key = normKey(item.title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      articles.push(item);
    }

    return json(200, { count: articles.length, articles }, 300);
  } catch (err) {
    return json(500, { error: err.message });
  }
};
