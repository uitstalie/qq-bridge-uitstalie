/**
 * 入站语音转写（wave 7）：把 QQ 语音条变成文本，喂给模型。
 *
 * 为什么不是直接调 `fetch_ptt_text`：那个动作依赖 **QQ 侧**的转写结果，实测同一条消息
 * 返回 `retcode=100 / ptt translate failed: error=9`——能不能拿到字取决于对方客户端和
 * 账号状态，不可依赖。这里改走「自己转」：
 *
 *   1. `get_msg(message_id)` → 找到 record 段拿到 `file`（`.amr`，实际是 SILK 封装）；
 *   2. `get_record({file, out_format:'wav'})` → **服务端**转码成 wav 并回 base64
 *      （本地不必装 silk 解码器，`ffmpeg` 也解不了 `#!SILK_V3`）；
 *   3. 落临时文件 → spawn `scripts/asr-transcribe.py`（faster-whisper，CPU int8）→ 文本。
 *
 * 三条不变量：
 *   - **失败一律降级**：任何一步出错都返回 null，调用方继续用 `[语音]`，绝不阻塞消息处理；
 *   - **串行队列**：转写是 CPU 密集的，同一时刻只跑一条，其余排队（并带 in-flight 去重）；
 *   - **不落盘任何音频残留**：临时文件在 finally 里删掉，且只写系统 tmp 目录。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** 同一进程内的转写缓存：message_id → 文本。QQ 的 message_id 在会话内唯一。 */
const cache = new Map();
const CACHE_MAX = 200;
/** 正在转写的 key → Promise，避免同一条消息（textContent + plainContent 两次调用）转两遍。 */
const inflight = new Map();
/** 串行队列：CPU 转写不要并发，否则桌面会被拖着卡。 */
let queue = Promise.resolve();

/** 转写开关：`socialV2.voice.transcribe.enabled`，默认关闭（这是重依赖，不该悄悄开）。 */
export function transcribeEnabled(cfg) {
  return cfg?.socialV2?.voice?.transcribe?.enabled === true;
}

function remember(key, text) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, text);
}

function tmpWavPath() {
  return path.join(os.tmpdir(), `qq-voice-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
}

async function oneBotPost(cfg, endpoint, body, timeoutMs) {
  const base = String(cfg?.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = String(cfg?.snowluma?.accessToken || '');
  const response = await fetch(`${base}${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.status !== 'ok' || payload?.retcode !== 0) {
    const reason = payload?.wording || payload?.message || `HTTP ${response.status}`;
    throw new Error(`${endpoint} 失败：${reason}`);
  }
  return payload.data;
}

/** 从一条消息里找出语音段的 `file` 字段（get_record 用它取音频）。 */
function recordFileOf(messageSegments) {
  for (const seg of messageSegments ?? []) {
    if (seg?.type === 'record' && seg?.data?.file) return String(seg.data.file);
  }
  return null;
}

/** 跑 python 转写；超时/异常都返回 null。 */
function runTranscriber(wavPath, cfg) {
  const voice = cfg?.socialV2?.voice ?? {};
  const transcribe = voice.transcribe ?? {};
  const python = String(transcribe.python || '');
  const modelDir = String(transcribe.modelDir || '');
  const model = String(transcribe.model || 'small');
  const script = path.resolve(ROOT, String(transcribe.script || 'scripts/asr-transcribe.py'));
  const timeoutMs = Number(transcribe.timeoutMs) > 0 ? Number(transcribe.timeoutMs) : 60000;

  if (!python || !fs.existsSync(python)) return Promise.resolve(null);
  if (!fs.existsSync(script)) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const child = spawn(python, [script, wavPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ASR_MODEL: model,
        ...(modelDir ? { ASR_MODEL_DIR: modelDir } : {}),
        ASR_COMPUTE: String(transcribe.computeType || 'int8'),
        ASR_LANGUAGE: String(transcribe.language || 'zh'),
      },
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(null);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { if (out.length < 8192) out += chunk.toString(); });
    child.stderr.on('data', (chunk) => { if (err.length < 8192) err += chunk.toString(); });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        if (err.trim()) console.error(`[voice-asr] ${err.trim().split('\n').slice(-1)[0]}`);
        finish(null);
        return;
      }
      finish(out.trim().replace(/\s+/g, ' ').slice(0, 500) || null);
    });
  });
}

/** 真正干活：拿 file → 服务端转 wav → 本地 ASR。任何一步失败返回 null。 */
async function doTranscribe({ messageId, file, cfg }) {
  const recordFile = file || await (async () => {
    const message = await oneBotPost(cfg, '/get_msg', { message_id: Number(messageId) }, 15000);
    return recordFileOf(message?.message);
  })();
  if (!recordFile) return null;

  const record = await oneBotPost(cfg, '/get_record', { file: recordFile, out_format: 'wav' }, 30000);
  const base64 = String(record?.base64 || '');
  if (!base64) return null;

  const wavPath = tmpWavPath();
  try {
    fs.writeFileSync(wavPath, Buffer.from(base64, 'base64'), { mode: 0o600 });
    return await runTranscriber(wavPath, cfg);
  } finally {
    try { fs.unlinkSync(wavPath); } catch {}
  }
}

/**
 * 对外入口：转写一条入站语音。
 *
 * @returns 文本或 null（null = 关闭/失败/无内容，调用方应当回退成 `[语音]`）
 */
export async function transcribeInboundVoice({ cfg, messageId, file = null, log = null }) {
  if (!transcribeEnabled(cfg)) return null;
  const key = String(messageId ?? file ?? '').trim();
  if (!key) return null;
  if (cache.has(key)) return cache.get(key);
  if (inflight.has(key)) return inflight.get(key);

  const task = queue.then(async () => {
    try {
      const text = await doTranscribe({ messageId, file, cfg });
      if (text) {
        remember(key, text);
        if (typeof log === 'function') log(`[voice-asr] ${key} → ${text.slice(0, 60)}`);
      }
      return text;
    } catch (error) {
      if (typeof log === 'function') log(`[voice-asr] ${key} 转写失败（降级为 [语音]）：${error?.message ?? error}`);
      return null;
    } finally {
      queue = Promise.resolve();
      inflight.delete(key);
    }
  });
  queue = task.catch(() => null);
  inflight.set(key, task);
  return task;
}

/** 便于测试/运维：清空缓存（不导出内部状态）。 */
export function clearVoiceAsrCache() {
  cache.clear();
}
