'use strict';

/* ===========================================================================
 * 白板操作录制 / 时间轴回放 / 版本管理（v4 新增，客户端 / 测试共享，零依赖）
 *
 * 设计要点：
 *  - Recorder：在“信封因果就绪、即将物化”这一点旁路记录（recordLocal /
 *    recordRemote），只观察、不参与协作管线，因此录制对实时协作零影响。
 *    每条记录带相对录制起点的 t（毫秒）与服务端权威 seq（本地操作在 ACK
 *    带 seqs 回填后补齐），生成可回放的时间轴 Timeline。
 *  - Player：在一份【隔离的 WB.Doc】视图上按时间轴重放信封（信封本身就是
 *    因果有序流，直接 apply 即可），支持 play / pause / 倍速 / 拖拽进度 /
 *    跳到指定 seq。回放期间不发送任何信封、不写实时 doc，退出即丢弃视图，
 *    实时 doc 始终保持最新。
 *  - VersionStore：命名版本快照（WB.Doc.snapshot()），可持久化到浏览器
 *    localStorage / IndexedDB 适配器；恢复版本（restoreEnvelopes）不做
 *    “时光倒流”（那会改写协作历史），而是以普通新信封把当前状态补偿为
 *    目标快照内容 —— 删除新增对象、恢复被删对象、set 偏差字段、补齐擦除
 *    单元，这些操作走正常因果广播，所有协作者最终一致地到达版本内容。
 *
 * UMD：Node(require) / 浏览器(<script>) 均可加载。
 * =========================================================================== */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./kernel.js'));
  } else root.WBReplay = factory(root.WB);
}(typeof self !== 'undefined' ? self : this, function (WB) {
  'use strict';

  const TIMELINE_VERSION = 1;
  const DEFAULT_NAME = (n) => `版本 v${n}`;
  const PLAYBACK_RATES = [0.5, 1, 2, 4, 8];

  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a && b && typeof a === 'object') {
      const ka = Object.keys(a), kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      for (const k of ka) {
        if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
        if (!deepEqual(a[k], b[k])) return false;
      }
      return true;
    }
    return false;
  }
  const clone = (v) => JSON.parse(JSON.stringify(v));

  /** 极简事件基类（与 net.js 风格一致，不引依赖） */
  class EE {
    constructor() { this._h = Object.create(null); }
    on(ev, fn) {
      (this._h[ev] = this._h[ev] || []).push(fn);
      return this;
    }
    off(ev, fn) {
      if (!this._h[ev]) return this;
      if (!fn) { this._h[ev] = []; return this; }
      this._h[ev] = this._h[ev].filter((f) => f !== fn);
      return this;
    }
    emit(ev) {
      const args = Array.prototype.slice.call(arguments, 1);
      for (const fn of (this._h[ev] || []).slice()) {
        try { fn.apply(null, args); } catch (err) { console.error('[WBReplay event]', ev, err); }
      }
      return this;
    }
  }

  /* ============================== 录制器 ============================== */

  /**
   * 操作录制器：旁路记录已因果就绪的信封，生成可回放时间轴。
   * @param {object} cfg { clockNow?: () => number }
   *   记录内容：{ idx, seq, t, origin:'local'|'remote', clientId, kind, env }
   *   - idx：本录制期内严格递增的物化次序（时间轴拖拽的稳定定位键）；
   *   - seq：服务端权威序号；本地操作 ACK 前为 null，resolveAck 回填；
   *   - t：相对录制起点的毫秒时间（回放节奏用）。
   */
  class Recorder extends EE {
    constructor(cfg) {
      super();
      cfg = cfg || {};
      this._now = cfg.clockNow || (() => Date.now());
      this.entries = [];
      this._ids = new Set();         // 已记录信封 id（重连/快照重放幂等，不重复录制）
      this.recording = true;
      this._t0 = this._now();
      this._counter = 0;
      // 基线快照：加入房间 / 全量快照同步时建立（房间在录制开始前已有内容）
      this.baseline = null;          // { snapshot, lastSeq, at: t }
    }

    start() {
      if (this.recording) return;
      this.recording = true;
      this._t0 = this._now();
      this.emit('record', true);
    }

    pause() {
      if (!this.recording) return;
      this.recording = false;
      this.emit('record', false);
    }

    toggle() { this.recording ? this.pause() : this.start(); return this.recording; }

    _elapsed() { return this._now() - this._t0; }

    /**
     * 记录一个已因果就绪、即将（或已经）物化的信封。
     * @param {object} env  信封
     * @param {object} meta { origin:'local'|'remote', seq?:number }
     */
    record(env, meta) {
      if (!this.recording || !env || !env.id) return null;
      if (this._ids.has(env.id)) return null;   // 重连/快照重放同一信封不重复录制
      this._ids.add(env.id);
      meta = meta || {};
      const entry = {
        idx: this._counter++,
        seq: Number.isInteger(meta.seq) ? meta.seq : (Number.isInteger(env.seq) ? env.seq : null),
        t: this._elapsed(),
        origin: meta.origin === 'local' ? 'local' : 'remote',
        clientId: env.clientId || '',
        kind: (env.op && env.op.kind) || '',
        env
      };
      this.entries.push(entry);
      this.emit('entry', entry);
      return entry;
    }

    recordLocal(env) { return this.record(env, { origin: 'local' }); }
    recordRemote(env) { return this.record(env, { origin: 'remote' }); }

    /**
     * 服务端 ACK 回填本地信封的权威 seq。
     * @param {string[]} ids   本次确认的信封 id（顺序即提交顺序）
     * @param {number} lastSeq 确认后的服务端 seq 水位
     * @param {number[]} [seqs] 可选，与 ids 对齐的逐条 seq（v3 二进制 ACK 支持）
     * 无 seqs 时按“新确认窗口连续定序”推导：本批新确认的本地信封必为窗口内
     * 连续的物化操作，按提交顺序领取 (lastSeq-n+1..lastSeq) 中未被占用的 seq。
     */
    resolveAck(ids, lastSeq, seqs) {
      if (!Array.isArray(ids) || !ids.length) return;
      if (Array.isArray(seqs) && seqs.length === ids.length) {
        for (let i = 0; i < ids.length; i++) this._assignSeq(ids[i], seqs[i] | 0);
        return;
      }
      const n = ids.length;
      const claimed = new Set(this.entries.filter((e) => e.seq != null).map((e) => e.seq));
      let seq = lastSeq | 0;
      // 从后往前为每个 id 领取窗口内第一个未被占用的 seq
      for (let i = n - 1; i >= 0; i--) {
        while (seq > 0 && claimed.has(seq)) seq -= 1;
        if (seq > 0) { this._assignSeq(ids[i], seq); claimed.add(seq); seq -= 1; }
      }
    }

    _assignSeq(id, seq) {
      for (const e of this.entries) {
        if (e.seq == null && e.env && e.env.id === id) {
          e.seq = seq;
          this.emit('seq', e);
          return true;
        }
      }
      return false;
    }

    /**
     * 建立/更换基线快照（加入房间、全量同步）。
     * @param {object} snapshot WB.Doc.snapshot() 产物
     * @param {number} lastSeq 快照对应的服务端水位
     * @param {object} [opts] { prune:true }
     *   prune=true（全量快照/重连换基线）：折叠并丢弃已包含在快照水位内的记录；
     *   未回填 seq 的本地信封不丢弃（它们尚不在服务端日志，重连会幂等重放）。
     */
    setBaseline(snapshot, lastSeq, opts) {
      const wm = lastSeq | 0;
      this.baseline = { snapshot: clone(snapshot), lastSeq: wm, at: this._elapsed() };
      if (opts && opts.prune) {
        this.entries = this.entries.filter((e) => e.seq == null || e.seq > wm);
        // 折叠后重排 idx，时间轴定位保持连续
        this.entries.forEach((e, i) => { e.idx = i; });
        this._counter = this.entries.length;
      }
      this.emit('baseline', this.baseline);
    }

    /** 换房间：清空全部记录与基线 */
    reset() {
      this.entries = [];
      this._ids.clear();
      this._counter = 0;
      this.baseline = null;
      this._t0 = this._now();
      this.emit('reset');
    }

    get duration() {
      return this.entries.reduce((m, e) => Math.max(m, e.t), 0);
    }
    get maxSeq() {
      return this.entries.reduce((m, e) => (e.seq != null ? Math.max(m, e.seq) : m),
        this.baseline ? this.baseline.lastSeq : 0);
    }

    timeline() {
      return {
        version: TIMELINE_VERSION,
        baseline: this.baseline ? clone(this.baseline) : null,
        startSeq: this.baseline ? this.baseline.lastSeq : 0,
        endSeq: this.maxSeq,
        duration: this.duration,
        count: this.entries.length,
        entries: this.entries.map((e) => ({
          idx: e.idx, seq: e.seq, t: e.t, origin: e.origin,
          clientId: e.clientId, kind: e.kind, env: clone(e.env)
        }))
      };
    }

    static validateTimeline(tl) {
      if (!tl || typeof tl !== 'object') return 'bad timeline';
      if (!Array.isArray(tl.entries)) return 'bad entries';
      return null;
    }
  }

  /* ============================== 播放器 ============================== */

  /**
   * 时间轴播放器：在隔离 Doc 视图上重放，支持 play/pause/倍速/拖拽/跳 seq。
   *
   * 时钟注入便于无头测试：cfg.scheduleFrame(fn) / cancelFrame(handle)，
   * cfg.now() 默认 performance.now/DT 不存在时用 Date.now。
   *
   * 事件：state(playing,paused,ended) / tick({time,index,seq}) / seek / end
   */
  class Player extends EE {
    /**
     * @param {object} timeline Recorder.timeline() 产物（或等价结构）
     * @param {object} cfg { clock, scheduleFrame, cancelFrame, now, autoLoop }
     *   clock 仅用于在视图 Doc 上继续 apply（信封自带时钟，实际不依赖它）
     */
    constructor(timeline, cfg) {
      super();
      const err = Recorder.validateTimeline(timeline);
      if (err) throw new Error(err);
      cfg = cfg || {};
      this.timeline = timeline;
      this.entries = timeline.entries.slice().sort((a, b) => a.idx - b.idx);

      // 录制时间 t 以“加入房间开始录制”为零点，回放前归一化到“首个可见事件 t=0”：
      // 有基线时以基线建立时刻为零点，否则以第一条记录为零点。
      const baseT = timeline.baseline && Number.isFinite(timeline.baseline.at)
        ? timeline.baseline.at
        : (this.entries.length ? this.entries[0].t : 0);
      this._tOffset = Math.max(0, baseT);
      for (const e of this.entries) e.t = Math.max(0, e.t - this._tOffset);

      this.view = new WB.Doc();
      this._appliedCount = 0;            // 已物化到 view 的条目数
      this._appliedIds = new Set();

      this.playing = false;
      this.rate = 1;
      this.rates = PLAYBACK_RATES.slice();
      this.time = 0;                    // 虚拟播放时间 ms
      this._clockLast = 0;
      this._frame = null;
      this._ended = false;
      this._rangeStart = 0;          // 版本回放范围（0 = 整条时间轴）
      this._rangeEnd = 0;

      this._now = cfg.now || (typeof performance !== 'undefined' && performance.now
        ? () => performance.now() : () => Date.now());
      this._schedule = cfg.scheduleFrame ||
        (typeof requestAnimationFrame !== 'undefined'
          ? (fn) => requestAnimationFrame(fn) : (fn) => setTimeout(() => fn(this._now()), 16));
      this._cancel = cfg.cancelFrame ||
        (typeof cancelAnimationFrame !== 'undefined'
          ? (h) => cancelAnimationFrame(h) : (h) => clearTimeout(h));

      // 起始位置：基线快照（若有）
      if (timeline.baseline && timeline.baseline.snapshot) {
        this.view.loadSnapshot(timeline.baseline.snapshot);
      }
    }

    get duration() {
      // 归一化后的最后一条事件时间（条目时间已在构造时减去录制起点偏移）
      return this.entries.reduce((m, e) => Math.max(m, e.t || 0), 0);
    }
    get startSeq() { return this.timeline.startSeq || 0; }
    get endSeq() { return this.timeline.endSeq || 0; }
    get state() { return this._ended ? 'ended' : (this.playing ? 'playing' : 'paused'); }
    /** 当前视图已物化到的服务端 seq（含基线） */
    get currentSeq() {
      const applied = this.entries.slice(0, this._appliedCount);
      return applied.reduce((m, e) => (e.seq != null ? Math.max(m, e.seq) : m), this.startSeq);
    }
    get currentIndex() { return this._appliedCount - 1; }
    get count() { return this.entries.length; }

    /* ------------------------------ 播放控制 ------------------------------ */

    play() {
      if (this.playing) return;
      // 已播到结尾再按播放：回到本次回放的起点重新开始
      if (this._ended || this._appliedCount >= this.entries.length) {
        if (this._rangeStart) this.seekSeq(this._rangeStart - 1);
        else this.seekIndex(-1);
        this._ended = false;
      }
      this.playing = true;
      this._clockLast = this._now();
      this._loop();
      this.emit('state', this.state);
    }

    pause() {
      if (!this.playing) return;
      this.playing = false;
      if (this._frame != null) { this._cancel(this._frame); this._frame = null; }
      this.emit('state', this.state);
    }

    toggle() { this.playing ? this.pause() : this.play(); }

    stop() { this.pause(); this.seekStart(); }

    /** 倍速：在预设档位间循环（0.5x→1x→2x→4x→8x），也可直接设值 */
    setRate(r) {
      if (r == null) {
        const i = this.rates.indexOf(this.rate);
        this.rate = this.rates[(i + 1) % this.rates.length];
      } else {
        this.rate = r;
      }
      // 不重置虚拟时间：从当前位置按新速率继续
      this._clockLast = this._now();
      this.emit('rate', this.rate);
      return this.rate;
    }

    /* ------------------------------ 定位 ------------------------------ */

    /**
     * 重建视图到指定条目索引（entry 已物化到 index，-1 = 仅基线/空白）。
     * 全量重建保证简单正确：视图 Doc 是临时只读副本，重建代价可接受；
     * 信封已按因果序排列，直接 apply，并用 id 集合幂等兜底。
     */
    seekIndex(index) {
      const target = Math.max(-1, Math.min(this.entries.length - 1, index));
      this.view = new WB.Doc();
      this._appliedIds = new Set();
      if (this.timeline.baseline && this.timeline.baseline.snapshot) {
        this.view.loadSnapshot(this.timeline.baseline.snapshot);
        for (const oid of this._allSnapshotIds(this.timeline.baseline.snapshot)) this._appliedIds.add(oid);
      }
      this._appliedCount = 0;
      for (let i = 0; i <= target; i++) this._applyEntry(this.entries[i]);
      this.time = target >= 0 ? this.entries[target].t : 0;
      this._ended = false;
      this.emit('seek', { time: this.time, index: this.currentIndex, seq: this.currentSeq });
      this.emit('tick', { time: this.time, index: this.currentIndex, seq: this.currentSeq });
      return this.view;
    }

    _allSnapshotIds(snap) {
      const ids = new Set();
      for (const so of snap.objects || []) {
        for (const k of Object.keys(so.regs || {})) ids.add(so.regs[k].id);
        for (const tk of Object.keys(so.erases || {})) {
          for (const e of so.erases[tk]) ids.add(e.id);
        }
      }
      return ids;
    }

    _applyEntry(entry) {
      const env = entry.env;
      if (!env || env.id == null) return;
      if (!this._appliedIds.has(env.id)) {
        this.view.apply(env);
        this._appliedIds.add(env.id);
      }
      this._appliedCount += 1;
    }

    /** 拖拽进度到时间 timeMs（吸附到该时刻应已物化的最后一条） */
    seekTime(timeMs) {
      const t = Math.max(0, Math.min(this.duration, timeMs | 0));
      let idx = -1;
      for (let i = 0; i < this.entries.length; i++) {
        if (this.entries[i].t <= t) idx = i; else break;
      }
      this.seekIndex(idx);
      return idx;
    }

    /** 跳到指定服务端 seq：视图重建到“seq <= target 的最后一条” */
    seekSeq(targetSeq) {
      const target = targetSeq | 0;
      let idx = -1;
      for (let i = 0; i < this.entries.length; i++) {
        const s = this.entries[i].seq;
        if (s != null && s <= target) idx = i;
      }
      this.seekIndex(idx);
      return idx;
    }

    /** 版本回放：起点 seq（含），终点 endSeq（含，0/null 表示时间轴末尾） */
    seekVersionRange(startSeq, endSeq) {
      this._rangeStart = startSeq | 0;
      this._rangeEnd = endSeq | 0 || 0;
      this.seekSeq((startSeq | 0) - 1);
    }

    seekStart() { return this.seekIndex(-1); }
    seekEnd() { return this.seekIndex(this.entries.length - 1); }

    stepForward() {
      if (this._appliedCount < this.entries.length) {
        this._applyEntry(this.entries[this._appliedCount]);
        this.time = this.entries[this._appliedCount - 1].t;
        this._emitTick();
      }
    }
    stepBack() {
      if (this._appliedCount > 0) this.seekIndex(this._appliedCount - 2);
    }

    /* ------------------------------ 播放主循环 ------------------------------ */

    _loop() {
      if (!this.playing) return;
      this._frame = this._schedule((now) => this._tick(now));
    }

    _tick(now) {
      if (!this.playing) return;
      now = now || this._now();
      const dt = (now - this._clockLast) * this.rate;
      this._clockLast = now;
      this.time += Math.max(0, dt);

      let hitRangeEnd = false;
      while (this._appliedCount < this.entries.length) {
        const e = this.entries[this._appliedCount];
        if (e.t > this.time) break;
        this._applyEntry(e);
        if (this._rangeEnd && e.seq != null && e.seq >= this._rangeEnd) {
          hitRangeEnd = true;
          break;
        }
      }
      this._emitTick();

      if (hitRangeEnd || this._appliedCount >= this.entries.length) { this._finish(); return; }
      this._loop();
    }

    _finish() {
      this.playing = false;
      this._ended = true;
      if (this._frame != null) { this._cancel(this._frame); this._frame = null; }
      this._emitTick();
      this.emit('end', { time: this.time, index: this.currentIndex, seq: this.currentSeq });
      this.emit('state', this.state);
    }

    _emitTick() {
      this.emit('tick', { time: this.time, index: this.currentIndex, seq: this.currentSeq });
    }

    /** 销毁：停止帧循环、释放视图 */
    dispose() {
      this.pause();
      this.view = null;
      this.entries = [];
    }
  }

  /* ============================== 版本管理 ============================== */

  /**
   * 命名版本快照存储。
   * @param {object} cfg { storage, prefix }
   *   storage：可选持久化适配器 { getItem(k), setItem(k,v), removeItem(k) }
   *            （浏览器传 localStorage 即可）；缺省仅内存。
   */
  class VersionStore extends EE {
    constructor(cfg) {
      super();
      cfg = cfg || {};
      this._storage = cfg.storage || null;
      this._prefix = cfg.prefix || 'wbreplay.versions';
      this._key = this._prefix + (cfg.scope ? ':' + cfg.scope : '');
      /** @type {Map<string, object>} */
      this.versions = new Map();
      this._counter = 0;
      this._load();
    }

    _load() {
      this.versions.clear();
      if (!this._storage) return;
      try {
        const raw = this._storage.getItem(this._key);
        if (!raw) return;
        const data = JSON.parse(raw);
        if (data && Array.isArray(data.versions)) {
          for (const v of data.versions) this.versions.set(v.id, v);
          this._counter = data.counter | 0;
        }
      } catch (err) { console.warn('[VersionStore] load failed', err); }
    }

    /** 切换作用域（如加入不同房间）：换存储键并重载该作用域下的版本 */
    setScope(scopeKey) {
      this._key = (this._prefix || 'wbreplay.versions') + ':' + scopeKey;
      this._counter = 0;
      this._load();
      this.emit('scope', scopeKey);
      return this;
    }

    _persist() {
      if (!this._storage) return;
      try {
        this._storage.setItem(this._key, JSON.stringify({
          counter: this._counter, versions: [...this.versions.values()]
        }));
      } catch (err) { console.warn('[VersionStore] persist failed', err); }
    }

    list() {
      return [...this.versions.values()].sort((a, b) => a.createdAt - b.createdAt);
    }
    get(id) { return this.versions.get(id) || null; }
    get count() { return this.versions.size; }

    /**
     * 保存当前版本快照。
     * @param {WB.Doc} doc 当前实时文档
     * @param {object} meta { name, knownVC, seq, clientId }
     */
    save(doc, meta) {
      meta = meta || {};
      this._counter += 1;
      const now = Date.now();
      const v = {
        id: WB.uid('ver'),
        name: meta.name || DEFAULT_NAME(this._counter),
        createdAt: now,
        seq: Number.isInteger(meta.seq) ? meta.seq : null,
        clientId: meta.clientId || '',
        snapshot: doc.snapshot(meta.knownVC || null)
      };
      this.versions.set(v.id, v);
      this._persist();
      this.emit('save', v);
      return v;
    }

    rename(id, name) {
      const v = this.versions.get(id);
      if (!v) return null;
      name = String(name == null ? '' : name).trim();
      if (!name) return v;
      v.name = name.slice(0, 60);
      this._persist();
      this.emit('rename', v);
      return v;
    }

    remove(id) {
      const v = this.versions.get(id);
      if (!v) return false;
      this.versions.delete(id);
      this._persist();
      this.emit('remove', id);
      return true;
    }

    clear() {
      this.versions.clear();
      this._persist();
      this.emit('clear');
    }
  }

  /* ------------------------- 版本恢复：补偿信封 ------------------------- */

  /**
   * 计算把 liveDoc 补偿到 targetSnapshot 内容所需的新信封（用于“恢复版本”）。
   *
   * 不做历史回滚（协作系统不能改写他人已收到的日志），而是生成一组普通新操作：
   *  - 快照里没有、当前存活的对象 → delete；
   *  - 快照里存活、当前已删/不存在的对象 → restore + set 偏差字段（或重建 create）；
   *  - 两边都存活 → 逐字段 set 偏差；像素擦单元差异 → erase / unerase 补偿；
   *  - 组成员关系差异 → group / ungroup。
   * 信封经正常提交路径广播，所有客户端因果收敛到同一版本内容。
   *
   * @param {WB.Clock} clock
   * @param {WB.Doc} liveDoc
   * @param {object} targetSnapshot VersionStore 保存的 snapshot
   * @returns {Array<env>} 可直接 commitEnvelopes 的信封列表（已按事务成组）
   */
  function restoreEnvelopes(clock, liveDoc, targetSnapshot) {
    const target = new WB.Doc().loadSnapshot(targetSnapshot);
    const targetLive = new Map();      // oid -> 物化对象
    const targetErased = new Map();    // oid -> Set<"tx,ty,cx,cy">（版本的像素擦状态）
    for (const o of target.liveObjects()) {
      targetLive.set(o.oid, o);
      if (o.type === 'stroke') targetErased.set(o.oid, target.erasedCells(o.oid));
    }

    const envs = [];
    const mk = (op) => WB.makeEnvelope(clock, op);

    const META_FIELDS = new Set(['oid', 'deleted']);
    const materialFields = (o) => Object.keys(o).filter((f) => !META_FIELDS.has(f));

    const toRestore = [];
    const toSet = [];                 // {oid, fields}
    const creates = [];               // 已彻底不存在、需重建的对象初始化

    for (const [oid, t] of targetLive) {
      const cur = liveDoc.get(oid);
      const tFields = materialFields(t);
      if (!cur) {
        // 当前文档没有该对象（从未见过或记录已被压缩）：用快照值整体重建
        const fields = {};
        for (const f of tFields) fields[f] = t[f];
        creates.push({ oid, type: t.type || 'rect', fields });
        continue;
      }
      if (cur.deleted === true) toRestore.push(oid);
      const diff = {};
      for (const f of tFields) {
        if (!deepEqual(cur[f], t[f])) diff[f] = t[f];
      }
      if (Object.keys(diff).length) toSet.push({ oid, fields: diff });
    }

    // 版本之后新建、版本里不存在的存活对象 → 删除
    const toDelete = [];
    for (const o of liveDoc.liveObjects()) {
      if (!targetLive.has(o.oid)) toDelete.push(o.oid);
    }

    // 像素擦单元差异：把每个笔迹对象恢复到版本的擦除集合
    const eraseOps = [];               // {unerase, chunks:[{oid,tx,ty,cells}]}
    for (const [oid, want] of targetErased) {
      const cur = liveDoc.get(oid);
      const have = (cur && cur.deleted !== true) ? liveDoc.erasedCells(oid) : new Set();
      const eraseCells = [];
      const uneraseCells = [];
      for (const c of want) if (!have.has(c)) eraseCells.push(c);
      for (const c of have) if (!want.has(c)) uneraseCells.push(c);
      if (eraseCells.length) {
        const chunks = chunkCells(eraseCells);
        if (chunks.length) eraseOps.push({ unerase: false, chunks: chunks.map((ch) => Object.assign({ oid }, ch)) });
      }
      if (uneraseCells.length) {
        const chunks = chunkCells(uneraseCells);
        if (chunks.length) eraseOps.push({ unerase: true, chunks: chunks.map((ch) => Object.assign({ oid }, ch)) });
      }
    }

    // 组关系差异：以版本快照的 groups 为准
    const groupOps = [];
    const targetGroups = targetSnapshot.groups || [];
    const targetGroupIds = new Set(targetGroups.map((g) => g.gid));
    for (const g of targetGroups) {
      const wantMembers = new Set(g.members || []);
      const same = [...wantMembers].every((oid) => {
        const o = liveDoc.get(oid);
        return o && o.group === g.gid;
      });
      const extraMember = liveDoc.liveObjects().some((o) => o.group === g.gid && !wantMembers.has(o.oid));
      if (!same || extraMember) groupOps.push({ kind: 'group', gid: g.gid, oids: [...wantMembers] });
    }
    // 当前存在、版本里没有的组 → 解组
    const ungroupOps = [];
    const liveGroupIds = new Set();
    for (const o of liveDoc.liveObjects()) if (o.group) liveGroupIds.add(o.group);
    for (const gid of liveGroupIds) {
      if (targetGroupIds.has(gid)) continue;
      const members = liveDoc.liveObjects().filter((o) => o.group === gid).map((o) => o.oid);
      if (members.length) ungroupOps.push({ kind: 'ungroup', gid, oids: members });
    }

    // 信封顺序必须是同一 clock 下的因果可投递序（CausalBuffer 要求按依赖出现）：
    // create（重建）→ delete（版本之后新增）→ restore（版本内被删）→ set（字段纠偏）
    // → erase/unerase（单元恢复）→ group → ungroup。
    if (creates.length) envs.push(mk({ kind: 'create', objects: creates }));
    if (toDelete.length) envs.push(mk({ kind: 'delete', oids: toDelete }));
    if (toRestore.length) envs.push(mk({ kind: 'restore', oids: toRestore }));
    for (const u of toSet) envs.push(mk({ kind: 'set', oid: u.oid, fields: u.fields }));
    for (const op of eraseOps) envs.push(mk({ kind: 'erase', chunks: op.chunks, unerase: op.unerase }));
    for (const op of groupOps) envs.push(mk(op));
    for (const op of ungroupOps) envs.push(mk(op));

    if (envs.length > 1) WB.atomic(envs);
    return envs;
  }

  /** "tx:ty,cx,cy" 集合 → erase 信封需要的 [{tx,ty,cells:[[cx,cy],…]}] 分块 */
  function chunkCells(keys) {
    const tiles = new Map();
    for (const k of keys) {
      // 与 Doc.erasedCells 的键格式一致：tileKey = "tx:ty"，完整键 "tx:ty,cx,cy"
      const comma = k.indexOf(',');
      if (comma < 0) continue;
      const [txStr, tyStr] = k.slice(0, comma).split(':');
      const rest = k.slice(comma + 1).split(',');
      if (!Number.isInteger(txStr | 0) || rest.length !== 2) continue;
      const tx = txStr | 0, ty = tyStr | 0, cx = rest[0] | 0, cy = rest[1] | 0;
      const tk = tx + ':' + ty;
      if (!tiles.has(tk)) tiles.set(tk, { tx, ty, cells: [] });
      tiles.get(tk).cells.push([cx, cy]);
    }
    return [...tiles.values()];
  }

  return {
    TIMELINE_VERSION,
    PLAYBACK_RATES,
    EE,
    Recorder,
    Player,
    VersionStore,
    restoreEnvelopes,
    chunkCells,
    deepEqual
  };
}));
