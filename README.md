# 陶片拼接推演工作台（Sherd Stitch Workbench）

供考古工作室在浏览器中推演陶片（陶片/陶片残片）拼合关系的 Web 工作台。

- **Node.js（Express）+ SQLite（better-sqlite3）+ 浏览器 Canvas**，无前端构建步骤。
- 上传陶片照片、为每片标记**毫米比例尺**（图上像素长度 ↔ 真实毫米）。
- 以“接缝”记录两片之间的**旋转角 θ、平移 (tx, ty)**（单位毫米）与**接缝说明**。
- 画布按**已采纳接缝**自动拼出各**连通组**，显示每片位置及其所依据的**接缝链**；未连通陶片单独成卡显示。
- 新接缝形成环时，若推算位置与现有布局的偏差超过方案的**毫米容差**，**拒绝采纳**、给出**冲突接缝链**与偏差数值，**原布局保持不变**。
- **修订已采纳接缝**：可对任意一条接缝修改**旋转角 θ、毫米平移 (tx, ty) 与说明**（接缝身份与采纳排序不变）。提交前先做**只读预览**——按原接缝身份及排序重算各陶片位姿与**每一个闭合环**残差、逐条列出**超差接缝的冲突链**，预览**不改动方案**；确认时服务器基于当前版本**原子地重新校验全部闭合环**，任一残差超差即拒绝（422，接缝/版本/布局均不变），版本落后返回 409，成功后接缝 ID 与排序不变、版本只递增一次、读取布局与预览一致。
- **批量试拼候选接缝（本轮新增）**：把若干条候选接缝作为**一批**按顺序填写（每条：两端陶片、旋转角 θ、毫米平移、说明），先做**只读试算**——**已有接缝优先**，候选按填写顺序参与布局，工作台给出整批加入后的**连通组、陶片位姿及每个闭合环残差**，超差时指出**候选序号、偏差与冲突链**；试算不改接缝和版本。确认必须使用**同一批内容**及**试算所基于的方案版本**，服务器在**单事务**内重新校验全部闭合环，通过才**依序采纳且版本只增加一次**，否则**整批不生效**（422）；方案版本已变化返回 **409** 并要求重新试算。陶片不属于本方案、未标比例尺、接缝连接同一片或参数非法时整批拒绝（400，逐条指出候选序号）。
- **方案移交包：导出/导入自包含 ZIP（本轮新增）**：在工作台一键**下载方案包**，内含方案名称、毫米容差、**陶片照片及比例尺**、**按采纳顺序排列的接缝**、每张照片的 **SHA-256 摘要**与导出时**全部闭合环校验摘要**；导出在服务器的**同一版本快照事务**内完成，导出期间方案即使被他人编辑，包内数据仍来自同一版本。在另一台工作台首页**导入 ZIP** 即创建**独立新方案**：陶片与接缝**重分配本地 ID** 并正确关联，连通组布局、位姿与全部闭合环结果与源方案**等价**。导入前整包校验**清单、参数、照片摘要、缺失/重复文件、越界路径及全部闭合环是否超容差**；损坏或不合法的包**整包拒绝**，不留下方案或孤儿照片。该操作不修改源方案，也不要求 `Base-Version`（它是新建操作，不与任何在线编辑冲突）；现有编辑与乐观锁约定继续有效。
- **撤销接缝即整体重算**连通组与位姿（布局从不持久化），不会沿用失效布局。
- **多人编辑乐观锁**：每个写请求须带 `Base-Version`；版本落后时返回 `409` 并在网页弹窗提示，绝不静默覆盖；页面还会每 10 秒轮询版本并提示他人更新。

## 运行方式

### 方式一：Docker Compose（推荐）

```bash
docker compose up --build -d
```

容器启动时即安装依赖、打开/创建 SQLite 并执行首次建表（`CREATE TABLE IF NOT EXISTS`），无需手工初始化。

浏览器访问：

```
http://localhost:8080
```

停止：

```bash
docker compose down          # 保留数据（命名卷 sherd-data）
docker compose down -v       # 同时删除数据库与上传图片
```

### 方式二：本机 Node.js

要求 Node.js ≥ 20。

```bash
npm install
npm start
```

默认访问 http://localhost:8080 ，数据库与图片位于 `./data/`（首次启动自动创建并建表）。

### 冒烟测试

```bash
npm test        # 即 node test/smoke.js
```

覆盖：建表就绪 → 建方案/上传/比例尺 → 接缝拼组与位姿传播 → 撤销断组重算 → 成环残差为 0 采纳 → 成环超差 422 拒绝且布局不变 → 过期版本 409 / 缺版本 428 → 接缝修订预览（只读、不改版本/接缝、给出超差冲突链）→ 修订确认 422 原子拒绝 / 容差内成功（ID 与排序不变、版本 +1、读取布局与预览一致）/ 409 / 428 / 400 / 404 → 修订成环接缝与仅改说明 → **批量试拼**：只读试算（既有接缝优先、候选按序为生成树/成环、位姿/残差/候选序号+冲突链、不改版本）→ 前置校验 400（同片/参数非法/陶片不属于方案/空批）→ 超差批 422 整批回滚 → 指纹不符 400 / 缺版本 428 / 版本变化 409 要求重试算 → 成功依序采纳且版本只 +1、读取布局与试算一致 → 批内桥接两个连通组并成环 → **方案移交包**：导出 ZIP（清单/参数/照片+SHA-256/按采纳序接缝/全部闭合环摘要、同一版本快照）→ 导入为独立方案（重分配本地 ID、接缝与照片正确关联、布局与闭合环等价、照片字节一致、可重复导入）→ 损坏包/非 ZIP/清单各类非法/缺照片/重复条目/越界路径/摘要不符/非图片伪装/意外文件全部 400 整包拒绝 → 闭合环超差 422 带 ord 冲突链 → 任何拒绝不留下方案或孤儿照片 → 空方案包导入 / 404 / 缺 package 字段 400。

## 使用说明

1. 首页**新建方案**，设定“闭合环毫米容差”（默认 2 mm，可随时在方案设置中修改）。
2. 进入方案，左侧**上传陶片照片**（图片在浏览器端自动压缩到最长边 2000px）。
3. 选中陶片 → **标记比例尺**：在照片上拖出一段对应已知长度的线段并填写毫米数（如 10 mm）。未标比例尺的陶片以占位尺寸单独显示，且不能参与接缝。
4. 点左侧 **新建接缝**：选择 A 片（参考、固定）与 B 片（移动对齐），在对齐窗口中
   拖动 B、用滚轮/输入框旋转 B，使断口吻合，并填写接缝说明；采纳即记录
   `p_B = R(θ)·p_A + (tx, ty)`（局部毫米坐标映射）。
5. 画布中：
   - **实线棕色**接缝为生成树接缝，决定布局；**橙色虚线**为成环接缝，仅用于闭合校验。
   - 陶片按毫米真实尺寸、按世界位姿绘制；右下角有毫米比例尺。
   - 点击陶片，右栏显示其毫米尺寸、世界位姿与“位置依据”接缝链（根片起的 `#接缝 → …`）。
   - 点击接缝编号可查看 θ/平移/说明、闭合残差并**撤销**。
6. 当新接缝形成环且闭合偏差超过容差时，会弹出拒绝框：显示偏差毫米数、角度差、
   冲突链（途经陶片与接缝及其说明），布局不发生任何变化。
7. 撤销任意接缝后，连通组立即重新划分、位姿由剩余接缝重新推导；原先连成一片的
   陶片可能分裂为多组或变为未连通片。
8. **修订已采纳接缝**：在右栏“接缝”列表中点击某条接缝旁的 **修订**，修改旋转角 /
   毫米平移 / 说明（接缝 `#id` 与两端陶片固定、采纳排序不变）。弹窗会在停笔约 0.25 秒后
   **自动预览**（也可点“立即预览”）：
   - 画布按**原接缝身份与排序**重绘全部陶片位姿（被修订接缝两端用蓝框、`#id ✎` 标出）；
   - 下方列出**每个闭合环残差**；超差接缝以红色标出并给出**冲突链**（生成树上的陶片/接缝路径 + 闭合接缝）；
   - 预览始终为只读，**不会改动方案**；任一闭合环超差时“确认修订”禁用。
   - 点“确认修订”时服务器基于当前方案版本**重新原子校验全部闭合环**：全部在容差内才写入，
     接缝 ID 与排序不变、版本只 +1，随后画布与预览完全一致；若期间他人已改方案则按
     `Base-Version` 约定返回 409（不会套用旧预览）；若重算仍超差则 422 且原接缝、版本、布局均不变。
9. **批量试拼候选接缝**：点左侧 **批量试拼**，在弹窗中按顺序逐条添加候选接缝
   （两端陶片 A→B、θ/tx/ty、说明，可任意增删行）。点 **试算整批**（停笔也会自动试算）：
   - 画布按“**既有接缝优先、候选按填写顺序加入**”重绘：候选生成树接缝为**蓝色实线**、
     候选成环接缝为**绿色虚线**（标签为“候1、候2…”），候选涉及的陶片加蓝框；既有接缝配色不变；
   - 下方给出每条候选的角色（**生成树接缝 / 成环接缝**）与**每个闭合环残差**；
     超差时以红色标出并逐条给出**候选序号、偏差毫米数、角度差与冲突链**（树上的陶片/接缝路径 + 闭合候选）；
   - 试算始终只读，**不改动接缝与版本**；任一闭合环超差时“确认采纳整批”禁用。
   - 点 **确认采纳整批** 时，浏览器回传**同一批内容指纹**与**试算所基于的版本号**，
     服务器在**单事务**内重新读取并复核全部闭合环：通过才按填写顺序逐条采纳、
     **版本只增加一次**，随后画布与试算完全一致；若期间他人已改方案则返回 409，
     弹窗关闭并提示**重新试算**；重算仍超差则 422、整批不生效，弹窗会基于服务器当前状态重新试算。
10. **移交方案到另一台工作台**：在方案工作台左下点 **📥 下载方案包（移交另一台工作台）**，
    得到自包含 ZIP（见下节“方案包结构”）。在另一台工作台首页点 **📦 导入方案包（.zip）**，
    选择该 ZIP（可填写新方案名，留空则沿用包内名称）：
    - 导入会创建一个**独立的新方案**（版本从 v1 开始），陶片/接缝重新分配本地 ID，
      接缝按包内采纳顺序关联；画布上的连通组、陶片位姿与闭合环残差与源方案等价；
    - 服务器先整包校验再落库：清单/checklist、方案参数（名称、毫米容差）、
      陶片比例尺与照片 SHA-256 摘要、缺失/重复文件、越界路径（`..`/绝对路径/反斜杠）、
      以及**全部闭合环**是否超过包内容差，任一不过都会**整包拒绝**；
    - 网页会逐条列出问题（400 给清单问题、422 给超差闭合环及冲突链）；
      失败时服务器上**不会创建方案，也不会留下任何照片文件**。

## 可配置项

均通过环境变量配置（见 `docker-compose.yml` 的 `environment`）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | HTTP 监听端口（容器内）。改宿主机访问端口请改 compose 的 `ports` 左侧，如 `"9090:8080"` |
| `DATA_DIR` | `./data`（本机）/ `/data`（容器） | 数据目录，存放 SQLite 与上传图片 |
| `DB_FILE` | `$DATA_DIR/workbench.db` | SQLite 数据库文件路径 |
| `UPLOAD_DIR` | `$DATA_DIR/uploads` | 陶片图片保存目录 |
| `MAX_UPLOAD_MB` | `20` | 单张照片上传大小上限（MB） |
| `MAX_PACKAGE_MB` | `200` | 导入方案包 ZIP 大小上限（MB，整体在内存中校验） |

方案级的**毫米容差**在网页“方案设置”中按方案独立配置，不是环境变量。

## 网页访问端口

- 默认：**http://localhost:8080**
- Docker 下在 `docker-compose.yml` 修改端口映射；本机运行用 `PORT=9090 npm start`。

## 方案移交包 HTTP API（可调用）：导出 / 导入 ZIP

把整个方案以**自包含 ZIP**下载、在另一台工作台导入为**独立新方案**。
两个接口都不需要 `Base-Version`：导出是只读操作；导入是**新建**操作、不修改任何既有方案，
因此不与在线编辑冲突。既有编辑与 `Base-Version` 乐观锁约定对原方案继续有效。

### 方案包结构（ZIP）

```
manifest.json            清单（UTF-8 JSON，见下）
photos/sherd-1.jpg       陶片照片（序号与 sherds[].ord 对应；jpg/jpeg/png/webp）
photos/sherd-2.png
…
```

`manifest.json`：

```json
{
  "kind": "sherd-stitch-workbench.package",
  "format_version": 1,
  "exported_at": "2026-09-30T12:00:00.000Z",
  "checklist": ["manifest", "project", "sherds", "seams"],
  "project": { "name": "灰陶罐H3", "tolerance_mm": 2, "source_version": 9 },
  "sherds": [
    { "ord": 1, "label": "A", "photo": "photos/sherd-1.jpg",
      "img_w": 1200, "img_h": 900, "scale_px": 152.4, "scale_mm": 10,
      "note": "", "sha256": "<64 位十六进制>", "size_bytes": 183422 }
  ],
  "seams": [
    { "ord": 1, "from_ord": 1, "to_ord": 2,
      "theta_deg": 0, "tx": -10, "ty": 0, "join_note": "口沿 A-B" }
  ],
  "cycle_check": {
    "tolerance_mm": 2,
    "checked_at": "2026-09-30T12:00:00.000Z",
    "rings": [
      { "seam_ord": 3, "from_ord": 1, "to_ord": 3,
        "distance_mm": 0, "rotation_deg": 0, "within_tolerance": true }
    ]
  }
}
```

- 陶片与接缝均用 `ord`（从 1 起、连续）标识，**与源库自增 ID 无关**；接缝端点用
  `from_ord` / `to_ord` 引用陶片，接缝数组的顺序即**采纳顺序**（决定 Kruskal 生成树）。
- 未标比例尺的陶片 `scale_px` / `scale_mm` 为 `null`，且不得作为接缝端点。
- `sherds[].sha256` / `size_bytes` 是照片字节的校验摘要；`cycle_check.rings`
  按采纳顺序列出导出时**全部成环接缝**的闭合残差，`within_tolerance` 与容差自洽。

### 导出（GET，二进制 ZIP）

```
GET /api/projects/{id}/export
```

- `200`：`Content-Type: application/zip`，`Content-Disposition: attachment`；
  包内全部数据来自**同一个版本快照**（项目/陶片/接缝/现算布局/照片字节在同一只读事务内读取）。
- `404`：方案不存在；`422`（`export_photo_missing`）：某陶片照片文件在服务器磁盘上缺失，无法自包含导出。

### 导入（POST，multipart/form-data）

```
POST /api/imports
Content-Type: multipart/form-data

package=@方案包.zip        # 必填，字段名固定 package
name=现场复核副本          # 可选，覆盖新方案名称（默认沿用包内 project.name）
```

- `201`：成功。创建**独立新方案**，响应即 `GET /api/projects/{newId}` 标准负载，另附
  `imported: true` 与 `source: { name, format_version, source_version, sherd_count, seam_count }`。
  新方案陶片按 `ord` 升序取得连续本地 ID，接缝按 `ord` 升序（采纳顺序）依序取得连续本地 ID，
  布局与全部闭合环结果与源方案等价。
- `400`（`error.reason = "package_invalid"`）：包损坏或不合法，**整包拒绝**。
  `error.issues[]` 逐条给出 `code` / `message` / `where`，覆盖：
  ZIP 无法解压（`zip_unreadable`，含重复条目、CRC 不符、ZIP64/加密包等）、
  清单缺失或非 JSON、`kind`/`format_version`/`checklist` 不符、
  方案名称或毫米容差非法（`tolerance_invalid`）、
  陶片/接缝序号重复或不连续、接缝端点不存在/连接同片/未标比例尺、参数越界、
  **照片缺失（`photo_missing`）、摘要不符（`photo_digest_mismatch`）、非图片伪装、扩展名与真实格式不符**、
  **越界路径（`path_outside_package`）、清单之外的意外文件（`unexpected_file`）**、
  闭合环摘要容差不一致等。
- `422`（`error.reason = "import_cycle_tolerance_exceeded"`）：服务器按包内采纳顺序现算，
  发现**任一闭合环残差超过包内容差**，**整包拒绝**；`error.violations[]` 给出超差接缝的
  `seam_ord` / `from_ord` / `to_ord`、`deviation_mm`、`rotation_deg` 与 `conflict_chain`
  （陶片/接缝均以 ord 标识）。
- `400`：缺少 `package` 字段，或包体超过 `MAX_PACKAGE_MB`（默认 200MB）。
- 以上任何失败都**不会创建方案、不会写入任何照片文件**（先整包校验通过，再在单事务内落库）。

### curl 示例

```bash
# 1) 从工作台 A 导出方案 1 的自包含 ZIP
curl -sS -o h3-sherd-package.zip http://localhost:8080/api/projects/1/export

# 2) 在工作台 B 导入为独立新方案（可选 -F name=... 重命名）
curl -sS -X POST http://other-workbench:8080/api/imports \
  -F 'package=@h3-sherd-package.zip;type=application/zip' \
  -F 'name=灰陶罐H3-二号坑副本'

# 不合法 / 超容差时分别为 400 package_invalid（issues[] 逐条）/ 422（violations[]），
# 整包拒绝，不留下方案或孤儿照片。
```

网页入口：方案工作台左下 **📥 下载方案包**；首页 **📦 导入方案包（.zip）**。

## 批量试拼 HTTP API（可调用）

把**一批**候选接缝（按填写顺序）先试算、后确认。试算只读；确认必须回传**同一批内容指纹**
（`batch_fingerprint`）与**试算所基于的方案版本**（`base_version` 与 `Base-Version` 头）。
每条候选字段与单条接缝一致：`from_id` / `to_id`（不同两片、均属本方案且已标比例尺）、
`theta_deg`（-360~360）、`tx` / `ty`（毫米，-100000~100000）、`join_note`（≤2000 字，可选）；
一批最多 100 条。

### 第一步：试算（只读，不需要 `Base-Version`，不改动方案/版本）

```
POST /api/projects/{id}/seams/batch-preview
Content-Type: application/json

{
  "candidates": [
    { "from_id": 2, "to_id": 3, "theta_deg": 0, "tx": -10, "ty": 0, "join_note": "候选 2-3" },
    { "from_id": 3, "to_id": 4, "theta_deg": 0, "tx": -10, "ty": 0, "join_note": "候选 3-4" },
    { "from_id": 1, "to_id": 4, "theta_deg": 0, "tx": -30, "ty": 0, "join_note": "闭合复核 1-4" }
  ]
}
```

返回体与 `GET /api/projects/{id}` 同构（`project` / `sherds` / `seams` / `layout`），另附：

- `batch_trial: true`、`preview_only: true`；
- `base_version`：试算所基于的当前方案版本（确认时原样回传）；
- `batch_fingerprint`：该批内容指纹（确认时原样回传）；
- `seams[]`：既有接缝用真实 `id`；候选为**虚拟接缝**，`id` 为 `null`、
  `virtual_seam_id` 为负数（-1、-2…，按填写顺序）、`candidate_index` 从 1 起；
- `candidate_results[]`：每条候选的布局角色——`role: "tree"`（生成树接缝，决定布局）
  或 `"cycle"`（成环接缝，仅做闭合校验）；
- `layout`：整批加入后的连通组、陶片位姿与**每个闭合环**残差（`residuals`）；
- `violations[]`：超差闭合环，元素含 `candidate_index`（超差候选序号，1 起）、
  `deviation_mm`、`rotation_deg`、`tolerance_mm` 与 `conflict_chain`
  （`sherds` 陶片路径、`seams` 树路径——其中候选带 `candidate_index`、既有接缝带真实 `id`、
  `closing_seam` 闭合候选）。无超差时为空数组。
- `400`：候选非法时 `error.reason = "batch_invalid_candidates"`，
  `error.errors[]` 按候选序号逐条给出原因（陶片不属于本方案、未标比例尺、连接同一片、参数非法等），整批不予试算。

### 第二步：确认（单事务，必须带试算时的 `Base-Version`）

```
POST /api/projects/{id}/seams/batch-commit
Base-Version: 9
Content-Type: application/json

{
  "candidates": [ …与试算完全相同的一批… ],
  "base_version": 9,
  "batch_fingerprint": "<上一步返回的指纹>"
}
```

- `200`：服务器在**单事务**内基于该版本重新读取并全量重算、复核**全部闭合环**；
  通过才按填写顺序**依序插入**全部候选并把版本**只 +1**；响应即 `GET /api/projects/{id}`
  标准负载，`layout` 与试算一致（候选接缝此时已取得连续的真实 id）。
- `422`：任一闭合环残差超容差。`error.reason = "batch_cycle_tolerance_exceeded"`，
  `error.violations[]` 给出每条超差的**候选序号**与冲突链；**整批不生效**，接缝、版本、布局均不变。
- `409`：`Base-Version`/`base_version` 与当前版本不一致（试算后方案被他人修改），
  `error.reason = "batch_version_conflict"`，返回 `current_version` / `your_version`；
  **必须重新试算后再确认**，不套用旧试算结果。
- `400`：缺少/错误 `batch_fingerprint`（`batch_content_mismatch`，批内容与试算不一致），
  或候选本身非法（同上）；`428`：缺少 `Base-Version`。以上均不改变任何状态。

### curl 示例

```bash
# 1) 试算（只读，保存指纹与版本）
curl -s -X POST http://localhost:8080/api/projects/1/seams/batch-preview \
  -H 'Content-Type: application/json' \
  -d '{"candidates":[
    {"from_id":2,"to_id":3,"theta_deg":0,"tx":-10,"ty":0,"join_note":"候选 2-3"},
    {"from_id":3,"to_id":4,"theta_deg":0,"tx":-10,"ty":0,"join_note":"候选 3-4"},
    {"from_id":1,"to_id":4,"theta_deg":0,"tx":-30,"ty":0,"join_note":"闭合 1-4"}
  ]}'

# 2) 用试算返回的 base_version / batch_fingerprint，在同一批内容上确认
curl -s -X POST http://localhost:8080/api/projects/1/seams/batch-commit \
  -H 'Base-Version: 9' -H 'Content-Type: application/json' \
  -d '{"candidates":[
    {"from_id":2,"to_id":3,"theta_deg":0,"tx":-10,"ty":0,"join_note":"候选 2-3"},
    {"from_id":3,"to_id":4,"theta_deg":0,"tx":-10,"ty":0,"join_note":"候选 3-4"},
    {"from_id":1,"to_id":4,"theta_deg":0,"tx":-30,"ty":0,"join_note":"闭合 1-4"}
  ],"base_version":9,"batch_fingerprint":"<preview 返回值>"}'
```

## 接缝修订 HTTP API（可调用）

修订一条**已采纳接缝**采用“先预览、后确认”两步。接缝身份（`from_id` / `to_id`）与采纳排序（接缝 `id`）不可修改；
可改字段为 `theta_deg`（°，-360~360）、`tx`、`ty`（毫米，-100000~100000）、`join_note`（≤2000 字，可选；省略时沿用原说明）。

### 第一步：预览（只读，不需要 `Base-Version`，不改动方案）

```
POST /api/seams/{seamId}/revision-preview
Content-Type: application/json

{ "theta_deg": 0, "tx": -11, "ty": 0, "join_note": "口沿 A-B 微调" }
```

返回体与 `GET /api/projects/{id}` 同构（`project` / `sherds` / `seams` / `layout`），但其中
`seams` 是“按原 id 与排序替换该接缝参数后”的假设集合，`layout` 是相应重算结果，另附：

- `base_version`：当前方案版本（确认时应原样回传）；
- `revised_seam_id`：被修订接缝 id；
- `preview_only: true`；
- `violations[]`：**每一个**超差闭合环，元素含 `seam_id`（超差的闭合接缝）、`deviation_mm`、
  `rotation_deg`、`tolerance_mm` 与 `conflict_chain`（`sherds` 陶片路径、`seams` 生成树路径及说明、
  `closing_seam` 闭合接缝）。无超差时为空数组。

### 第二步：确认（必须带当前 `Base-Version`）

```
PATCH /api/seams/{seamId}
Base-Version: 11
Content-Type: application/json

{ "theta_deg": 0, "tx": -11, "ty": 0, "join_note": "口沿 A-B 微调" }
```

- `200`：成功。服务器在**单事务**内基于该版本重新读取并全量重算、复核全部闭合环，通过才更新该接缝并把
  版本**只 +1**；响应即 `GET /api/projects/{id}` 标准负载，`layout` 与上一步预览一致，接缝 ID/排序不变。
- `422`：任一闭合环残差超方案毫米容差。`error.reason = "revision_cycle_tolerance_exceeded"`，
  `error.violations[]` 给出每条超差接缝与冲突链；**原接缝、版本与布局均不变**（事务回滚）。
- `409`：`Base-Version` 与当前版本不一致（方案已被他人修改），返回 `current_version` / `your_version`；
  本次拒绝，**不得套用旧预览**，应重新拉取方案与预览后再确认。
- `428`：缺少 `Base-Version`；`400`：参数非法；`404`：接缝不存在。以上均不改变任何状态。

### curl 示例

```bash
# 1) 预览（只读）
curl -s -X POST http://localhost:8080/api/seams/1/revision-preview \
  -H 'Content-Type: application/json' \
  -d '{"theta_deg":0,"tx":-11,"ty":0,"join_note":"口沿 A-B 微调"}'

# 2) 基于当前版本确认（假设当前版本为 11）
curl -s -X PATCH http://localhost:8080/api/seams/1 \
  -H 'Base-Version: 11' -H 'Content-Type: application/json' \
  -d '{"theta_deg":0,"tx":-11,"ty":0,"join_note":"口沿 A-B 微调"}'
```

既有单条接缝接口与返回契约保持不变：`POST /api/projects/{id}/seams`（采纳/成环拒绝）、
`DELETE /api/seams/{id}`（撤销）、`GET /api/projects/{id}`（读取现算布局）。
本轮新增的批量接口为 `POST /api/projects/{id}/seams/batch-preview`（只读试算）与
`POST /api/projects/{id}/seams/batch-commit`（单事务确认），均不改变上述既有约定。

## 数据模型

- `projects`：方案（名称、毫米容差、乐观锁 `version`）。
- `sherds`：陶片（图片文件、图像像素宽高、比例尺 `scale_px`/`scale_mm`）。
- `seams`：有向接缝 `from_id → to_id`，`theta_deg / tx / ty`（把 from 局部毫米坐标
  映射到 to 局部毫米坐标），`join_note` 接缝说明。修订仅 UPDATE 该接缝的这四个字段，
  **不改 id / from_id / to_id**，因此采纳排序（Kruskal 次序）稳定。
- 每次写事务都会把 `projects.version + 1`；布局（连通组、位姿）**只在读取时现算**，
  不入库，因此撤销/修订后天然不会残留旧位置。接缝修订的预览也只现算、不落库。
- **方案移交包**不另建表：导出时在同一同步事务内读取项目/陶片/接缝、现算布局并读取
  照片字节，组装成 ZIP（见上文“方案移交包 HTTP API”）；导入时先在内存中整包校验，
  全部通过后才在单事务内插入新方案/陶片/接缝并落盘照片。导入是**新建独立方案**：
  陶片与接缝重新取得本地自增 ID（接缝按包内采纳序连续插入），端点经 ord → 新 ID 重映射，
  因此布局与闭合环结果与源方案等价；不沿用源方案的 `version`（新方案从 v1 起）。

## 目录结构

```
server.js              Express 入口与 REST API（含乐观锁、成环拒绝、接缝修订预览/确认、批量试拼试算/确认、方案包导出/导入、上传）
src/db.js              SQLite 打开与建表
src/geo.js             刚体变换（旋转/平移、求逆、复合、偏差度量）纯函数
src/layout.js          连通组/生成树(Kruskal 采纳序)/位姿传播/成环评估/残差/接缝修订重算(evaluateSeamRevision)/批量试算(evaluateSeamBatch)
src/zip.js             零依赖 ZIP 读写器（STORE/DEFLATE、CRC 校验，拒绝 ZIP64/加密/重复条目）
src/packageio.js       方案包构造(buildExportZip)与导入整包校验(parseImportPackage：清单/参数/照片摘要/缺失重复/越界路径)
public/                前端（原生 ES Module + Canvas，无需构建）
  index.html, css/style.css
  js/app.js            路由与首页（含导入方案包入口）
  js/workspace.js      工作台三栏、画布绘制与交互、轮询、下载方案包
  js/package-transfer.js 方案包导入弹窗（issues/超差冲突链展示）
  js/modals.js         比例尺标定弹窗、接缝对齐弹窗
  js/revise.js         接缝修订弹窗（改参 → 自动预览位姿/残差/冲突链 → 确认）
  js/batch.js          批量试拼弹窗（按序填候选 → 只读试算连通组/位姿/闭合环 → 同批同事单事务确认）
  js/geo-client.js     前端几何与卡片布局
  js/api.js, js/ui.js  fetch 封装 / toast、弹窗
test/smoke.js          端到端冒烟测试
Dockerfile, docker-compose.yml
```
