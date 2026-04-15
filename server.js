require("dotenv").config();

const path = require("path");
const fs   = require("fs");
const express = require("express");
const fetch   = require("node-fetch");

const app  = express();
const PORT = process.env.PORT || 3000;
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1/chat/completions";
const DEEPSEEK_API_KEY  = process.env.DEEPSEEK_API_KEY  || "";
const MODEL             = process.env.DEEPSEEK_MODEL    || "deepseek-chat";
const MEANINGS_PATH     = path.join(__dirname, "meanings.json");
const EXTRA_BANK_PATH   = path.join(__dirname, "wordbank-extra.json");

/* ─────────────────────────────────────────
   SHARED MEANINGS DATABASE
   File: meanings.json  { word: [meaning1, meaning2, ...] }
   Loaded into memory on startup; written back with debounce.
───────────────────────────────────────── */

let meaningsDb = {};
try {
  meaningsDb = JSON.parse(fs.readFileSync(MEANINGS_PATH, "utf8"));
  console.log(`[meanings] loaded ${Object.keys(meaningsDb).length} words`);
} catch (_) {
  meaningsDb = {};
  console.log("[meanings] no existing DB found, starting fresh");
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(MEANINGS_PATH, JSON.stringify(meaningsDb, null, 2), "utf8", (err) => {
      if (err) console.error("[meanings] save failed:", err.message);
    });
  }, 800);
}

/* ─────────────────────────────────────────
   EXTRA WORDBANK (wordbank-extra.json)
   Chain-discovered words not in the original wordbank.json
───────────────────────────────────────── */

let extraBankWords = [];
try {
  const raw = fs.readFileSync(EXTRA_BANK_PATH, "utf8");
  const parsed = JSON.parse(raw);
  extraBankWords = Array.isArray(parsed.words) ? parsed.words : [];
  console.log(`[extra-bank] loaded ${extraBankWords.length} extra words`);
} catch (_) {
  extraBankWords = [];
}

let extraSaveTimer = null;
function scheduleExtraSave() {
  clearTimeout(extraSaveTimer);
  extraSaveTimer = setTimeout(() => {
    fs.writeFile(EXTRA_BANK_PATH, JSON.stringify({ words: extraBankWords }, null, 2), "utf8", (err) => {
      if (err) console.error("[extra-bank] save failed:", err.message);
    });
  }, 800);
}

/** Validate a candidate word before adding to the extra bank. */
function isValidExtraWord(word) {
  if (!word || typeof word !== "string") return false;
  const t = word.trim();
  if (t.length < 2 || t.length > 30) return false;
  if (!/^[a-zA-Z][a-zA-Z'-]*[a-zA-Z]$|^[a-zA-Z]$/.test(t)) return false;
  // Block obvious noise (single letters, all-caps acronyms >4 chars, numbers mixed in)
  if (/\d/.test(t)) return false;
  if (t.length > 4 && t === t.toUpperCase()) return false;
  return true;
}

/**
 * Strip POS prefix(es) from a meaning string to get the bare Chinese content.
 * e.g. "n. 罐子；v. 装罐" → "罐子；装罐"
 *      "adj. 清晰的"     → "清晰的"
 *      "罐子"            → "罐子"   (no change)
 */
function stripPos(s) {
  return String(s || "").replace(/[a-zA-Z]+\.\s*/g, "").trim();
}

/** Whether a string has a POS prefix (e.g. "n. " / "adj. "). */
function hasPosBadge(s) {
  return /^[a-zA-Z]+\.\s/.test(String(s || "").trim());
}

/**
 * Anti-pollution validation before adding a meaning.
 * mode: "en-cn" (meaning must contain Chinese) | "cn-en" (skip Chinese check)
 */
function isValidMeaning(meaning, mode) {
  if (!meaning || typeof meaning !== "string") return false;
  const t = meaning.trim();
  // Allow a bit more length to accommodate POS prefix(es), e.g. "n. 预言；v. 预言"
  if (t.length < 1 || t.length > 120) return false;
  // For EN→CN the stripped content must contain at least one Chinese character
  if (mode !== "cn-en" && !/[\u4e00-\u9fff]/.test(t)) return false;
  // Block AI refusal / error patterns
  const blocked = ["无法", "抱歉", "sorry", "error", "cannot", "对不起", "不确定",
                   "我不", "无从", "请注意", "作为ai", "as an ai", "i cannot"];
  if (blocked.some((p) => t.toLowerCase().includes(p))) return false;
  return true;
}

/**
 * Persist a new meaning for a word, with POS-aware deduplication.
 *
 * - Compares stripped (POS-removed) base content for dedup.
 * - If an incoming entry has a POS badge and an existing one doesn't,
 *   the existing entry is UPGRADED in place (more information wins).
 * - Caps at 10 meanings per word.
 */
function persistMeaning(word, meaning, mode) {
  if (!isValidMeaning(meaning, mode)) return false;
  const key = String(word).toLowerCase().trim();
  const val  = meaning.trim();
  if (!meaningsDb[key]) meaningsDb[key] = [];
  const list = meaningsDb[key];

  const valBase    = stripPos(val);
  const valHasPos  = hasPosBadge(val);

  // Check for a semantic duplicate (compare stripped content)
  const dupIdx = list.findIndex((m) => {
    if (m === val) return true;
    const mBase = stripPos(m);
    // Consider duplicates if one stripped version contains the other
    return mBase === valBase || mBase.includes(valBase) || valBase.includes(mBase);
  });

  if (dupIdx !== -1) {
    // If the new version has POS and the existing one doesn't → upgrade
    if (valHasPos && !hasPosBadge(list[dupIdx])) {
      list[dupIdx] = val;
      scheduleSave();
      console.log(`[meanings] upgraded "${key}": ${list[dupIdx]} → ${val}`);
      return true;
    }
    return false; // genuine duplicate, skip
  }

  if (list.length >= 10) return false;
  list.push(val);
  scheduleSave();
  console.log(`[meanings] +1 for "${key}": ${val}`);
  return true;
}

/* ─────────────────────────────────────────
   HELPERS
───────────────────────────────────────── */

function safeJson(text) {
  try { return JSON.parse(text); } catch (_) { return null; }
}
function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  return m ? safeJson(m[0]) : null;
}
function normalizeStatus(s) {
  return ["correct", "close", "wrong"].includes(s) ? s : "wrong";
}

/**
 * Call an AI chat-completions endpoint.
 * Tries the user's custom API (if headers present) first;
 * on failure automatically falls back to the system default DeepSeek key.
 *
 * @param {Array}  messages         - OpenAI-style messages array
 * @param {object} opts
 * @param {number} [opts.temperature=0.15]
 * @param {string} [opts.customKey]   - from X-Api-Key header
 * @param {string} [opts.customBase]  - from X-Api-Base header
 * @param {string} [opts.customModel] - from X-Api-Model header
 * @returns {Promise<string>}  raw content string from the first successful call
 */
async function callAI(messages, opts = {}) {
  const { temperature = 0.15, customKey, customBase, customModel } = opts;

  const configs = [];
  if (customKey && customBase) {
    configs.push({ key: customKey, base: customBase, model: customModel || MODEL });
  }
  configs.push({ key: DEEPSEEK_API_KEY, base: DEEPSEEK_BASE_URL, model: MODEL });

  let lastErr = null;
  for (const cfg of configs) {
    try {
      const resp = await fetch(cfg.base, {
        method:  "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
        body: JSON.stringify({
          model:           cfg.model,
          temperature,
          response_format: { type: "json_object" },
          messages,
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        lastErr = new Error(`HTTP ${resp.status}: ${errText}`);
        console.warn(`[callAI] ${cfg.base === DEEPSEEK_BASE_URL ? "default" : "custom"} API failed (${resp.status}), trying next…`);
        continue;
      }

      const payload = await resp.json();
      return payload?.choices?.[0]?.message?.content || "";
    } catch (err) {
      lastErr = err;
      console.warn(`[callAI] request error (${err.message}), trying next…`);
    }
  }

  throw lastErr || new Error("All AI configs exhausted");
}

/* ─────────────────────────────────────────
   EXPRESS SETUP
───────────────────────────────────────── */

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/wordbank.json", express.static(path.join(__dirname, "wordbank.json")));
app.use("/wordData.js",   express.static(path.join(__dirname, "wordData.js")));

/* ─────────────────────────────────────────
   GET /api/meaning?word=xxx
   Returns known meanings from shared DB (no AI call).
───────────────────────────────────────── */

app.get("/api/meaning", (req, res) => {
  const word = String(req.query.word || "").trim();
  if (!word) return res.status(400).json({ error: "word required" });
  const meanings = meaningsDb[word.toLowerCase()] || [];
  res.json({ word, meanings });
});

/* ─────────────────────────────────────────
   POST /api/judge
   1. Looks up known meanings from DB
   2. EN→CN: fast-path exact match → skip AI
   3. Otherwise: calls AI with all known meanings in prompt
   4. Auto-persists AI-returned standardMeaning back to DB
───────────────────────────────────────── */

app.post("/api/judge", async (req, res) => {
  try {
    const customKey   = req.headers["x-api-key"]   || "";
    const customBase  = req.headers["x-api-base"]  || "";
    const customModel = req.headers["x-api-model"] || "";

    const { targetWord, userInput, mode } = req.body || {};
    if (!targetWord || !userInput) {
      return res.status(400).json({ error: "targetWord 和 userInput 不能为空" });
    }

    const isEnToCn = mode !== "cn-en";
    const key          = String(targetWord).toLowerCase().trim();
    const knownList    = meaningsDb[key] || [];
    const knownStr     = knownList.length > 0 ? knownList.join("、") : "";
    const inputTrimmed = String(userInput).trim();

    /* ── Fast-path: exact match (POS-stripped comparison) ── */
    if (isEnToCn && knownList.length > 0) {
      const inputBase = stripPos(inputTrimmed).replace(/[，,。.！!？?]/g, "");
      const exactMatch = knownList.some((m) => {
        const mBase = stripPos(m).replace(/[，,。.！!？?]/g, "");
        return m === inputTrimmed || mBase === inputTrimmed || mBase === inputBase;
      });
      if (exactMatch) {
        return res.json({ status: "correct", msg: "完全正确！", standardMeaning: knownStr });
      }
    }
    if (!isEnToCn) {
      const inputLower = inputTrimmed.toLowerCase();
      if (inputLower === key) {
        return res.json({ status: "correct", msg: "完全正确！", standardMeaning: knownStr || targetWord });
      }
    }

    /* ── Build prompts ── */
    const knownNote = knownStr
      ? `（已知参考释义：${knownStr}，以上任一均视为正确，判题时请忽略词性前缀差异）`
      : "（该词暂无已知释义，请在 standardMeaning 字段给出带词性的中文释义）";

    const systemPrompt = isEnToCn
      ? `你是英语老师，判断学生给出的中文释义是否正确。${knownNote} ` +
        `规则：1.完全准确→correct；2.同义近义→close；3.明显错误→wrong。` +
        `standardMeaning 必须包含词性标注，格式：词性缩写. 释义，多词性用；分隔，例：n. 预言；v. 预言。` +
        `只输出JSON，无其他内容：{"status":"correct|close|wrong","msg":"一句话反馈","standardMeaning":"词性标注释义"}`
      : `你是英语老师，判断学生输入的英文单词拼写是否正确。标准答案：${targetWord}。` +
        `规则：1.拼写完全正确→correct；2.轻微拼写错误→close；3.明显错误→wrong。` +
        `只输出JSON：{"status":"correct|close|wrong","msg":"一句话反馈","standardMeaning":"${targetWord}"}`;

    const userPrompt = isEnToCn
      ? `单词：${targetWord}\n学生输入：${inputTrimmed}`
      : `题目中文释义：${knownStr || "（见单词）"}\n标准英文：${targetWord}\n学生输入：${inputTrimmed}`;

    /* ── Call AI (tries custom key first, falls back to default) ── */
    const content = await callAI(
      [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      { temperature: 0.15, customKey, customBase, customModel }
    );
    const parsed = safeJson(content) || extractJson(content) || {};

    /* ── Persist AI's returned meaning ── */
    if (parsed.standardMeaning && isEnToCn) {
      persistMeaning(targetWord, parsed.standardMeaning, "en-cn");
    }

    /* ── Return enriched response ── */
    const freshList = meaningsDb[key] || [];
    return res.json({
      status:          normalizeStatus(parsed.status),
      msg:             parsed.msg || "已判题",
      standardMeaning: freshList.length > 0 ? freshList.join(" / ") : (parsed.standardMeaning || ""),
    });

  } catch (err) {
    return res.status(500).json({ error: "判题服务异常", detail: String(err.message || err) });
  }
});

/* ─────────────────────────────────────────
   GET /api/wordinfo?word=xxx
   1. Returns known meaning from DB (no AI for meaning)
   2. Calls AI only for phonetic (and meaning if DB is empty)
   3. Auto-persists AI meaning to DB
───────────────────────────────────────── */

app.get("/api/wordinfo", async (req, res) => {
  try {
    const word = String(req.query.word || "").trim();
    if (!word) return res.status(400).json({ error: "word 参数不能为空" });

    const customKey   = req.headers["x-api-key"]   || "";
    const customBase  = req.headers["x-api-base"]  || "";
    const customModel = req.headers["x-api-model"] || "";

    const key         = word.toLowerCase();
    const knownList   = meaningsDb[key] || [];
    const hasMeaning  = knownList.length > 0;

    const systemPrompt = hasMeaning
      ? `你是英语词典，根据给定词条返回音标。只输出JSON，无其他内容：{"word":"英文词","phonetic":"国际音标，不含斜线","meaning":""}`
      : `你是英语词典，根据给定词条返回音标和带词性标注的中文释义。` +
        `词性格式：词性缩写. 释义，多词性用；分隔，如：n. 罐子；v. 将…装入罐中。` +
        `只输出JSON，无其他内容：{"word":"英文词","phonetic":"国际音标，不含斜线","meaning":"词性标注释义"}`;

    const content = await callAI(
      [{ role: "system", content: systemPrompt }, { role: "user", content: `词条：${word}` }],
      { temperature: 0.1, customKey, customBase, customModel }
    );
    const parsed  = safeJson(content) || extractJson(content) || {};

    // Persist AI meaning if DB was empty
    if (!hasMeaning && parsed.meaning) {
      persistMeaning(word, parsed.meaning, "en-cn");
    }

    const freshList = meaningsDb[key] || [];
    return res.json({
      word,
      phonetic: parsed.phonetic || "",
      meaning:  freshList.length > 0 ? freshList.join(" / ") : (parsed.meaning || ""),
    });

  } catch (err) {
    return res.status(500).json({ error: "词条服务异常", detail: String(err.message || err) });
  }
});

/* ─────────────────────────────────────────
   GET /wordbank-extra.json
   Serves the extra wordbank to the frontend.
───────────────────────────────────────── */

app.get("/wordbank-extra.json", (req, res) => {
  res.json({ words: extraBankWords });
});

/* ─────────────────────────────────────────
   GET /api/example?word=&meaning=&tag=
   Generates one contextual example sentence for P1-1.
   No server-side cache (user-layer cache is on the client).
───────────────────────────────────────── */

app.get("/api/example", async (req, res) => {
  try {
    const word    = String(req.query.word    || "").trim();
    const meaning = String(req.query.meaning || "").trim();
    const tag     = String(req.query.tag     || "日常生活").trim();
    if (!word) return res.status(400).json({ error: "word 参数不能为空" });

    const customKey   = req.headers["x-api-key"]   || "";
    const customBase  = req.headers["x-api-base"]  || "";
    const customModel = req.headers["x-api-model"] || "";

    const systemPrompt =
      `你是资深英语母语者。根据给定单词和兴趣场景生成一句地道、简短的英文例句及中文翻译。` +
      `规则：1.例句必须包含目标单词；2.贴合兴趣场景；3.句子不要太复杂；` +
      `4.只输出JSON，不含任何 Markdown 标记：{"en":"英文例句","cn":"中文翻译"}`;
    const userPrompt =
      `单词：${word}${meaning ? `（释义：${meaning}）` : ""}\n兴趣场景：${tag}`;

    const content = await callAI(
      [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      { temperature: 0.7, customKey, customBase, customModel }
    );
    const parsed = safeJson(content) || extractJson(content) || {};

    if (!parsed.en || !parsed.cn) {
      return res.status(502).json({ error: "AI 返回格式异常" });
    }
    return res.json({ en: parsed.en, cn: parsed.cn });

  } catch (err) {
    return res.status(500).json({ error: "例句服务异常", detail: String(err.message || err) });
  }
});

/* ─────────────────────────────────────────
   POST /api/derived-question
   Generates an engaging chain question for P1-2.
   Body: { baseWord, root, rootMeaning, derivedWord }
───────────────────────────────────────── */

app.post("/api/derived-question", async (req, res) => {
  try {
    const { baseWord, root, rootMeaning, derivedWord } = req.body || {};
    if (!baseWord || !derivedWord) {
      return res.status(400).json({ error: "baseWord 和 derivedWord 不能为空" });
    }

    const customKey   = req.headers["x-api-key"]   || "";
    const customBase  = req.headers["x-api-base"]  || "";
    const customModel = req.headers["x-api-model"] || "";

    const systemPrompt =
      `你是深谙词根词缀记忆法的英语老师。` +
      `用户刚学了一个单词及其词根，现在向他提问同词族的派生词。` +
      `规则：1.语气启发性，引导思考；2.给出词缀提示；3.只输出JSON：{"question":"引导提问话术"}`;
    const userPrompt =
      `刚学的单词：${baseWord}\n` +
      `核心词根：${root}（${rootMeaning}）\n` +
      `要考查的派生词：${derivedWord}`;

    const content = await callAI(
      [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      { temperature: 0.5, customKey, customBase, customModel }
    );
    const parsed = safeJson(content) || extractJson(content) || {};

    return res.json({ question: parsed.question || "" });

  } catch (err) {
    return res.status(500).json({ error: "连环问生成异常", detail: String(err.message || err) });
  }
});

/* ─────────────────────────────────────────
   POST /api/lexicon/upsert
   Adds a chain-discovered word to wordbank-extra.json.
   Body: { word }
   Returns: { word, added: bool, meaning }
───────────────────────────────────────── */

app.post("/api/lexicon/upsert", async (req, res) => {
  try {
    const word = String(req.body?.word || "").trim();
    if (!word) return res.status(400).json({ error: "word 参数不能为空" });

    if (!isValidExtraWord(word)) {
      return res.status(422).json({ error: "词形校验未通过", word });
    }

    const key = word.toLowerCase();

    // Already in extra bank?
    if (extraBankWords.some((w) => w.toLowerCase() === key)) {
      const existingMeaning = (meaningsDb[key] || []).join(" / ");
      return res.json({ word, added: false, meaning: existingMeaning });
    }

    // Get AI meaning for the new word (needed for anti-pollution check)
    const customKey   = req.headers["x-api-key"]   || "";
    const customBase  = req.headers["x-api-base"]  || "";
    const customModel = req.headers["x-api-model"] || "";

    const systemPrompt =
      `你是英语词典，返回单词的带词性标注中文释义和音标。` +
      `词性格式：词性缩写. 释义，多词性用；分隔，如：n. 罐子；v. 将…装入罐中。` +
      `只输出JSON：{"phonetic":"音标不含斜线","meaning":"词性标注释义"}`;
    let meaning = "";
    let phonetic = "";
    try {
      const content = await callAI(
        [{ role: "system", content: systemPrompt }, { role: "user", content: `单词：${word}` }],
        { temperature: 0.1, customKey, customBase, customModel }
      );
      const parsed = safeJson(content) || extractJson(content) || {};
      meaning  = parsed.meaning  || "";
      phonetic = parsed.phonetic || "";
    } catch (_) {}

    if (!meaning || !isValidMeaning(meaning, "en-cn")) {
      return res.status(422).json({ error: "无法获取有效中文释义，拒绝入库", word });
    }

    // Persist meaning and phonetic
    persistMeaning(word, meaning, "en-cn");

    // Add to extra bank
    extraBankWords.push(word);
    scheduleExtraSave();
    console.log(`[extra-bank] +1 word "${word}": ${meaning}`);

    return res.json({ word, added: true, meaning, phonetic });

  } catch (err) {
    return res.status(500).json({ error: "词库更新异常", detail: String(err.message || err) });
  }
});

/* ─────────────────────────────────────────
   FALLBACK
───────────────────────────────────────── */

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`MVP server started: http://localhost:${PORT}`);
});
