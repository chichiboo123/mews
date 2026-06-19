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
// 표시되는 요약은 cleanText(…, 280)로 최대 280자 발췌만 사용합니다(저작권 안전장치).
// ※ RSS 약관에 "개인 구독·비상업적 사용만 허용"을 명시한 매체(예: 노컷뉴스)는
//   제외했습니다. 운영 성격(비영리/영리)에 따라 아래 목록을 가감하세요.
const PUBLISHER_FEEDS = [
  // 종합지 문화·연예
  { source: "경향신문", url: "https://www.khan.co.kr/rss/rssdata/culture_news.xml" },
  { source: "경향신문", url: "https://www.khan.co.kr/rss/rssdata/entertain_news.xml" },
  { source: "한겨레", url: "https://www.hani.co.kr/rss/culture/" },
  { source: "동아일보", url: "https://rss.donga.com/culture.xml" },
  { source: "동아일보", url: "https://rss.donga.com/entertainment.xml" },
  { source: "한국경제", url: "https://www.hankyung.com/feed/culture" },
  { source: "한국경제", url: "https://www.hankyung.com/feed/entertainment" },
  { source: "서울신문", url: "https://www.seoul.co.kr/xml/rss/rss_culture.xml" },
  { source: "서울신문", url: "https://www.seoul.co.kr/xml/rss/rss_entertainment.xml" },
  { source: "헤럴드경제", url: "http://biz.heraldcorp.com/rss/010100000000.xml" },
  // 공연·뮤지컬 커버리지 보강 (문화·연예 전문 섹션)
  { source: "오마이뉴스", url: "https://rss.ohmynews.com/rss/culture.xml" },
  { source: "이데일리", url: "http://rss.edaily.co.kr/happypot_news.xml" }, // 문화/생활
  { source: "이데일리", url: "http://rss.edaily.co.kr/spn_news.xml" }, // 스타in(연예)
  { source: "스포츠경향", url: "http://www.khan.co.kr/rss/rssdata/kh_entertainment.xml" },
];

// 다수의 국내 언론사 RSS는 봇/비표준 User-Agent를 403으로 차단하므로
// 일반 브라우저처럼 보이는 헤더를 사용한다(공개 배포 피드 정상 수신 목적).
const RSS_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/rss+xml, application/xml, text/xml, */*",
  "Accept-Language": "ko,en;q=0.9",
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
// 더 구체적인 서브도메인(예: biz.chosun.com)을 먼저 매칭하도록 길이순 정렬해 사용.
const HOST_NAME = {
  // 종합일간
  "chosun.com": "조선일보", "donga.com": "동아일보", "joongang.co.kr": "중앙일보",
  "joins.com": "중앙일보", "hani.co.kr": "한겨레", "khan.co.kr": "경향신문",
  "hankookilbo.com": "한국일보", "kmib.co.kr": "국민일보", "munhwa.com": "문화일보",
  "seoul.co.kr": "서울신문", "segye.com": "세계일보", "kukinews.com": "쿠키뉴스",
  "naeil.com": "내일신문",
  // 통신
  "yna.co.kr": "연합뉴스", "yonhapnewstv.co.kr": "연합뉴스TV",
  "newsis.com": "뉴시스", "news1.kr": "뉴스1",
  // 방송
  "sbs.co.kr": "SBS", "kbs.co.kr": "KBS", "imbc.com": "MBC", "ytn.co.kr": "YTN",
  "jtbc.co.kr": "JTBC", "jtbc.com": "JTBC", "mbn.co.kr": "MBN",
  "ichannela.com": "채널A", "tvchosun.com": "TV조선", "nocutnews.co.kr": "노컷뉴스",
  // 경제
  "mk.co.kr": "매일경제", "hankyung.com": "한국경제", "edaily.co.kr": "이데일리",
  "mt.co.kr": "머니투데이", "fnnews.com": "파이낸셜뉴스", "asiae.co.kr": "아시아경제",
  "sedaily.com": "서울경제", "heraldcorp.com": "헤럴드경제", "ajunews.com": "아주경제",
  "biz.chosun.com": "조선비즈", "newspim.com": "뉴스핌", "ebn.co.kr": "EBN",
  "econovill.com": "이코노믹리뷰", "dt.co.kr": "디지털타임스", "etnews.com": "전자신문",
  "inews24.com": "아이뉴스24", "dealsite.co.kr": "딜사이트",
  // 스포츠·연예
  "sportschosun.com": "스포츠조선", "sportsseoul.com": "스포츠서울",
  "sports.donga.com": "스포츠동아", "osen.co.kr": "OSEN", "newsen.com": "뉴스엔",
  "tvreport.co.kr": "TV리포트", "xportsnews.com": "엑스포츠뉴스",
  "mydaily.co.kr": "마이데일리", "isplus.com": "일간스포츠",
  "star.mt.co.kr": "스타뉴스", "spotvnews.co.kr": "스포티비뉴스",
  "dispatch.co.kr": "디스패치", "ize.co.kr": "아이즈",
  // 인터넷·기타
  "ohmynews.com": "오마이뉴스", "pressian.com": "프레시안",
  "mediatoday.co.kr": "미디어오늘", "newdaily.co.kr": "뉴데일리",
  "dailian.co.kr": "데일리안", "ibabynews.com": "베이비뉴스",
  "tf.co.kr": "더팩트", "m-i.kr": "매일일보", "gukjenews.com": "국제뉴스",
  "kyongbuk.co.kr": "경북일보", "gnnews.co.kr": "경남일보", "knnews.co.kr": "경남신문",
  "kado.net": "강원도민일보", "kwnews.co.kr": "강원일보", "jejunews.com": "제주일보",
  "joongdo.co.kr": "중도일보", "kihoilbo.co.kr": "기호일보",
};
const HOST_KEYS = Object.keys(HOST_NAME).sort((a, b) => b.length - a.length);

function sourceFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").replace(/^m\./, "");
    for (const key of HOST_KEYS) {
      if (host === key || host.endsWith("." + key)) return HOST_NAME[key];
    }
    // 미등록 매체: 도메인 핵심부만 노출 (예: example.co.kr → example)
    const base = host.replace(/\.(co\.kr|or\.kr|go\.kr|com|kr|net|org)$/i, "");
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
function mapNaverItem(it) {
  const link = decode(it.originallink || it.link || "");
  return {
    title: cleanText(it.title, 0),
    link,
    summary: cleanText(it.description, 0), // 네이버 공식 스니펫: 전문 그대로
    source: sourceFromUrl(link),
    provider: "naver",
    pubDate: it.pubDate || "",
  };
}

// start로 페이지네이션하여 100개 제한 없이 최대치까지 수집
// (네이버 제한: display ≤ 100, start ≤ 1000 → 최대 1000개). 결과 소진 시 조기 종료.
async function fetchNaver(q) {
  if (!NAVER_ID || !NAVER_SECRET) return null; // 미설정 → 폴백 신호
  const headers = {
    "X-Naver-Client-Id": NAVER_ID,
    "X-Naver-Client-Secret": NAVER_SECRET,
  };
  const PAGE = 100;
  const MAX_START = 1000;
  const out = [];
  let anySuccess = false;

  for (let start = 1; start <= MAX_START; start += PAGE) {
    const url =
      `${NAVER_NEWS}?` +
      new URLSearchParams({ query: q, display: String(PAGE), start: String(start), sort: "sim" });
    let items;
    try {
      const data = JSON.parse(await fetchText(url, 5000, { headers }));
      items = Array.isArray(data.items) ? data.items : [];
    } catch (_) {
      break; // 중간 페이지 실패 → 지금까지 모은 것으로 진행
    }
    anySuccess = true;
    for (const it of items) out.push(mapNaverItem(it));
    if (items.length < PAGE) break; // 마지막 페이지(더 없음)
  }

  if (!anySuccess) return null; // 첫 호출부터 실패(미설정/401/429) → 폴백 신호
  return out;
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
      provider: "google",
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
      summary: cleanText(tag(chunk, "description"), 0), // RSS description 전문 그대로
      pubDate: tag(chunk, "pubDate") || tag(chunk, "dc:date"),
      source,
      provider: "rss",
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
