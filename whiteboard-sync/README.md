# 协作白板 v3 · P2P 低延迟 / 二进制增量同步 / 离线合并 / 录制回放与版本管理

v3 在 v2「LWW CRDT + 版本向量因果投递」内核之上，补齐了真实弱网/大规模协作所需的
**传输带宽、消息可靠性、断线续传、快照加速、慢客户端背压、离线编辑合并**六项能力；
并新增**操作录制、时间轴回放、命名版本管理**（详见文末「录制回放与版本管理」）。
v2 的 JSON/WebSocket 协议完全保留，同一 `/ws` 端口上 v2（JSON）与 v3（二进制）客户端可同房间共存、双向互见。

```
whiteboard-sync/
├── server.js            # 双协议服务端：v2 JSON + v3 二进制 Link / 快照链 / Outbox 背压 / RTC 信令转发 / 媒体中继 / ★ 录制时间轴 + 版本
├── public/
│   ├── kernel.js        # 共享 CRDT 内核（LWW、CausalBuffer、选择性撤销、压感笔迹、橡皮分块…）
│   ├── replay.js  (新)  # ★ 时间轴回放引擎（播放/暂停/倍速/拖拽/跳 seq）+ 版本恢复操作生成
│   ├── net.js           # 二进制协议 + 可靠 Link + 快照/增量 planSync + 离线 IndexedDB + 媒体续传
│   ├── mesh.js          # WebRTC DataChannel P2P 网状连接（WS 只转发 SDP/ICE 信令）
│   ├── sync.js          # 浏览器同步门面：版本协商/增量/离线合并/队列/P2P 旁路/慢降级
│   ├── app.js           # 画布与工具（v3 可用时走 SyncClient，否则回退 v2 JSON；★ 回放/版本 UI）
│   └── index.html
├── test-replay.js (新) # 60 项录制/回放/版本测试（纯逻辑引擎 + 真实 ws/HTTP 全链路）
├── test-v3.js           # 29 项 v3 全链路测试（真实 ws 二进制，自动拉起服务端、自动分配端口）
├── test-kernel.js       # 内核一致性测试
├── test-smoke.js        # v2 协议兼容测试
└── test-frontend.js     # 前端状态机测试（含回放入口/只读隔离/退出回最新）
```

## v3 九项能力对照（需求逐条）

1. **WS 只做信令/控制，大数据走 P2P**：`mesh.js` 在房间成员间建 WebRTC DataChannel 网状连接，
   SDP offer/answer 与 ICE candidate 全部经 WS（`RTC_SDP/RTC_ICE`）转发；DataChannel 一旦建立，
   大操作（笔迹/媒体）走 P2P，服务端链路仅承担权威 seq、ACK 与兜底中继。
   DataChannel 用 `ordered=false, maxRetransmits=0`，可靠性由自研 Link 统一承担。

2. **二进制协议**（`net.js`，自定义 ArrayBuffer，无 proto 依赖）：坐标/线宽/变换用 **Float32**，
   时间用 **Uint32**，压感量化为 Uint8、倾斜 Int8；笔迹点紧凑到 **19 字节/点**
   （同等 JSON 约 80+ 字节/点）。100 点笔迹整包实测约为 JSON 的 1/4（2030B vs 8706B）。
   消息自动分片为 ≤16KB 帧，匹配 DataChannel 安全阈值。

3. **增量同步**：JOIN / REQ_SYNC 携带 `lastSeq` 与版本向量，服务端 `planSync` 判定
   纯 delta / 基线快照+delta / 全量，只返回缺失信封。

4. **快照加速**：每 100 个物化操作拍一份快照，保留最近 8 份构成快照链；
   新客户端「先加载最近快照，再重放其后少量操作」（105 操作的房间只需重放 5 条）。

5. **背压三级处理**：客户端 `SendQueue`（同 squashKey 中间帧合并、窗口满 await drain）、
   服务端每客户端 `Outbox`（字节水位 + Link 在途窗口检测）、**慢客户端自动降级为快照同步**
   （MODE=1 优先控制帧即时送达，排空后 REQ_SYNC 补快照并 MODE=0 恢复）。服务端 socket
   写缓冲超水位即停止向停摆客户端写入，慢端不拖垮其他成员。

6. **离线编辑**：未确认信封与时钟（Lamport/local/VC）持久化到 **IndexedDB**
   （`OfflineStore`，隐私模式/Node 自动退回内存）；关页或断线期间可继续编辑，
   重连后按 lamport 序合并上传，服务端按 env.id 幂等。本地缓存快照支持离线秒开。

7. **去重/乱序/重传**：Link 在任意数据报传输（WS 或 DataChannel）上提供
   严格递增 32 位序号、累积 ACK + SACK 选择确认、NACK 缺口请求、RTO 超时重传；
   重复帧/乱序帧/旧序号一律丢弃，缺口缓冲重组。已在 30% 丢包 + 重复 + 乱序的损伤链路下验证 20/20 有序不重。

8. **收发队列序号校验**：发送队列按本地 lamport 严格升序；接收端 Link 帧序号 +
   应用层服务端 seq 双重水位校验，回退 seq 直接丢弃，杜绝旧消息覆盖新状态。

9. **协议版本化**：连接先 `HELLO{name,major,minor}` 协商 —— major 不一致 `WELCOME(ok=false)`
   并拒绝连接；minor 高于服务端则 `action=degrade` 降级运行。

**媒体（图片/大文件）**：`MediaSender/MediaReceiver` 接收端驱动分块拉取，
`MEDIA_REQ{offset}` 天然支持**断点续传**——旧 offset 块/重复块丢弃、乱序块暂存、缺口重请求；
无 P2P 时可 `PUT /api/media` 走服务端中继。

测试覆盖（`npm test`）：`test-kernel.js` + `test-frontend.js`(含回放) +
`test-smoke.js`（v2 兼容）+ `test-v3.js` + `test-replay.js`(★ 录制/回放/版本)。

---

# 以下为 v2 内核设计说明（仍然适用）

# 协作白板 v2 · CRDT 多人并发内核

在 v1「单房间单笔迹、服务端 seq 排序」的基础上，升级为支持**多用户并发编辑、对象化白板、选择性撤销**的协作内核。
原生 HTML/CSS/JS + Canvas 前端，Node.js + ws 后端，零额外依赖（内核同时被浏览器与 Node 加载）。

## 目录结构

```
whiteboard-sync/
├── package.json
├── server.js            # 房间 / 权威 CRDT 物化 / 因果缓冲 / 快照 / 日志压缩 / 心跳
├── public/
│   ├── kernel.js        # ★ 共享协作内核（CRDT、时钟、撤销、压感、平滑、橡皮、识别）
│   ├── app.js           # 对象化渲染 / 指针手势 / 工具栏 / 网络层
│   ├── index.html
│   └── style.css
├── test-kernel.js       # 262 项内核一致性测试（并发/选择性撤销/事务/压缩/压感/橡皮…）
├── test-smoke.js        # 26 项真实 ws 协议测试（自动拉起服务端，覆盖 5 个验收场景）
└── test-frontend.js     # 21 项前端状态机测试（stub DOM/Canvas/WebSocket 加载真实 app.js）
```

## 启动与测试

```bash
npm install
npm start                 # http://localhost:8080/

npm test                  # 三套测试全跑
node test-kernel.js       # 纯内核（无需服务端）
node test-smoke.js        # 协议（未运行时自动拉起 server.js）
node test-frontend.js     # 前端（无需浏览器）
```

## 一、一致性模型（需求 1、3）

- **LWW-Element-Map CRDT**：白板是一组对象（`oid`），每个字段是一个 LWW 寄存器，
  写入带 `(lamport, clientId)` 时间戳。任意副本对同一组信封折叠出**相同结果**，
  与网络到达顺序无关 —— 这就是「不能只靠服务端 seq 排序」的核心：**seq 仅用于日志排序/观测，不参与冲突仲裁**。
- 每个信封携带：
  - `clientId`：操作者；
  - `lamport`：Lamport 逻辑时钟；
  - `clock`：版本向量（依赖向量），声明「我见过各节点的第几条操作」；
  - `id`：`<clientId>:<localCount>`，全局幂等。
- **因果投递**：`CausalBuffer` 用 happens-before 规则（发送者序号连续 + 依赖向量不超前）
  保证 `create` 必先于后续 `set`；缺依赖的信封先挂起，补齐后按序冲刷。

## 二、对象模型与操作类型（需求 2）

对象类型：`stroke / rect / ellipse / triangle / arrow / line / text / note / image / group`。
操作 `kind`：`create / set / delete / restore / group / ungroup / layer / erase`，
覆盖图形、文本、便签、图片、选择、移动、缩放、旋转、删除、图层调整、组合、解组。

- 移动/缩放/旋转统一写对象的仿射变换字段 `tr{tx,ty,sx,sy,r}`，对笔迹和图形一视同仁。
- 图层顺序用**十进制分数索引**（fractional indexing）：`zBetween(a,b)` 逐位长除取严格中点，
  并发同位置插入产生相同键，再由 `(lamport,clientId)` 确定平局，永不重排。

## 三、选择性撤销（需求 4，验收场景 2）

撤销**不回滚历史**，而是发一条「逆操作」信封（`op.inv = {originId, originLamport, polarity}`）。
内核折叠逆写入时做**架空检测**：

> 若原操作之后（含并发更大 lamport）存在**他人的普通写入**到同一字段，逆操作空转（void）。
> 他人的撤销/重做不算新鲜意图；自身的记录不阻塞；保护是**字段级**的（`create` 的撤销是对象级）。

因此：
- 只撤销自己的操作（`UndoManager` 只记录本人发出的顶层编辑/事务）；
- A 撤销自己旧笔迹时，若 B 已修改该区域，**A 的撤销不会覆盖 B 的结果**；
- 没被他人碰过的字段正常恢复，互不影响（per-field）。
- 历史面板支持对任意一条自己的历史操作做**选择性撤销**（`undoSelective`），不限于栈顶。

## 四、事务与原子操作组（需求 5，验收场景 3）

多对象编辑（一次粘贴多个元素、一次移动多个选中对象）的多个信封用 `WB.atomic()` 绑定同一 `txnId`。
因果缓冲保证整组要么一起就绪、要么全部挂起 —— **其他客户端要么全部看到移动，要么看不到，绝不会只移动一半**。

## 五、操作压缩（需求 6）

连续移动/缩放的高频帧都带 `squashKey`（精确到「手势 × 对象」），
`WB.squash(log)` 把相同 key 的一串信封折叠为携带最终状态的一条。
服务端超过阈值自动压缩，并提供 `POST /api/compact?roomId=`；
超出硬上限时建立快照水位（snapshot watermark），日志体积有界，晚加入者走快照 + 增量。

## 六、压感笔迹（需求 7，验收场景 4）

采样点升级为 `{x, y, p 压感, tx/ty 倾斜, t 时间戳, w 宽度}`。
宽度由两端共享的同一确定性公式计算，发送端预算好 `w` 随点传输：

```
w(p) = base · (kP + (1-kP)·pressure) · 1/(1 + kS·v/vRef)
        └── 压感变宽 ──┘                └── 速度变细 ──┘
```

接收端无需重放，逐点宽度两端逐值一致。

## 七、平滑与简化（需求 8）

- 发送前用 **Ramer–Douglas–Peucker（RDP）** 简化点集（保留压感等属性）；
- 渲染支持 **向心 Catmull-Rom**（默认，已验证均匀情形退化为标准 Bezier 系数）、
  **三次均匀 B 样条**、线性、以及 v1 的中点二次贝塞尔。

## 八、橡皮擦（需求 9，验收场景 5）

- **像素擦**：笔迹被划成 `16×16` 个单元的块（块边长 = `cellSize × 16`，cellSize 取笔迹宽度）。
  只同步被触碰的块 + 块内单元下标（`erase {chunks:[{oid,tx,ty,cells:[[cx,cy],…]}]}`），
  增量同步、增量重绘，不全量重画；擦除状态在 CRDT 里按**单元（cell）粒度**做 LWW 寄存器折叠，撤销按格恢复。
  - 选择性撤销也是单元级：A、B 先后擦同一分块里的不同单元，A 撤销只恢复 A 擦过的格子，
    B 擦的格子保留；只有他人在 A 之后**重擦同一格**时，该格的恢复才空转（同块其它格不连坐）。
  - 快照/日志压缩时每个单元除当前获胜记录外还保留各他人最新写入（protector），
    晚加入者与水位之后重放的撤销仍得到逐单元一致的结果。
- **对象擦**：沿擦除路径命中整个对象 → `delete`（可多对象事务）。
- **整笔擦**：命中笔迹 → `delete`。

## 九、笔刷与识别（需求 10）

- 笔刷：钢笔、**荧光笔**（半透明 multiply）、**虚线**（setLineDash）、**纹理笔**（沿线盖点）；
- 工具：箭头、矩形/椭圆/三角/直线（一笔**图形识别**或直接插入）；
- **手写转文字**：内置 $1 Unistroke 识别器（重采样 64 点 → 旋转归一 → 缩放 → 黄金角搜索），
  内置数字与常用符号模板，命中阈值后笔迹转 `text` 对象（原笔迹不入库，无重复）。

## 消息协议（JSON over WebSocket，`/ws`）

```jsonc
// C → S
{ "type": "join", "roomId": "r1", "userId": "u-a", "lastSeq": 0 }
{ "type": "ops",  "envelopes": [ /* 单条或同一 txnId 的事务原子组 */ ] }
{ "type": "ping" }

// 信封
{ "id": "u-a:7", "clientId": "u-a", "lamport": 7,
  "clock": { "u-a": 7, "u-b": 3 },
  "txnId": "txn-…", "squashKey": "move:<gesture>:<oid>",
  "op": { "kind": "set", "oid": "obj-1", "fields": {"x": 100}, "prev": {"x": 80} } }

// S → C
{ "type": "joined",  "roomId": "r1", "userId": "u-a", "lastSeq": 16 }
{ "type": "snapshot","watermark": 0, "snapshot": { /* 折叠后的对象/擦除/组 + known VC */ },
                      "envelopes": [ /* 水位之后仍在日志的增量 */ ] }
{ "type": "ops",     "envelopes": [ /* 因果广播（不含发送者自己） */ ] }
{ "type": "ack",     "ids": ["u-a:7"], "lastSeq": 16 }
{ "type": "pong" | "error" }
```

HTTP：`GET /api/rooms`、`GET /api/room?roomId=`、`GET /api/compact?roomId=`（运维/测试压缩）。

## 验收场景 ↔ 测试

| 验收场景 | 测试 |
| --- | --- |
| 1. 三客户端同画并发，最终一致、无重复 | `test-smoke.js [1]`、`test-kernel.js [1]`（6 种乱序全收敛） |
| 2. A 撤销旧笔迹不破坏 B 的后续修改 | `test-smoke.js [2]`、`test-kernel.js [2]/[2b]` |
| 3. 多对象移动原子（全有或全无） | `test-smoke.js [3]`、`test-kernel.js [3]`（事务缺半时 0/5 可见） |
| 4. 压感笔迹两端宽度一致 | `test-smoke.js [4]`、`test-kernel.js [4]` |
| 5. 橡皮分块两端一致 | `test-smoke.js [5]`、`test-kernel.js [8b]` |

## 设计要点

- **为什么 seq 不再解决冲突**：seq 是单点全序，无法表达「B、C 都基于 A 的状态并发修改」这种偏序；
  CRDT 让每个副本本地确定性收敛，服务端只负责定序、广播、物化快照。
- **为什么撤销用逆操作而不是删日志**：协作系统不能改写他人已收到的历史；逆操作是一条普通新操作，
  同样参与因果/广播/压缩，架空检测保证「选择性」——只在不与他人意图冲突时生效。
- **为什么变换用独立 `tr` 而不是改 x/y**：笔迹是点云没有包围盒基准，统一仿射字段让移动/缩放/旋转
  对所有类型语义一致，命中测试用逆变换把屏幕点映回对象局部坐标。
- **乐观预提交 + 幂等重发**：本地操作立即上屏，未 ack 的断线期间积压，重连后按原 `id` 重发，
  服务端 `applied` 集合幂等去重，绝不重复入库。

> 说明：白板内容保存在服务端内存中，进程重启后清空（重连客户端以服务端快照为准）；
> 持久化可在 `Doc.snapshot()` 之上接入 Redis/数据库。

---

# 录制回放与版本管理（v3 新增）

白板操作在服务端**全程自动录制**为一条带权威 `seq` 与 `serverTs` 的物化时间轴；
浏览器在**独立的回放 Doc** 上重放，提供时间轴回放与命名版本能力。

## 录制（服务端）

- 房间结构新增 `timeline`（与会被压缩的 `log` 独立，上限 20 万条，压缩日志不影响录制）
  与 `versions`（命名版本，上限 100 份）。信封一旦经 `CausalBuffer` 物化（拿到 seq）
  即追加进时间轴，因此时间轴就是「可回放的操作日志」。
- 版本保存：对指定 seq（默认当前最新）从时间轴**重放物化**出一份 `Doc.snapshot()`
  快照（含版本向量与逐单元擦除 protector），命名后存于房间。

HTTP API（v2/v3 客户端共用，JSON）：

| 方法/路径 | 作用 |
| --- | --- |
| `GET /api/timeline?roomId=&fromSeq=&toSeq=` | 录制时间轴：按 seq 升序返回物化信封 |
| `GET /api/versions?roomId=` | 版本列表（轻量，不含快照载荷） |
| `POST /api/versions` | 保存版本 `{roomId,name,seq?,clientId?}`，缺省 seq=最新 |
| `GET /api/version?roomId=&id=` | 版本详情（含快照，供按版本回放/恢复） |
| `DELETE /api/version?roomId=&id=` | 删除命名版本（只删快照，不动白板） |

## 时间轴回放（`public/replay.js` · `WBReplay.ReplayController`）

- **物理隔离**：回放在新建的 `WB.Doc` 上按 seq 重放，不触碰实时协作文档、不发送任何信封；
  回放期间实时协作照常物化（仅不显示）。点「退出回放」即丢弃回放 Doc，画面回到实时最新。
- 控件：播放 / 暂停 / 上一条 / 下一条 / 倍速（0.5×–8×，播放中切换即时生效）/
  拖拽进度条（按事件位置，也可按比例/时间）/ 输入 **seq 跳转** / 空格播放暂停 / Esc 退出。
- 时间用信封 `serverTs`（缺失时合成等间隔），按真实操作节奏播放；
  seek 用**快照检查点**加速（任意位置只从最近检查点重放一小段），后向拖拽也能正确还原 LWW 状态。
- 回放期画布只读：屏蔽指针手势、双击编辑、编辑类快捷键与一切上行信封（顶栏显示只读徽标）。

## 版本管理（保存 / 命名 / 恢复 / 按版本回放）

- 右侧「版本」面板：命名保存当前版本，或填 seq 保存历史某刻；列表可**回放** / **恢复** / **删除**。
- **按版本回放**：跳到该版本的 seq（时间轴定位），可继续向后播放看它之后的演化。
- **恢复版本**不回滚历史、不伪造他人操作：`WBReplay.buildRestoreOps(liveDoc, targetSnap)`
  对比当前实时 Doc 与目标快照（字段 / 删除 / 像素擦单元 / 组），生成一批**普通补偿操作**
  （set / delete / restore+set / create / erase / unerase / group / ungroup），
  由本人 `Clock` 签发、走正常提交与因果广播——恢复是一次新编辑，所有协作者经 CRDT 收敛一致。

## 测试

`test-replay.js` 60 项：回放加载/拖拽/单步/跳 seq、播放暂停倍速（注入虚拟时钟确定性验证）、
检查点后向重建一致性；恢复操作（移动/删除/重建/像素擦）；以及真实 ws+HTTP 全链路：
时间轴录制、范围过滤、版本保存(最新/指定 seq)+校验、列表/详情/删除、按版本回放隔离、
恢复广播后晚加入者收敛、压缩不影响时间轴。`test-frontend.js` 另含回放入口/只读/
实时协作不中断/退出回最新的前端集成断言。
