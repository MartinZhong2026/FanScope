# K3 版本化追加式数据库迁移（运维与开发说明）

状态：K3 基础设施。`api/migrations/` 当前**没有任何 `.sql` 迁移**；本 PR 不引入业务表、不改 `articles`、不改首页统计。
**合并 K3 不等于可以发布带迁移的版本**：首个带迁移的后端发布须等待 K2 控制器、生产备份与 R1 审批。

## 1. 三条路径严格分离

| 路径 | 入口 | 是否写库 |
| --- | --- | --- |
| 应用在已有数据库上启动 | `db.mjs` 末尾 `verifyMigrationsAtStartup()` | **只读**。有待执行迁移 → `MIGRATIONS_PENDING` 拒绝启动；已应用文件被修改 → `MIGRATION_CHECKSUM_MISMATCH` 拒绝启动；数据库含本版本不认识的已应用迁移（代码回滚）→ 记录 `migrations.database_ahead` 警告后继续 |
| 预检 | `migrate-cli.mjs lint` / `status` / `apply --dry-run` | `lint` 不开库；`status` 只读打开；`--dry-run` 在事务内完整执行与校验后 ROLLBACK |
| 实际迁移 | `migrate-cli.mjs apply --expect …` | 是。仅执行与 `--expect` 完全一致的已审核清单 |

| 进程自己新建的空数据库 | `initializeFreshDatabase()` | 是。启动前文件不存在或为 0 字节、尚无任何数据时，直接建到完整的当前 schema（与 K3 之前“新库一次建全”的行为一致），记入账本。测试、CI 夹具、Docker 演练和首次开发启动依赖这一点；生产控制器只在已有数据库上发布，且拒绝重建缺失的生产库 |

对**已有数据库**，启动**从不**执行迁移。这样现有发布控制器（`deploy_backend.py`，`migrationPolicy:'no-change'` + 冻结副本启动指纹比对）保持原样有效：
- 迁移目录为空时，K3 启动零写入，现有控制器照常发布（CI Docker 演练已验证）。
- 镜像一旦包含待执行迁移，候选启动在冻结副本上直接失败，现有控制器回滚，冻结副本指纹不变（本地已用真实 `rehearsal()` 验证）。不存在“新镜像启动时悄悄改结构”的路径。

## 2. 迁移文件规则

- 文件名：`<YYYYMMDDTHHMMSSZ>_<lower_snake>.sql`，UTC；时间戳必须是合法时刻且唯一；目录内除 `README.md` 外出现任何其他文件即报错。
- 校验和：SHA-256，计算前去除 BOM、CRLF 统一为 LF（`.gitattributes` 也强制 `*.sql eol=lf`）。
- 已在任何环境应用过的文件**禁止修改**，改动请新增迁移。未应用过的文件可以修正。
- 新迁移的时间戳不得早于数据库中最后一个已应用迁移（`MIGRATION_OUT_OF_ORDER`）；并行分支合并时请重命名为新时间戳。

## 3. 兼容性保证（两层）

**静态审查**（分词器处理注释、字符串与引号标识符，不是简单关键词匹配）只允许：

- `CREATE TABLE name (...)`（禁止 `IF NOT EXISTS`、`TEMP`、`AS SELECT`）
- `CREATE INDEX`；`CREATE UNIQUE INDEX` 只能建在同一迁移新建的表上
- `CREATE VIRTUAL TABLE name USING fts5(...)`（Node 22 / SQLite 3.53.4 已验证可用，含 trigram）
- `ALTER TABLE t ADD [COLUMN] ...`，但 `t` 不得在 `POSITIONAL_INSERT_TABLES` 中
- `INSERT INTO <本迁移新建的表>(列…) ...`

其余全部拒绝：DROP、RENAME、DROP COLUMN、UPDATE、DELETE、REPLACE、触发器、视图、PRAGMA、VACUUM、ATTACH、ANALYZE、事务控制、`WITH`、带 schema 前缀的名称等。**不提供文件内“批准”开关**：作者自己在同一 PR 里批准自己的破坏性变更不构成有效控制；确需非追加变更时，应另行设计 expand/contract 方案并单独评审。

**效果校验**（真正的保证）：在同一 `BEGIN IMMEDIATE` 事务内，执行前后比较：
- 所有既有对象仍存在；索引/视图/触发器定义不变；既有表的原有列定义（名称、类型、NOT NULL、默认值、主键、顺序）不变、外键不减少；
- 既有表**原有列**的全部行内容摘要不变（新增列不计入），`sqlite_sequence` 既有行不变；
- 新增对象只能是已声明的表/索引（及 fts5 影子表、新表自动索引）；未声明的列/表/索引、触发器/视图、既有表上的 UNIQUE 索引、新外键违规均拒绝。
任何违规 → `MIGRATION_NOT_ADDITIVE`，整条迁移回滚。

**为什么 `POSITIONAL_INSERT_TABLES` 必要**：`meta`、`schema_migrations`、`lab_*`、`cn_import_*`、`provider_cache`、`article_metadata_checks` 等表在现有代码中以无列名的 `INSERT … VALUES/SELECT` 写入。对它们 `ADD COLUMN` 会让**当前和旧版本代码**的写入立即因列数不符失败，所以“追加列”对这些表并不兼容，被静态与效果两层同时拒绝。测试会扫描 `api/src`，发现新的位置式写入表未登记即失败；名单只增不减（旧镜像仍在用）。

## 4. 原子性与故障

- 每个迁移独立一个 `BEGIN IMMEDIATE` 事务，迁移 SQL 与账本记录同事务提交；首次应用时账本表 `fanscope_migrations` 也在该事务内创建。失败、校验不过、进程被杀（已测试 SIGKILL 于 COMMIT 前）都不会留下“已记录但未生效”或半张表。
- 多个迁移时，前面已提交的保持已提交（错误详情 `committed` 列出），重跑只执行剩余部分。K2 发布失败时仍以冻结快照整体恢复。
- 锁竞争：`busy_timeout`（默认 5000ms，可 `--busy-timeout-ms`）后报 `MIGRATION_LOCKED`，本步不写入。两个执行器并发时，在写锁内重读账本，保证只执行一次。
- WAL：迁移不改 journal mode、不 checkpoint；并发读者保持一致快照（已测试）。
- 不自动备份、不删除或修复异常账本行、不改写 legacy `schema_migrations`。

## 5. 与原有 `db.mjs` 启动机制的关系

- `db.mjs` 原有的 import 时建表/加列/一次性数据处理（v1.2–rss-url）**原样保留**，K3 未修改其行为；`lab.mjs`、`metadata-enrichment.mjs`、`openalex.mjs` 等模块的 import 时建表也未改。
- 这些既有行为在 v1.2 旧库**首次**启动时会改变 schema/数据（测试中明确记录为既有行为，非 K3 引入）；对已升级的库重启为零写入。
- K3 使用独立账本 `fanscope_migrations`，不向 legacy `schema_migrations` 加列（该表被位置式 INSERT 写入，加列会破坏旧代码）。
- `apply` 要求 legacy 基线（`1.2 … rss-url`）全部存在，否则 `LEGACY_BASELINE_MISSING`。迁移只应作用于**完整启动过一次**的数据库：若库从未完整启动，其他模块的 import 时建表尚未执行。
- 加入首个真实迁移后，以旧库夹具升级的测试（如 `migration-v12/v13`）需要在首次启动后显式 `migrate apply`，与生产流程一致；首次启动会在 `db.mjs` 处因 `MIGRATIONS_PENDING` 停止，其他模块的 import 建表要在 apply 后再次启动时完成。
- `/api/health` 增加只读字段 `migrations: {runner, applied, latest}`；“数据库领先”警告经 K1 结构化日志输出（`migrations.database_ahead`）。
- 离线中文导入模式（`FANSCOPE_OFFLINE_CHINESE_IMPORT`）沿用原逻辑跳过整个启动初始化，也跳过 K3 校验。

## 6. 命令

```bash
cd api
npm run migrate -- lint                                   # 不开库；输出 id+checksum 清单
DATABASE_PATH=... npm run migrate -- status               # 只读
DATABASE_PATH=... npm run migrate -- apply --dry-run --expect '<id>:<sha256>,...'
DATABASE_PATH=... npm run migrate -- apply --expect '<id>:<sha256>,...' --commit <sha>
```

输出为单个 JSON；退出码 0 成功、2 迁移错误（结构化 `error.code`/`details`）、1 意外错误。`apply` 必须带 `--expect`（无待执行时用 `--expect ''`）。CLI 不导入 `db.mjs`，不会创建不存在的数据库文件（`DATABASE_MISSING`）。
`FANSCOPE_MIGRATIONS_DIR` 仅用于测试，`NODE_ENV=production` 时被忽略。

错误码：`MIGRATIONS_PENDING`、`MIGRATION_CHECKSUM_MISMATCH`、`MIGRATION_UNKNOWN_APPLIED`、`MIGRATION_OUT_OF_ORDER`、`MIGRATION_PLAN_MISMATCH`、`MIGRATION_SQL_REJECTED`、`MIGRATION_NOT_ADDITIVE`、`MIGRATION_FAILED`、`MIGRATION_LOCKED`、`MIGRATION_LEDGER_INVALID`、`LEGACY_BASELINE_MISSING`、`MIGRATION_FILE_INVALID`、`MIGRATION_DUPLICATE_TIMESTAMP`、`MIGRATION_DIR_MISSING`、`DATABASE_MISSING`。

## 7. 留给 K2 的接口（待实现，K3 未改控制器）

1. 构建：对发布 commit 运行 `migrate lint`；清单为空 → 维持 `migrationPolicy:'no-change'`；非空 → `migrationPolicy:'additive'` 并把 `[{id,checksum}]` 写入 manifest。
2. 冻结副本（`--network none`）：候选镜像 `status` 的 pending 必须与 manifest 完全相同 → `apply --expect <manifest>` → Python 侧按“既有表原有列 + 白名单新增”比对（不能沿用整库指纹相等）→ 候选镜像启动相对迁移后状态零写入 → **旧镜像**在迁移后副本上启动与 health/统计校验通过。
3. 生产：维护模式、冻结备份后，容器停止状态下以同一 `--expect` 执行 `apply`，再启动候选；失败按现有流程恢复冻结快照。
4. `fanscope_migrations` 是 K2 指纹白名单需要识别的新表。

## 8. 尚未验证 / 已知限制

- 未在生产或生产副本上运行；未做真实 K2 发布与回滚（K2 未实现）。
- 效果校验对既有表做全量行摘要，执行时间随库大小线性增长，需在 R1 前用生产规模副本测时。
- 旧版兼容已验证：K3 前的 `main` 代码在迁移后的库上启动零写入、health 与统计正常（手工核验）；当前代码在“数据库领先”状态下读写正常（自动化测试）。更早的镜像未逐一验证。
