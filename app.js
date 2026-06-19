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
  let activeProviders = new Set(); // 활성화된 출처 필터 (다중 선택)

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
    // 출처 필터 (다중 선택). 활성 출처에 속한 기사만 표시
    list = list.filter((a) => activeProviders.has(a.provider));
    if (refineTerm) {
      const t = refineTerm.toLowerCase();
      list = list.filter((a) => a.title.toLowerCase().includes(t));
    }
    list.sort((a, b) => (sortOrder === "latest" ? b.ms - a.ms : a.ms - b.ms));
    filtered = list;
    shownCount = Math.min(PAGE_SIZE, filtered.length);
  }

  // ---- 출처 필터: 결과에 존재하는 출처 목록(고정 순서) ----
  const PROVIDER_ORDER = ["naver", "rss", "google"];
  function presentProviders() {
    const set = new Set(allArticles.map((a) => a.provider).filter(Boolean));
    return PROVIDER_ORDER.filter((p) => set.has(p));
  }
  function providerCount(p) {
    return allArticles.reduce((n, a) => n + (a.provider === p ? 1 : 0), 0);
  }

  // 출처 필터 칩 HTML (결과가 있을 때 항상 노출)
  function providerFilterHtml() {
    const present = presentProviders();
    if (present.length === 0) return "";
    const chips = present
      .map((p) => {
        const pm = PROVIDER_META[p];
        const on = activeProviders.has(p);
        return `<button type="button" class="pfilter${on ? " is-active" : ""}"
            data-provider="${p}" aria-pressed="${on}" title="${pm.label}">
            ${pm.svg}<span class="pfilter__name">${pm.short}</span>
            <span class="pfilter__count">${providerCount(p)}</span>
          </button>`;
      })
      .join("");
    return `
      <div class="provider-filter" id="providerFilter" role="group" aria-label="출처 필터">
        <span class="provider-filter__label">
          <span class="material-icons-round" aria-hidden="true">filter_list</span>출처
        </span>
        ${chips}
      </div>`;
  }

  // ---- 출처(데이터 제공 경로) 배지 — 브랜드 아이콘 ----
  const PROVIDER_META = {
    naver: {
      label: "네이버 검색",
      short: "네이버",
      svg: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect width="24" height="24" rx="6" fill="#03C75A"/><path fill="#fff" d="M13.9 12.3 9.7 6H6.2v12h3.9v-6.3l4.2 6.3h3.5V6h-3.9z"/></svg>`,
    },
    rss: {
      label: "신문사 공식 RSS",
      short: "RSS",
      svg: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect width="24" height="24" rx="6" fill="#EE802F"/><circle cx="7.4" cy="16.6" r="1.7" fill="#fff"/><path fill="#fff" d="M5.7 8.4v2.5a4.7 4.7 0 0 1 4.7 4.7h2.5A7.2 7.2 0 0 0 5.7 8.4z"/><path fill="#fff" d="M5.7 4.8v2.5A8.6 8.6 0 0 1 14.3 16h2.5A11.1 11.1 0 0 0 5.7 4.8z"/></svg>`,
    },
    google: {
      label: "구글 뉴스",
      short: "구글",
      svg: `<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.34A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.94H.96a9 9 0 0 0 0 8.12l3.01-2.34z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.47.89 11.43 0 9 0A9 9 0 0 0 .96 4.94l3.01 2.34C4.68 5.16 6.66 3.58 9 3.58z"/></svg>`,
    },
  };

  // ---- 카드 HTML ----
  function cardHtml(a, i = 0) {
    const safeLink = escapeHTML(a.link);

    // 네이버 공식 스니펫 / 신문사 RSS 요약이 있을 때만 표시 (전문 그대로)
    const summaryBlock = a.summary
      ? `<p class="card__summary">${escapeHTML(a.summary)}</p>`
      : "";

    // 데이터 수집 경로를 브랜드 아이콘으로만 간단히 표기 (출처·신빙성 구분)
    const pm = PROVIDER_META[a.provider];
    const providerBadge = pm
      ? `<span class="card__provider" title="${pm.label}" aria-label="출처: ${pm.label}">${pm.svg}</span>`
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
          ${providerBadge}
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
        ${providerFilterHtml()}
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

    // 출처 필터 토글 (다중 선택, 이벤트 위임)
    const filterEl = document.getElementById("providerFilter");
    if (filterEl) {
      filterEl.addEventListener("click", (e) => {
        const btn = e.target.closest(".pfilter[data-provider]");
        if (!btn) return;
        const p = btn.dataset.provider;
        if (activeProviders.has(p)) activeProviders.delete(p);
        else activeProviders.add(p);
        const on = activeProviders.has(p);
        btn.classList.toggle("is-active", on);
        btn.setAttribute("aria-pressed", String(on));
        applyFilterSort();
        renderGrid();
      });
    }
  }

  // ---- 그리드 + 더보기 렌더링 (셸은 유지) ----
  function renderGrid() {
    const grid = document.getElementById("grid");
    const loadMore = document.getElementById("loadMore");
    const count = document.getElementById("resultCount");
    if (!grid) return;

    count.textContent = `${filtered.length}개의 기사`;

    if (filtered.length === 0) {
      const msg =
        activeProviders.size === 0
          ? "표시할 출처를 하나 이상 선택해 주세요."
          : refineTerm
          ? `결과 내에서 '${escapeHTML(refineTerm)}'에 해당하는 기사가 없어요.`
          : "선택한 출처에 해당하는 기사가 없어요.";
      grid.innerHTML = `
        <p class="grid__empty">
          <span class="material-icons-round" aria-hidden="true">search_off</span>
          ${msg}
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
          provider: a.provider || "",
          date: formatDate(a.pubDate),
          ms: Number.isNaN(ms) ? 0 : ms,
        };
      });

      saveRecent(keyword);
      refineTerm = "";
      sortOrder = "latest";
      activeProviders = new Set(presentProviders()); // 모든 출처 기본 활성
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
