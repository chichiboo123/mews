/* =========================================================
   뮤스 (Mews) — 뉴스 목록 함수 (네이버 검색 API 기반 하이브리드)
   1) 네이버 뉴스 검색 API로 키워드 검색 결과(제목·링크·공식 스니펫)를 받고,
   2) 국내 신문사 공식 RSS(문화·연예)에서 "매체가 배포한 요약"으로 보강합니다.
   - 네이버 API 키가 없거나 호출 실패 시 구글 뉴스 RSS로 자동 폴백
   - 본문을 직접 크롤링하지 않으므로 공개·배포된 정보만 사용합니다.
   자격 증명은 환경변수에서만 읽습니다 (코드/리포지토리에 키를 두지 않음):
     NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
   ========================================================= */

const NAVER_ID = process.env.NAVER_CLIENT_ID;
const NAVER_SECRET = process.env.NAVER_CLIENT_SECRET;
const NAVER_NEWS = "https://openapi.naver.com/v1/search/news.json";

const GOOGLE_BASE = "https://news.google.com/rss/search";

// ── 국내 신문사 공식 RSS (문화/연예/공연 섹션) ──────────────
// 매체가 syndication(배포) 목적으로 공개한 피드만 사용. 실패해도 나머지로
// 동작하도록 allSettled + 타임아웃으로 내결함성을 둡니다. 자유롭게 편집하세요.
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

const RSS_HEADERS = {
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

// 네이버/RSS 텍스트 정제 — 태그(<b> 등) 제거 + 엔티티 디코드 + 공백 정리 + 컷
function cleanText(raw, max = 200) {
  let t = decode(String(raw || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  if (max && t.length > max) t = t.slice(0, max - 1).trimEnd() + "…";
  return t;
}

function tag(chunk, name) {
  const m = chunk.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1].trim() : "";
}

// 제목 비교/중복 제거용 키: 끝의 " - 언론사" 제거 후 기호·공백 제거
function normKey(title) {
  return String(title || "")
    .replace(/\s+[-–—|·]\s+[^-–—|·]+$/, "")
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]/g, "");
}

// 원문 링크 호스트에서 표시용 매체명 추정 (네이버 응답엔 매체명 필드가 없음)
const HOST_NAME = {
  "chosun.com": "조선일보", "donga.com": "동아일보", "joongang.co.kr": "중앙일보",
  "hani.co.kr": "한겨레", "khan.co.kr": "경향신문", "hankyung.com": "한국경제",
  "mk.co.kr": "매일경제", "seoul.co.kr": "서울신문", "yna.co.kr": "연합뉴스",
  "newsis.com": "뉴시스", "news1.kr": "뉴스1", "sbs.co.kr": "SBS",
  "kbs.co.kr": "KBS", "imbc.com": "MBC", "nocutnews.co.kr": "노컷뉴스",
  "heraldcorp.com": "헤럴드경제", "edaily.co.kr": "이데일리", "mt.co.kr": "머니투데이",
  "sportschosun.com": "스포츠조선", "sportsseoul.com": "스포츠서울",
  "osen.co.kr": "OSEN", "tvreport.co.kr": "TV리포트", "newsen.com": "뉴스엔",
};
function sourceFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").replace(/^m\./, "");
    for (const key in HOST_NAME) if (host.endsWith(key)) return HOST_NAME[key];
    const base = host.replace(/\.(co\.kr|com|kr|net|org)$/i, "");
    return base ? base.split(".").pop() : "뉴스";
  } catch (_) {
    return "뉴스";
  }
}

// 타임아웃이 적용된 fetch → 텍스트
async function fetchText(url, ms, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ── 네이버 뉴스 검색 API (1순위: 검색 + 공식 스니펫) ──────────
async function fetchNaver(q) {
  if (!NAVER_ID || !NAVER_SECRET) return null; // 미설정 → 폴백 신호
  const url =
    `${NAVER_NEWS}?` +
    new URLSearchParams({ query: q, display: "100", start: "1", sort: "sim" });
  try {
    const text = await fetchText(url, 7000, {
      headers: {
        "X-Naver-Client-Id": NAVER_ID,
        "X-Naver-Client-Secret": NAVER_SECRET,
      },
    });
    const data = JSON.parse(text);
    const items = Array.isArray(data.items) ? data.items : [];
    return items.map((it) => {
      const link = decode(it.originallink || it.link || "");
      return {
        title: cleanText(it.title, 0),
        link,
        summary: cleanText(it.description, 200),
        source: sourceFromUrl(link),
        pubDate: it.pubDate || "",
      };
    });
  } catch (_) {
    return null; // 호출 실패(401/429 등) → 폴백 신호
  }
}

// ── 구글 뉴스 RSS (폴백: 제목·링크·날짜) ─────────────────────
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
      summary: "",
    });
  }
  return items;
}

async function fetchGoogle(q) {
  const variants = ["", "when:1y", "when:1m"];
  const settled = await Promise.allSettled(
    variants.map((v) => {
      const params = new URLSearchParams({
        q: v ? `${q} ${v}` : q,
        hl: "ko", gl: "KR", ceid: "KR:ko",
      });
      return fetchText(`${GOOGLE_BASE}?${params}`, 7000, { headers: RSS_HEADERS }).then(
        parseGoogleItems
      );
    })
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
    items.push({
      title,
      link: decode(tag(chunk, "link")) || decode(tag(chunk, "guid")),
      summary: cleanText(tag(chunk, "description"), 200),
      pubDate: tag(chunk, "pubDate") || tag(chunk, "dc:date"),
      source,
    });
  }
  return items;
}

async function fetchPublishers() {
  const settled = await Promise.allSettled(
    PUBLISHER_FEEDS.map((f) =>
      fetchText(f.url, 5000, { headers: RSS_HEADERS }).then((xml) =>
        parsePublisherItems(xml, f.source)
      )
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
    // 1순위 네이버, 미설정/실패 시 구글 뉴스 폴백 — 신문사 RSS는 병렬 수집
    const [naver, publisherPool] = await Promise.all([
      fetchNaver(q),
      fetchPublishers().catch(() => []),
    ]);

    const usedNaver = naver !== null;
    const base = usedNaver ? naver : await fetchGoogle(q).catch(() => []);

    if (base.length === 0 && publisherPool.length === 0) {
      return json(502, { error: "뉴스를 가져올 수 없습니다." });
    }

    // 신문사 RSS에서 키워드와 일치하는 기사(공식 요약 + 직링크) 선별
    const matches = makeMatcher(q);
    const publisherMatched = publisherPool.filter(matches);

    const seen = new Set();
    const articles = [];

    // 1) 신문사 RSS 매칭분 우선 — 공식 요약 + 원문 직링크의 가장 깔끔한 결과
    for (const item of publisherMatched) {
      const key = normKey(item.title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      articles.push(item);
    }

    // 2) 네이버(또는 폴백 구글) 결과로 폭 보완 — 중복 제목은 건너뜀
    for (const item of base) {
      const key = normKey(item.title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      articles.push(item);
    }

    return json(200, { count: articles.length, source: usedNaver ? "naver" : "google", articles }, 300);
  } catch (err) {
    return json(500, { error: err.message });
  }
};
