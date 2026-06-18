/* =========================================================
   뮤스 (Mews) — Musical News
   /.netlify/functions/news 를 통해 구글 뉴스 RSS를 가져와
   CORS 제약 없이 카드 형태로 렌더링합니다.
   ========================================================= */

(() => {
  "use strict";

  // ---- DOM 참조 ----
  const form = document.getElementById("searchForm");
  const input = document.getElementById("searchInput");
  const results = document.getElementById("results");

  // ---- 유틸: HTML 이스케이프 (XSS 방지) ----
  const escapeHTML = (str) =>
    String(str ?? "").replace(
      /[&<>"']/g,
      (ch) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }[ch])
    );

  // ---- 상태 화면 렌더링 ----
  function showLoading() {
    results.setAttribute("aria-busy", "true");
    results.innerHTML = `
      <div class="state state--loading">
        <div class="spinner" role="status" aria-label="검색 중"></div>
        <p class="state__title">뮤스가 검색 중입니다...</p>
        <p class="state__desc">당신을 위한 뮤지컬 소식을 가져오고 있어요.</p>
      </div>`;
  }

  function showError(message) {
    results.setAttribute("aria-busy", "false");
    results.innerHTML = `
      <div class="state state--error">
        <span class="material-icons-round state__icon" aria-hidden="true">cloud_off</span>
        <p class="state__title">뉴스를 불러오지 못했습니다</p>
        <p class="state__desc">${escapeHTML(message)}</p>
      </div>`;
  }

  function showEmpty(keyword) {
    results.setAttribute("aria-busy", "false");
    results.innerHTML = `
      <div class="state">
        <span class="material-icons-round state__icon" aria-hidden="true">search_off</span>
        <p class="state__title">관련 뉴스가 없습니다</p>
        <p class="state__desc">'${escapeHTML(keyword)}' 뮤지컬에 대한 최신 뉴스를 찾지 못했어요. 다른 작품을 검색해 보세요.</p>
      </div>`;
  }

  // ---- 제목 정제: 끝의 " - 언론사명" 제거 ----
  function cleanTitle(rawTitle, sourceName) {
    let title = (rawTitle || "").trim();
    if (sourceName && title.endsWith(` - ${sourceName}`)) {
      title = title.slice(0, -(sourceName.length + 3));
    } else {
      title = title.replace(/\s+-\s+[^-]+$/, "");
    }
    return title.trim();
  }

  // ---- 날짜 정제: RFC 822 → YYYY년 MM월 DD일 ----
  function formatDate(pubDate) {
    if (!pubDate) return "";
    const date = new Date(pubDate);
    if (Number.isNaN(date.getTime())) return "";
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    return `${yyyy}년 ${mm}월 ${dd}일`;
  }

  // ---- XML(RSS) 파싱 → 기사 배열 ----
  function parseFeed(xmlText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, "application/xml");
    if (doc.querySelector("parsererror")) {
      throw new Error("응답 데이터를 해석하지 못했어요.");
    }
    const items = [...doc.querySelectorAll("item")];
    return items.map((item) => {
      const rawTitle = item.querySelector("title")?.textContent ?? "";
      const link = item.querySelector("link")?.textContent ?? "";
      const pubDate = item.querySelector("pubDate")?.textContent ?? "";
      const sourceName = item.querySelector("source")?.textContent ?? "";
      return {
        title: cleanTitle(rawTitle, sourceName),
        link: link.trim(),
        date: formatDate(pubDate),
        source: (sourceName || "구글 뉴스").trim(),
      };
    });
  }

  // ---- 결과 카드 렌더링 ----
  function renderResults(articles, keyword) {
    results.setAttribute("aria-busy", "false");

    const cards = articles
      .map((a, i) => {
        const safeLink = escapeHTML(a.link);
        const safeTitle = escapeHTML(a.title);
        const safeSource = escapeHTML(a.source);
        const safeDate = escapeHTML(a.date);
        const delay = Math.min(i * 0.04, 0.4);

        return `
          <a class="card" href="${safeLink}" target="_blank" rel="noopener noreferrer"
             style="animation-delay:${delay}s">
            <div class="card__top">
              <span class="card__source" title="${safeSource}">
                <span class="material-icons-round" aria-hidden="true">newspaper</span>
                ${safeSource}
              </span>
              <span class="card__link-icon" aria-hidden="true">
                <span class="material-icons-round">open_in_new</span>
              </span>
            </div>
            <h3 class="card__title">${safeTitle}</h3>
            ${
              safeDate
                ? `<span class="card__date">
                     <span class="material-icons-round" aria-hidden="true">calendar_today</span>
                     ${safeDate}
                   </span>`
                : ""
            }
          </a>`;
      })
      .join("");

    results.innerHTML = `
      <div class="results__head">
        <h2 class="results__title">
          <span class="results__keyword">'${escapeHTML(keyword)}'</span> 뮤지컬 소식
        </h2>
        <span class="results__count">${articles.length}개의 기사</span>
      </div>
      <div class="grid">${cards}</div>`;
  }

  // ---- 검색 실행 ----
  let activeController = null;

  async function runSearch(rawQuery) {
    const keyword = (rawQuery ?? "").trim();
    if (!keyword) {
      input.focus();
      return;
    }

    const searchQuery = `${keyword} 뮤지컬`;
    const encoded = encodeURIComponent(searchQuery);

    // Netlify Functions 엔드포인트
    const url = `/.netlify/functions/news?q=${encoded}&hl=ko&gl=KR&ceid=KR:ko`;

    if (activeController) activeController.abort();
    activeController = new AbortController();

    showLoading();

    try {
      const res = await fetch(url, { signal: activeController.signal });
      if (!res.ok) {
        throw new Error(`서버 응답 오류 (${res.status})`);
      }
      const xmlText = await res.text();
      const articles = parseFeed(xmlText);
      if (articles.length === 0) {
        showEmpty(keyword);
        return;
      }
      renderResults(articles, keyword);
    } catch (err) {
      if (err.name === "AbortError") return;
      console.error(err);
      showError("잠시 후 다시 시도해 주세요.");
    }
  }

  // ---- 이벤트 바인딩 ----
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    runSearch(input.value);
  });
})();
