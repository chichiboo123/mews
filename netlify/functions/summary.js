/* =========================================================
   뮤스 (Mews) — 기사 요약(리드) 함수
   구글 뉴스의 암호화된 리다이렉트 링크를 batchexecute 엔드포인트로
   해석해 원문 URL을 얻은 뒤, 기사 페이지의 리드(메타 설명/첫 문단)를
   추출합니다. 한글 인코딩(EUC-KR 등) 자동 감지 및 잡음 제거 포함.
   ========================================================= */

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "ko,en;q=0.8",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

// 타임아웃이 적용된 fetch → 텍스트 (UTF-8 가정, 구글 페이지용)
async function fetchText(url, options, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 타임아웃 fetch → 문자셋 자동 감지 후 디코딩한 HTML (기사 페이지용)
async function fetchHtml(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: HEADERS,
      signal: ctrl.signal,
    });
    if (!res.ok) return "";
    const buf = Buffer.from(await res.arrayBuffer());

    // 1) Content-Type 헤더 → 2) <meta charset> 순으로 문자셋 결정
    let charset = (res.headers.get("content-type") || "").match(
      /charset=["']?([\w-]+)/i
    )?.[1];
    if (!charset) {
      const head = buf.slice(0, 4096).toString("latin1");
      charset =
        head.match(/<meta[^>]+charset=["']?\s*([\w-]+)/i)?.[1] ||
        head.match(/charset=["']?([\w-]+)/i)?.[1];
    }
    charset = (charset || "utf-8").toLowerCase().trim();
    if (["ms949", "cp949", "ksc5601", "ks_c_5601-1987"].includes(charset)) {
      charset = "euc-kr";
    }

    try {
      return new TextDecoder(charset).decode(buf);
    } catch (_) {
      return new TextDecoder("utf-8").decode(buf);
    }
  } catch (_) {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

function articleId(url) {
  const m = url.match(/\/(?:articles|read)\/([^?\/]+)/);
  return m ? m[1] : null;
}

// (구버전) base64에 평문 URL이 박혀 있는 경우 추출
function decodeLegacy(id) {
  try {
    const data = id.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(data, "base64").toString("latin1");
    const m = decoded.match(/https?:\/\/[^ -"'<>\\^`{|}]+/);
    if (m && !m[0].includes("news.google.com")) return m[0];
  } catch (_) {
    /* 무시 */
  }
  return null;
}

// (신버전) batchexecute로 원문 URL 해석
async function decodeViaBatch(id) {
  const page = await fetchText(
    `https://news.google.com/rss/articles/${id}`,
    { headers: HEADERS },
    4500
  );
  if (!page) return null;

  const sg = page.match(/data-n-a-sg="([^"]+)"/);
  const ts = page.match(/data-n-a-ts="([^"]+)"/);
  if (!sg || !ts) return null;

  const inner = [
    "garturlreq",
    [
      ["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null,
        null, null, null, 0, 1],
      "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0,
    ],
    id,
    Number(ts[1]),
    sg[1],
  ];
  const body =
    "f.req=" +
    encodeURIComponent(JSON.stringify([[["Fbv4je", JSON.stringify(inner)]]]));

  const resp = await fetchText(
    "https://news.google.com/_/DotsSplashUi/data/batchexecute",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "User-Agent": HEADERS["User-Agent"],
      },
      body,
    },
    4500
  );
  if (!resp) return null;

  const m = resp.match(/"Fbv4je","((?:\\.|[^"\\])*)"/);
  if (!m) return null;
  try {
    const arr = JSON.parse(JSON.parse(`"${m[1]}"`));
    const url = arr[1];
    if (url && /^https?:\/\//.test(url) && !url.includes("news.google.com")) {
      return url;
    }
  } catch (_) {
    /* 무시 */
  }
  return null;
}

async function resolveRealUrl(target) {
  if (!target.includes("news.google.com")) return target;
  const id = articleId(target);
  if (!id) return null;
  return (await decodeViaBatch(id)) || decodeLegacy(id);
}

// ---- 텍스트 정제 ----
function normalize(text) {
  return String(text || "")
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
    .replace(/\s+/g, " ")
    .trim();
}

// 앞쪽 군더더기(매체 속보 머리말, [단독]/[속보] 등) 제거
function stripPrefix(t) {
  let out = t;
  for (let i = 0; i < 3; i++) {
    out = out
      .replace(/^\[[^\]]{1,15}\]\s*/, "")
      .replace(/^【[^】]{1,15}】\s*/, "")
      .replace(/^[가-힣A-Za-z0-9.]{2,12}\s*(속보|단독)\s+/, "")
      .trim();
  }
  return out;
}

// 깨진 인코딩 / 코드성 텍스트 판별
function looksBroken(t) {
  if (/�/.test(t)) return true;
  const allowed =
    t.match(
      /[ -~가-힣　-〿＀-￯ㄱ-ㅎㅏ-ㅣ·…—\n]/g
    ) || [];
  return allowed.length < t.length * 0.85;
}

function looksLikeCode(t) {
  return /[{}]|function\s*\(|=>|var\s|window\.|document\.|stockData|\.push\(|;\s*$/.test(
    t
  );
}

function finalize(raw) {
  const t = stripPrefix(normalize(raw));
  if (t.length < 25 || looksBroken(t) || looksLikeCode(t)) return "";
  if (t.length <= 180) return t;
  return t.slice(0, 177).trimEnd() + "…";
}

function pickDescription(html) {
  // 1) 메타 태그 (가장 신뢰도 높은 리드)
  const patterns = [
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i,
    /<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:description["']/i,
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
    /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i,
    /<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']*)["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) {
      const text = finalize(m[1]);
      if (text) return text;
    }
  }

  // 2) 메타가 없으면 본문 첫 문단 (스크립트/스타일 제거 후)
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");

  const paragraphs = body.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || [];
  for (const p of paragraphs) {
    const text = finalize(p.replace(/<[^>]+>/g, " "));
    if (text && text.length >= 60) return text;
  }
  return "";
}

async function extractSummary(url) {
  const html = await fetchHtml(url, 6000);
  if (!html) return "";
  return pickDescription(html);
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  const target = event.queryStringParameters?.url;
  if (!target) return json(400, { summary: "" });

  try {
    const real = await resolveRealUrl(target);
    if (!real || real.includes("news.google.com")) return json(200, { summary: "" });
    return json(200, { summary: await extractSummary(real) });
  } catch (_) {
    return json(200, { summary: "" });
  }
};
