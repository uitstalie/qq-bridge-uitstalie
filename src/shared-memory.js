/**
 * 跨会话共享记忆（memory / 联想层）。
 *
 * 背景：每个 group / private 会话各有一条 DSH 会话，上下文天然隔离 —— 这是对的（一个群的
 * 梗不该污染另一个群的语气）。但"完全不知道别的会话在聊什么"又太死：模型没法把 A 群刚
 * 发生的事、刚认识的梗，带到 B 群去联想。
 *
 * 这份模块就是这个夹层，只做两件轻量的事：
 *
 *   1. **观察（observations）**：每条入站消息落一条滚动记录（自动扫描，**不过模型**、
 *      不产生 token），带会话 key / 发言人 / 时间。默认只收群聊（`includePrivate: false`），
 *      避免私聊内容漏进群里。
 *   2. **事实（facts）**：模型主动记下的跨会话事实/印象（`qq_shared_remember`），
 *      比如"群里管 90 后叫牢登"、"Mr_ 有个双屏速通梗"。
 *
 * 注入时只取**别的会话**的最近观察 + 最近事实，压成一小段（默认 ≤ 800 字），
 * 放在唤醒提示词里。不是全量灌入 —— 共享层是"联想线索"，不是第二份聊天记录。
 *
 * 存储：`state/shared-memory.json`，原子写 + 去抖，读失败按空库启动（绝不因此阻断桥接）。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 一条观察最多存多少字（超出截断，避免长消息把库撑爆）。 */
const OBSERVATION_MAX_CHARS = 160;
/** 去抖写盘间隔（毫秒）。消息密集时合并成一次写。 */
const FLUSH_DEBOUNCE_MS = 1500;

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function createSharedMemory({ file, cfg, log = null }) {
  let data = { version: 1, observations: [], facts: [] };
  let loaded = false;
  let dirty = false;
  let timer = null;
  let lastLoadAt = 0;

  const settings = () => {
    const sm = cfg?.sharedMemory ?? {};
    return {
      enabled: sm.enabled !== false,
      includePrivate: sm.includePrivate === true,
      maxObservations: clampInt(sm.maxObservations, 800, 50, 5000),
      maxFacts: clampInt(sm.maxFacts, 200, 20, 2000),
      injectInPrompt: sm.injectInPrompt !== false,
      digestMaxChars: clampInt(sm.digestMaxChars, 800, 200, 4000),
      windowMs: clampInt(sm.digestWindowMinutes, 45, 5, 1440) * 60000,
      digestLines: clampInt(sm.digestLines, 6, 1, 20),
    };
  };

  const load = () => {
    if (loaded) return data;
    loaded = true;
    lastLoadAt = Date.now();
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = {
          version: 1,
          observations: Array.isArray(parsed.observations) ? parsed.observations.filter((o) => o && typeof o.text === 'string') : [],
          facts: Array.isArray(parsed.facts) ? parsed.facts.filter((f) => f && typeof f.text === 'string') : [],
        };
      }
    } catch (error) {
      if (error?.code !== 'ENOENT' && typeof log === 'function') log(`[shared-memory] 读取失败，按空库启动：${error?.message ?? error}`);
    }
    return data;
  };

  const flush = () => {
    if (!dirty) return;
    clearTimeout(timer);
    timer = null;
    const s = settings();
    data.observations = data.observations.slice(-s.maxObservations);
    data.facts = data.facts.slice(-s.maxFacts);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
      dirty = false;
    } catch (error) {
      if (typeof log === 'function') log(`[shared-memory] 写盘失败：${error?.message ?? error}`);
    }
  };

  const scheduleFlush = () => {
    dirty = true;
    if (timer) return;
    timer = setTimeout(flush, FLUSH_DEBOUNCE_MS);
    if (typeof timer.unref === 'function') timer.unref();
  };

  /** 记一条观察（自动扫描路径）。只收群聊除非显式允许私聊。 */
  const recordObservation = ({ key, sender = '', userId = null, text = '', at = Date.now() }) => {
    const s = settings();
    if (!s.enabled) return;
    if (!key || !String(key).startsWith('group:') && !s.includePrivate) return;
    const clean = normalizeText(text);
    if (!clean) return;
    if (/^\[(图片|语音|视频|文件[^\]]*|表情[^\]]*|卡片消息|转发消息)\]$/.test(clean)) return; // 无信息量的占位
    load();
    data.observations.push({
      key: String(key),
      sender: normalizeText(sender).slice(0, 32),
      userId: userId != null ? String(userId) : null,
      text: clean.slice(0, OBSERVATION_MAX_CHARS),
      at: Number(at) || Date.now(),
    });
    if (data.observations.length > s.maxObservations * 1.5) data.observations = data.observations.slice(-s.maxObservations);
    scheduleFlush();
  };

  /** 记一条跨会话事实（模型主动路径）。同文去重，只更新时间。 */
  const remember = ({ text, tags = [], source = null, at = Date.now() }) => {
    const s = settings();
    const clean = normalizeText(text).slice(0, 240);
    if (!s.enabled || !clean) return null;
    load();
    const existing = data.facts.find((f) => f.text === clean);
    if (existing) {
      existing.at = Number(at) || Date.now();
      if (source) existing.source = String(source);
      if (Array.isArray(tags) && tags.length) existing.tags = [...new Set([...(existing.tags ?? []), ...tags.map((t) => normalizeText(t)).filter(Boolean)])].slice(0, 8);
      scheduleFlush();
      return existing;
    }
    const entry = {
      text: clean,
      tags: Array.isArray(tags) ? tags.map((t) => normalizeText(t)).filter(Boolean).slice(0, 8) : [],
      source: source ? String(source) : null,
      at: Number(at) || Date.now(),
    };
    data.facts.push(entry);
    scheduleFlush();
    return entry;
  };

  /** 删除跨会话事实：按包含匹配（用于纠错）。返回删除条数。 */
  const forget = ({ text = '' } = {}) => {
    const q = normalizeText(text).slice(0, 240);
    if (!q) return 0;
    load();
    const before = data.facts.length;
    data.facts = data.facts.filter((f) => !String(f.text ?? '').includes(q));
    const removed = before - data.facts.length;
    if (removed > 0) scheduleFlush();
    return removed;
  };

  /** 轻量检索：事实 + 观察的包含匹配，按时间倒序。 */
  const recall = ({ query = '', limit = 8 } = {}) => {
    load();
    const q = normalizeText(query).toLowerCase();
    const max = clampInt(limit, 8, 1, 50);
    const hit = (text) => !q || text.toLowerCase().includes(q);
    const facts = data.facts.filter((f) => hit(f.text)).slice(-max).reverse();
    const observations = data.observations.filter((o) => hit(o.text)).slice(-max).reverse();
    return { facts, observations };
  };

  /** 压成一段给模型看的跨会话近况（只含**别的**会话）。 */
  const digest = ({ excludeKey = '', now = Date.now() } = {}) => {
    const s = settings();
    if (!s.enabled || !s.injectInPrompt) return '';
    load();
    const recent = data.observations.filter((o) => o.key !== excludeKey && now - Number(o.at) <= s.windowMs);
    // 每个会话最多取 2 条，避免一个刷屏群把整段占满
    const perKey = new Map();
    for (const o of [...recent].reverse()) {
      const n = perKey.get(o.key) ?? 0;
      if (n >= 2) continue;
      perKey.set(o.key, n + 1);
    }
    const picked = [];
    const seen = new Set();
    for (const o of [...recent].reverse()) {
      if (seen.has(o.key + '\u0000' + o.at)) continue;
      const used = picked.filter((p) => p.key === o.key).length;
      if (used >= 2) continue;
      if (picked.length >= s.digestLines) break;
      picked.push(o);
    }
    const facts = data.facts.slice(-6).reverse();
    if (picked.length === 0 && facts.length === 0) return '';

    const ago = (at) => {
      const min = Math.max(0, Math.round((now - Number(at)) / 60000));
      if (min < 1) return '刚刚';
      if (min < 60) return `${min} 分钟前`;
      return `${Math.round(min / 60)} 小时前`;
    };
    const keyLabel = (key) => (key.startsWith('group:') ? `群 ${key.slice(6)}` : `私聊 ${key.slice(8)}`);
    const lines = [];
    if (facts.length) {
      lines.push('跨会话事实：');
      for (const f of facts) lines.push(`- ${f.text}${f.source ? `（来自${keyLabel(String(f.source))}）` : ''}`);
    }
    if (picked.length) {
      lines.push('其它会话近况（只作联想线索，不要直接说"A 群刚才聊…"）：');
      for (const o of picked) {
        const who = o.sender ? `${o.sender}：` : '';
        lines.push(`- [${keyLabel(o.key)} · ${ago(o.at)}] ${who}${o.text}`);
      }
    }
    let block = `【跨会话共享记忆】\n${lines.join('\n')}`;
    if (block.length > s.digestMaxChars) block = `${block.slice(0, s.digestMaxChars - 1)}…`;
    return block;
  };

  const stats = () => {
    load();
    return { observations: data.observations.length, facts: data.facts.length, file, lastLoadAt };
  };

  return { recordObservation, remember, forget, recall, digest, stats, flush };
}
