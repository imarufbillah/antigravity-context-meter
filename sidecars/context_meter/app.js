(() => {
  const POLL_MS = 1200;
  const $ = (id) => document.getElementById(id);

  const LS_OVERRIDES_KEY = 'cm_model_overrides_v1';
  const LS_WARN_KEY = 'cm_warn_pct_v2';
  const LS_SCALE_KEY = 'cm_chart_scale';
  const LS_RATES_KEY = 'cm_model_rates_v1';

  function loadJson(key, fallback) {
    try {
      const raw = JSON.parse(localStorage.getItem(key) || 'null');
      return raw && typeof raw === 'object' ? raw : fallback;
    } catch {
      return fallback;
    }
  }

  function saveJson(key, val) {
    localStorage.setItem(key, JSON.stringify(val));
  }

  function defaultRatesForModel(model) {
    const hay = `${model?.modelId || ''} ${model?.label || ''} ${model?.modelKey || ''}`.toLowerCase();
    if (hay.includes('opus')) return { in: 15.0, cache: 1.5, out: 75.0 };
    if (hay.includes('sonnet') || hay.includes('claude')) return { in: 3.0, cache: 0.3, out: 15.0 };
    if (hay.includes('flash')) return { in: 0.3, cache: 0.075, out: 2.5 };
    if (hay.includes('gpt-oss')) return { in: 0.2, cache: 0.05, out: 0.8 };
    return { in: 1.25, cache: 0.31, out: 10.0 };
  }

  function normalizeWarnPct(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 5 || n > 95) return 30;
    return Math.round(n);
  }

  const state = {
    conv: '',
    etag: '',
    data: null,
    overrides: loadJson(LS_OVERRIDES_KEY, {}),
    rates: loadJson(LS_RATES_KEY, {}),
    warnPct: normalizeWarnPct(localStorage.getItem(LS_WARN_KEY)),
    chartScale: localStorage.getItem(LS_SCALE_KEY) === 'window' ? 'window' : 'fit',
    inspectedIdx: null,
    pollFailures: 0,
  };

  const params = new URLSearchParams(location.search);
  const currentConv = () => window.sidecar?.conversationId || params.get('conversationId') || '';

  async function apiFetch(path, options = {}) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, options);
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  const getJson = (path) => apiFetch(path, { method: 'GET' });
  const postJson = (path, body) =>
    apiFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  let prefsEditRev = 0;
  let savePrefsChain = Promise.resolve();

  function syncLocalStorageFromState() {
    try {
      saveJson(LS_OVERRIDES_KEY, state.overrides);
      localStorage.setItem(LS_WARN_KEY, String(state.warnPct));
      localStorage.setItem(LS_SCALE_KEY, state.chartScale);
      saveJson(LS_RATES_KEY, state.rates);
    } catch {
      // Ignore storage quota errors in restricted webviews.
    }
  }

  function persistPrefs() {
    prefsEditRev += 1;
    syncLocalStorageFromState();
    const payload = {
      warnPct: state.warnPct,
      chartScale: state.chartScale,
      overrides: state.overrides,
      rates: state.rates,
    };
    savePrefsChain = savePrefsChain
      .then(() => postJson('/api/prefs', payload))
      .catch(() => {});
  }

  function hasCustomLocalPrefs() {
    return (
      state.warnPct !== 30 ||
      state.chartScale !== 'fit' ||
      Object.keys(state.overrides).length > 0 ||
      Object.keys(state.rates).length > 0
    );
  }

  async function hydratePrefs() {
    const revAtStart = prefsEditRev;
    try {
      const remote = await getJson('/api/prefs');
      if (prefsEditRev !== revAtStart) return;
      if (remote?.exists) {
        state.warnPct = normalizeWarnPct(remote.warnPct);
        state.chartScale = remote.chartScale === 'window' ? 'window' : 'fit';
        state.overrides = remote.overrides && typeof remote.overrides === 'object' ? remote.overrides : {};
        state.rates = remote.rates && typeof remote.rates === 'object' ? remote.rates : {};
        syncLocalStorageFromState();
        syncControlUI();
        if (state.data) render();
      } else if (hasCustomLocalPrefs()) {
        persistPrefs();
      }
    } catch {
      // Fall back silently to localStorage when /api/prefs is unavailable.
    }
  }

  function syncScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f6f7f9)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const theme = lum < 0.5 ? 'dark' : 'light';
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
  }
  syncScheme();
  new MutationObserver(syncScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtTok(n) {
    const v = Number(n) || 0;
    if (v >= 1000000) return `${(v / 1000000).toFixed(2).replace(/\.?0+$/, '')}M`;
    if (v >= 10000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    if (v >= 1000) return `${(v / 1000).toFixed(2).replace(/\.?0+$/, '')}k`;
    return String(Math.round(v));
  }

  function fmtSigned(n) {
    if (!Number.isFinite(n) || n === 0) return '0';
    return `${n > 0 ? '+' : '-'}${fmtTok(Math.abs(n))}`;
  }

  function fmtUsd(v) {
    const n = Number(v) || 0;
    if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
    return `$${n.toFixed(2)}`;
  }

  function activeModelKey() {
    return state.data?.model?.modelKey || '__default__';
  }

  function autoLimit() {
    return Number(state.data?.model?.contextWindow) || 1000000;
  }

  function effectiveLimit() {
    const ov = Number(state.overrides[activeModelKey()]);
    return Number.isFinite(ov) && ov > 0 ? ov : autoLimit();
  }

  function effectiveRates() {
    const def = defaultRatesForModel(state.data?.model);
    const custom = state.rates[activeModelKey()];
    if (!custom || typeof custom !== 'object') return { ...def, isCustom: false };
    return {
      in: Number.isFinite(Number(custom.in)) ? Number(custom.in) : def.in,
      cache: Number.isFinite(Number(custom.cache)) ? Number(custom.cache) : def.cache,
      out: Number.isFinite(Number(custom.out)) ? Number(custom.out) : def.out,
      isCustom: true,
    };
  }

  const DEFAULT_WARN_HINT = 'Triggers /compact reminder';

  const DEFAULT_RATES_HINT = 'In · Cache · Out (per model)';

  function modelHintText() {
    const modelLabel = state.data?.model?.label;
    return modelLabel ? `Saved for ${modelLabel}` : 'Saved per model';
  }

  function setFieldError(inputEl, hintEl, message) {
    inputEl.setAttribute('aria-invalid', 'true');
    inputEl.closest('.custom-limit-wrap, .rate-field')?.classList.add('is-invalid');
    hintEl.textContent = message;
    hintEl.classList.add('is-error');
  }

  function clearFieldError(inputEl, hintEl, defaultText) {
    inputEl.removeAttribute('aria-invalid');
    inputEl.closest('.custom-limit-wrap, .rate-field')?.classList.remove('is-invalid');
    hintEl?.classList.remove('is-error');
    if (hintEl && defaultText != null) hintEl.textContent = defaultText;
  }

  function syncControlUI() {
    const key = activeModelKey();
    const ov = Number(state.overrides[key]);
    const hasOverride = Number.isFinite(ov) && ov > 0;
    const limit = effectiveLimit();

    const autoBtn = $('auto-limit-btn');
    autoBtn.textContent = `Auto (${fmtTok(autoLimit())})`;
    autoBtn.classList.toggle('active', !hasOverride);

    document.querySelectorAll('.seg-btn[data-limit]').forEach((btn) => {
      btn.classList.toggle('active', hasOverride && Number(btn.dataset.limit) === limit);
    });

    const customInput = $('custom-limit');
    const limitInvalid = customInput.getAttribute('aria-invalid') === 'true';
    const isPreset = [128000, 200000, 1000000].includes(limit);
    const isCustomLimit = hasOverride && !isPreset;
    customInput.closest('.custom-limit-wrap')?.classList.toggle('is-active', isCustomLimit && !limitInvalid);
    if (document.activeElement !== customInput && !limitInvalid) {
      customInput.value = isCustomLimit ? fmtTok(limit) : '';
    }

    document.querySelectorAll('.warn-btn').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.warn) === state.warnPct);
    });

    const customWarnInput = $('custom-warn');
    const warnInvalid = customWarnInput.getAttribute('aria-invalid') === 'true';
    const isWarnPreset = [30, 50, 70].includes(state.warnPct);
    $('custom-warn-wrap')?.classList.toggle('is-active', !isWarnPreset && !warnInvalid);
    if (document.activeElement !== customWarnInput && !warnInvalid) {
      customWarnInput.value = !isWarnPreset ? `${state.warnPct}%` : '';
    }

    $('warn-marker').style.setProperty('--warn-pos', `${Math.min(98, Math.max(5, state.warnPct))}%`);

    if (!limitInvalid) {
      $('settings-model-hint').textContent = modelHintText();
    }
    $('budget-summary-chip').textContent = `${hasOverride ? fmtTok(limit) : 'Auto'} · ${state.warnPct}%`;

    $('scale-fit-btn').classList.toggle('active', state.chartScale === 'fit');
    $('scale-win-btn').classList.toggle('active', state.chartScale === 'window');

    const r = effectiveRates();
    for (const [id, val] of [['rate-in', r.in], ['rate-cache', r.cache], ['rate-out', r.out]]) {
      const el = $(id);
      if (document.activeElement !== el && el.getAttribute('aria-invalid') !== 'true') {
        el.value = String(val);
      }
    }
    $('rate-summary-chip').textContent = `${r.isCustom ? 'Custom' : 'Est.'} $${r.in}/$${r.cache}/$${r.out}`;
  }

  function setAttrsIfChanged(el, attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      const s = String(v);
      if (el.getAttribute(k) !== s) el.setAttribute(k, s);
    }
  }

  function updateInspector(step) {
    const el = $('chart-inspector');
    if (!step) {
      if (!el.querySelector('.inspector-hint')) {
        el.innerHTML = '<span class="inspector-hint">Hover or tab through bars to inspect step telemetry</span>';
      }
      return;
    }
    const cachePct = step.promptTotal > 0 ? ((step.cacheReadTokens / step.promptTotal) * 100).toFixed(1) : '0.0';
    const toolsText = step.toolCount > 0 ? ` · ${step.toolCount} ${step.toolCount === 1 ? 'tool' : 'tools'}` : '';
    const compactText = step.compacted ? ' · COMPACTED' : '';
    const nextText = `Step #${step.stepIndex} · ${fmtTok(step.afterOutputTotal)} (${fmtSigned(step.delta)}) · ${cachePct}% cached${toolsText}${compactText}`;
    if (el.textContent !== nextText) el.textContent = nextText;
  }

  function renderChart(history, limit) {
    const canvas = $('chart-canvas');
    const svg = $('chart-svg');
    const empty = $('chart-empty');

    if (!history || !history.length) {
      canvas.classList.add('hidden');
      empty.classList.remove('hidden');
      if (svg.childElementCount) svg.textContent = '';
      updateInspector(null);
      return;
    }

    empty.classList.add('hidden');
    canvas.classList.remove('hidden');

    const W = 420;
    const H = 112;
    const padY = 8;
    const warnTarget = limit * (state.warnPct / 100);
    const peakData = Math.max(...history.map((h) => h.afterOutputTotal), 1000);

    const maxVal =
      state.chartScale === 'window'
        ? Math.max(limit, peakData)
        : Math.max(peakData * 1.18, 1000);

    $('y-max').textContent = fmtTok(maxVal);
    $('y-mid').textContent = fmtTok(maxVal / 2);

    const n = history.length;
    const slot = W / n;
    const gap = slot > 5 ? 2 : slot > 3 ? 1.2 : 0.6;
    const barW = Math.max(1, slot - gap);
    const warnY = H - padY - (warnTarget / maxVal) * (H - padY * 2);
    const showWarn = warnY >= 4 && warnY <= H - 6;
    const labelY = Math.max(11, warnY - 3);
    const warnText = `${state.warnPct}% warn (${fmtTok(warnTarget)})`;

    const widthStr = barW.toFixed(1);
    const bars = history.map((h, i) => {
      const totalH = Math.max(3, (h.afterOutputTotal / maxVal) * (H - padY * 2));
      const pctOfLimit = (h.afterOutputTotal / limit) * 100;
      let fill = 'var(--cm-primary)';
      if (h.compacted) fill = 'var(--cm-success)';
      else if (pctOfLimit >= Math.min(95, state.warnPct + 15)) fill = 'var(--cm-error)';
      else if (pctOfLimit >= state.warnPct) fill = 'var(--cm-warning)';
      return {
        attrs: {
          'aria-label': `Step ${h.stepIndex}, ${fmtTok(h.afterOutputTotal)} tokens, delta ${fmtSigned(h.delta)}`,
          x: (i * (barW + gap)).toFixed(1),
          y: (H - padY - totalH).toFixed(1),
          width: widthStr,
          height: totalH.toFixed(1),
          fill,
        },
        selected: state.inspectedIdx === i,
      };
    });

    const existingBars = svg.querySelectorAll('.chart-bar');
    const warnLine = svg.querySelector('.chart-warn-line');
    const warnLabel = svg.querySelector('.chart-warn-label');

    if (existingBars.length === n && warnLine && warnLabel) {
      warnLine.classList.toggle('hidden', !showWarn);
      warnLabel.classList.toggle('hidden', !showWarn);
      if (showWarn) {
        const yStr = warnY.toFixed(1);
        setAttrsIfChanged(warnLine, { y1: yStr, y2: yStr });
        setAttrsIfChanged(warnLabel, { y: labelY.toFixed(1) });
        if (warnLabel.textContent !== warnText) warnLabel.textContent = warnText;
      }

      bars.forEach((b, i) => {
        existingBars[i].classList.toggle('is-selected', b.selected);
        setAttrsIfChanged(existingBars[i], b.attrs);
      });
    } else {
      const parts = [
        `<line class="chart-warn-line${showWarn ? '' : ' hidden'}" x1="0" y1="${warnY.toFixed(1)}" x2="${W}" y2="${warnY.toFixed(1)}" stroke="currentColor" stroke-opacity="0.32" stroke-dasharray="3 3" stroke-width="1"/>`,
        `<text class="chart-warn-label${showWarn ? '' : ' hidden'}" x="${W - 2}" y="${labelY.toFixed(1)}" text-anchor="end" font-size="11" font-family="var(--cm-mono)" fill="currentColor" fill-opacity="0.65">${warnText}</text>`,
      ];

      bars.forEach((b, i) => {
        const a = b.attrs;
        parts.push(
          `<rect class="chart-bar${b.selected ? ' is-selected' : ''}" data-idx="${i}" tabindex="0" role="button" aria-label="${a['aria-label']}" x="${a.x}" y="${a.y}" width="${a.width}" height="${a.height}" rx="2" fill="${a.fill}" fill-opacity="0.86"/>`,
        );
      });

      const activeBar = document.activeElement;
      const focusedIdx =
        activeBar && svg.contains(activeBar) && activeBar.classList?.contains('chart-bar')
          ? activeBar.dataset.idx
          : null;

      svg.innerHTML = parts.join('');

      if (focusedIdx != null) {
        svg.querySelector(`.chart-bar[data-idx="${CSS.escape(focusedIdx)}"]`)?.focus({ preventScroll: true });
      }
    }

    const inspected =
      state.inspectedIdx != null && history[state.inspectedIdx]
        ? history[state.inspectedIdx]
        : null;
    updateInspector(inspected);
  }

  function renderModelBar(limit) {
    const m = state.data?.model || null;
    const hasOverride = Number(state.overrides[activeModelKey()]) > 0;
    if (!m) {
      $('model-name').textContent = 'Model unavailable';
      $('model-window-pill').textContent = `${fmtTok(limit)} window`;
      return;
    }

    $('model-name').textContent = m.isDefaultFallback ? `${m.label} (default)` : m.label;
    $('model-name').title = [m.modelId, m.modelKey].filter(Boolean).join(' · ');

    $('model-window-pill').textContent = hasOverride
      ? `${fmtTok(limit)} budget`
      : `${fmtTok(m.contextWindow)}${m.windowKnown ? '' : ' est.'} window`;
  }

  function renderDeepDiagnostics(d) {
    const cum = d?.cumulative || {};
    const sub = d?.subagents || { count: 0, items: [] };
    const rates = effectiveRates();

    const calcCost = (inTok, cacheTok, outTok) =>
      (inTok * rates.in + cacheTok * rates.cache + outTok * rates.out) / 1000000;
    const calcUncached = (inTok, cacheTok, outTok) =>
      ((inTok + cacheTok) * rates.in + outTok * rates.out) / 1000000;

    const spend = calcCost(cum.inputTokens || 0, cum.cacheReadTokens || 0, cum.outputTokens || 0);
    const uncached = calcUncached(cum.inputTokens || 0, cum.cacheReadTokens || 0, cum.outputTokens || 0);
    const saved = Math.max(0, uncached - spend);
    const turns = Math.max(1, d?.userTurns || 0);

    $('cost-spend').textContent = `~${fmtUsd(spend)}`;
    $('cost-saved').textContent = `~${fmtUsd(saved)}`;
    $('cost-per-turn').textContent = d?.userTurns ? `~${fmtUsd(spend / turns)}` : '$0.00';

    if (sub.count > 0) {
      const subSpend = calcCost(
        sub.totalInputTokens || 0,
        sub.totalCacheReadTokens || 0,
        sub.totalOutputTokens || 0,
      );
      $('cost-with-sub-note').textContent = `Incl. subagents: ~${fmtUsd(spend + subSpend)}`;
      $('cost-with-sub-note').classList.remove('hidden');
    } else {
      $('cost-with-sub-note').classList.add('hidden');
    }

    // Compaction Impact History
    const events = Array.isArray(d?.compactionEvents) ? d.compactionEvents : [];
    $('compacts-count-pill').textContent = `${events.length} ${events.length === 1 ? 'event' : 'events'}`;
    if (!events.length) {
      $('compacts-empty').classList.remove('hidden');
      $('compacts-list').classList.add('hidden');
    } else {
      $('compacts-empty').classList.add('hidden');
      $('compacts-list').classList.remove('hidden');
      $('compacts-list').innerHTML = events
        .map(
          (ev) => `
          <li class="event-item">
            <div class="event-left">
              <span class="event-step">#${ev.stepIndex}</span>
              <span class="event-flow">${fmtTok(ev.beforeTokens)} → ${fmtTok(ev.afterTokens)}</span>
            </div>
            <span class="event-saved">-${ev.reductionPct.toFixed(0)}%</span>
          </li>`,
        )
        .join('');
    }

    // Top Context Hogs
    const hogs = Array.isArray(d?.topHogs) ? d.topHogs : [];
    if (!hogs.length) {
      $('hogs-empty').classList.remove('hidden');
      $('hogs-list').classList.add('hidden');
    } else {
      $('hogs-empty').classList.add('hidden');
      $('hogs-list').classList.remove('hidden');
      const maxDelta = Math.max(...hogs.map((h) => h.delta), 1);
      $('hogs-list').innerHTML = hogs
        .map((h) => {
          const wPct = Math.max(6, Math.round((h.delta / maxDelta) * 100));
          return `
            <li class="hog-item">
              <div class="hog-top">
                <span class="hog-label" title="${escHtml(h.label)}"><span class="hog-step">#${h.stepIndex}</span>${escHtml(h.label)}</span>
                <span class="hog-val">+${fmtTok(h.delta)}</span>
              </div>
              <div class="hog-bar-track"><div class="hog-bar-fill" style="--hog-w: ${wPct}%"></div></div>
            </li>`;
        })
        .join('');
    }

    // Subagent & Swarm Burn
    $('subagents-count-pill').textContent = `${sub.count} ${sub.count === 1 ? 'agent' : 'agents'}`;
    $('subagents-total-pill').textContent =
      sub.activeCount > 0 ? `${sub.activeCount} running` : '';

    if (!sub.count) {
      $('subagents-empty').classList.remove('hidden');
      $('subagents-content').classList.add('hidden');
    } else {
      $('subagents-empty').classList.add('hidden');
      $('subagents-content').classList.remove('hidden');
      $('sub-combined-noncached').textContent = fmtTok(
        (cum.nonCachedTokens || 0) + (sub.totalNonCachedTokens || 0),
      );
      $('sub-combined-cache').textContent = fmtTok(
        (cum.cacheReadTokens || 0) + (sub.totalCacheReadTokens || 0),
      );
      $('subagents-list').innerHTML = (sub.items || [])
        .map(
          (item) => `
          <li class="subagent-item">
            <div class="sub-left">
              <span class="sub-dot${item.running ? ' is-running' : ''}" aria-hidden="true"></span>
              <span class="sub-name" title="${escHtml(item.name)}">${escHtml(item.name)}</span>
            </div>
            <span class="sub-stats">${fmtTok(item.nonCachedTokens)} burn · ${fmtTok(item.currentContextTokens)} ctx</span>
          </li>`,
        )
        .join('');
    }
  }

  function render() {
    const d = state.data;
    const conv = state.conv;
    const limit = effectiveLimit();

    $('conv-badge').textContent = conv ? `#${conv.slice(0, 8)}` : 'No chat';
    $('conv-badge').title = conv || 'No active conversation';

    const livePill = $('live-pill');
    const isOffline = state.pollFailures >= 2;
    const turnActive = !isOffline && Boolean(d?.turnActive);
    livePill.classList.toggle('is-offline', isOffline);
    livePill.classList.toggle('is-active', turnActive);
    $('live-label').textContent = isOffline ? 'Offline' : turnActive ? 'Active' : 'Live';
    livePill.title = isOffline ? 'Lost connection to local Context Meter sidecar — retrying' : 'Polling active conversation';

    renderModelBar(limit);

    const latest = d?.latest || null;
    const cacheRead = latest?.cacheReadTokens || 0;
    const freshInput = latest?.inputTokens || 0;
    const output = latest?.outputTokens || 0;
    const pending = d?.pendingEstTokens || 0;
    const currentTotal = d?.currentContextTokens || 0;

    const pct = limit > 0 ? (currentTotal / limit) * 100 : 0;
    $('ctx-current').textContent = fmtTok(currentTotal);
    $('ctx-limit-label').textContent = `of ${fmtTok(limit)} (${pct.toFixed(1)}%)`;

    const warnTarget = limit * (state.warnPct / 100);
    const toWarn = warnTarget - currentTotal;
    $('runway-left').textContent =
      toWarn > 0 ? `${fmtTok(toWarn)} to ${state.warnPct}% warn` : `${fmtTok(Math.abs(toWarn))} over ${state.warnPct}% warn`;

    const hist = d?.history || [];
    if (hist.length >= 2) {
      const avgDelta = hist.slice(-10).reduce((acc, h) => acc + Math.max(0, h.delta), 0) / Math.min(10, hist.length);
      $('runway-velocity').textContent = `Avg +${fmtTok(avgDelta)} / step`;
      $('runway-velocity').classList.remove('hidden');
    } else {
      $('runway-velocity').classList.add('hidden');
    }

    const segPct = (val) => Math.min(100, (val / Math.max(limit, 1)) * 100);
    const pCache = segPct(cacheRead);
    const pInput = Math.min(100 - pCache, segPct(freshInput));
    const pOutput = Math.min(100 - pCache - pInput, segPct(output));
    const pPending = Math.min(100 - pCache - pInput - pOutput, segPct(pending));

    $('seg-cache').style.setProperty('--w', `${pCache.toFixed(2)}%`);
    $('seg-input').style.setProperty('--w', `${pInput.toFixed(2)}%`);
    $('seg-output').style.setProperty('--w', `${pOutput.toFixed(2)}%`);
    $('seg-pending').style.setProperty('--w', `${pPending.toFixed(2)}%`);
    $('meter-track').setAttribute('aria-valuenow', String(Math.min(100, Math.round(pct))));

    $('leg-cache').textContent = fmtTok(cacheRead);
    $('leg-input').textContent = fmtTok(freshInput);
    $('leg-output').textContent = fmtTok(output);
    $('leg-pending').textContent = fmtTok(pending);
    $('leg-pending-wrap').classList.toggle('hidden', pending <= 0);

    const badge = $('status-badge');
    const banner = $('compact-banner');
    const highThreshold = Math.min(95, state.warnPct + 15);

    badge.className = 'status-badge';
    banner.classList.remove('is-high');

    if (pct >= highThreshold) {
      badge.classList.add('status-high');
      badge.textContent = 'High — /compact';
      banner.classList.remove('hidden');
      banner.classList.add('is-high');
      $('compact-msg').textContent = `Context is at ${pct.toFixed(0)}%. Run /compact now to cut per-turn token burn.`;
    } else if (pct >= state.warnPct) {
      badge.classList.add('status-warn');
      badge.textContent = 'Consider /compact';
      banner.classList.remove('hidden');
      $('compact-msg').textContent = `Passed ${state.warnPct}% target (${fmtTok(currentTotal)}). Good time to run /compact.`;
    } else {
      badge.classList.add('status-ok');
      badge.textContent = currentTotal > 0 ? 'Healthy' : 'Ready';
      banner.classList.add('hidden');
    }

    const isEmpty = !d?.exists && hist.length === 0;
    $('empty-state').classList.toggle('hidden', !isEmpty);
    $('telemetry-grid').classList.toggle('hidden', isEmpty);

    $('cache-hit-badge').textContent = `${(d?.latestCacheHitRate || 0).toFixed(1)}% cached`;
    $('st-cache').textContent = fmtTok(cacheRead);
    $('st-input').textContent = fmtTok(freshInput);
    $('st-output').textContent = fmtTok(output);

    const ob = d?.outputBreakdown || null;
    const splitEl = $('st-output-split');
    if (ob && (ob.latestThinkingTokens != null || ob.latestResponseTokens != null)) {
      splitEl.textContent = `Think ${fmtTok(ob.latestThinkingTokens || 0)} · Resp ${fmtTok(ob.latestResponseTokens || 0)}`;
      splitEl.classList.remove('hidden');
    } else {
      splitEl.classList.add('hidden');
    }

    $('st-delta').textContent = latest
      ? `${fmtSigned(latest.delta)}${latest.compacted ? ' (compact)' : ''}`
      : '—';

    const cum = d?.cumulative || {};
    $('session-cache-badge').textContent = `${(cum.cacheHitRate || 0).toFixed(1)}% cache hit`;
    $('cum-noncached').textContent = fmtTok(cum.nonCachedTokens || 0);
    $('cum-cache').textContent = fmtTok(cum.cacheReadTokens || 0);
    $('cum-output-split').textContent = ob
      ? `${fmtTok(ob.totalThinkingTokens || 0)} / ${fmtTok(ob.totalResponseTokens || 0)}`
      : `${fmtTok(cum.outputTokens || 0)} total`;
    $('cum-turns').textContent = `${d?.userTurns || 0} / ${d?.totalToolCalls || 0} / ${d?.compactions || 0}`;

    renderChart(hist, limit);
    renderDeepDiagnostics(d);
  }

  function toggleSettings(forceOpen, focusTargetId) {
    const drawer = $('settings-drawer');
    const shouldOpen = forceOpen != null ? forceOpen : drawer.classList.contains('hidden');
    drawer.classList.toggle('hidden', !shouldOpen);
    const expanded = String(shouldOpen);
    $('settings-toggle').setAttribute('aria-expanded', expanded);
    $('budget-summary-chip').setAttribute('aria-expanded', expanded);
    $('rate-summary-chip').setAttribute('aria-expanded', expanded);
    if (shouldOpen && focusTargetId) {
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
      drawer.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' });
      $(focusTargetId)?.focus({ preventScroll: true });
    }
  }

  $('settings-toggle').addEventListener('click', () => toggleSettings());
  $('budget-summary-chip').addEventListener('click', () => toggleSettings(undefined, 'auto-limit-btn'));
  $('rate-summary-chip').addEventListener('click', () => toggleSettings(true, 'rate-in'));

  $('auto-limit-btn').addEventListener('click', () => {
    clearFieldError($('custom-limit'), $('settings-model-hint'), modelHintText());
    delete state.overrides[activeModelKey()];
    persistPrefs();
    syncControlUI();
    render();
  });

  document.querySelectorAll('.seg-btn[data-limit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      clearFieldError($('custom-limit'), $('settings-model-hint'), modelHintText());
      state.overrides[activeModelKey()] = Number(btn.dataset.limit);
      persistPrefs();
      syncControlUI();
      render();
    });
  });

  function parseCustomLimit(raw) {
    const s = String(raw || '').trim().toLowerCase().replace(/,/g, '');
    if (!s) return null;
    const m = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(s);
    if (!m) return null;
    const num = Number(m[1]);
    if (!Number.isFinite(num) || num <= 0) return null;
    let tokens;
    if (m[2] === 'm') tokens = Math.round(num * 1000000);
    else if (m[2] === 'k') tokens = Math.round(num * 1000);
    else tokens = num < 10000 ? Math.round(num * 1000) : Math.round(num);
    if (tokens < 10000 || tokens > 10000000) return null;
    return tokens;
  }

  function bindValidatedInput({ inputId, hintId, defaultHint, errorMsg, parse, onValid, onClear }) {
    const input = $(inputId);
    const hint = $(hintId);
    const getDefault = typeof defaultHint === 'function' ? defaultHint : () => defaultHint;
    let debounceTimer = null;

    input.addEventListener('input', (e) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      const parsed = parse(e.target.value);
      if (input.getAttribute('aria-invalid') === 'true' && (!e.target.value.trim() || parsed != null)) {
        clearFieldError(input, hint, getDefault());
      }
      if (parsed != null) {
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          onValid(parsed);
        }, 450);
      }
    });

    input.addEventListener('change', (e) => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      const parsed = parse(e.target.value);
      if (parsed != null) {
        clearFieldError(input, hint, getDefault());
        onValid(parsed);
      } else if (!e.target.value.trim()) {
        clearFieldError(input, hint, getDefault());
        onClear();
      } else {
        setFieldError(input, hint, errorMsg);
      }
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.target.blur();
    });
  }

  bindValidatedInput({
    inputId: 'custom-limit',
    hintId: 'settings-model-hint',
    defaultHint: modelHintText,
    errorMsg: 'Enter 10k–10M (e.g. 250k or 1.5M)',
    parse: parseCustomLimit,
    onValid: (parsed) => {
      state.overrides[activeModelKey()] = parsed;
      persistPrefs();
      syncControlUI();
      render();
    },
    onClear: () => {
      delete state.overrides[activeModelKey()];
      persistPrefs();
      syncControlUI();
      render();
    },
  });

  document.querySelectorAll('.warn-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      clearFieldError($('custom-warn'), $('warn-hint'), DEFAULT_WARN_HINT);
      state.warnPct = Number(btn.dataset.warn);
      persistPrefs();
      syncControlUI();
      render();
    });
  });

  function parseCustomWarn(raw) {
    const s = String(raw || '').trim().replace(/%$/, '').trim();
    if (!s) return null;
    const num = Number(s);
    if (!Number.isFinite(num)) return null;
    const rounded = Math.round(num);
    if (rounded < 5 || rounded > 95) return null;
    return rounded;
  }

  bindValidatedInput({
    inputId: 'custom-warn',
    hintId: 'warn-hint',
    defaultHint: DEFAULT_WARN_HINT,
    errorMsg: 'Enter 5%–95% (e.g. 40%)',
    parse: parseCustomWarn,
    onValid: (parsed) => {
      state.warnPct = parsed;
      persistPrefs();
      syncControlUI();
      render();
    },
    onClear: () => {
      state.warnPct = 30;
      persistPrefs();
      syncControlUI();
      render();
    },
  });

  const RATE_IDS = ['rate-in', 'rate-cache', 'rate-out'];
  let rateDebounceTimer = null;
  const clearAllRateErrors = () => {
    const hint = $('rates-hint');
    RATE_IDS.forEach((id) => clearFieldError($(id), hint, DEFAULT_RATES_HINT));
  };

  const readValidRates = () => {
    const parsed = {};
    for (const id of RATE_IDS) {
      const raw = $(id).value.trim();
      const val = Number(raw);
      if (raw === '' || !Number.isFinite(val) || val < 0) return null;
      parsed[id] = val;
    }
    return parsed;
  };

  const commitRates = (parsed) => {
    state.rates[activeModelKey()] = {
      in: parsed['rate-in'],
      cache: parsed['rate-cache'],
      out: parsed['rate-out'],
    };
    persistPrefs();
    syncControlUI();
    render();
  };

  const saveRateInputs = () => {
    if (rateDebounceTimer) {
      clearTimeout(rateDebounceTimer);
      rateDebounceTimer = null;
    }
    const hint = $('rates-hint');
    const parsed = {};
    let hasInvalid = false;

    for (const id of RATE_IDS) {
      const el = $(id);
      const raw = el.value.trim();
      const val = Number(raw);
      if (raw === '' || !Number.isFinite(val) || val < 0) {
        hasInvalid = true;
        setFieldError(el, hint, 'Enter non-negative $/1M rates (e.g. 1.25)');
      } else {
        clearFieldError(el, null);
        parsed[id] = val;
      }
    }
    if (hasInvalid) return;

    hint.classList.remove('is-error');
    hint.textContent = DEFAULT_RATES_HINT;
    commitRates(parsed);
  };
  RATE_IDS.forEach((id) => {
    $(id).addEventListener('change', saveRateInputs);
    $(id).addEventListener('input', (e) => {
      if (rateDebounceTimer) clearTimeout(rateDebounceTimer);
      const raw = e.target.value.trim();
      const val = Number(raw);
      if (e.target.getAttribute('aria-invalid') === 'true' && raw !== '' && Number.isFinite(val) && val >= 0) {
        clearFieldError(e.target, null);
        if (!RATE_IDS.some((otherId) => $(otherId).getAttribute('aria-invalid') === 'true')) {
          clearFieldError(e.target, $('rates-hint'), DEFAULT_RATES_HINT);
        }
      }
      const valid = readValidRates();
      if (valid) {
        rateDebounceTimer = setTimeout(() => {
          rateDebounceTimer = null;
          commitRates(valid);
        }, 450);
      }
    });
  });

  $('rate-reset-btn').addEventListener('click', () => {
    if (rateDebounceTimer) {
      clearTimeout(rateDebounceTimer);
      rateDebounceTimer = null;
    }
    clearAllRateErrors();
    delete state.rates[activeModelKey()];
    persistPrefs();
    syncControlUI();
    render();
  });

  document.querySelectorAll('.scale-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.chartScale = btn.dataset.scale === 'window' ? 'window' : 'fit';
      persistPrefs();
      syncControlUI();
      render();
    });
  });

  const svgEl = $('chart-svg');
  const clearInspect = () => {
    state.inspectedIdx = null;
    svgEl.querySelectorAll('.chart-bar.is-selected').forEach((n) => n.classList.remove('is-selected'));
    updateInspector(null);
  };
  const inspectTarget = (el) => {
    const bar = el?.closest?.('.chart-bar');
    if (!bar) return false;
    const idx = Number(bar.dataset.idx);
    const hist = state.data?.history || [];
    if (!Number.isFinite(idx) || !hist[idx]) return false;
    state.inspectedIdx = idx;
    svgEl.querySelectorAll('.chart-bar.is-selected').forEach((n) => n.classList.remove('is-selected'));
    bar.classList.add('is-selected');
    updateInspector(hist[idx]);
    return true;
  };
  svgEl.addEventListener('pointerover', (e) => {
    if (!inspectTarget(e.target)) clearInspect();
  });
  svgEl.addEventListener('pointerout', (e) => {
    if (e.target?.closest?.('.chart-bar') && !e.relatedTarget?.closest?.('.chart-bar')) {
      clearInspect();
    }
  });
  svgEl.addEventListener('pointerleave', clearInspect);
  svgEl.addEventListener('focusin', (e) => inspectTarget(e.target));
  svgEl.addEventListener('focusout', (e) => {
    if (!svgEl.contains(e.relatedTarget)) clearInspect();
  });
  svgEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.inspectedIdx != null) clearInspect();
  });
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (state.inspectedIdx != null && !svgEl.contains(e.target)) {
        clearInspect();
      }
    },
    { passive: true },
  );

  $('copy-compact-btn').addEventListener('click', async () => {
    const btn = $('copy-compact-btn');
    try {
      await navigator.clipboard.writeText('/compact');
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy /compact'; }, 1400);
    } catch {
      btn.textContent = 'Type /compact';
    }
  });

  async function poll() {
    try {
      const conv = currentConv();
      if (conv !== state.conv) {
        state.conv = conv;
        state.etag = '';
        state.data = null;
        state.inspectedIdx = null;
      }
      const q = new URLSearchParams();
      if (state.etag) q.set('etag', state.etag);
      if (conv) q.set('conversationId', conv);

      const res = await getJson(`/api/context?${q}`);
      const wasOffline = state.pollFailures >= 2;
      state.pollFailures = 0;
      if (!res.unchanged) {
        state.etag = res.etag || '';
        state.data = res;
        syncControlUI();
        render();
      } else if (wasOffline) {
        render();
      }
    } catch {
      state.pollFailures += 1;
      if (state.pollFailures === 2) render();
    } finally {
      setTimeout(poll, POLL_MS);
    }
  }

  syncControlUI();
  render();
  hydratePrefs();
  poll();
})();
