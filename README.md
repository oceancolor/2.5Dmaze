# 2.5Dmaze · 迷宫寻宝博弈

一个 128×128 格的迷宫寻宝博弈游戏：4 只呆萌卡通小机器人从迷宫四角出发，抢五色宝石（红黄绿蓝紫，成套加分）、开宝箱赌分数或体力，在体力耗尽前找到属于自己的出口。其中 3 只由大模型决策，1 只由玩家操控。**核心特色是让玩家用 AI 来玩**：把卷轴里的提示词交给自己的 Agent（WorkBuddy / CodeBuddy 等），或者接入自己的大模型 API key；玩家写下博弈思路，并决定 AI 该多听自己的。

**45° 仿 3D 俯视 · art deco 低饱和马卡龙配色 · 回合制同步步进 · 客户端（Web / H5 / 桌面）+ 游戏服务器（记录对战数据；AI 费用谁用谁付）**

> 服务器按 `docs/06-多端与服务器架构.md` 分期建设：**S0 已完成**（游客账号、对局上传 + 服务器重放校验、离线补传、我的战绩）；下一步 M1（玩家思路 + 自主度 + 自带模型经服务器中转）。

---

## 当前状态

**浏览器可玩版已接通：手打 / 脚本 Agent / 提示词 Agent 三种玩法，对手可选模拟大模型 / 本地代理大模型 / 启发式。打完的每一局都会上传到游戏服务器，用同一个内核逐回合重放校验。** 规格见 `docs/SPEC.md`。

| 阶段 | 状态 |
|---|---|
| P0.5 玩法确认 / P1 设计文档（00–04） | ✅（已冻结为参考依据） |
| 阶段 0 · 规格收敛 `SPEC.md` | ✅ SPEC-0.1 |
| 阶段 1 · 确定性内核（Node：生成/规则/仲裁/计分/启发式 AI/回放 + `node --test`）+ 新内核仿真重出基线 | ✅ 基线见 SPEC 附录 B |
| 阶段 2 · 灰盒可玩（浏览器：等距渲染/HUD/输入/倍速/记录） | ✅ 可玩；人工试玩清单（04 §10）与 O6/O7 A/B 待用户试玩 |
| 阶段 3 · LLM 代理与玩家托管 | 🟡 规划 agent / 预算 / 降级 / 脚本沙箱 / 本地代理全通（mock + 假上游实测）；**等 HY4 凭证（O9）接真模型** |
| 阶段 4 · 平衡复核 + 灰盒闸门 → P2 美术 | ⏳ |
| 服务器 S0（06 §14）：游客账号 · 记录上传 + 重放校验 · 离线补传 · 我的战绩 · 同构 lint · 部署模板 | ✅ |
| 服务器与玩家 AI 代打后续（M1 → S1 → M2 → M3 → H5 → Electron 桌面壳） | 📝 设计稿：`docs/05`（v0.2）、`docs/06`（v0.2），待定问题 Q4–Q7、Q12、Q14、Q15 |

> 为什么先做灰盒：手感与穿模只能在"能玩的东西"上测。资产先行 = 手感问题必然发现得太晚。

### 开玩（Node ≥ 22.13，零依赖，无需 `npm install`）

```bash
npm run play          # 游戏服务器（开发模式）：http://127.0.0.1:5173/ ，数据在 .data/maze.db
node tools/serve.mjs  # 纯静态预览 http://127.0.0.1:8080/ （不连服务器，记录只存本机）
```

开局设置页里选：

| 你怎么玩 | 说明 |
|---|---|
| **自己手打** | 方向键 / WASD 每回合走一步，AI 等你（无超时）；Q E C Z 屏幕斜向，空格原地等，按住连走。两种方向映射可切（M 键） |
| **脚本 Agent** | 写 `function decide(obs, api)`，返回 `'N' / 'E' / 'S' / 'W' / 'STAY'`。在 Worker 里跑，每回合限时 100 ms；`api.shortestStep / distance`（每回合 8 次）、`api.setState`（≤16 KB）、`api.log`。带示例与「试运行」。连续 10 次异常切回手动，累计 5 次无效返回改为引擎自动回家 |
| **提示词 Agent** | 写一段打法描述（≤2000 字），大模型只负责「选目标」，引擎负责寻路；执行中若目标已负担不起，自保闸门会改回出口。可用模拟大模型离线玩，也可接本地代理 |

对手 AI-A/B/C 各自可选「模拟大模型 / 大模型（本地代理）/ 启发式」与风格预设（均衡 / 凑套 / 开箱 / 保守 / 冒险）。

快捷键：`1 2 3` 倍速 1/2/4× · `0` 跳过动画 · `P` 暂停 · `- =` 缩放（最小档为全图）· `F` 归位 · 拖拽平移 · `Enter` 观战时跳到结算 · `N` 新局 · `Esc` 设置。结算卡可校验严格回放、下载记录 JSONL，并显示本局记录的上传与服务器校验结果；开局设置页底部是「我的战绩」（最近 10 局）。

**对局记录**：第一次上传时自动领一个游客身份（令牌存在这个浏览器里）。每局结束就上传，服务器用同一个内核逐回合重放：结论是「校验通过 / 校验不一致（指出第几回合）/ 无法校验（规则版本不同）」。断网打完的局先存在本机（IndexedDB），联网后自动补传。服务器能证明「规则合法、结果确实由这串操作产生」，证明不了「操作出自谁」（06 §6.3）。

### 接真大模型（本地代理，密钥不进前端）

```bash
# 任何 OpenAI 兼容的 /chat/completions 端点均可（HY4 拿到凭证后同样填这三项）
LLM_BASE_URL=https://…/v1  LLM_API_KEY=sk-…  LLM_MODEL=…  npm run proxy     # 监听 127.0.0.1:8787
# 也可写 proxy/config.local.json：{"baseUrl":"…","apiKey":"…","model":"…"}（已在 .gitignore）
```

代理只放行 `http://127.0.0.1:*` / `http://localhost:*` 来源、请求体 ≤64 KB、日志打码密钥。代理不可达或连续 3 次 5xx/429 时，走代理的座位本局熔断为启发式（模拟大模型座位不受影响）。

### 常用命令

```bash
npm test                               # 确定性 lint + 同构 lint + 体积门禁（K11/K12/K14）+ 全部用例（node --test）
npm run server                         # 同 npm run play；环境变量见 server/main.mjs 文件头
node server/backup.mjs                 # SQLite 在线快照到 .data/backups（保留 14 份）
node tools/serve.mjs                   # 静态预览 http://127.0.0.1:8080/ · 内核俯视预览 /tools/preview/ · 美术样张 /tools/gallery/
node tools/size-budget.mjs             # 只跑体积门禁：从 index.html 沿 import 图统计真实加载的 JS + 图集
node tools/bench-maze.mjs --runs 1000  # 内核性能 K04（地图生成 P95 ≤ 20 ms）/ K05（BFS 平均 ≤ 1.5 ms）
node tools/art/build.mjs               # 美术管线：无头 Blender 渲染 4× 原图（.cache/art/raw，不入库）→ 打包 assets/atlas/pilot{,@2x}（地图内，首屏）+ env{,@2x}（场外布景，非首屏）
                                       #   --only 前缀1,前缀2 只重渲指定 sprite；--no-render 只重新打包；Blender 路径用环境变量 BLENDER 覆盖
node tools/art/pack.mjs                # 只重新打包（改了缩小/阴影后处理时用）
node tools/bench.mjs --n 1000          # 新内核平衡基线（4 个启发式 AI）；可加 --stamina --respawn --setBonus --gemsPerColor --maxTurns --json
node tools/calibrate.mjs               # 扫 thinKeep → 墙密度 / 校验通过率（换生成器后重标）
node tools/lint-determinism.mjs        # 只跑确定性门禁
node tools/lint-isomorphic.mjs         # 只跑同构门禁（共享代码不得引用 DOM / 浏览器 API / Node API）
```

### 部署到云主机（maze.aiquiz.games）

模板在 `deploy/`，按 Linux + systemd + Nginx 写（06 §12）：

```bash
# 1. 云主机装 Node ≥ 22.13；建用户与目录
useradd --system --home /srv/maze maze && mkdir -p /srv/maze /var/lib/maze /etc/maze && chown maze:maze /var/lib/maze
# 2. 代码放到 /srv/maze（git clone 或 rsync，无需 npm install）
# 3. 配置
cp deploy/maze.env.example /etc/maze/maze.env
cp deploy/maze.service deploy/maze-backup.service deploy/maze-backup.timer /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now maze maze-backup.timer
# 4. Nginx：deploy/nginx-maze.conf → /etc/nginx/conf.d/maze.conf，填证书路径；nginx -t && systemctl reload nginx
curl https://maze.aiquiz.games/healthz      # {"ok":true,"api":true,...}
```

- 服务器只监听 `127.0.0.1:5173`，HTTPS 由 Nginx 终结；`TRUST_PROXY=1` 让限频按真实客户端 IP 计。
- 备份每天 04:00 做到 `/var/lib/maze/backups`，**还需要再同步到云主机之外**（对象存储）。
- 上线前核对：云主机所属厂商与 ICP 备案接入商一致；网站底部展示备案号（06 §12.1）。

---

## 文档索引

| 文件 | 内容 |
|---|---|
| **`docs/SPEC.md`** | **实现规格，唯一依据。** 规则、生成、结算、AI、config 键表、待定项全在这里 |
| `docs/00-制作交付说明.md` | 冻结 · 参考。P1 汇编版与实测依据 |
| `docs/01-总设计案.md` | 冻结 · 参考。P1 规则推导与历次裁定（数值以 SPEC 为准） |
| `docs/02-技术方案.md` + `docs/02b-技术方案-增补.md` | 冻结 · 参考。渲染栈、迷宫生成、LLM 节流与降级、性能预算 |
| `docs/03-美术资产计划.md` | 冻结 · 参考。色板、图集规格、sprite 清单、灰盒最小集。**v1.5 节 = 3D 管线现行执行规则**（描边、地形变体、角色全状态、宝石 / 宝箱 / 出口 / 装饰、视口布局（地图铺满 + 四角 HUD + 场外台地土崖 / 林子 / 左上右上地标）、@2x 加载与 3.0 MB 体积） |
| `docs/04-验收判据.md` | 冻结 · 参考。断言素材库与坐标级场景（需按 SPEC §15 改写后使用） |
| **`docs/05-玩家AI代打设计.md`** | **核心特色「玩家用 AI 来玩」的设计稿**：卷轴提示词接入玩家自己的 Agent / 玩家自带模型 API key；玩家思路 + 自主 / 结合 / 严格三档；Agent 网关协议、密钥处理、分期与验收、裁定与待定问题 |
| **`docs/06-多端与服务器架构.md`** | **产品形态设计稿**：客户端（Web / H5 / 桌面）+ 服务器；同一确定性内核跑在客户端、服务器宿主、服务器校验三处；对战数据记录、AI 中转（谁用谁付）、账号、PvP 预留、接口、分期与验收 |

---

## 旧仿真脚本（零第三方依赖 · 旧规则 · 仅作历史参考）

> ⚠ 这些是 P1 阶段的仿真，跑的是**旧规则**（10 颗宝石/同色去重、停留与僵持扣体力等），且存在两套互不一致的实现。输出数字**仅作历史参考**，不用于 SPEC 的结论；新规则的数字一律用 `tools/bench.mjs`（基于 `src/core`）。

`tools/` 下全部可复跑，用 Node 直接跑：

```bash
node tools/bench-match.mjs            # 完整对局四门禁：到达率 / 人均宝石 / 零收获 / 回合数
node tools/bench-events.mjs           # LLM 事件触发次数（边沿型 vs 状态型）
node tools/bench-keep.mjs             # 迷宫生成参数扫描：墙密度 / 路径长度 / 区间通过率
node tools/bench-keep-actors.mjs      # 同上，按 actor 拆分
node tools/sim/t2o.mjs 400            # 调用预算双池实测
```

> ⚠ 引用脚本输出的任何数字时，请带上口径四元组：**（出口方案, 宝石数, 竞争度, 目标墙密度）**。
> 同一件事在不同脚本/配置下会给出差 1.9 倍的数——本轮为此付出的代价不小，详见 `docs/00` 的"口径提醒"。

---

## 技术要点（一句话版）

- **渲染**：Canvas 2D 原生，零第三方依赖，地面分块 8×8 预烘焙，墙/角色按行序绘制保证遮挡
- **迷宫**：growing-tree + braid + 削墙，标定到**封边后墙密度 0.355 ± 0.008**；开局校验单连通、出生点不四面受阻、出口开口宽 1
- **规则**：体力只因成功位移消耗（不扣分原则）；计分 = 宝石数 + 5 × 成套数 + 宝箱分
- **LLM**：本地 Node 代理只监听 `127.0.0.1:8787`，Key 绝不进前端；每 N 回合重规划 + 事件触发，本地 BFS 执行单步移动；计划第 t+L 回合生效，回放只读记录
- **确定性**：`stateHash` 逐回合可校验；`Math.random` 只在 `rng.js`、`Date.now` 只在 `clock.js`
- **服务器**：`server/`，Node 内置 `node:http` + `node:sqlite`，零依赖；内核 / AI / 记录 / 调度器是浏览器与服务器共用的同一份代码（同构 lint 守门），上传的记录用它严格回放

---

## 待办中的硬阻塞

HY4 的 `baseURL`（含 `/v1`）、`model id`、鉴权头与前缀——只阻塞阶段 3 的真模型接入；代理已按 OpenAI 兼容格式就绪，拿到凭证即可填入。U7 后 HY4 是服务器中转里的一个服务商预设，费用由选用它的玩家自己出。

服务器：域名 `maze.aiquiz.games` + 自有云主机（起步 2 核 4 GB），部署模板见上文；第一次部署时确认云主机的地域与系统（`docs/06` Q18）。其余待定项见 `docs/SPEC.md` §16。
