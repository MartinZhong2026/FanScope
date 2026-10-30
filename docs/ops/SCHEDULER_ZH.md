# K5 持久化调度器（运维说明）

状态：代码已实现，**默认关闭**（`FANSCOPE_SCHEDULER` 未设为 `true`）。生产启用前必须：K2 控制器已安装、`scheduled_jobs` 迁移已经审核发布、门禁文件与只读挂载已验证。

## 任务

| 任务 | 周期 | 内容 |
| --- | --- | --- |
| `ingest:english` | `SCAN_INTERVAL_MINUTES` | 复用 V1.4 增量监测与 `scan_windows` 游标，不启动历史回填 |
| `ingest:chinese` | 24 小时 | 仅处理登记状态为 A/B **且** 已有 verified 来源的期刊；复用暂停任务的游标。当前 22 本中 0 本符合，任务空跑并记录 `no_verified_sources` |
| `lifecycle:dx-purge` | 1 小时 | 诊断原稿与报告到期物理清理 |

开启后替代 v14 的英文监测定时器和诊断清理定时器，不叠加。

## 规则

- `scheduled_jobs` 持久保存到期时间与租约。重启不重置到期时间；逾期任务只补跑一次；旧执行者失去租约后不能写入。
- 失败按 `周期 × 2^连续失败次数` 退避，上限 24 小时；全局最多 2 个任务并行。
- 门禁文件（`FANSCOPE_RELEASE_GATE_FILE`）不是 `open` 时，调度器不做任何数据库写入，包括认领、续租和状态更新。文件缺失、损坏或未配置都按关闭处理。超过 `alert_after` 只告警，不会自动开放。

## 观察

`GET /api/ingest/freshness`（只读、无隐私内容）返回调度开关、门禁状态、各任务上次结果、英文新鲜度，以及 22 本中文期刊的逐刊状态。`automatic` 只在状态与来源核验同时满足时为 true。

`api/config/chinese-source-status.json` 由 [22 本矩阵](../architecture/CN_JOURNALS_22_MATRIX.md) 整理，变更状态必须先在矩阵留下证据。

## 已知限制

- 英文单刊扫描内部不检查门禁，只在刊与刊之间检查。发布时依赖控制器 drain 与 SIGTERM 优雅停止，再取冻结快照。
- 尚无主机侧告警定时器（`gate-status` 已提供）。
- 未覆盖交付计划 §9-A 的 60 天增长模拟与逐点崩溃矩阵；§9-B 生产 7 天观察未开始。Linux Docker 只读挂载、门禁切换、强杀重启与优雅停止由 `scheduler_rehearsal.py` 覆盖。
