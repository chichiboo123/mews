/* =========================================================
   뮤스 (Mews) — Musical News
   Netlify 프록시(_redirects)를 통해 구글 뉴스 RSS를 가져와
   CORS 제약 없이 카드 형태로 렌더링합니다.
   ========================================================= */

(() => {
  "use strict";

  // ---- 추천 뮤지컬 키워드 (한국 / 해외 작품 혼합) ----
  const SUGGESTED_KEYWORDS = [
    "마틸다", "위키드", "영웅", "레미제라블", "오페라의 유령",
    "하데스타운", "프랑켄슈타인", "지킬앤하이드", "킹키부츠", "캣츠",
    "데스노트", "햄릿", "물랑루즈", "벤허", "엘리자벳",
    "노트르담 드 파리", "시카고", "맘마미아", "광화문연가", "스위니토드",
    "젠틀맨스 가이드", "라이온킹", "billy elliot", "베토벤", "アラジン",
  ];

  // ---- DOM 참조 ----
  const form = document.getElementById("searchForm");
  const input = document.getElementById("searchInput");
  const tagList = document.getElementById("tagList");
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

  // ---- 추천 키워드 랜덤 셔플 & 렌더링 ----
  function renderTags(count = 7) {
    const shuffled = [...SUGGESTED_KEYWORDS].sort(() => Math.random() - 0.5);
    const picks = shuffled.slice(0, count);

    tagList.innerHTML = "";
    picks.forEach((keyword) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tag";
      btn.textContent = keyword;
      btn.addEventListener("click", () => {
        input.value = keyword;
        runSearch(keyword);
      });
      tagList.appendChild(btn);
    });
  }

  // ---- 상태 화면 렌더링 ----
  function showLoading() {
    results.setAttribute("aria-busy", "true");
    results.innerHTML = `
      <div class="state state--loading">
        <div class="spinner" role="status" aria-label="검색 중"></div>
        <p class="state__title">은하수 탐색 중...</p>
        <p class="state__desc">별빛 사이에서 뮤지컬 소식을 모으고 있어요.</p>
      </div>`;
  }

  function showError(message) {
    results.setAttribute("aria-busy", "false");
    results.innerHTML = `
      <div class="state state--error">
        <span class="material-icons-round state__icon" aria-hidden="true">cloud_off</span>
        <p class="state__title">소식을 불러오지 못했어요</p>
        <p class="state__desc">${escapeHTML(message)}</p>
      </div>`;
  }

  function showEmpty(keyword) {
    results.setAttribute("aria-busy", "false");
    results.innerHTML = `
      <div class="state">
        <span class="material-icons-round state__icon" aria-hidden="true">search_off</span>
        <p class="state__title">관련 뉴스를 찾지 못했어요</p>
        <p class="state__desc">‘${escapeHTML(keyword)}’에 대한 뮤지컬 소식이 아직 없어요. 다른 작품을 검색해 보세요.</p>
      </div>`;
  }

  // ---- 제목 정제: 끝의 " - 언론사명" 제거 ----
  function cleanTitle(rawTitle, sourceName) {
    let title = (rawTitle || "").trim();

    // source가 있으면 정확히 일치하는 접미사 우선 제거
    if (sourceName && title.endsWith(` - ${sourceName}`)) {
      title = title.slice(0, -(sourceName.length + 3));
    } else {
      // 일반 패턴: 맨 끝 " - 무언가" 한 덩어리 제거
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

    // 파싱 에러 감지
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
          <span class="results__keyword">‘${escapeHTML(keyword)}’</span> 뮤지컬 소식
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

    // 검색 품질 향상을 위해 " 뮤지컬" 강제 부착
    const searchQuery = `${keyword} 뮤지컬`;
    const encoded = encodeURIComponent(searchQuery);

    // Netlify 프록시 엔드포인트 (_redirects 참고)
    const url = `/google-news/?q=${encoded}&hl=ko&gl=KR&ceid=KR:ko`;

    // 이전 요청 취소
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
      if (err.name === "AbortError") return; // 새 검색으로 대체됨
      console.error(err);
      showError(
        "잠시 후 다시 시도해 주세요. (Netlify 환경에서 정상 동작합니다.)"
      );
    }
  }

  // ---- 이벤트 바인딩 ----
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    runSearch(input.value);
  });

  // ---- 초기화 ----
  renderTags();
})();
