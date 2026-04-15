(function () {
  "use strict";

  /* ─── Constants ─── */
  const DEFAULT_TARGET        = 20;
  const REVIEW_STEPS          = [1, 2, 4, 7, 15, 30];
  const MAX_STAGE             = REVIEW_STEPS.length - 1;
  const STORAGE_KEY           = "en-training-state-v2";
  const SETTINGS_KEY          = "en-training-settings-v1";
  const EXAMPLE_CACHE_KEY     = "en-training-examples-v1";
  const DEFAULT_INTEREST_TAGS = ["美剧", "科技", "游戏", "职场", "商业"];
  const IS_GITHUB_PAGES       = window.location.hostname.endsWith("github.io");
  const USE_SERVER_API        = !IS_GITHUB_PAGES;
  const APP_ROOT              = (() => {
    if (!IS_GITHUB_PAGES) return "/";
    const seg = window.location.pathname.split("/").filter(Boolean);
    return seg.length > 0 ? `/${seg[0]}/` : "/";
  })();

  function withRoot(path) {
    return `${APP_ROOT}${String(path || "").replace(/^\/+/, "")}`;
  }

  /* ─── DOM refs ─── */
  const $  = (id) => document.getElementById(id);
  const dom = {
    views: {
      home:     $("homeView"),
      quiz:     $("quizView"),
      feedback: $("feedbackView"),
      answer:   $("answerView"),
      done:     $("doneView"),
    },
    // settings
    settingsToggle:  $("settingsToggle"),
    settingsPanel:   $("settingsPanel"),
    cfgBaseUrl:      $("cfgBaseUrl"),
    cfgApiKey:       $("cfgApiKey"),
    cfgModel:        $("cfgModel"),
    // interest tags (home page)
    interestTagList: $("interestTagList"),
    interestTagInput:$("interestTagInput"),
    interestTagAdd:  $("interestTagAdd"),
    settingsSave:    $("settingsSave"),
    settingsClear:   $("settingsClear"),
    settingsStatus:  $("settingsStatus"),
    // home
    statNew:         $("statNew"),
    statInProgress:  $("statInProgress"),
    statMastered:    $("statMastered"),
    countInput:      $("countInput"),
    countMinus:      $("countMinus"),
    countPlus:       $("countPlus"),
    todayBoard:      $("todayBoard"),
    overflowHint:    $("overflowHint"),
    progressBar:     $("progressBar"),
    progressText:    $("progressText"),
    startBtn:        $("startBtn"),
    // quiz
    quizBackBtn:     $("quizBackBtn"),
    quizProgressText:$("quizProgressText"),
    speakBtn:        $("speakBtn"),
    dpNewBar:        $("dpNewBar"),
    dpReviewBar:     $("dpReviewBar"),
    modeTag:         $("modeTag"),
    questionText:    $("questionText"),
    questionHint:    $("questionHint"),
    answerForm:      $("answerForm"),
    answerInput:     $("answerInput"),
    submitBtn:       $("submitBtn"),
    micBtn:          $("micBtn"),
    skipBtn:         $("skipBtn"),
    // feedback
    feedbackProgressText: $("feedbackProgressText"),
    feedbackCard:    $("feedbackCard"),
    feedbackStatus:  $("feedbackStatus"),
    feedbackMsg:     $("feedbackMsg"),
    feedbackCompare: $("feedbackCompare"),
    // answer + judge banner
    judgeBanner:      $("judgeBanner"),
    judgeStatusText:  $("judgeStatusText"),
    judgeMsgText:     $("judgeMsgText"),
    judgeCompareText: $("judgeCompareText"),
    answerBackBtn:    $("answerBackBtn"),
    answerProgressText: $("answerProgressText"),
    answerSpeakBtn:   $("answerSpeakBtn"),
    answerSpeakBtnCard: $("answerSpeakBtnCard"),
    answerWord:       $("answerWord"),
    answerPhonetic:   $("answerPhonetic"),
    answerMeaning:    $("answerMeaning"),
    rootCard:         $("rootCard"),
    exampleCard:      $("exampleCard"),
    chainPrompt:      $("chainPrompt"),
    nextBtn:          $("nextBtn"),
    // done
    doneStats:   $("doneStats"),
    restartBtn:  $("restartBtn"),
  };

  /* ─── Runtime (not persisted) ─── */
  const rt = {
    words:               [],
    state:               null,
    settings:            { baseUrl: "", apiKey: "", model: "", interestTags: [] },
    exampleCache:        {},
    preloadedExampleWord: null,
    pendingChainItem:    null,
    currentFeedback:     null,
    currentWordInfo:     null,
    currentUserInput:    null,
    voiceRec:            null,
    voiceActive:         false,
    quizBg:              '#3DDE6C',
    meaningsDb:          {},
  };

  /* ════════════════════════════════
     DATE HELPERS
  ════════════════════════════════ */

  function todayStr() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function dateAddDays(dateStr, days) {
    const d = new Date(`${dateStr}T00:00:00`);
    d.setDate(d.getDate() + days);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  /* ════════════════════════════════
     PERSISTENCE
  ════════════════════════════════ */

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) { /* ignore */ }
    return { pointer: 0, wordMeta: {}, wordOrder: null, targetDailyCount: DEFAULT_TARGET, today: null };
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rt.state));
  }

  /* ── User API settings (BYOK + interest tags) ── */
  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (!s.interestTags) s.interestTags = [];
        return s;
      }
    } catch (_) { /* ignore */ }
    return { baseUrl: "", apiKey: "", model: "", interestTags: [] };
  }

  function saveSettings(s) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }

  /* ── Example sentence cache (user-layer, localStorage only) ── */
  function loadExampleCache() {
    try {
      const raw = localStorage.getItem(EXAMPLE_CACHE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return {};
  }

  function saveExampleCache() {
    localStorage.setItem(EXAMPLE_CACHE_KEY, JSON.stringify(rt.exampleCache));
  }

  function getCachedExample(word, tag) {
    return rt.exampleCache[`${word.toLowerCase()}:${tag}`] || null;
  }

  function setCachedExample(word, tag, data) {
    rt.exampleCache[`${word.toLowerCase()}:${tag}`] = data;
    saveExampleCache();
  }

  function localMeaningsFor(word) {
    const key = String(word || "").toLowerCase();
    const list = rt.meaningsDb[key];
    return Array.isArray(list) ? list : [];
  }

  /** Returns fetch headers that include user BYOK if configured. */
  function apiHeaders() {
    const h = { "Content-Type": "application/json" };
    const s = rt.settings;
    if (s.apiKey)  h["X-Api-Key"]   = s.apiKey;
    if (s.baseUrl) h["X-Api-Base"]  = s.baseUrl;
    if (s.model)   h["X-Api-Model"] = s.model;
    return h;
  }

  /* ════════════════════════════════
     VIEW SWITCHING
  ════════════════════════════════ */

  function setScene(name) {
    const fixed = { home: '#FAFAFA', answer: '#111111', done: '#111111' };
    const bg = Object.prototype.hasOwnProperty.call(fixed, name) ? fixed[name] : rt.quizBg;
    document.documentElement.style.setProperty('--scene-bg', bg);
    document.body.dataset.scene = name;
  }

  function showView(name) {
    Object.values(dom.views).forEach((v) => v.classList.remove("active"));
    dom.views[name].classList.add("active");
    setScene(name);
  }

  /* ════════════════════════════════
     SHUFFLE
  ════════════════════════════════ */

  function shuffleArray(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }


  /* ════════════════════════════════
     WORD PICKING (exclude set)
  ════════════════════════════════ */

  function pickDueReviews(max, exclude) {
    const today = todayStr();
    return Object.entries(rt.state.wordMeta)
      .filter(([w, meta]) =>
        meta.nextReview && meta.nextReview <= today && !exclude.has(w)
      )
      .sort((a, b) => (a[1].nextReview < b[1].nextReview ? -1 : 1))
      .slice(0, max)
      .map(([w]) => w);
  }

  function pickNewWords(max, exclude) {
    const order = rt.state.wordOrder;
    const result = [];
    let ptr = rt.state.pointer;
    while (ptr < order.length && result.length < max) {
      const w = order[ptr];
      ptr++;
      const meta = rt.state.wordMeta[w];
      const isNew = !meta || (!meta.nextReview && meta.stage === undefined);
      if (isNew && !exclude.has(w)) result.push(w);
    }
    rt.state.pointer = ptr;
    return result;
  }

  /* ════════════════════════════════
     EBBINGHAUS – LARGE CYCLE SETTLE
  ════════════════════════════════ */

  function settleLargeCycle() {
    const s = rt.state;
    if (!s.today || s.today.settled) return;
    const today = todayStr();
    const records = s.today.records || {};

    Object.entries(records).forEach(([word, rec]) => {
      if (!rec.finalCorrect) return;
      const meta = s.wordMeta[word] || { meaning: "", phonetic: "", stage: -1 };
      if (rec.hadWrong) {
        meta.stage = 0;
      } else {
        meta.stage = Math.min((meta.stage === undefined ? -1 : meta.stage) + 1, MAX_STAGE);
      }
      const interval = REVIEW_STEPS[Math.max(0, meta.stage)];
      meta.nextReview = dateAddDays(today, interval);
      s.wordMeta[word] = meta;
    });

    s.today.settled = true;
    saveState();
  }

  /* ════════════════════════════════
     PLAN CREATION
  ════════════════════════════════ */

  function createTodayPlan(targetCount) {
    const today = todayStr();
    const exclude = new Set();

    const reviewMax = Math.round(targetCount * 0.6);
    const allDueReviews = pickDueReviews(9999, exclude);
    const reviewWords = allDueReviews.slice(0, reviewMax);
    const totalOverdue = allDueReviews.length;

    reviewWords.forEach((w) => exclude.add(w));

    const newMax = targetCount - reviewWords.length;
    const newWords = pickNewWords(newMax, exclude);

    const queue = shuffleArray([
      ...reviewWords.map((w) => ({ word: w, source: "review" })),
      ...newWords.map((w) => ({ word: w, source: "new" })),
    ]);

    rt.state.today = {
      date: today,
      targetCount,
      queue,
      initialTotal: queue.length,
      newTotal: newWords.length,
      reviewTotal: reviewWords.length,
      totalOverdueReview: totalOverdue,
      newDone: 0,
      reviewDone: 0,
      records: {},
      correctCount: 0,
      closeCount: 0,
      wrongCount: 0,
      settled: false,
      startAt: Date.now(),
    };
    saveState();
  }

  /* ════════════════════════════════
     ENSURE TODAY'S PLAN
  ════════════════════════════════ */

  function ensureTodayPlan() {
    const s = rt.state;
    const today = todayStr();

    if (s.today && s.today.date !== today && !s.today.settled) {
      settleLargeCycle();
    }

    if (!s.today || s.today.date !== today) {
      createTodayPlan(s.targetDailyCount || DEFAULT_TARGET);
    }
  }

  /* ════════════════════════════════
     DYNAMIC PLAN ADJUSTMENT
  ════════════════════════════════ */

  function adjustTodayPlan(newTarget) {
    const t = rt.state.today;
    const attempted = new Set(Object.keys(t.records));
    const currentEffective = attempted.size + t.queue.length;

    if (newTarget > currentEffective) {
      const toAdd = newTarget - currentEffective;
      const existing = new Set([...attempted, ...t.queue.map((i) => i.word)]);

      const reviewAdd = pickDueReviews(Math.round(toAdd * 0.6), existing);
      reviewAdd.forEach((w) => existing.add(w));
      const newAdd = pickNewWords(toAdd - reviewAdd.length, existing);

      const extra = [
        ...reviewAdd.map((w) => ({ word: w, source: "review" })),
        ...newAdd.map((w) => ({ word: w, source: "new" })),
      ];
      t.queue.push(...extra);
      t.reviewTotal += reviewAdd.length;
      t.newTotal    += newAdd.length;

    } else if (newTarget < currentEffective) {
      const removable = t.queue.filter((i) => !attempted.has(i.word));
      const toRemove  = Math.min(currentEffective - newTarget, removable.length);
      let removed = 0;
      for (let i = t.queue.length - 1; i >= 0 && removed < toRemove; i--) {
        if (!attempted.has(t.queue[i].word)) {
          const item = t.queue.splice(i, 1)[0];
          if (item.source === "review") t.reviewTotal = Math.max(0, t.reviewTotal - 1);
          else t.newTotal = Math.max(0, t.newTotal - 1);
          removed++;
        }
      }
    }

    rt.state.targetDailyCount = newTarget;
    t.targetCount  = newTarget;
    t.initialTotal = attempted.size + t.queue.length;
    saveState();
    updateDashboard();
    updateQuizProgress();
  }

  /* ════════════════════════════════
     STATS (home look-board)
  ════════════════════════════════ */

  function computeStats() {
    const meta    = rt.state.wordMeta;
    const records = (rt.state.today && rt.state.today.records) || {};
    let newCount = 0, inProgress = 0, mastered = 0;

    rt.words.forEach((w) => {
      const m     = meta[w];
      const stage = m ? (m.stage !== undefined ? m.stage : -1) : -1;

      if (stage >= MAX_STAGE) {
        mastered++;
      } else if (stage >= 0 || (m && m.nextReview) || records[w]) {
        // stage 已推进过，或历史上已结算过（有 nextReview），或今天已答过
        inProgress++;
      } else {
        newCount++;
      }
    });

    dom.statNew.textContent        = newCount;
    dom.statInProgress.textContent = inProgress;
    dom.statMastered.textContent   = mastered;
  }

  /* ════════════════════════════════
     DASHBOARD (home plan card)
  ════════════════════════════════ */

  function updateDashboard() {
    const t = rt.state.today;
    if (!t) return;

    const settled = t.newDone + t.reviewDone;
    const total   = t.initialTotal;
    const progress = total > 0 ? Math.round((settled / total) * 100) : 0;

    dom.todayBoard.textContent = `新词 ${t.newTotal} · 复习 ${t.reviewTotal}`;

    const overflow = t.totalOverdueReview - t.reviewTotal;
    if (overflow > 0) {
      dom.overflowHint.textContent = `另有 ${overflow} 个复习词待追回`;
      dom.overflowHint.classList.remove("hidden");
    } else {
      dom.overflowHint.classList.add("hidden");
    }

    dom.progressBar.style.width = `${progress}%`;
    dom.progressText.textContent = `${settled} / ${total}`;
  }

  /* ════════════════════════════════
     QUIZ PROGRESS
  ════════════════════════════════ */

  function updateQuizProgress() {
    const t = rt.state.today;
    if (!t) return;

    const nDone = t.newDone,    nTotal = t.newTotal;
    const rDone = t.reviewDone, rTotal = t.reviewTotal;

    const text = `新词 ${nDone}/${nTotal} · 复习 ${rDone}/${rTotal}`;
    dom.quizProgressText.textContent      = text;
    dom.feedbackProgressText.textContent  = text;
    dom.answerProgressText.textContent    = text;

    dom.dpNewBar.style.width    = nTotal > 0 ? `${Math.round((nDone / nTotal) * 100)}%` : "0%";
    dom.dpReviewBar.style.width = rTotal > 0 ? `${Math.round((rDone / rTotal) * 100)}%` : "0%";
  }

  /* ════════════════════════════════
     WORD META — parallel fetch
     /api/meaning (fast, local DB) and /api/wordinfo (AI, slow)
     are fired in parallel when both are needed.
  ════════════════════════════════ */

  async function ensureWordMeta(word) {
    if (!rt.state.wordMeta[word]) {
      rt.state.wordMeta[word] = { meaning: "", phonetic: "", stage: -1, nextReview: "" };
    }
    const meta = rt.state.wordMeta[word];

    const needMeaning  = !meta.meaning;
    const needPhonetic = !meta.phonetic;

    if (needMeaning) {
      const localMeanings = localMeaningsFor(word);
      if (localMeanings.length > 0) {
        meta.meaning = localMeanings.join(" / ");
      }
    }

    if (!needMeaning && !needPhonetic) return meta;

    if (!USE_SERVER_API) {
      saveState();
      return meta;
    }

    // Fire both requests in parallel
    const tasks = [];

    if (needMeaning) {
      tasks.push(
        fetch(withRoot(`api/meaning?word=${encodeURIComponent(word)}`))
          .then((r) => r.ok ? r.json() : null)
          .then((d) => {
            if (d && d.meanings && d.meanings.length > 0) {
              meta.meaning = d.meanings.join(" / ");
            }
          })
          .catch(() => {})
      );
    }

    if (needPhonetic) {
      tasks.push(
        fetch(withRoot(`api/wordinfo?word=${encodeURIComponent(word)}`), { headers: apiHeaders() })
          .then((r) => r.ok ? r.json() : null)
          .then((d) => {
            if (d) {
              if (d.phonetic) meta.phonetic = d.phonetic;
              if (d.meaning && !meta.meaning) meta.meaning = d.meaning;
            }
          })
          .catch(() => {})
      );
    }

    await Promise.all(tasks);
    saveState();
    return meta;
  }

  /* ════════════════════════════════
     MODE DETECTION
  ════════════════════════════════ */

  function modeForItem(item, meta) {
    if (item.source === "review" && meta && meta.meaning) return "cn-en";
    return "en-cn";
  }

  /* ════════════════════════════════
     WORD ROOTS CARD
  ════════════════════════════════ */

  function renderRootCard(word) {
    const roots = Array.isArray(window.WordRoots) ? window.WordRoots : [];
    const lower = word.toLowerCase();

    const matched = roots
      .filter((entry) => {
        const token = String(entry.root || "").toLowerCase().replace(/[^a-z]/g, "");
        return token.length >= 2 && lower.includes(token);
      })
      .slice(0, 2);

    if (!matched.length) {
      dom.rootCard.classList.add("hidden");
      dom.rootCard.innerHTML = "";
      return [];
    }

    const html = matched.map((entry) => {
      const examples = (entry.examples || []).slice(0, 2);
      const listItems = examples.map((x) => `<li>${x.word}：${x.meaning}</li>`).join("");
      return `<section>
        <h3>${entry.root} · ${entry.meaning}</h3>
        <p>${entry.description || ""}</p>
        ${listItems ? `<ul>${listItems}</ul>` : ""}
      </section>`;
    });

    dom.rootCard.classList.remove("hidden");
    dom.rootCard.innerHTML = `<h3>词根词缀解析</h3>${html.join("")}`;
    return matched;
  }

  /* ════════════════════════════════
     P1-1: AI EXAMPLE SENTENCE
     User-layer cache only. Random tag. One sentence per word.
  ════════════════════════════════ */

  /**
   * Pre-load example sentence while user is still on the quiz view.
   * Stores result silently into dom.exampleCard (hidden view).
   * renderAnswer will skip the reset if word matches preloadedExampleWord.
   */
  async function preloadExampleForWord(word, meaning) {
    if (!USE_SERVER_API) {
      dom.exampleCard.classList.add("hidden");
      dom.exampleCard.innerHTML = "";
      return;
    }
    rt.preloadedExampleWord = word;
    // (re)set card to loading state so it's ready when answer view shows)
    dom.exampleCard.classList.add("hidden");
    dom.exampleCard.innerHTML = "";

    const tags = (rt.settings.interestTags && rt.settings.interestTags.length > 0)
      ? rt.settings.interestTags
      : DEFAULT_INTEREST_TAGS;
    const shuffledTags = shuffleArray(tags);

    // Cache hit: render immediately (will show when answer view activates)
    for (const tag of shuffledTags) {
      const cached = getCachedExample(word, tag);
      if (cached) {
        _renderExampleCard(cached, tag);
        return;
      }
    }

    // No cache — show loading placeholder, then fetch
    const chosenTag = shuffledTags[0];
    dom.exampleCard.innerHTML = `<p class="example-loading">AI 正在生成「${chosenTag}」场景例句…</p>`;
    dom.exampleCard.classList.remove("hidden");

    try {
      const r = await fetch(
        withRoot(`api/example?word=${encodeURIComponent(word)}&meaning=${encodeURIComponent(meaning)}&tag=${encodeURIComponent(chosenTag)}`),
        { headers: apiHeaders() }
      );
      if (!r.ok) throw new Error();
      const d = await r.json();
      // Only commit if user hasn't moved to a different word
      if (rt.preloadedExampleWord === word && d.en && d.cn) {
        setCachedExample(word, chosenTag, d);
        _renderExampleCard(d, chosenTag);
      } else if (rt.preloadedExampleWord === word) {
        dom.exampleCard.classList.add("hidden");
      }
    } catch (_) {
      if (rt.preloadedExampleWord === word) {
        dom.exampleCard.classList.add("hidden");
      }
    }
  }

  // Legacy alias kept for any direct call sites; now just calls preload
  async function fetchExampleAsync(word, meaning) {
    if (!USE_SERVER_API) return;
    // Reset example card
    dom.exampleCard.classList.add("hidden");
    dom.exampleCard.innerHTML = "";

    const tags = (rt.settings.interestTags && rt.settings.interestTags.length > 0)
      ? rt.settings.interestTags
      : DEFAULT_INTEREST_TAGS;

    // Shuffle to randomise which tag we check first
    const shuffledTags = shuffleArray(tags);

    // Check cache for any tag (use first cache hit found)
    for (const tag of shuffledTags) {
      const cached = getCachedExample(word, tag);
      if (cached) {
        _renderExampleCard(cached, tag);
        return;
      }
    }

    // No cache — pick the first (already random) tag and generate
    const chosenTag = shuffledTags[0];

    dom.exampleCard.innerHTML = `<p class="example-loading">AI 正在生成「${chosenTag}」场景例句…</p>`;
    dom.exampleCard.classList.remove("hidden");

    try {
      const r = await fetch(
        withRoot(`api/example?word=${encodeURIComponent(word)}&meaning=${encodeURIComponent(meaning)}&tag=${encodeURIComponent(chosenTag)}`),
        { headers: apiHeaders() }
      );
      if (!r.ok) throw new Error();
      const d = await r.json();
      if (d.en && d.cn) {
        setCachedExample(word, chosenTag, d);
        _renderExampleCard(d, chosenTag);
      } else {
        dom.exampleCard.classList.add("hidden");
      }
    } catch (_) {
      dom.exampleCard.classList.add("hidden");
    }
  }

  function _renderExampleCard(data, tag) {
    dom.exampleCard.innerHTML =
      `<span class="example-tag">${tag}</span>` +
      `<p class="example-en">${data.en}</p>` +
      `<p class="example-cn">${data.cn}</p>`;
    dom.exampleCard.classList.remove("hidden");
  }

  /* ════════════════════════════════
     P1-2: DERIVED WORD CHAIN
     Finds a sibling word from the same root,
     injects it as the very next queue item (position +1),
     and optionally upserts new words into wordbank-extra.
  ════════════════════════════════ */

  function findDerivedCandidate(baseWord, matchedRoots) {
    const today = rt.state.today;
    const askedTargets = new Set((today.chainAskedTargets  || []).map((w) => w.toLowerCase()));
    const askedBases   = new Set((today.chainAskedBaseWords|| []).map((w) => w.toLowerCase()));

    if (askedBases.has(baseWord.toLowerCase())) return null;

    const wordSet = new Set(rt.words.map((w) => w.toLowerCase()));

    // First pass: prefer wordbank words
    for (const root of matchedRoots) {
      for (const ex of (root.examples || [])) {
        const w = (ex.word || "").toLowerCase().trim();
        if (!w || w === baseWord.toLowerCase() || askedTargets.has(w)) continue;
        if (wordSet.has(w)) {
          const original = rt.words.find((rw) => rw.toLowerCase() === w) || ex.word;
          return { word: original, root, example: ex, inWordbank: true };
        }
      }
    }

    // Second pass: non-wordbank examples (will be upserted)
    for (const root of matchedRoots) {
      for (const ex of (root.examples || [])) {
        const w = (ex.word || "").toLowerCase().trim();
        if (!w || w === baseWord.toLowerCase() || askedTargets.has(w)) continue;
        return { word: ex.word, root, example: ex, inWordbank: false };
      }
    }

    return null;
  }

  /**
   * Sync entry point called from renderAnswer.
   * Sets rt.pendingChainItem immediately (template prompt),
   * then async-enriches with AI question text and upserts if needed.
   */
  function maybeTriggerChain(baseWord, status, matchedRoots) {
    if (!matchedRoots || matchedRoots.length === 0) return;
    if (status !== "correct" && status !== "close") return;

    const candidate = findDerivedCandidate(baseWord, matchedRoots);
    if (!candidate) return;

    const today = rt.state.today;
    if (!today.chainAskedBaseWords) today.chainAskedBaseWords = [];
    if (!today.chainAskedTargets)   today.chainAskedTargets   = [];
    today.chainAskedBaseWords.push(baseWord.toLowerCase());
    today.chainAskedTargets.push(candidate.word.toLowerCase());
    saveState();

    // Build template question synchronously (instant, no AI needed)
    const rootInfo   = candidate.root;
    const prompt     =
      `词根 [${rootInfo.root}] 表示「${rootInfo.meaning}」，你刚学了「${baseWord}」。` +
      `那么同词根的「${candidate.word}」是什么意思呢？`;

    rt.pendingChainItem = {
      word:           candidate.word,
      source:         "chain",
      kind:           "chain",
      promptOverride: prompt,
      baseWord,
    };

    // Async enrichment: better AI question text + upsert new words (fire-and-forget)
    if (USE_SERVER_API) {
      _enrichChainAsync(baseWord, candidate).catch(() => {});
    }
  }

  async function _enrichChainAsync(baseWord, candidate) {
    // Upsert word into bottom lexicon if not in wordbank
    if (!candidate.inWordbank) {
      try {
        const r = await fetch(withRoot("api/lexicon/upsert"), {
          method:  "POST",
          headers: apiHeaders(),
          body:    JSON.stringify({ word: candidate.word }),
        });
        if (r.ok) {
          const d = await r.json();
          if (d.word && !rt.words.includes(d.word)) {
            rt.words.push(d.word);
            // Insert at a random future position in wordOrder so it enters the normal queue
            const ptr       = rt.state.pointer;
            const remaining = rt.state.wordOrder.length - ptr;
            const insertPos = ptr + Math.floor(Math.random() * Math.max(1, remaining));
            rt.state.wordOrder.splice(insertPos, 0, d.word);
            saveState();
          }
        }
      } catch (_) {}
    }

    // Try AI for a richer question prompt (update pending item if user hasn't moved on)
    try {
      const r = await fetch(withRoot("api/derived-question"), {
        method:  "POST",
        headers: apiHeaders(),
        body:    JSON.stringify({
          baseWord,
          root:        candidate.root.root,
          rootMeaning: candidate.root.meaning,
          derivedWord: candidate.word,
        }),
      });
      if (r.ok) {
        const d = await r.json();
        if (d.question && rt.pendingChainItem && rt.pendingChainItem.word === candidate.word) {
          rt.pendingChainItem.promptOverride = d.question;
        }
      }
    } catch (_) {}
  }

  /* ════════════════════════════════
     BUTTON LOADING STATE
  ════════════════════════════════ */

  function setQuizBtnsLoading(loading) {
    dom.submitBtn.disabled = loading;
    dom.skipBtn.disabled   = loading;
    dom.submitBtn.classList.toggle('is-loading', loading);
  }

  function setNextBtnLoading(loading) {
    dom.nextBtn.disabled = loading;
    if (loading) {
      dom.nextBtn.dataset.originalText = dom.nextBtn.textContent;
      dom.nextBtn.textContent = "加载中…";
    } else {
      if (dom.nextBtn.dataset.originalText) {
        dom.nextBtn.textContent = dom.nextBtn.dataset.originalText;
      }
    }
  }

  /* ════════════════════════════════
     RENDER QUIZ — non-blocking
     Shows the question immediately if data is cached,
     or shows the view with a loading skeleton while fetching.
  ════════════════════════════════ */

  function currentItem() {
    return (rt.state.today && rt.state.today.queue[0]) || null;
  }

  async function renderQuiz() {
    updateDashboard();
    updateQuizProgress();

    const item = currentItem();
    if (!item) { finishSession(); return; }

    const cachedMeta = rt.state.wordMeta[item.word];

    // Determine if we can show the question right now without any API call
    // en-cn: the word itself is the question — always available immediately
    // cn-en: need the meaning — available if already cached
    const previewMode = modeForItem(item, cachedMeta);
    const canShowNow  = previewMode === "en-cn" || (cachedMeta && cachedMeta.meaning);

    // Set full-screen scene color: green for en-cn (new words), yellow for cn-en (review)
    rt.quizBg = previewMode === 'cn-en' ? '#FFD60A' : '#3DDE6C';

    if (canShowNow) {
      // Render immediately
      _applyQuizUI(item, cachedMeta || {}, previewMode);
      showView("quiz");
      setQuizBtnsLoading(false);
      setTimeout(() => dom.answerInput.focus(), 30);

      // Fetch remaining metadata, then preload example sentence in background
      ensureWordMeta(item.word).then((meta) => {
        preloadExampleForWord(item.word, meta.meaning || "");
      });
    } else {
      // Must wait for meaning — show skeleton loading state first
      dom.modeTag.textContent       = "加载中…";
      dom.questionText.textContent  = "⋯";
      dom.questionText.classList.remove("question-cn");
      dom.questionHint.textContent  = "";
      dom.answerInput.disabled      = true;
      setQuizBtnsLoading(true);
      showView("quiz");

      const meta = await ensureWordMeta(item.word);
      const mode = modeForItem(item, meta);
      _applyQuizUI(item, meta, mode);
      dom.answerInput.disabled = false;
      setQuizBtnsLoading(false);
      setTimeout(() => dom.answerInput.focus(), 30);

      // Preload example now that we have the meaning
      preloadExampleForWord(item.word, meta.meaning || "");
    }

    item.mode = previewMode;
    saveState();
  }

  function _applyQuizUI(item, meta, mode) {
    // Chain question label + prompt
    if (item.kind === "chain") {
      dom.modeTag.textContent = "词族连环问";
      dom.chainPrompt.textContent = item.promptOverride || "";
      dom.chainPrompt.classList.remove("hidden");
    } else {
      dom.modeTag.textContent = mode === "en-cn" ? "英译中" : "中译英";
      dom.chainPrompt.classList.add("hidden");
    }

    if (mode === "en-cn") {
      dom.questionText.textContent = item.word;
      dom.questionText.classList.remove("question-cn");
      dom.questionHint.textContent = "";
    } else {
      dom.questionText.textContent = meta.meaning || "释义加载中…";
      dom.questionText.classList.add("question-cn");
      dom.questionHint.textContent = `提示：首字母 ${item.word[0].toUpperCase()}，共 ${item.word.length} 个字母`;
    }

    dom.answerInput.value = "";
  }

  /* ════════════════════════════════
     REGISTER ATTEMPT
  ════════════════════════════════ */

  function registerAttempt(word, status) {
    const t = rt.state.today;
    const rec = t.records[word] || { attempts: 0, hadWrong: false, finalCorrect: false };
    rec.attempts += 1;
    if (status === "wrong") {
      rec.hadWrong = true;
      t.wrongCount += 1;
    } else if (status === "close") {
      rec.finalCorrect = true;
      t.closeCount += 1;
    } else {
      rec.finalCorrect = true;
      t.correctCount += 1;
    }
    t.records[word] = rec;
    computeStats();
  }

  /* ════════════════════════════════
     SUBMIT ANSWER
  ════════════════════════════════ */

  async function submitAnswer(userInput) {
    const item = currentItem();
    if (!item) return;

    rt.currentUserInput = userInput;
    const meta = rt.state.wordMeta[item.word] || { meaning: "", phonetic: "" };

    // Immediately disable buttons and show feedback view
    setQuizBtnsLoading(true);
    dom.feedbackCard.className      = "feedback-card";
    dom.feedbackStatus.textContent  = "判题中…";
    dom.feedbackMsg.textContent     = "AI 正在分析你的答案";
    showView("feedback");

    let result = null;
    if (USE_SERVER_API) {
      try {
        const resp = await fetch(withRoot("api/judge"), {
          method: "POST",
          headers: apiHeaders(),
          body: JSON.stringify({
            targetWord:      item.word,
            standardMeaning: meta.meaning || "",
            userInput,
            mode:            item.mode || "en-cn",
          }),
        });
        if (resp.ok) result = await resp.json();
      } catch (_) { /* network error below */ }
    }

    if (!result && !USE_SERVER_API) {
      const mode = item.mode || "en-cn";
      const normalize = (s) => String(s || "").toLowerCase().replace(/[\s，,。.！!？?；;：:]/g, "");
      if (mode === "cn-en") {
        const expected = normalize(item.word);
        const got = normalize(userInput);
        result = {
          status: expected === got ? "correct" : "wrong",
          msg: expected === got ? "拼写正确" : `标准拼写是 ${item.word}`,
          standardMeaning: meta.meaning || "",
        };
      } else {
        const standards = String(meta.meaning || "").split("/").map((x) => normalize(x)).filter(Boolean);
        const got = normalize(userInput);
        const hit = standards.some((s) => s && (s.includes(got) || got.includes(s)));
        result = {
          status: hit ? "correct" : "wrong",
          msg: hit ? "释义匹配" : "静态模式下无法使用 AI 精细判题，已按本地词库判断",
          standardMeaning: meta.meaning || "",
        };
      }
    }

    if (!result) {
      result = { status: "wrong", msg: "网络异常，暂按错误处理", standardMeaning: meta.meaning || "" };
    }

    if (result.standardMeaning) {
      meta.meaning = result.standardMeaning;
      rt.state.wordMeta[item.word] = meta;
    }

    registerAttempt(item.word, result.status);

    rt.currentFeedback = result;
    rt.currentWordInfo = {
      word:     item.word,
      meaning:  meta.meaning || result.standardMeaning || "",
      phonetic: meta.phonetic || "",
      status:   result.status,
    };
    saveState();

    setQuizBtnsLoading(false);
    renderAnswer();
  }

  /* ════════════════════════════════
     SKIP (直接看答案)
  ════════════════════════════════ */

  function skipCurrent() {
    const item = currentItem();
    if (!item) return;
    registerAttempt(item.word, "wrong");
    const meta = rt.state.wordMeta[item.word] || {};
    rt.currentFeedback = { status: "skip", msg: "已标记为未掌握，稍后再来" };
    rt.currentWordInfo = {
      word:     item.word,
      meaning:  meta.meaning || "",
      phonetic: meta.phonetic || "",
      status:   "skip",
    };
    saveState();
    renderAnswer();
  }

  /* ════════════════════════════════
     RENDER ANSWER
  ════════════════════════════════ */

  function renderAnswer() {
    const info = rt.currentWordInfo;
    if (!info) return;

    const fb = rt.currentFeedback || {};
    const status = fb.status || "wrong";
    const statusLabels = {
      correct: "完全正确 ✓",
      close:   "意思相近",
      wrong:   "答错了",
      skip:    "直接看答案",
    };

    dom.judgeBanner.className = `judge-banner status-${status}`;
    dom.judgeStatusText.textContent = statusLabels[status] || "已判题";
    dom.judgeMsgText.textContent    = fb.msg || "";

    if (status === "close" && rt.currentUserInput) {
      const std = info.meaning || fb.standardMeaning || "";
      dom.judgeCompareText.textContent =
        `你的输入：${rt.currentUserInput}\n标准释义：${std}`;
      dom.judgeCompareText.classList.remove("hidden");
    } else {
      dom.judgeCompareText.classList.add("hidden");
    }

    dom.answerWord.textContent      = info.word;
    dom.answerPhonetic.textContent  = info.phonetic ? `/${info.phonetic}/` : "";
    dom.answerMeaning.textContent   = info.meaning || "（释义加载中）";

    // Root card (returns matched roots for chain logic)
    const matchedRoots = renderRootCard(info.word);

    // P1-1: example sentence — use preloaded result if available for this word
    // (preload started in renderQuiz; if word matches, DOM is already populated)
    if (rt.preloadedExampleWord !== info.word) {
      // Word mismatch (rare edge case) — fallback to fresh fetch
      dom.exampleCard.classList.add("hidden");
      dom.exampleCard.innerHTML = "";
      preloadExampleForWord(info.word, info.meaning || "");
    }
    // Clear the preload marker regardless
    rt.preloadedExampleWord = null;
    rt.pendingChainItem = null;

    updateQuizProgress();
    setNextBtnLoading(false);
    showView("answer");

    // P1-2: chain question trigger (sync template, async AI enrichment)
    const fbStatus = rt.currentFeedback?.status || "wrong";
    maybeTriggerChain(info.word, fbStatus, matchedRoots);

    // Pre-fetch next word's metadata in the background
    const nextItem = rt.state.today?.queue[1];
    if (nextItem) ensureWordMeta(nextItem.word);
  }

  /* ════════════════════════════════
     MOVE QUEUE AFTER ANSWER
  ════════════════════════════════ */

  function moveQueueAfterAnswer() {
    const item = rt.state.today.queue.shift();
    if (!item) return;

    const status = rt.currentFeedback?.status || "wrong";
    if (status === "wrong" || status === "skip") {
      // Wrong / skip: push word back into the queue for retry
      // Chain-injected pending item is discarded (don't chain off a failed answer)
      rt.pendingChainItem = null;
      if (status !== "skip" || item.kind !== "chain") {
        // Skip on a chain item: just discard it (don't re-add chain questions)
        const offset = Math.floor(Math.random() * 6) + 5;
        const pos    = Math.min(rt.state.today.queue.length, offset);
        rt.state.today.queue.splice(pos, 0, item);
      }
    } else {
      if (item.source === "new")    rt.state.today.newDone++;
      if (item.source === "review") rt.state.today.reviewDone++;
      // chain: inject pending derived-word question at the front of the queue
      if (rt.pendingChainItem) {
        rt.state.today.queue.unshift(rt.pendingChainItem);
        rt.pendingChainItem = null;
      }
    }

    rt.currentFeedback  = null;
    rt.currentWordInfo  = null;
    rt.currentUserInput = null;
    saveState();
  }

  /* ════════════════════════════════
     FINISH SESSION
  ════════════════════════════════ */

  function finishSession() {
    settleLargeCycle();
    const t = rt.state.today;
    const total   = t.correctCount + t.closeCount + t.wrongCount;
    const correct = t.correctCount + t.closeCount;
    const acc     = total ? Math.round((correct / total) * 100) : 0;
    const mins    = Math.max(1, Math.round((Date.now() - t.startAt) / 60000));
    dom.doneStats.textContent = `完成 ${t.initialTotal} 词，用时 ${mins} 分钟，正确率 ${acc}%`;
    showView("done");
  }

  /* ════════════════════════════════
     SPEECH SYNTHESIS
  ════════════════════════════════ */

  function speakWord(word) {
    if (!word || !window.speechSynthesis) return;
    const utter = new SpeechSynthesisUtterance(word);
    utter.lang = "en-US";
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  }

  /* ════════════════════════════════
     SPEECH RECOGNITION
  ════════════════════════════════ */

  function initVoice() {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) { dom.micBtn.classList.add("hidden"); return; }

    const rec = new SpeechRec();
    rec.continuous      = false;
    rec.interimResults  = false;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      rt.voiceActive = true;
      dom.micBtn.classList.add("recording");
    };

    rec.onresult = (e) => {
      const transcript = e.results[0][0].transcript.trim();
      dom.answerInput.value = transcript;
      stopVoice();
      submitAnswer(transcript);
    };

    rec.onerror  = () => stopVoice();
    rec.onend    = () => { rt.voiceActive = false; dom.micBtn.classList.remove("recording"); };

    rt.voiceRec = rec;
  }

  function toggleVoice() {
    if (!rt.voiceRec) return;
    const item = currentItem();
    if (!item) return;

    if (rt.voiceActive) {
      stopVoice();
      return;
    }

    rt.voiceRec.lang = (item.mode === "en-cn") ? "zh-CN" : "en-US";
    try { rt.voiceRec.start(); } catch (_) { /* already started */ }
  }

  function stopVoice() {
    if (!rt.voiceRec) return;
    try { rt.voiceRec.stop(); } catch (_) { /* ignore */ }
    rt.voiceActive = false;
    dom.micBtn.classList.remove("recording");
  }

  /* ════════════════════════════════
     VIEWPORT FIX
  ════════════════════════════════ */

  function applyViewportFix() {
    if (!window.visualViewport) return;
    document.documentElement.style.setProperty("--vvh", `${window.visualViewport.height}px`);
  }

  /* ════════════════════════════════
     COUNT PICKER
  ════════════════════════════════ */

  function renderCountPicker() {
    dom.countInput.value = rt.state.targetDailyCount || DEFAULT_TARGET;
  }

  /* ════════════════════════════════
     EVENT BINDING
  ════════════════════════════════ */

  /* ─── Settings panel ─── */
  function renderSettingsPanel() {
    const s = rt.settings;
    dom.cfgBaseUrl.value = s.baseUrl || "";
    dom.cfgApiKey.value  = s.apiKey  || "";
    dom.cfgModel.value   = s.model   || "";
    setSettingsStatus("", false);
  }

  function setSettingsStatus(msg, isErr) {
    dom.settingsStatus.textContent = msg;
    dom.settingsStatus.classList.toggle("err", isErr);
  }

  function bindSettings() {
    dom.settingsToggle.addEventListener("click", () => {
      dom.settingsPanel.classList.toggle("hidden");
      if (!dom.settingsPanel.classList.contains("hidden")) {
        renderSettingsPanel();
      }
    });

    dom.settingsSave.addEventListener("click", () => {
      const baseUrl = dom.cfgBaseUrl.value.trim();
      const apiKey  = dom.cfgApiKey.value.trim();
      const model   = dom.cfgModel.value.trim();

      if (baseUrl && !apiKey) {
        setSettingsStatus("填了 Base URL 就需要同时填 API Key。", true);
        return;
      }

      // Keep interestTags unchanged (managed from home page)
      rt.settings = { baseUrl, apiKey, model, interestTags: rt.settings.interestTags || [] };
      saveSettings(rt.settings);

      if (apiKey) {
        setSettingsStatus("✓ 已保存，将优先使用你的 API，失败时自动切换默认。", false);
      } else {
        setSettingsStatus("✓ 已保存，将使用系统默认 API。", false);
      }
    });

    dom.settingsClear.addEventListener("click", () => {
      // Keep interestTags, only clear API fields
      rt.settings = { baseUrl: "", apiKey: "", model: "", interestTags: rt.settings.interestTags || [] };
      saveSettings(rt.settings);
      renderSettingsPanel();
      setSettingsStatus("✓ 已清除，将使用系统默认 API。", false);
    });
  }

  /* ── Interest tags (home page) ── */
  function renderInterestTags() {
    const tags = rt.settings.interestTags || [];
    if (tags.length === 0) {
      dom.interestTagList.innerHTML =
        `<p class="interest-empty-hint">暂无场景，系统将随机使用默认场景生成例句</p>`;
      return;
    }
    dom.interestTagList.innerHTML = tags.map((t, i) =>
      `<span class="interest-tag">
         ${t}
         <button class="interest-tag-remove" data-idx="${i}" aria-label="删除">×</button>
       </span>`
    ).join("");

    dom.interestTagList.querySelectorAll(".interest-tag-remove").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.idx, 10);
        rt.settings.interestTags.splice(idx, 1);
        saveSettings(rt.settings);
        renderInterestTags();
      });
    });
  }

  function addInterestTag() {
    const raw = dom.interestTagInput.value.trim();
    if (!raw) return;
    // Prevent duplicates
    const tags = rt.settings.interestTags || [];
    if (!tags.includes(raw)) {
      tags.push(raw);
      rt.settings.interestTags = tags;
      saveSettings(rt.settings);
    }
    dom.interestTagInput.value = "";
    renderInterestTags();
  }

  function bindEvents() {
    function applyCountInput() {
      let val = parseInt(dom.countInput.value, 10);
      if (isNaN(val) || val < 1)   val = 1;
      if (val > 200)               val = 200;
      dom.countInput.value = val;
      if (val === rt.state.targetDailyCount) return;
      rt.state.targetDailyCount = val;
      ensureTodayPlan();
      adjustTodayPlan(val);
      computeStats();
    }

    dom.countInput.addEventListener("change", applyCountInput);
    dom.countInput.addEventListener("blur",   applyCountInput);

    dom.countMinus.addEventListener("click", () => {
      dom.countInput.value = Math.max(1, (parseInt(dom.countInput.value, 10) || 1) - 5);
      applyCountInput();
    });
    dom.countPlus.addEventListener("click", () => {
      dom.countInput.value = Math.min(200, (parseInt(dom.countInput.value, 10) || 1) + 5);
      applyCountInput();
    });

    dom.startBtn.addEventListener("click", () => {
      ensureTodayPlan();
      renderQuiz();
    });

    dom.answerForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = dom.answerInput.value.trim();
      if (!text) return;
      stopVoice();
      submitAnswer(text);
    });

    dom.skipBtn.addEventListener("click", () => {
      stopVoice();
      // Immediately disable to prevent double-click
      dom.skipBtn.disabled = true;
      skipCurrent();
      dom.skipBtn.disabled = false;
    });

    dom.speakBtn.addEventListener("click", () => {
      const item = currentItem();
      if (item) speakWord(item.word);
    });

    dom.micBtn.addEventListener("click", toggleVoice);

    dom.quizBackBtn.addEventListener("click", () => {
      stopVoice();
      updateDashboard();
      computeStats();
      renderCountPicker();
      showView("home");
    });

    dom.nextBtn.addEventListener("click", () => {
      setNextBtnLoading(true);
      moveQueueAfterAnswer();
      if (rt.state.today.queue.length > 0) renderQuiz();
      else finishSession();
    });

    dom.answerBackBtn.addEventListener("click", () => {
      moveQueueAfterAnswer();
      updateDashboard();
      computeStats();
      renderCountPicker();
      showView("home");
    });

    const speakAnswer = () => {
      if (rt.currentWordInfo) speakWord(rt.currentWordInfo.word);
    };
    dom.answerSpeakBtn.addEventListener("click", speakAnswer);
    dom.answerSpeakBtnCard.addEventListener("click", speakAnswer);

    dom.restartBtn.addEventListener("click", () => {
      computeStats();
      renderCountPicker();
      updateDashboard();
      showView("home");
    });

    // Interest tags
    dom.interestTagAdd.addEventListener("click", addInterestTag);
    dom.interestTagInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); addInterestTag(); }
    });

    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", applyViewportFix);
    }
  }

  /* ════════════════════════════════
     BOOT
  ════════════════════════════════ */

  async function boot() {
    rt.state       = loadState();
    rt.settings    = loadSettings();
    rt.exampleCache = loadExampleCache();
    bindSettings();

    const resp = await fetch(withRoot("wordbank.json"));
    const data = await resp.json();
    rt.words = Array.isArray(data.words) ? data.words : [];

    try {
      const mr = await fetch(withRoot("meanings.json"));
      if (mr.ok) {
        const md = await mr.json();
        rt.meaningsDb = md && typeof md === "object" ? md : {};
      }
    } catch (_) {
      rt.meaningsDb = {};
    }

    // Merge extra words (from chain upserts) without re-shuffling the main order
    try {
      const er = await fetch(withRoot("wordbank-extra.json"));
      if (er.ok) {
        const ed = await er.json();
        const extra = Array.isArray(ed.words) ? ed.words : [];
        const wordSet = new Set(rt.words.map((w) => w.toLowerCase()));
        extra.forEach((w) => { if (!wordSet.has(w.toLowerCase())) rt.words.push(w); });
      }
    } catch (_) {}

    // Rebuild wordOrder if the word list grew (new extra words added)
    const savedOrder = rt.state.wordOrder;
    if (!savedOrder || savedOrder.length < rt.words.length) {
      // Re-shuffle only if this is a fresh start; otherwise append new words
      if (!savedOrder || savedOrder.length === 0) {
        rt.state.wordOrder = shuffleArray(rt.words);
      } else {
        const existing = new Set(savedOrder.map((w) => w.toLowerCase()));
        const newWords  = rt.words.filter((w) => !existing.has(w.toLowerCase()));
        // Append new words at random positions after current pointer
        newWords.forEach((w) => {
          const ptr = rt.state.pointer;
          const remaining = savedOrder.length - ptr;
          const pos = ptr + Math.floor(Math.random() * Math.max(1, remaining));
          savedOrder.splice(pos, 0, w);
        });
      }
      saveState();
    }

    ensureTodayPlan();

    initVoice();
    bindEvents();
    applyViewportFix();
    computeStats();
    renderCountPicker();
    renderInterestTags();
    updateDashboard();
    showView("home");
  }

  boot();
})();
