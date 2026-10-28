/**
 * 人格状态变量（persona state）：把「好感度」这类数值从模型脑子里挪到桥接里。
 *
 * 为什么不让模型自己记：提示词里的「请在对话过程中记录并维护一个变量」是社区常见写法，
 * 但模型在长上下文里必然漂移、多会话会串、进程重启就归零，而且人（操作者）既看不见也
 * 改不了。这里改成：
 *
 *   - 数值存在 `state/persona-state.json`，按「会话 key + 成员 QQ」分桶；
 *   - 每轮唤醒注入一行当前值（见 bridge 的 【人格状态】）；
 *   - 模型只能通过工具提交 **增量 + 理由**，范围夹取、变更留痕由桥接做；
 *   - 初始值/上下限/步进来自人格卡的 frontmatter（roles/<角色>.md 的 `state:` 段）。
 *
 * 存储结构：
 *   { entries: { "group:906731526|2608482101": { "affinity": { value, at, lastDelta, reason } } } }
 */

import fs from 'node:fs';
import path from 'node:path';

const FLUSH_DEBOUNCE_MS = 1200;

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 状态定义规范化：只接受有 id/label 的条目，数值字段做一次兜底。 */
export function normalizeStateDefs(defs) {
  if (!Array.isArray(defs)) return [];
  const out = [];
  for (const def of defs) {
    if (!def || typeof def !== 'object') continue;
    const id = String(def.id ?? '').trim();
    if (!/^[a-z][a-z0-9_-]{1,24}$/.test(id)) continue;
    const min = clampInt(def.min, 0, -100000, 100000);
    const max = clampInt(def.max, 100, -100000, 100000);
    if (max <= min) continue;
    out.push({
      id,
      label: String(def.label ?? id).trim().slice(0, 16),
      initial: clampInt(def.initial, Math.round((min + max) / 2), min, max),
      min,
      max,
      step: clampInt(def.step, 5, 1, 100),
      desc: def.desc ? String(def.desc).slice(0, 120) : '',
    });
  }
  return out;
}

export function createPersonaState({ file, cfg, log = null }) {
  let data = { entries: {} };
  let loaded = false;
  let dirty = false;
  let timer = null;

  const settings = () => {
    const ps = cfg?.personaState ?? {};
    return {
      enabled: ps.enabled !== false,
      maxEntries: clampInt(ps.maxEntries, 500, 20, 5000),
    };
  };

  const load = () => {
    if (loaded) return data;
    loaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
        data = { entries: parsed.entries };
      }
    } catch (error) {
      if (error?.code !== 'ENOENT' && typeof log === 'function') log(`[persona-state] 读取失败，按空库启动：${error?.message ?? error}`);
    }
    return data;
  };

  const flush = () => {
    if (!dirty) return;
    clearTimeout(timer);
    timer = null;
    const s = settings();
    const keys = Object.keys(data.entries);
    if (keys.length > s.maxEntries) {
      // 按最近更新时间裁掉最旧的，防止长期运行无限膨胀
      const sorted = keys.map((k) => ({ k, at: Math.max(...Object.values(data.entries[k] ?? {}).map((v) => Number(v?.at) || 0)) }))
        .sort((a, b) => b.at - a.at)
        .slice(0, s.maxEntries);
      const keep = new Set(sorted.map((x) => x.k));
      data.entries = Object.fromEntries(Object.entries(data.entries).filter(([k]) => keep.has(k)));
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(data, null, 1)}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
      dirty = false;
    } catch (error) {
      if (typeof log === 'function') log(`[persona-state] 写盘失败：${error?.message ?? error}`);
    }
  };

  const scheduleFlush = () => {
    dirty = true;
    if (timer) return;
    timer = setTimeout(flush, FLUSH_DEBOUNCE_MS);
    if (typeof timer.unref === 'function') timer.unref();
  };

  const bucketKey = (key, userId) => `${String(key ?? '')}|${String(userId ?? '')}`;

  /** 读某个（会话, 成员）的全部状态值；没有就按人格卡定义返回初始值（不落盘）。 */
  const read = (key, userId, defs = []) => {
    load();
    const bucket = data.entries[bucketKey(key, userId)] ?? {};
    const values = {};
    for (const def of defs) {
      const stored = bucket[def.id];
      values[def.id] = stored && Number.isFinite(Number(stored.value))
        ? { value: Number(stored.value), at: Number(stored.at) || 0, lastDelta: Number(stored.lastDelta) || 0, reason: String(stored.reason ?? '') }
        : { value: def.initial, at: 0, lastDelta: 0, reason: '' };
    }
    return values;
  };

  /** 提交一个增量：夹到 [min,max]，留痕（lastDelta/reason/at），返回新值。 */
  const adjust = ({ key, userId, def, delta, reason = '', at = Date.now() }) => {
    const s = settings();
    if (!s.enabled || !def) return null;
    const rawDelta = Number(delta);
    if (!Number.isFinite(rawDelta) || rawDelta === 0) return null;
    const step = Math.max(1, Number(def.step) || 5);
    const bounded = Math.max(-step * 5, Math.min(step * 5, Math.round(rawDelta)));
    load();
    const bk = bucketKey(key, userId);
    const bucket = data.entries[bk] ?? (data.entries[bk] = {});
    const prev = bucket[def.id] && Number.isFinite(Number(bucket[def.id].value)) ? Number(bucket[def.id].value) : def.initial;
    const next = Math.max(def.min, Math.min(def.max, prev + bounded));
    bucket[def.id] = {
      value: next,
      at: Number(at) || Date.now(),
      lastDelta: next - prev,
      reason: String(reason ?? '').slice(0, 60),
    };
    scheduleFlush();
    return { value: next, prev, delta: next - prev };
  };

  /** 直接把某个值设到范围内（操作者/管理端用）。 */
  const set = ({ key, userId, def, value, reason = 'operator', at = Date.now() }) => {
    const s = settings();
    if (!s.enabled || !def) return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    load();
    const bk = bucketKey(key, userId);
    const bucket = data.entries[bk] ?? (data.entries[bk] = {});
    const prev = bucket[def.id] && Number.isFinite(Number(bucket[def.id].value)) ? Number(bucket[def.id].value) : def.initial;
    const next = Math.max(def.min, Math.min(def.max, Math.round(n)));
    bucket[def.id] = { value: next, at: Number(at) || Date.now(), lastDelta: next - prev, reason: String(reason ?? '').slice(0, 60) };
    scheduleFlush();
    return { value: next, prev, delta: next - prev };
  };

  /** 压成提示词里的一行（只给当前对话对象）。 */
  const describe = (key, userId, defs = []) => {
    if (!defs.length) return '';
    const values = read(key, userId, defs);
    const parts = [];
    for (const def of defs) {
      const v = values[def.id];
      const deltaText = v.lastDelta ? `（上次 ${v.lastDelta > 0 ? '+' : ''}${v.lastDelta}${v.reason ? `：${v.reason}` : ''}）` : '';
      parts.push(`${def.label} ${v.value}/${def.max}${deltaText}`);
    }
    return parts.join('；');
  };

  const stats = () => {
    load();
    return { entries: Object.keys(data.entries).length, file };
  };

  return { read, adjust, set, describe, stats, flush };
}
