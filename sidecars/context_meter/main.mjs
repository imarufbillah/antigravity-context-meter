/**
 * Context Meter sidecar backend (read-only).
 *
 * Combines:
 * 1. <appData>/brain/<conversationId>/.system_generated/logs/transcript.jsonl
 *    for exact per-step input_tokens, cache_read_tokens, output_tokens,
 *    top context growth spikes (hogs), and compaction impact history.
 * 2. Local Language Server Connect RPC (GetUserStatus, GetCascadeTrajectory,
 *    GetAllCascadeTrajectories) for active model identification,
 *    thinking/response output split, and child subagent/swarm token totals.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ID_RE = /^[0-9a-f-]{8,}$/i;

const STATIC = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

const PREFS_PATH = process.env.PLUGIN_DATA
  ? join(process.env.PLUGIN_DATA, 'prefs.json')
  : join(homedir(), '.gemini', 'config', 'context-meter-prefs.json');

function sanitizePrefs(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const warnRaw = Number(src.warnPct);
  const warnPct = Number.isFinite(warnRaw)
    ? Math.min(95, Math.max(5, Math.round(warnRaw)))
    : 30;
  const chartScale = src.chartScale === 'window' ? 'window' : 'fit';

  const overrides = {};
  if (src.overrides && typeof src.overrides === 'object' && !Array.isArray(src.overrides)) {
    for (const [k, v] of Object.entries(src.overrides)) {
      if (!k || typeof k !== 'string') continue;
      const limit = Number(v);
      if (Number.isFinite(limit) && limit >= 10000 && limit <= 10000000) {
        overrides[k] = Math.round(limit);
      }
    }
  }

  const rates = {};
  if (src.rates && typeof src.rates === 'object' && !Array.isArray(src.rates)) {
    for (const [k, v] of Object.entries(src.rates)) {
      if (!k || typeof k !== 'string' || !v || typeof v !== 'object') continue;
      const rIn = Number(v.in);
      const rCache = Number(v.cache);
      const rOut = Number(v.out);
      if (
        Number.isFinite(rIn) && rIn >= 0 &&
        Number.isFinite(rCache) && rCache >= 0 &&
        Number.isFinite(rOut) && rOut >= 0
      ) {
        rates[k] = { in: rIn, cache: rCache, out: rOut };
      }
    }
  }

  return { warnPct, chartScale, overrides, rates };
}

function readPrefsFile() {
  if (!existsSync(PREFS_PATH)) {
    return { exists: false, ...sanitizePrefs(null) };
  }
  try {
    const raw = JSON.parse(readFileSync(PREFS_PATH, 'utf-8'));
    return { exists: true, ...sanitizePrefs(raw) };
  } catch {
    return { exists: false, ...sanitizePrefs(null) };
  }
}

function writePrefsFile(raw) {
  const clean = sanitizePrefs(raw);
  mkdirSync(dirname(PREFS_PATH), { recursive: true });
  const tmp = `${PREFS_PATH}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(clean, null, 2), 'utf-8');
  renameSync(tmp, PREFS_PATH);
  return { exists: true, ...clean };
}

function inferContextWindow(modelId = '', label = '', modelKey = '') {
  const hay = `${modelId} ${label} ${modelKey}`.toLowerCase();
  if (hay.includes('gpt-oss-120b')) return { windowTokens: 128000, known: true };
  if (hay.includes('gemini')) return { windowTokens: 1000000, known: true };
  if (hay.includes('claude')) return { windowTokens: 1000000, known: true };
  if (hay.includes('gpt-4') || hay.includes('gpt-5') || /\bo[134]\b/.test(hay)) {
    return { windowTokens: 200000, known: true };
  }
  return { windowTokens: 1000000, known: false };
}

async function lsRpc(method, body) {
  const addr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!addr || !csrf) return null;
  try {
    const res = await fetch(
      `http://${addr}/exa.language_server_pb.LanguageServerService/${method}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-codeium-csrf-token': csrf,
        },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(1500),
      },
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const USER_STATUS_TTL_MS = 12000;
const TRAJECTORY_TTL_MS = 3500;
const ALL_TRAJ_TTL_MS = 4500;

let userStatusCache = { at: 0, data: null };
const trajectoryCache = new Map(); // conv -> { at, mtimeKey, data }
let allTrajCache = { at: 0, summaries: null };
const childTranscriptCache = new Map(); // path -> { fileKey, summary }

async function getModelCatalog() {
  const now = Date.now();
  if (userStatusCache.data && now - userStatusCache.at < USER_STATUS_TTL_MS) {
    return userStatusCache.data;
  }
  const res = await lsRpc('GetUserStatus', {});
  const cfg = res?.userStatus?.cascadeModelConfigData;
  if (!cfg) return userStatusCache.data;

  const byKey = new Map();
  const configs = Array.isArray(cfg.clientModelConfigs) ? cfg.clientModelConfigs : [];
  for (const item of configs) {
    const modelKey = item?.modelOrAlias?.model || '';
    if (!modelKey) continue;
    const label = item.label || item.modelId || modelKey;
    const modelId = item.modelId || '';
    const inferred = inferContextWindow(modelId, label, modelKey);
    byKey.set(modelKey, {
      modelKey,
      modelId,
      label,
      contextWindow: inferred.windowTokens,
      windowKnown: inferred.known,
    });
  }
  const defaultModelKey = cfg.defaultOverrideModelConfig?.modelOrAlias?.model || '';
  const catalog = { byKey, defaultModelKey };
  userStatusCache = { at: now, data: catalog };
  return catalog;
}

async function getTrajectoryUsage(conv, mtimeKey) {
  const now = Date.now();
  const cached = trajectoryCache.get(conv);
  if (
    cached &&
    cached.mtimeKey === mtimeKey &&
    now - cached.at < TRAJECTORY_TTL_MS
  ) {
    return cached.data;
  }

  const res = await lsRpc('GetCascadeTrajectory', { cascadeId: conv });
  const steps = Array.isArray(res?.trajectory?.steps) ? res.trajectory.steps : null;
  if (!steps) return cached?.data || null;

  let latestModelKey = '';
  let latestThinkingTokens = null;
  let latestResponseTokens = null;
  let totalThinkingTokens = 0;
  let totalResponseTokens = 0;
  let hasOutputBreakdown = false;

  for (const st of steps) {
    const meta = st?.metadata;
    if (!meta) continue;
    const modelKey = meta.modelUsage?.model || meta.generatorModel || '';
    if (modelKey) latestModelKey = modelKey;

    if (meta.modelUsage) {
      const think = Number(meta.modelUsage.thinkingOutputTokens);
      const resp = Number(meta.modelUsage.responseOutputTokens);
      if (Number.isFinite(think) || Number.isFinite(resp)) {
        hasOutputBreakdown = true;
        const tVal = Number.isFinite(think) ? think : 0;
        const rVal = Number.isFinite(resp) ? resp : 0;
        latestThinkingTokens = tVal;
        latestResponseTokens = rVal;
        totalThinkingTokens += tVal;
        totalResponseTokens += rVal;
      }
    }
  }

  const parsed = {
    latestModelKey,
    hasOutputBreakdown,
    latestThinkingTokens,
    latestResponseTokens,
    totalThinkingTokens,
    totalResponseTokens,
  };
  if (trajectoryCache.size > 50) trajectoryCache.clear();
  trajectoryCache.set(conv, { at: now, mtimeKey, data: parsed });
  return parsed;
}

async function getAllTrajectorySummaries() {
  const now = Date.now();
  if (allTrajCache.summaries && now - allTrajCache.at < ALL_TRAJ_TTL_MS) {
    return allTrajCache.summaries;
  }
  const res = await lsRpc('GetAllCascadeTrajectories', {});
  const summaries = res?.trajectorySummaries;
  if (!summaries || typeof summaries !== 'object') return allTrajCache.summaries;
  allTrajCache = { at: now, summaries };
  return summaries;
}

function summarizeChildTranscript(path) {
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  const fileKey = `${st.mtimeMs}:${st.size}`;
  const cached = childTranscriptCache.get(path);
  if (cached && cached.fileKey === fileKey) return cached.summary;

  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }

  let sumInput = 0;
  let sumCacheRead = 0;
  let sumOutput = 0;
  let latestContext = 0;
  let userTurns = 0;
  let toolCalls = 0;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (obj.type === 'USER_INPUT') userTurns += 1;
    const hasTokens =
      obj.input_tokens != null || obj.cache_read_tokens != null || obj.output_tokens != null;
    if (obj.type === 'PLANNER_RESPONSE' || hasTokens) {
      const i = Number(obj.input_tokens) || 0;
      const c = Number(obj.cache_read_tokens) || 0;
      const o = Number(obj.output_tokens) || 0;
      sumInput += i;
      sumCacheRead += c;
      sumOutput += o;
      latestContext = i + c + o;
      if (Array.isArray(obj.tool_calls)) toolCalls += obj.tool_calls.length;
    }
  }

  const summary = {
    inputTokens: sumInput,
    cacheReadTokens: sumCacheRead,
    outputTokens: sumOutput,
    nonCachedTokens: sumInput + sumOutput,
    currentContextTokens: latestContext,
    userTurns,
    toolCalls,
  };
  if (childTranscriptCache.size > 150) childTranscriptCache.clear();
  childTranscriptCache.set(path, { fileKey, summary });
  return summary;
}

async function getSubagentBurn(conv) {
  const summaries = await getAllTrajectorySummaries();
  if (!summaries) return { count: 0, activeCount: 0, totalNonCachedTokens: 0, totalCacheReadTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, items: [] };

  const children = [];
  for (const [id, entry] of Object.entries(summaries)) {
    if (!id || id === conv || !ID_RE.test(id)) continue;
    const meta = entry?.trajectoryMetadata;
    if (!meta) continue;
    if (meta.rootConversationId === conv || meta.parentConversationId === conv) {
      children.push({ id, entry, meta });
    }
  }

  if (!children.length) {
    return {
      count: 0,
      activeCount: 0,
      totalNonCachedTokens: 0,
      totalCacheReadTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      items: [],
    };
  }

  children.sort((a, b) => String(b.meta.createdAt || '').localeCompare(String(a.meta.createdAt || '')));
  const limited = children.slice(0, 30);

  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalOutputTokens = 0;
  let totalNonCachedTokens = 0;
  let activeCount = 0;
  const items = [];

  for (const { id, entry, meta } of limited) {
    const p = findTranscriptPath(id);
    const tr = p ? summarizeChildTranscript(p) : null;
    const inputTokens = tr?.inputTokens || 0;
    const cacheReadTokens = tr?.cacheReadTokens || 0;
    const outputTokens = tr?.outputTokens || 0;
    const nonCachedTokens = tr?.nonCachedTokens || 0;

    totalInputTokens += inputTokens;
    totalCacheReadTokens += cacheReadTokens;
    totalOutputTokens += outputTokens;
    totalNonCachedTokens += nonCachedTokens;

    const running = entry?.status === 'CASCADE_RUN_STATUS_RUNNING';
    if (running) activeCount += 1;

    const rawName =
      meta.agentScript?.name ||
      meta.subagentSpec?.role ||
      entry?.summary ||
      `Agent ${id.slice(0, 6)}`;
    const role = meta.subagentSpec?.typeName || '';

    items.push({
      id,
      name: rawName,
      role,
      running,
      currentContextTokens: tr?.currentContextTokens || 0,
      nonCachedTokens,
      cacheReadTokens,
      toolCalls: tr?.toolCalls || 0,
    });
  }

  return {
    count: children.length,
    activeCount,
    totalInputTokens,
    totalCacheReadTokens,
    totalOutputTokens,
    totalNonCachedTokens,
    items,
  };
}

function resolveModelInfo(catalog, modelKey, isDefaultFallback) {
  if (!modelKey) return null;
  const entry = catalog?.byKey?.get(modelKey);
  if (entry) {
    return { ...entry, isDefaultFallback };
  }
  const inferred = inferContextWindow('', '', modelKey);
  return {
    modelKey,
    modelId: '',
    label: modelKey,
    contextWindow: inferred.windowTokens,
    windowKnown: inferred.known,
    isDefaultFallback,
  };
}

function safeReaddir(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function findAppDataDirs() {
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) !== 'sidecar_data') continue;
      const appData = dirname(d);
      return existsSync(join(appData, 'brain')) ? [appData] : [];
    }
    return [];
  }
  const root = join(homedir(), '.gemini');
  return safeReaddir(root)
    .sort()
    .map((name) => join(root, name))
    .filter((c) => existsSync(join(c, 'brain')));
}

function findTranscriptPath(conv) {
  if (!conv || !ID_RE.test(conv)) return null;
  for (const appData of findAppDataDirs()) {
    const p = join(appData, 'brain', conv, '.system_generated', 'logs', 'transcript.jsonl');
    if (existsSync(p)) return p;
  }
  return null;
}

function estimateStepChars(step) {
  let chars = 0;
  if (typeof step.content === 'string') chars += step.content.length;
  if (typeof step.thinking === 'string') chars += step.thinking.length;
  if (Array.isArray(step.tool_calls)) chars += JSON.stringify(step.tool_calls).length;
  return chars;
}

function describeToolCall(tc) {
  const name = tc?.name || 'tool';
  const args = tc?.arguments && typeof tc.arguments === 'object' ? tc.arguments : null;
  if (!args) return name;
  const target =
    args.Path ||
    args.TargetFile ||
    args.CommandLine ||
    args.query ||
    args.Url ||
    args.ToolName ||
    '';
  if (typeof target !== 'string' || !target) return name;
  const clean = target.includes('/') ? basename(target) || target : target;
  const short = clean.length > 26 ? `${clean.slice(0, 25)}…` : clean;
  return `${name} (${short})`;
}

function parseTranscript(path) {
  const st = statSync(path);
  const fileKey = `${st.mtimeMs}:${st.size}`;
  const raw = readFileSync(path, 'utf-8');
  const lines = raw.split('\n');

  let totalSteps = 0;
  let userTurns = 0;
  let totalToolCalls = 0;
  let compactions = 0;

  let sumInput = 0;
  let sumCacheRead = 0;
  let sumOutput = 0;

  let prevPromptTotal = 0;
  let pendingCharsAfterPlanner = 0;
  let lastStepType = '';
  let lastStepStatus = '';
  let lastPlannerHasToolCalls = false;
  let lastUpdatedAt = null;
  let pendingToolLabels = [];
  let sawUserInputSincePlanner = false;

  const history = [];
  const spikes = [];
  const compactionEvents = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }

    totalSteps += 1;
    lastStepType = obj.type || '';
    lastStepStatus = obj.status || '';
    if (obj.created_at) lastUpdatedAt = obj.created_at;

    if (obj.type === 'USER_INPUT') {
      userTurns += 1;
      sawUserInputSincePlanner = true;
    }

    const hasTokens =
      obj.input_tokens != null || obj.cache_read_tokens != null || obj.output_tokens != null;

    if (obj.type === 'PLANNER_RESPONSE' || hasTokens) {
      const inputTokens = Number(obj.input_tokens) || 0;
      const cacheReadTokens = Number(obj.cache_read_tokens) || 0;
      const outputTokens = Number(obj.output_tokens) || 0;
      const promptTotal = inputTokens + cacheReadTokens;
      const afterOutputTotal = promptTotal + outputTokens;
      const toolCalls = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];
      const toolCount = toolCalls.length;

      totalToolCalls += toolCount;
      sumInput += inputTokens;
      sumCacheRead += cacheReadTokens;
      sumOutput += outputTokens;

      const compacted = prevPromptTotal > 0 && promptTotal < prevPromptTotal * 0.7;
      if (compacted) {
        compactions += 1;
        const savedTokens = prevPromptTotal - promptTotal;
        const reductionPct = Math.round((savedTokens / prevPromptTotal) * 1000) / 10;
        compactionEvents.push({
          stepIndex: Number(obj.step_index) || history.length,
          beforeTokens: prevPromptTotal,
          afterTokens: promptTotal,
          savedTokens,
          reductionPct,
          createdAt: obj.created_at || null,
        });
      }

      const delta = prevPromptTotal > 0 ? promptTotal - prevPromptTotal : promptTotal;
      if (prevPromptTotal > 0 && delta > 0) {
        let sourceLabel = 'Conversation turn';
        if (pendingToolLabels.length) {
          sourceLabel =
            pendingToolLabels.length > 2
              ? `${pendingToolLabels.slice(0, 2).join(', ')} +${pendingToolLabels.length - 2}`
              : pendingToolLabels.join(', ');
        } else if (sawUserInputSincePlanner) {
          sourceLabel = 'User prompt / attachments';
        }
        spikes.push({
          stepIndex: Number(obj.step_index) || history.length,
          delta,
          promptTotal,
          label: sourceLabel,
        });
      }

      prevPromptTotal = promptTotal;

      history.push({
        stepIndex: Number(obj.step_index) || history.length,
        createdAt: obj.created_at || null,
        inputTokens,
        cacheReadTokens,
        outputTokens,
        promptTotal,
        afterOutputTotal,
        delta,
        toolCount,
        compacted,
      });

      pendingCharsAfterPlanner = 0;
      lastPlannerHasToolCalls = toolCount > 0;
      pendingToolLabels = toolCalls.map(describeToolCall);
      sawUserInputSincePlanner = false;
    } else {
      pendingCharsAfterPlanner += estimateStepChars(obj);
    }
  }

  const latest = history.length ? history[history.length - 1] : null;
  const pendingEstTokens = Math.round(pendingCharsAfterPlanner / 4);
  const currentContextTokens = latest ? latest.afterOutputTotal + pendingEstTokens : pendingEstTokens;

  const totalPromptTokens = sumInput + sumCacheRead;
  const sessionCacheHitRate =
    totalPromptTokens > 0 ? Math.round((sumCacheRead / totalPromptTokens) * 1000) / 10 : 0;
  const latestCacheHitRate =
    latest && latest.promptTotal > 0
      ? Math.round((latest.cacheReadTokens / latest.promptTotal) * 1000) / 10
      : 0;

  const turnActive =
    totalSteps > 0 &&
    (lastStepType !== 'PLANNER_RESPONSE' || lastStepStatus !== 'DONE' || lastPlannerHasToolCalls);

  const topHogs = spikes.sort((a, b) => b.delta - a.delta).slice(0, 5);

  return {
    fileKey,
    exists: true,
    totalSteps,
    userTurns,
    totalToolCalls,
    compactions,
    compactionEvents: compactionEvents.reverse(),
    topHogs,
    turnActive,
    lastUpdatedAt,
    pendingEstTokens,
    currentContextTokens,
    latest,
    latestCacheHitRate,
    cumulative: {
      inputTokens: sumInput,
      cacheReadTokens: sumCacheRead,
      outputTokens: sumOutput,
      nonCachedTokens: sumInput + sumOutput,
      totalProcessedTokens: sumInput + sumCacheRead + sumOutput,
      cacheHitRate: sessionCacheHitRate,
    },
    history: history.slice(-120),
  };
}

const app = new SidecarApp();

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));

for (const [route, [file, contentType]] of Object.entries(STATIC)) {
  app.api(
    route,
    () => new Response(readFileSync(join(__dirname, file), 'utf-8'), { contentType }),
    'GET',
  );
}

app.api(
  '/api/context',
  async (data) => {
    const conv = data.conversationId || app.config.conversationId || '';
    if (!conv || !ID_RE.test(conv)) {
      return { conversationId: conv || null, exists: false };
    }

    const path = findTranscriptPath(conv);
    let fileKey = 'none';
    if (path) {
      try {
        const st = statSync(path);
        fileKey = `${st.mtimeMs}:${st.size}`;
      } catch {
        fileKey = 'none';
      }
    }

    const [catalog, traj, subagents] = await Promise.all([
      getModelCatalog(),
      getTrajectoryUsage(conv, fileKey),
      getSubagentBurn(conv),
    ]);

    const activeKey = traj?.latestModelKey || catalog?.defaultModelKey || '';
    const model = resolveModelInfo(
      catalog,
      activeKey,
      !traj?.latestModelKey && Boolean(catalog?.defaultModelKey),
    );

    const subKey = `${subagents.count}:${subagents.activeCount}:${subagents.totalNonCachedTokens}:${subagents.totalCacheReadTokens}`;
    const etag = `${fileKey}|${model?.modelKey || ''}|${traj?.totalThinkingTokens || 0}|${traj?.totalResponseTokens || 0}|${subKey}`;

    if (data.etag && data.etag === etag) {
      return { conversationId: conv, exists: Boolean(path), unchanged: true, etag };
    }

    if (!path) {
      return {
        conversationId: conv,
        etag,
        exists: false,
        model,
        subagents,
        outputBreakdown: traj?.hasOutputBreakdown
          ? {
              latestThinkingTokens: traj.latestThinkingTokens,
              latestResponseTokens: traj.latestResponseTokens,
              totalThinkingTokens: traj.totalThinkingTokens,
              totalResponseTokens: traj.totalResponseTokens,
            }
          : null,
        currentContextTokens: 0,
        pendingEstTokens: 0,
        totalSteps: 0,
        userTurns: 0,
        totalToolCalls: 0,
        compactions: 0,
        compactionEvents: [],
        topHogs: [],
        turnActive: false,
        latest: null,
        latestCacheHitRate: 0,
        cumulative: {
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          nonCachedTokens: 0,
          totalProcessedTokens: 0,
          cacheHitRate: 0,
        },
        history: [],
      };
    }

    try {
      const parsed = parseTranscript(path);
      return {
        conversationId: conv,
        etag,
        model,
        subagents,
        outputBreakdown: traj?.hasOutputBreakdown
          ? {
              latestThinkingTokens: traj.latestThinkingTokens,
              latestResponseTokens: traj.latestResponseTokens,
              totalThinkingTokens: traj.totalThinkingTokens,
              totalResponseTokens: traj.totalResponseTokens,
            }
          : null,
        ...parsed,
      };
    } catch (err) {
      return {
        conversationId: conv,
        exists: false,
        model,
        subagents,
        error: String(err?.message || err),
      };
    }
  },
  'GET',
);

app.api('/api/prefs', () => readPrefsFile(), 'GET');
app.api('/api/prefs', (data) => writePrefsFile(data), 'POST');

app.run();
