/* =========================================================
   뮤스 (Mews) — Musical News
   Netlify Function(news)을 통해 네이버 뉴스 검색 API + 국내 신문사 공식
   RSS를 합쳐 카드 형태로 렌더링합니다. (공식 요약 · 정렬 · 더보기 · 결과 내 검색)
   ========================================================= */

(() => {
  "use strict";

  const PAGE_SIZE = 9;
  const RECENT_KEY = "mews-recent";
  const THEME_KEY = "mews-theme";
  const RECENT_MAX = 6;
  const POPULAR = ["위키드", "레미제라블", "오페라의 유령", "지킬앤하이드", "라이온킹"];

  // ---- DOM 참조 ----
  const form = document.getElementById("searchForm");
  const input = document.getElementById("searchInput");
  const resetButton = document.getElementById("resetButton");
  const homeButton = document.getElementById("homeButton");
  const results = document.getElementById("results");
  const themeToggle = document.getElementById("themeToggle");
  const scrollTopBtn = document.getElementById("scrollTop");

  // 입력값 유무에 따라 초기화 버튼 표시
  function syncResetButton() {
    resetButton.hidden = input.value.trim() === "";
  }

  // ---- 상태 ----
  let allArticles = []; // 검색 결과 전체
  let filtered = []; // 정렬·필터 적용본
  let shownCount = 0; // 현재 노출 개수
  let sortOrder = "latest"; // latest | oldest
  let refineTerm = ""; // 결과 내 검색어
  let currentKeyword = ""; // 표시용 키워드

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

  // ---- 최근 검색어 (localStorage) ----
  function getRecent() {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.slice(0, RECENT_MAX) : [];
    } catch (_) {
      return [];
    }
  }

  function saveRecent(keyword) {
    try {
      const next = [keyword, ...getRecent().filter((k) => k !== keyword)].slice(
        0,
        RECENT_MAX
      );
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch (_) {}
  }

  // ---- 추천/최근 검색어 칩 HTML ----
  function suggestHtml() {
    const recent = getRecent();
    let html = "";

    if (recent.length) {
      html += `<span class="suggest__label">최근 검색</span>`;
      html += recent
        .map(
          (k, i) =>
            `<button type="button" class="chip chip--recent" data-query="${escapeHTML(
              k
            )}" style="animation-delay:${i * 40}ms">
               <span class="material-icons-round" aria-hidden="true">history</span>${escapeHTML(
                 k
               )}
             </button>`
        )
        .join("");
    }

    html += `<span class="suggest__label">인기 작품</span>`;
    html += POPULAR.map(
      (k, i) =>
        `<button type="button" class="chip chip--popular" data-query="${escapeHTML(
          k
        )}" style="animation-delay:${i * 40}ms">
           <span class="material-icons-round" aria-hidden="true">star</span>${escapeHTML(
             k
           )}
         </button>`
    ).join("");

    return html;
  }

  // ---- 상태 화면 ----
  function showIntro() {
    results.setAttribute("aria-busy", "false");
    results.innerHTML = `
      <div class="state state--intro">
        <span class="material-icons-round state__icon" aria-hidden="true">nights_stay</span>
        <p class="state__title">뮤지컬 작품명을 검색해 보세요</p>
        <p class="state__desc">관심 있는 작품의 최신 뉴스를 카드로 모아 드릴게요.</p>
        <div class="suggest" id="suggest" aria-label="추천 검색어">${suggestHtml()}</div>
      </div>`;
  }

  function skeletonCardsHtml(n) {
    const one = `
      <div class="skeleton-card" aria-hidden="true">
        <div class="skeleton-line skeleton-line--chip"></div>
        <div class="skeleton-line skeleton-line--title"></div>
        <div class="skeleton-line skeleton-line--title-2"></div>
        <div class="skeleton-line skeleton-line--text"></div>
        <div class="skeleton-line skeleton-line--text-2"></div>
        <div class="skeleton-line skeleton-line--date"></div>
      </div>`;
    return Array.from({ length: n }, () => one).join("");
  }

  function showLoading() {
    results.setAttribute("aria-busy", "true");
    results.innerHTML = `
      <div class="state state--loading">
        <div class="spinner" role="status" aria-label="검색 중"></div>
        <p class="state__title">뮤스가 검색 중입니다...</p>
        <p class="state__desc">당신을 위한 뮤지컬 소식을 가져오고 있어요.</p>
      </div>
      <div class="skeleton-grid" aria-hidden="true">${skeletonCardsHtml(6)}</div>`;
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
  function cardHtml(a, i = 0) {
    const safeLink = escapeHTML(a.link);

    // 신문사 RSS가 배포한 공식 요약이 있을 때만 표시
    const summaryBlock = a.summary
      ? `<p class="card__summary">${escapeHTML(a.summary)}</p>`
      : "";

    // 그리드 내 위치 기준 진입 애니메이션 지연 (과하지 않게 캡)
    const delay = Math.min(i, PAGE_SIZE - 1) * 45;

    return `
      <a class="card" href="${safeLink}" target="_blank" rel="noopener noreferrer"
         style="--card-delay:${delay}ms"
         data-link="${safeLink}">
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
        네이버 뉴스 검색과 국내 신문사 공식 RSS를 기반으로 제공됩니다.
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
    syncResetButton();
    const encoded = encodeURIComponent(`${keyword} 뮤지컬`); // 검색 품질 향상

    if (activeController) activeController.abort();
    activeController = new AbortController();

    showLoading();

    try {
      const res = await fetch(`/.netlify/functions/news?q=${encoded}`, {
        signal: activeController.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `서버 응답 오류 (${res.status})`);

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
          source: (a.source || "뉴스").trim(),
          summary: (a.summary || "").trim(),
          date: formatDate(a.pubDate),
          ms: Number.isNaN(ms) ? 0 : ms,
        };
      });

      saveRecent(keyword);
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
    syncResetButton();
    showIntro();
    input.focus();
  }

  // ---- 이벤트 바인딩 ----
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    runSearch(input.value);
  });

  input.addEventListener("input", syncResetButton);
  resetButton.addEventListener("click", resetAll);
  homeButton.addEventListener("click", resetAll);

  // 추천/최근 검색어 칩 클릭 (이벤트 위임)
  results.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip[data-query]");
    if (!chip) return;
    const q = chip.getAttribute("data-query");
    input.value = q;
    syncResetButton();
    runSearch(q);
  });

  // ---- 테마 토글 ----
  function setTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (_) {}
  }
  if (themeToggle) {
    themeToggle.addEventListener("click", () => {
      const current =
        document.documentElement.getAttribute("data-theme") === "dark"
          ? "dark"
          : "light";
      setTheme(current === "dark" ? "light" : "dark");
    });
  }

  // ---- 맨 위로 버튼 ----
  if (scrollTopBtn) {
    scrollTopBtn.hidden = false;
    const toggleScrollTop = () => {
      scrollTopBtn.classList.toggle("is-visible", window.scrollY > 400);
    };
    window.addEventListener("scroll", toggleScrollTop, { passive: true });
    scrollTopBtn.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    toggleScrollTop();
  }
})();
