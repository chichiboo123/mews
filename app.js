/* =========================================================
   뮤스 (Muse) — Musical News
   Netlify Functions(news / summary)를 통해 구글 뉴스를 가져와
   카드 형태로 렌더링합니다. (요약 · 정렬 · 더보기 · 결과 내 검색)
   ========================================================= */

(() => {
  "use strict";

  const PAGE_SIZE = 9;

  // ---- DOM 참조 ----
  const form = document.getElementById("searchForm");
  const input = document.getElementById("searchInput");
  const resetButton = document.getElementById("resetButton");
  const results = document.getElementById("results");

  // ---- 상태 ----
  let allArticles = []; // 검색 결과 전체
  let filtered = []; // 정렬·필터 적용본
  let shownCount = 0; // 현재 노출 개수
  let sortOrder = "latest"; // latest | oldest
  let refineTerm = ""; // 결과 내 검색어
  let currentKeyword = ""; // 표시용 키워드
  const summaryCache = new Map(); // link -> 요약(빈 문자열 포함)

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

  // ---- 상태 화면 ----
  function showIntro() {
    results.setAttribute("aria-busy", "false");
    results.innerHTML = `
      <div class="state state--intro">
        <span class="material-icons-round state__icon" aria-hidden="true">nights_stay</span>
        <p class="state__title">뮤지컬 작품명을 검색해 보세요</p>
      </div>`;
  }

  function showLoading() {
    results.setAttribute("aria-busy", "true");
    results.innerHTML = `
      <div class="state state--loading">
        <div class="spinner" role="status" aria-label="검색 중"></div>
        <p class="state__title">뮤즈가 검색 중입니다...</p>
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

  // ---- 정렬·필터 적용 (페이지네이션 초기화) ----
  function applyFilterSort() {
    let list = allArticles.slice();
    if (refineTerm) {
      const t = refineTerm.toLowerCase();
      list = list.filter((a) => a.title.toLowerCase().includes(t));
    }
    list.sort((a, b) => (sortOrder === "latest" ? b.ms - a.ms : a.ms - b.ms));
    filtered = list;
    shownCount = Math.min(PAGE_SIZE, filtered.length);
  }

  // ---- 카드 HTML ----
  function cardHtml(a) {
    const safeLink = escapeHTML(a.link);
    const cached = summaryCache.get(a.link); // undefined=미로딩, ''=결과없음
    const needs = cached === undefined;

    let summaryBlock = "";
    if (needs) {
      summaryBlock = `<p class="card__summary card__summary--loading" aria-hidden="true"></p>`;
    } else if (cached) {
      summaryBlock = `<p class="card__summary">${escapeHTML(cached)}</p>`;
    }

    return `
      <a class="card" href="${safeLink}" target="_blank" rel="noopener noreferrer"
         data-link="${safeLink}"${needs ? " data-needs-summary" : ""}>
        <div class="card__top">
          <span class="card__source" title="${escapeHTML(a.source)}">
            <span class="material-icons-round" aria-hidden="true">newspaper</span>
            ${escapeHTML(a.source)}
          </span>
          <span class="card__link-icon" aria-hidden="true">
            <span class="material-icons-round">open_in_new</span>
          </span>
        </div>
        <h3 class="card__title">${escapeHTML(a.title)}</h3>
        ${summaryBlock}
        ${
          a.date
            ? `<span class="card__date">
                 <span class="material-icons-round" aria-hidden="true">calendar_today</span>
                 ${escapeHTML(a.date)}
               </span>`
            : ""
        }
      </a>`;
  }

  // ---- 검색 결과 셸(헤더 + 컨트롤) 렌더링 ----
  function renderShell() {
    results.setAttribute("aria-busy", "false");
    results.innerHTML = `
      <div class="results__head">
        <div class="results__heading">
          <h2 class="results__title">
            <span class="results__keyword">'${escapeHTML(currentKeyword)}'</span> 뮤지컬 소식
          </h2>
          <span class="results__count" id="resultCount"></span>
        </div>
        <div class="results__controls">
          <label class="control control--select">
            <span class="material-icons-round" aria-hidden="true">sort</span>
            <span class="control__label">정렬</span>
            <select id="sortSelect" aria-label="정렬 기준">
              <option value="latest">최신순</option>
              <option value="oldest">오래된순</option>
            </select>
          </label>
          <div class="control control--search">
            <span class="material-icons-round" aria-hidden="true">filter_alt</span>
            <input type="search" id="refineInput" placeholder="결과 내 검색"
              aria-label="결과 내 검색" autocomplete="off" />
          </div>
        </div>
      </div>
      <p class="results__source">
        <span class="material-icons-round" aria-hidden="true">travel_explore</span>
        Google 뉴스 검색 결과를 기반으로 제공됩니다.
      </p>
      <div class="grid" id="grid"></div>
      <div class="load-more" id="loadMore"></div>`;

    // 컨트롤 이벤트 (셸은 검색당 1회만 생성되므로 입력 포커스 유지됨)
    const sortSelect = document.getElementById("sortSelect");
    sortSelect.value = sortOrder;
    sortSelect.addEventListener("change", (e) => {
      sortOrder = e.target.value;
      applyFilterSort();
      renderGrid();
    });

    let refineTimer;
    document.getElementById("refineInput").addEventListener("input", (e) => {
      clearTimeout(refineTimer);
      const value = e.target.value.trim();
      refineTimer = setTimeout(() => {
        refineTerm = value;
        applyFilterSort();
        renderGrid();
      }, 200);
    });
  }

  // ---- 그리드 + 더보기 렌더링 (셸은 유지) ----
  function renderGrid() {
    const grid = document.getElementById("grid");
    const loadMore = document.getElementById("loadMore");
    const count = document.getElementById("resultCount");
    if (!grid) return;

    count.textContent = `${filtered.length}개의 기사`;

    if (filtered.length === 0) {
      grid.innerHTML = `
        <p class="grid__empty">
          <span class="material-icons-round" aria-hidden="true">search_off</span>
          결과 내에서 '${escapeHTML(refineTerm)}'에 해당하는 기사가 없어요.
        </p>`;
      loadMore.innerHTML = "";
      return;
    }

    const shown = filtered.slice(0, shownCount);
    grid.innerHTML = shown.map(cardHtml).join("");

    if (shownCount < filtered.length) {
      loadMore.innerHTML = `
        <button type="button" class="load-more__btn" id="loadMoreBtn">
          <span class="material-icons-round" aria-hidden="true">expand_more</span>
          더보기
          <span class="load-more__count">${shownCount} / ${filtered.length}</span>
        </button>`;
      document.getElementById("loadMoreBtn").addEventListener("click", () => {
        shownCount = Math.min(shownCount + PAGE_SIZE, filtered.length);
        renderGrid();
      });
    } else {
      loadMore.innerHTML = "";
    }

    loadSummaries();
  }

  // ---- 요약 지연 로딩 (현재 그리드의 카드만, 동시 4개) ----
  async function loadSummaries() {
    const els = [...document.querySelectorAll(".card[data-needs-summary]")];
    if (els.length === 0) return;

    let i = 0;
    const worker = async () => {
      while (i < els.length) {
        const el = els[i++];
        el.removeAttribute("data-needs-summary");
        const link = el.dataset.link;

        let text = summaryCache.get(link);
        if (text === undefined) {
          text = await fetchSummary(link);
          summaryCache.set(link, text);
        }
        applySummary(el, text);
      }
    };

    await Promise.all(Array.from({ length: 4 }, worker));
  }

  async function fetchSummary(link) {
    try {
      const res = await fetch(
        `/.netlify/functions/summary?url=${encodeURIComponent(link)}`
      );
      if (!res.ok) return "";
      const data = await res.json();
      return (data.summary || "").trim();
    } catch (_) {
      return "";
    }
  }

  function applySummary(el, text) {
    const p = el.querySelector(".card__summary");
    if (!p) return;
    if (text) {
      p.textContent = text;
      p.classList.remove("card__summary--loading");
      p.removeAttribute("aria-hidden");
    } else {
      p.remove();
    }
  }

  // ---- 검색 실행 ----
  let activeController = null;

  async function runSearch(rawQuery) {
    const keyword = (rawQuery ?? "").trim();
    if (!keyword) {
      input.focus();
      return;
    }

    currentKeyword = keyword;
    const encoded = encodeURIComponent(`${keyword} 뮤지컬`); // 검색 품질 향상

    if (activeController) activeController.abort();
    activeController = new AbortController();

    showLoading();

    try {
      const res = await fetch(`/.netlify/functions/news?q=${encoded}`, {
        signal: activeController.signal,
      });
      if (!res.ok) throw new Error(`서버 응답 오류 (${res.status})`);

      const data = await res.json();
      const articles = data.articles || [];

      if (articles.length === 0) {
        showEmpty(keyword);
        return;
      }

      allArticles = articles.map((a) => {
        const ms = a.pubDate ? Date.parse(a.pubDate) : 0;
        return {
          title: cleanTitle(a.title, a.source),
          link: (a.link || "").trim(),
          source: (a.source || "구글 뉴스").trim(),
          date: formatDate(a.pubDate),
          ms: Number.isNaN(ms) ? 0 : ms,
        };
      });

      refineTerm = "";
      sortOrder = "latest";
      applyFilterSort();
      renderShell();
      renderGrid();
    } catch (err) {
      if (err.name === "AbortError") return;
      console.error(err);
      showError("잠시 후 다시 시도해 주세요.");
    }
  }

  // ---- 초기화 ----
  function resetAll() {
    if (activeController) activeController.abort();
    allArticles = [];
    filtered = [];
    shownCount = 0;
    sortOrder = "latest";
    refineTerm = "";
    currentKeyword = "";
    input.value = "";
    showIntro();
    input.focus();
  }

  // ---- 이벤트 바인딩 ----
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    runSearch(input.value);
  });

  resetButton.addEventListener("click", resetAll);
})();
