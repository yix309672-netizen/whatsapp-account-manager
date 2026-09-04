/**
 * Leaf 分布式发号移植（TypeScript 版）
 * 来源：https://github.com/Meituan-Dianping/Leaf.git（leaf-core）
 * - 号段模式：对标 SegmentIDGenImpl —— DB(leaf_alloc) 原子取段 + 内存双缓冲预取 + 动态步长
 * - 雪花模式：对标 SnowflakeIDGenImpl —— twepoch + 10bit workerId + 12bit sequence（BigInt 输出字符串）
 * 单进程 Electron 下无需读写锁；workerId 持久化于 app_settings（替代 ZK）。
 */
import { randomInt } from 'crypto';
import { getDb } from '../utils/db';
import { logger } from '../utils/logger';

// ---------- 号段模式（Segment） ----------

const MAX_STEP = 1000000;
const SEGMENT_DURATION_MS = 15 * 60 * 1000;

interface SegmentBuf {
  value: number;
  max: number;
  step: number;
  minStep: number;
  updateTs: number;
  next: { value: number; max: number; step: number } | null;
  prefetching: boolean;
}

const buffers = new Map<string, SegmentBuf>();

function allocSegmentFromDb(tag: string, customStep?: number): { maxId: number; step: number } {
  const db = getDb();
  const txn = db.transaction(() => {
    const row = db.prepare('SELECT max_id AS maxId, step FROM leaf_alloc WHERE biz_tag = ?').get(tag) as
      | { maxId: number; step: number }
      | undefined;
    if (!row) throw new Error(`号段不存在：${tag}（请先添加业务标签）`);
    const step = customStep && customStep > 0 ? Math.min(customStep, MAX_STEP) : row.step;
    const maxId = row.maxId + step;
    db.prepare('UPDATE leaf_alloc SET max_id = ?, step = ?, updated_at = strftime(\'%s\',\'now\') WHERE biz_tag = ?')
      .run(maxId, step, tag);
    return { maxId, step };
  });
  return txn();
}

// Leaf 动态步长：15分钟内用完 → 翻倍；30分钟没用完 → 减半；上限 1000000
function nextStep(buf: SegmentBuf, dbStep: number): number {
  const duration = Date.now() - buf.updateTs;
  let s = buf.step;
  if (duration < SEGMENT_DURATION_MS) {
    if (s * 2 <= MAX_STEP) s = s * 2;
  } else if (duration >= SEGMENT_DURATION_MS * 2) {
    s = Math.max(Math.floor(s / 2), buf.minStep);
  }
  return Math.min(s, MAX_STEP) || dbStep;
}

function fillSegment(tag: string, buf: SegmentBuf, first: boolean): void {
  const { maxId, step } = allocSegmentFromDb(tag, first ? undefined : nextStep(buf, buf.step));
  if (first) buf.minStep = step;
  buf.step = step;
  buf.updateTs = Date.now();
  buf.value = maxId - step;
  buf.max = maxId;
}

function ensureBuffer(tag: string): SegmentBuf {
  let buf = buffers.get(tag);
  if (!buf) {
    buf = { value: 0, max: 0, step: 0, minStep: 0, updateTs: 0, next: null, prefetching: false };
    // 首段同步加载（对标 Leaf init buffer）
    const { maxId, step } = allocSegmentFromDb(tag);
    buf.minStep = step;
    buf.step = step;
    buf.updateTs = Date.now();
    buf.value = maxId - step;
    buf.max = maxId;
    buffers.set(tag, buf);
    logger.info(`[Leaf] segment buffer init tag=${tag} step=${step} max=${maxId}`);
  }
  return buf;
}

function prefetchNext(tag: string, buf: SegmentBuf): void {
  if (buf.prefetching || buf.next) return;
  buf.prefetching = true;
  // 后台预取下一段（对标 Leaf 双 buffer 异步线程）
  setImmediate(() => {
    try {
      const { maxId, step } = allocSegmentFromDb(tag, nextStep(buf, buf.step));
      buf.step = step;
      buf.updateTs = Date.now();
      buf.next = { value: maxId - step, max: maxId, step };
      logger.info(`[Leaf] segment prefetched tag=${tag} step=${step} max=${maxId}`);
    } catch (e) {
      logger.warn(`[Leaf] segment prefetch failed tag=${tag}:`, e);
    } finally {
      buf.prefetching = false;
    }
  });
}

export function segmentNextIds(tag: string, count: number): number[] {
  const n = Math.floor(Number(count) || 0);
  if (!tag || !tag.trim()) throw new Error('请提供业务标签 biz_tag');
  if (n < 1 || n > 100000) throw new Error('单次取号 1-100000 个');
  const buf = ensureBuffer(tag.trim());
  const out: number[] = [];
  while (out.length < n) {
    const idle = buf.max - buf.value;
    // 剩余不足 10% 时触发后台预取（对标 Leaf 0.9*step 阈值）
    if (!buf.next && idle < 0.1 * buf.step) prefetchNext(tag, buf);
    if (buf.value < buf.max) {
      out.push(++buf.value);
      continue;
    }
    // 当前段用完，切到预取好的下一段；没 ready 则同步取一段
    if (buf.next) {
      buf.value = buf.next.value;
      buf.max = buf.next.max;
      buf.next = null;
      continue;
    }
    fillSegment(tag, buf, false);
  }
  return out;
}

export function addTag(tag: string, step = 1000, description = ''): void {
  const t = String(tag || '').trim();
  if (!t || t.length > 64) throw new Error('业务标签 1-64 字符');
  const s = Math.min(Math.max(Math.floor(Number(step) || 1000), 1), MAX_STEP);
  getDb().prepare(
    'INSERT INTO leaf_alloc (biz_tag, max_id, step, description) VALUES (?, 0, ?, ?) ON CONFLICT(biz_tag) DO UPDATE SET step = ?, description = ?'
  ).run(t, s, String(description || ''), s, String(description || ''));
  buffers.delete(t);
  logger.info(`[Leaf] tag upsert ${t} step=${s}`);
}

export function listTags(): Array<{ biz_tag: string; max_id: number; step: number; description: string | null }> {
  return getDb().prepare('SELECT biz_tag, max_id, step, description FROM leaf_alloc ORDER BY biz_tag').all() as Array<{
    biz_tag: string; max_id: number; step: number; description: string | null;
  }>;
}

// ---------- 雪花模式（Snowflake，对标 SnowflakeIDGenImpl） ----------

const TWEPOCH = 1288834974657; // Leaf 默认起始时间戳
const WORKER_ID_BITS = 10n;
const MAX_WORKER_ID = Number(~(-1n << WORKER_ID_BITS)); // 1023
const SEQUENCE_BITS = 12n;
const WORKER_ID_SHIFT = SEQUENCE_BITS;
const TIMESTAMP_SHIFT = SEQUENCE_BITS + WORKER_ID_BITS;
const SEQUENCE_MASK = Number(~(-1n << SEQUENCE_BITS)); // 4095
const WORKER_KEY = 'leaf_worker_id';

let snowSeq = 0;
let snowLastTs = -1;

function getWorkerId(): number {
  const db = getDb();
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(WORKER_KEY) as { value: string } | undefined;
  let wid = row ? Number(row.value) : NaN;
  if (!Number.isInteger(wid) || wid < 0 || wid > MAX_WORKER_ID) {
    wid = randomInt(0, MAX_WORKER_ID + 1);
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
      .run(WORKER_KEY, String(wid), String(wid));
    logger.info(`[Leaf] snowflake workerId init: ${wid}`);
  }
  return wid;
}

function tilNextMillis(lastTs: number): number {
  let ts = Date.now();
  while (ts <= lastTs) ts = Date.now();
  return ts;
}

export function snowflakeNextIds(count: number): string[] {
  const n = Math.floor(Number(count) || 0);
  if (n < 1 || n > 100000) throw new Error('单次取号 1-100000 个');
  const workerId = BigInt(getWorkerId());
  const out: string[] = [];
  for (let k = 0; k < n; k++) {
    let ts = Date.now();
    if (ts < snowLastTs) {
      const offset = snowLastTs - ts;
      if (offset > 5) throw new Error(`时钟回拨 ${offset}ms 过大，暂停发号（Leaf 同款保护）`);
      ts = tilNextMillis(snowLastTs);
    }
    if (ts === snowLastTs) {
      snowSeq = (snowSeq + 1) & SEQUENCE_MASK;
      if (snowSeq === 0) {
        snowSeq = randomInt(0, 100);
        ts = tilNextMillis(snowLastTs);
      }
    } else {
      snowSeq = randomInt(0, 100);
    }
    snowLastTs = ts;
    const id = ((BigInt(ts - TWEPOCH)) << TIMESTAMP_SHIFT) | (workerId << WORKER_ID_SHIFT) | BigInt(snowSeq);
    out.push(id.toString());
  }
  return out;
}

export function leafStatus(): { workerId: number; tags: Array<{ biz_tag: string; max_id: number; step: number; description: string | null }>; twepoch: number } {
  return { workerId: getWorkerId(), tags: listTags(), twepoch: TWEPOCH };
}

// ---------- 号段 → 待筛号码（供筛号任务） ----------

export function genPhones(prefix: string, start: number, count: number): string[] {
  const pre = String(prefix || '').replace(/[^0-9]/g, '');
  const st = Math.floor(Number(start));
  const n = Math.floor(Number(count));
  if (!pre || pre.length < 1 || pre.length > 6) throw new Error('前缀需 1-6 位数字（国家区号，如 86/886/1）');
  if (!Number.isInteger(st) || st < 0) throw new Error('起始号需 ≥0 的整数');
  if (!Number.isInteger(n) || n < 1 || n > 5000) throw new Error('单次生成 1-5000 个（与筛号上限对齐）');
  const width = String(st + n - 1).length;
  if (pre.length + width > 15) throw new Error('生成号码超 15 位（E.164 上限），请减小起始号或数量');
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(pre + String(st + i).padStart(width, '0'));
  }
  return out;
}
