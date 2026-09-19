'use strict';

/* ===========================================================================
 * 协作白板 - 录制回放 / 版本管理（纯逻辑模块，浏览器与 Node 共用）
 *
 * ReplayController：时间轴回放引擎
 *  - 在一个【独立】的 WB.Doc 上按服务端权威 seq 序重放物化信封，
 *    与实时协作文档完全隔离：回放不 apply 到 live doc、不发送任何信封，
 *    因此回放只读、绝不影响实时协作；退出回放即丢弃该 Doc，画面回到最新。
 *  - 支持：播放 / 暂停 / 倍速（0.5×…8×）/ 拖拽进度（时间或比例）/ 跳到指定 seq；
 *  - 重放用快照检查点加速：任意位置 seek 只从最近检查点重放一小段。
 *
 * buildRestoreOps：版本恢复操作生成器
 *  - 把“当前 live Doc”与“目标版本快照”做三方对比（字段 / 删除 / 像素擦单元 / 组），
 *    生成一批【普通新信封操作】（set/delete/restore-create/erase/unerase/group）。
 *  - 不回滚历史、不伪造他人操作：恢复是一次由本人时钟签发的新编辑，
 *    走正常因果广播，所有协作者最终一致（与选择性撤销同一套 CRDT 哲学）。
 *
 * UMD：Node(require) / 浏览器(<script>) 均可加载，仅依赖 kernel.js。
 * ========================================================================= */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./kernel.js'));
  } else root.WBReplay = factory(root.WB);
}(typeof self !== 'undefined' ? self : this, function (WB) {
  'use strict';

  /* ------------------------- 微型事件发射器 ------------------------- */
  class EE {
    constructor() { this._h = Object.create(null); }
    on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return this; }
    off(ev, fn) {
      const a = this._h[ev];
      if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
      return this;
    }
    emit(ev) {
      const a = this._h[ev];
      if (!a) return;
      const args = Array.prototype.slice.call(arguments, 1);
      for (const fn of a.slice()) fn.apply(null, args);
    }
  }

  const DEFAULT_GAP_MS = 16;        // serverTs 缺失时的合成时间步长
  const CHECKPOINT_MAX = 64;        // 检查点快照上限（seek 性能 / 内存折中）

  /* ============================ 时间轴回放引擎 ============================ */

  class ReplayController extends EE {
    /**
     * @param {object} opts
     *   events?: env[]                 初始时间轴信封（可稍后 load）
     *   timeOf?: (env, index)=>number  自定义事件时间（测试用）
     *   schedule?: (fn, delayMs)=>id    注入定时器（测试用，默认 setTimeout）
     *   cancel?:   (id)=>void
     *   now?:      ()=>number
     */
    constructor(opts) {
      super();
      opts = opts || {};
      this._timeOf = opts.timeOf || ((e, i) => (e && e.serverTs) || i * DEFAULT_GAP_MS);
      this._schedule = opts.schedule || ((fn, d) => setTimeout(fn, d));
      this._cancel = opts.cancel || ((id) => clearTimeout(id));
      this._now = opts.now || (() => Date.now());

      this.events = [];
      this.doc = new WB.Doc();       // ★ 回放专用 Doc，与实时 Doc 隔离
      this.checkpoints = new Map();  // index -> snapshot
      this.index = -1;               // 已应用到的事件下标（-1 = 空）
      this.playing = false;
      this.speed = 1;
      this._timer = null;
      this._playWallStart = 0;       // 播放起点墙钟
      this._playVirtStart = 0;       // 播放起点虚拟时间
      if (opts.events) this.load(opts.events);
    }

    /** 载入（或替换）时间轴：按 seq 升序，重建检查点并回到起点 */
    load(events) {
      this._stopTimer();
      this.playing = false;
      this.events = (events || []).slice().sort((a, b) =>
        (a.seq | 0) - (b.seq | 0) ||
        ((a.serverTs | 0) - (b.serverTs | 0)) ||
        (a.id < b.id ? -1 : 1));
      this.doc = new WB.Doc();
      this.checkpoints = new Map();
      this.checkpoints.set(-1, this.doc.snapshot());
      this.index = -1;
      this._buildCheckpoints();
      this.emit('change', this.state());
      return this;
    }

    _buildCheckpoints() {
      const n = this.events.length;
      if (!n) return;
      const stride = Math.max(1, Math.ceil(n / CHECKPOINT_MAX));
      const d = new WB.Doc();
      for (let i = 0; i < n; i++) {
        d.apply(this.events[i]);
        if ((i + 1) % stride === 0 && i < n - 1) {
          this.checkpoints.set(i, d.snapshot());
        }
      }
    }

    /** 从最近检查点物化到目标下标；target=-1 清空 */
    _materialize(target) {
      target = Math.max(-1, Math.min(this.events.length - 1, target | 0));
      if (target === this.index) return;
      // 找 <= target 的最近检查点（检查点只可能在当前位置之前可用；
      // 向后 seek 时不能复用当前 doc（LWW 无法回退），必须从检查点重建）
      let base = -1;
      for (const k of this.checkpoints.keys()) {
        if (k <= target && k > base) base = k;
      }
      const d = new WB.Doc();
      d.loadSnapshot(this.checkpoints.get(base));
      for (let i = base + 1; i <= target; i++) d.apply(this.events[i]);
      this.doc = d;
      this.index = target;
    }

    /* ------------------------------ 定位 ------------------------------ */

    /** 跳到时间轴事件下标（会保持/重排播放循环） */
    seekIndex(i) {
      this._materialize(i);
      this.emit('change', this.state());
      this._resyncPlayLoop();
      return this;
    }

    /** 跳到指定服务端 seq：呈现“所有 seq<=target 的信封都应用后”的状态 */
    seekSeq(seq) {
      seq = seq | 0;
      let lo = -1;
      for (let i = 0; i < this.events.length; i++) {
        if ((this.events[i].seq | 0) <= seq) lo = i; else break;
      }
      return this.seekIndex(lo);
    }

    /** 拖拽进度：fraction ∈ [0,1]，映射到事件下标 */
    seekFraction(f) {
      const n = this.events.length;
      if (!n) return this.seekIndex(-1);
      f = Math.max(0, Math.min(1, f));
      return this.seekIndex(Math.round(f * (n - 1)));
    }

    /** 拖到某个相对虚拟时间（毫秒，相对首个事件） */
    seekTime(t) {
      const t0 = this._t(0);
      const target = Math.max(0, t0 + t);
      let lo = -1;
      for (let i = 0; i < this.events.length; i++) {
        if (this._t(i) <= target) lo = i; else break;
      }
      return this.seekIndex(lo);
    }

    /** 单步前进/后退 n 个事件（暂停状态下逐帧查看；测试用） */
    frame(n) {
      n = n == null ? 1 : n | 0;
      this.seekIndex(this.index + n);
      return this;
    }

    /* ------------------------------ 播放 ------------------------------ */

    play() {
      if (!this.events.length || this.playing) return;
      if (this.index >= this.events.length - 1) {
        // 已到结尾再按播放：从头开始
        this._materialize(-1);
      }
      this.playing = true;
      this._playWallStart = this._now();
      this._playVirtStart = this._virtTime();
      this.emit('change', this.state());
      this._tick();   // 立即应用已到点的事件（含第一个事件），再排后续
    }

    pause() {
      if (!this.playing) return;
      this.playing = false;
      this._stopTimer();
      this.emit('change', this.state());
    }

    toggle() { this.playing ? this.pause() : this.play(); }

    setSpeed(s) {
      s = Number(s);
      if (!Number.isFinite(s) || s <= 0) return;
      this.speed = s;
      this.emit('change', this.state());
      this._resyncPlayLoop();
    }

    _resyncPlayLoop() {
      if (!this.playing) return;
      this._playWallStart = this._now();
      this._playVirtStart = this._virtTime();
      this._stopTimer();
      this._tick();
    }

    _stopTimer() {
      if (this._timer != null) { this._cancel(this._timer); this._timer = null; }
    }

    /** 播放循环一拍：应用所有“已到点”的事件，再排下一拍 */
    _tick() {
      this._timer = null;
      if (!this.playing) return;
      if (this.index >= this.events.length - 1) { this.pause(); return; }
      const elapsed = (this._now() - this._playWallStart) * this.speed;
      const dueVirt = this._playVirtStart + elapsed;
      let next = this.index;
      while (next + 1 < this.events.length && this._vt(next + 1) <= dueVirt) next += 1;
      if (next > this.index) {
        this._materialize(next);
        this.emit('change', this.state());
      }
      if (this.index >= this.events.length - 1) { this.pause(); return; }
      // 下一拍间隔 = 下一事件剩余虚拟时间 / 倍速；夹在 8ms…100ms 之间保证流畅不忙等
      const gapVirt = Math.max(0, this._vt(this.index + 1) - dueVirt);
      const delay = Math.max(8, Math.min(100, gapVirt / this.speed));
      this._timer = this._schedule(() => this._tick(), delay);
    }

    destroy() { this._stopTimer(); this.playing = false; this.removeAllListeners && this.removeAllListeners(); }

    /* ------------------------------ 读数 ------------------------------ */

    _t(i) { return i >= 0 && i < this.events.length ? this._timeOf(this.events[i], i) : 0; }
    /** 相对首个事件的虚拟时间（毫秒），时间轴播放/拖拽统一用它 */
    _vt(i) { return i >= 0 && i < this.events.length ? this._t(i) - this._t(0) : 0; }
    get totalEvents() { return this.events.length; }
    get currentSeq() { return this.index >= 0 ? (this.events[this.index].seq | 0) : 0; }
    get startSeq() { return this.events.length ? (this.events[0].seq | 0) : 0; }
    get endSeq() { return this.events.length ? (this.events[this.events.length - 1].seq | 0) : 0; }
    get duration() {
      return this.events.length > 1 ? Math.max(0, this._vt(this.events.length - 1)) : 0;
    }
    _virtTime() { return this._vt(this.index); }
    get currentTime() { return this._virtTime(); }
    get fraction() {
      const n = this.events.length;
      return n > 1 ? (this.index + 1) / n : (n === 1 ? 1 : 0);
    }

    state() {
      return {
        playing: this.playing,
        speed: this.speed,
        index: this.index,
        total: this.events.length,
        seq: this.currentSeq,
        startSeq: this.startSeq,
        endSeq: this.endSeq,
        time: this.currentTime,
        duration: this.duration,
        fraction: this.fraction
      };
    }
  }

  /* ========================== 版本恢复操作生成 ========================== */

  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a && b && typeof a === 'object') {
      const ka = Object.keys(a), kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      for (const k of ka) { if (!deepEqual(a[k], b[k])) return false; }
      return true;
    }
    return false;
  }

  /**
   * "tx:ty,cx:cy" -> 分块 chunks（erase/unerase 信封体格式，同块单元聚合）。
   * key 与 WB.Doc.erasedCells 返回格式一致（tile 用冒号、单元用逗号分隔）。
   */
  function cellsToChunks(keys) {
    const tiles = new Map();
    for (const key of keys) {
      const ci = key.indexOf(',');
      const [tx, ty] = key.slice(0, ci).split(':').map(Number);
      const [cx, cy] = key.slice(ci + 1).split(',').map(Number);
      const tk = tx + ',' + ty;
      if (!tiles.has(tk)) tiles.set(tk, { tx, ty, cells: [] });
      tiles.get(tk).cells.push([cx, cy]);
    }
    return [...tiles.values()];
  }

  /**
   * 比较 liveDoc（当前实时状态）与 targetSnapshot（目标版本）生成恢复操作体。
   * 调用方用自己的 Clock 把 op bodies 签成信封（多个时 WB.atomic 绑定事务）。
   *
   * @returns {{ops: object[], summary: object}}
   */
  function buildRestoreOps(liveDoc, targetSnapshot) {
    const tdoc = new WB.Doc();
    tdoc.loadSnapshot(targetSnapshot);
    const ops = [];
    const eraseOps = [];   // 像素擦/恢复：必须排在 create 之后（因果序）
    const uneraseOps = [];
    const summary = { sets: 0, deletes: 0, recreates: 0, eraseTiles: 0, uneraseTiles: 0, groups: 0, ungroups: 0 };

    const targetObjs = new Map();   // oid -> 物化对象（含 deleted 字段）
    for (const so of targetSnapshot.objects || []) targetObjs.set(so.oid, tdoc.get(so.oid));

    const deleteOids = [];
    const createMissing = [];  // 当前完全不存在的对象 → create
    const restoreOids = [];    // 当前已删除、目标活着的对象 → restore（清 deleted 寄存器）
    const reviveSets = [];     // 随 restore 一起回写的字段 {oid, fields}
    for (const [oid, tobj] of targetObjs) {
      const live = liveDoc.get(oid);
      const targetDeleted = tobj.deleted === true;

      // 像素擦单元（对目标存在的所有对象；recreate 后也要随带 erase）
      const targetErased = tdoc.erasedCells(oid);
      const liveErased = live ? liveDoc.erasedCells(oid) : new Set();
      const toErase = [], toUnerase = [];
      for (const k of targetErased) if (!liveErased.has(k)) toErase.push(k);
      for (const k of liveErased) if (!targetErased.has(k)) toUnerase.push(k);
      if (toErase.length) {
        eraseOps.push({ kind: 'erase', chunks: cellsToChunks(toErase).map((c) => Object.assign({ oid }, c)) });
        summary.eraseTiles += 1;
      }
      if (toUnerase.length) {
        uneraseOps.push({ kind: 'erase', unerase: true, chunks: cellsToChunks(toUnerase).map((c) => Object.assign({ oid }, c)) });
        summary.uneraseTiles += 1;
      }

      if (targetDeleted) {
        if (live && live.deleted !== true) deleteOids.push(oid);
        continue;
      }

      if (!live) {
        // 当前完全没有此对象（从未见过或已被压缩水位回收）→ 按目标 create
        const fields = {};
        for (const f of Object.keys(tobj)) {
          if (f === 'oid' || f === 'deleted') continue;
          fields[f] = tobj[f];
        }
        createMissing.push({ oid, type: tobj.type, fields });
        continue;
      }
      if (live.deleted === true) {
        // 当前已删、目标活着：restore 清删除标记，再 set 回目标字段
        const fields = {};
        for (const f of Object.keys(tobj)) {
          if (f === 'oid' || f === 'deleted') continue;
          fields[f] = tobj[f];
        }
        restoreOids.push(oid);
        reviveSets.push({ oid, fields });
        continue;
      }

      // 双方都活着：逐字段回写差异（恢复是更高 lamport 的新写入）
      const fields = {};
      for (const f of Object.keys(tobj)) {
        if (f === 'oid' || f === 'deleted') continue;
        if (!deepEqual(live[f], tobj[f])) fields[f] = tobj[f];
      }
      if (Object.keys(fields).length) {
        ops.push({ kind: 'set', oid, fields });
        summary.sets += 1;
      }
    }

    if (createMissing.length) {
      ops.push({ kind: 'create', objects: createMissing });
      summary.recreates += createMissing.length;
    }
    if (restoreOids.length) ops.push({ kind: 'restore', oids: restoreOids });
    for (const rs of reviveSets) {
      if (Object.keys(rs.fields).length) ops.push({ kind: 'set', oid: rs.oid, fields: rs.fields });
    }
    // create/restore 之后再擦除/恢复目标单元
    ops.push(...eraseOps);
    ops.push(...uneraseOps);
    if (deleteOids.length) {
      ops.push({ kind: 'delete', oids: deleteOids });
      summary.deletes = deleteOids.length;
    }

    // 当前活着、但目标版本里根本没有的对象 → 删除
    const extraOids = [];
    for (const o of liveDoc.liveObjects()) {
      if (!targetObjs.has(o.oid)) extraOids.push(o.oid);
    }
    if (extraOids.length) {
      ops.push({ kind: 'delete', oids: extraOids });
      summary.deletes += extraOids.length;
    }

    // 组：目标快照 groups（gid -> 成员）对齐到当前
    const targetGroups = new Map();
    for (const g of targetSnapshot.groups || []) targetGroups.set(g.gid, (g.members || []).slice());
    const liveGroups = new Map(); // gid -> 当前活着的成员
    for (const o of liveDoc.liveObjects()) {
      if (o.group) {
        if (!liveGroups.has(o.group)) liveGroups.set(o.group, []);
        liveGroups.get(o.group).push(o.oid);
      }
    }
    for (const [gid, members] of targetGroups) {
      const cur = liveGroups.get(gid) || [];
      const same = cur.length === members.length && members.every((m) => cur.includes(m));
      if (!same) { ops.push({ kind: 'group', gid, oids: members }); summary.groups += 1; }
    }
    for (const gid of liveGroups.keys()) {
      if (!targetGroups.has(gid)) {
        ops.push({ kind: 'ungroup', gid, oids: liveGroups.get(gid) });
        summary.ungroups += 1;
      }
    }

    return { ops, summary };
  }

  return { ReplayController, buildRestoreOps, cellsToChunks, deepEqual };
}));
