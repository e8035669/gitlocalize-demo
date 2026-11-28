// ==UserScript==
// @name         GitLocalize 匯出待翻譯內容
// @namespace    https://github.com/e8035669/gitlocalize-demo
// @version      1.0.0
// @description  一鍵複製(JSON)或下載(CSV)GitLocalize 頁面上的原文與譯文,方便批次交給 AI / 機器翻譯
// @match        https://gitlocalize.com/repo/*
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // 複製時附加在 JSON 前面的提示詞,{LANG} 會換成頁面上的目標語言名稱
  const PROMPT_TEMPLATE =
    '請將以下 JSON 中每個 value 從原文翻譯成 {LANG}。\n' +
    '規則:\n' +
    '1. 保留所有 key 不變,只翻譯 value。\n' +
    '2. 保留 {name}、%s、%d、<b>、\\n 等佔位符與標記,不要翻譯或更動。\n' +
    '3. 保留 value 中的換行。\n' +
    '4. 只回傳合法的 JSON,不要加任何說明。\n\n';

  const STORAGE_KEY = 'gl-export-settings';
  const settings = Object.assign(
    { batchSize: 0, withPrompt: true, visibleOnly: true },
    JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
  );
  const saveSettings = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));

  // GitLocalize 在畫面上會把 key 中的 "." 顯示成 "\.",還原成實際的 key
  const unescapeKey = (k) => k.trim().replace(/\\\./g, '.');

  function collectRows() {
    const rows = [...document.querySelectorAll('tr.segment-row')];
    return rows
      .filter((row) => !settings.visibleOnly || row.getClientRects().length > 0)
      .map((row) => {
        const src = row.querySelector('.js-hash-source-segment');
        const target = row.querySelector('.js-hash-target-segment');
        const keyEl = row.querySelector('.segment-key-name');
        if (!src || !target || !keyEl) return null;
        // 未翻譯的格子會顯示原文的複本,必須以 data-is-translated 判斷
        const translated = target.getAttribute('data-is-translated') === 'true';
        return {
          key: unescapeKey(keyEl.textContent),
          source: src.getAttribute('content') ?? src.textContent,
          translation: translated ? (target.querySelector('.segment-content')?.textContent ?? '') : '',
          translated,
        };
      })
      .filter(Boolean);
  }

  function pageInfo() {
    const headers = [...document.querySelectorAll('th.editor__column')];
    const lang = (i) => headers[i]?.firstChild?.textContent.trim() || '';
    const parts = location.pathname.split('/').filter(Boolean);
    return {
      targetLang: lang(1) || 'target language',
      fileName: decodeURIComponent(parts[parts.length - 1] || 'gitlocalize'),
    };
  }

  async function copyText(text) {
    if (typeof GM_setClipboard === 'function') {
      GM_setClipboard(text, 'text');
      return;
    }
    await navigator.clipboard.writeText(text);
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const csvCell = (v) => '"' + String(v).replace(/"/g, '""') + '"';

  function toCsv(items) {
    const lines = [['key', 'source', 'translation', 'translated'].map(csvCell).join(',')];
    for (const r of items) {
      lines.push([r.key, r.source, r.translation, r.translated ? 'true' : 'false'].map(csvCell).join(','));
    }
    // BOM 讓 Excel 以 UTF-8 開啟,中文才不會亂碼
    return '\ufeff' + lines.join('\r\n');
  }

  // ---- UI ----
  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;right:16px;bottom:16px;z-index:99999;background:#fff;border:1px solid #ccc;' +
    'border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.25);padding:10px;font:13px/1.4 sans-serif;' +
    'color:#222;width:230px;';
  panel.innerHTML = `
    <div style="font-weight:bold;margin-bottom:6px">GitLocalize 匯出</div>
    <div id="gl-stat" style="margin-bottom:6px;color:#666"></div>
    <button id="gl-copy-un" style="${btn('#f5c518')}">📋 複製未翻譯</button>
    <button id="gl-copy-all" style="${btn('#eee')}">📋 複製全部(原文+譯文)</button>
    <button id="gl-csv-un" style="${btn('#eee')}">⬇ CSV:未翻譯</button>
    <button id="gl-csv-all" style="${btn('#eee')}">⬇ CSV:全部</button>
    <label style="display:block;margin-top:6px">每批筆數(0=不分批)
      <input id="gl-batch" type="number" min="0" style="width:60px;margin-left:4px"></label>
    <label style="display:block"><input id="gl-prompt" type="checkbox"> 附加翻譯提示詞</label>
    <label style="display:block"><input id="gl-visible" type="checkbox"> 僅目前顯示的列</label>
    <div id="gl-msg" style="margin-top:6px;color:#0a7d2c;min-height:1.4em"></div>`;
  document.body.appendChild(panel);

  function btn(bg) {
    return `display:block;width:100%;margin-bottom:4px;padding:6px;border:1px solid #bbb;border-radius:4px;background:${bg};cursor:pointer;`;
  }

  const $ = (id) => panel.querySelector(id);
  const batchCursor = { un: 0, all: 0 };

  $('#gl-batch').value = settings.batchSize;
  $('#gl-prompt').checked = settings.withPrompt;
  $('#gl-visible').checked = settings.visibleOnly;

  const msg = (text, ok = true) => {
    const el = $('#gl-msg');
    el.style.color = ok ? '#0a7d2c' : '#c00';
    el.textContent = text;
  };

  function refreshStat() {
    const rows = collectRows();
    const un = rows.filter((r) => !r.translated).length;
    $('#gl-stat').textContent = `共 ${rows.length} 筆,未翻譯 ${un} 筆`;
  }

  $('#gl-batch').addEventListener('change', (e) => {
    settings.batchSize = Math.max(0, parseInt(e.target.value, 10) || 0);
    batchCursor.un = batchCursor.all = 0;
    saveSettings();
  });
  $('#gl-prompt').addEventListener('change', (e) => {
    settings.withPrompt = e.target.checked;
    saveSettings();
  });
  $('#gl-visible').addEventListener('change', (e) => {
    settings.visibleOnly = e.target.checked;
    batchCursor.un = batchCursor.all = 0;
    saveSettings();
    refreshStat();
  });

  async function copyJson(untranslatedOnly) {
    const rows = collectRows().filter((r) => !untranslatedOnly || !r.translated);
    if (!rows.length) return msg('沒有可複製的項目', false);

    let slice = rows;
    let batchLabel = '';
    const size = settings.batchSize;
    if (size > 0 && rows.length > size) {
      const total = Math.ceil(rows.length / size);
      const mode = untranslatedOnly ? 'un' : 'all';
      if (batchCursor[mode] >= total) batchCursor[mode] = 0;
      const i = batchCursor[mode]++;
      slice = rows.slice(i * size, (i + 1) * size);
      batchLabel = `(第 ${i + 1}/${total} 批,再按一次複製下一批)`;
    }

    const data = {};
    for (const r of slice) {
      data[r.key] = untranslatedOnly ? r.source : { source: r.source, translation: r.translation };
    }
    let text = JSON.stringify(data, null, 2);
    if (settings.withPrompt && untranslatedOnly) {
      text = PROMPT_TEMPLATE.replace('{LANG}', pageInfo().targetLang) + text;
    }
    try {
      await copyText(text);
      msg(`已複製 ${slice.length} 筆${batchLabel}`);
    } catch (e) {
      msg('複製失敗:' + e.message, false);
    }
  }

  function downloadCsv(untranslatedOnly) {
    const rows = collectRows().filter((r) => !untranslatedOnly || !r.translated);
    if (!rows.length) return msg('沒有可下載的項目', false);
    const { fileName } = pageInfo();
    const suffix = untranslatedOnly ? 'untranslated' : 'all';
    download(`${fileName}-${suffix}.csv`, toCsv(rows), 'text/csv;charset=utf-8');
    msg(`已下載 ${rows.length} 筆`);
  }

  $('#gl-copy-un').addEventListener('click', () => copyJson(true));
  $('#gl-copy-all').addEventListener('click', () => copyJson(false));
  $('#gl-csv-un').addEventListener('click', () => downloadCsv(true));
  $('#gl-csv-all').addEventListener('click', () => downloadCsv(false));

  refreshStat();
  // 使用者在頁面上翻譯後,統計數字隨之更新
  let timer;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(refreshStat, 500);
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-is-translated'] });
})();
