# v1.2 人工升级、配置与回滚

这些是人工审核Draft PR之后的操作说明，不是已执行的生产动作。继续使用 `fanscope.pages.dev`、`fanscope-api.adapttochina.com`、现有Nginx和 `fanscope_data` named volume。**不使用 `docker compose down -v`，不初始化/清空生产数据库，不重新创建现有账号。**

## 先验证代码与备份

```bash
cd api
npm ci --ignore-scripts
npm test
cd ..
node scripts/check-sensitive.mjs
docker compose -f deploy/docker-compose.yml build fanscope-api
```

在可写的私有备份目录留足空间。维护窗口暂停业务写入，先用旧容器的Node22执行新提供的独立备份脚本；该脚本不导入应用，也不触发迁移：

```bash
docker cp api/src/backup.mjs fanscope-api:/tmp/fanscope-backup.mjs
docker exec fanscope-api node --experimental-sqlite /tmp/fanscope-backup.mjs /app/data/fanscope.sqlite /app/data/fanscope.pre-v1.2.sqlite
docker cp fanscope-api:/app/data/fanscope.pre-v1.2.sqlite ./PRIVATE_BACKUP/fanscope.pre-v1.2.sqlite
```

先自行创建 `PRIVATE_BACKUP` 并限制读取权限，且**不要放入Git目录或公开静态目录**。脚本用SQLite `VACUUM INTO` 生成WAL一致性快照，检查 `integrity_check`，文件存在则拒绝覆盖。不要简单复制正在写入的 `.sqlite`。同时私下备份 `lab-documents`（原始文档）、服务器 `.env`，记录旧镜像ID和Git SHA；这些都不能上传到GitHub。

在隔离卷上恢复这份快照，运行新镜像一次，再运行一次，核对文章、账号、论文、项目数量及会话；检查 `schema_migrations`、`lab_private_manuscript_archive`、`PRAGMA integrity_check`。旧密码hash不应改变。启动前迁移还会在数据卷生成一次 `*.pre-v1.2-*.sqlite` 自动快照，但它不替代离机备份。需要双份快照的磁盘空间，备份失败应停止启动排查。

## 后端环境与费用边界

只在服务器 `api/.env` 保存密钥，不加入静态JS。沿用原有账号/管理员密钥。核对：

| 配置 | 默认与用途 |
| --- | --- |
| `ALLOWED_ORIGINS` | 必须含 `https://fanscope.pages.dev`；预览域名需明确另加 |
| `PUBLIC_FRONTEND_URL` / `PUBLIC_API_URL` | 保留当前生产HTTPS域名 |
| `CROSSREF_CONTACT_EMAIL` | 配置真实维护邮箱以遵守Polite Pool |
| `MAX_CROSSREF_PAGES=4` | 每期刊软调度预算，完成当前固定窗口后才暂停；单窗最多10000项，过密窗口自动细分；不再因第4页未完直接报错 |
| `INITIAL_LOOKBACK_DAYS=14` | 仅首次回看；补录可用CLI `npm run scan -- --backfill --days=90`。运行单实例，勿与线上调度并发运行第二个CLI扫描 |
| `MAX_AI_PER_SCAN=2` / `MAX_AI_DAILY=20` | 名称保留兼容，摘要队列每15分钟独立执行、并发1；每批至多5、默认2；失败也占每日尝试预算；最多5次重试 |
| `DEEPSEEK_MODEL` | 沿用已有模型配置，部署前确认当前账号可用；不擅自替换付费模型 |
| `MAX_DOCUMENT_AI_DAILY=10` | 文档分析每日尝试上限，并发至多2；每次最多85000字符输入、4500输出Token；原文可含敏感数据，上传前应确认授权 |
| Research Brief | 覆盖至少50%且有证据记录至少30条后，管理员显式生成；每日最多3次、每次1200输出Token、缓存24小时；不能推导总体同比或投稿成功率 |
| `OPENALEX_ENABLED=false` | 默认关闭。核对当期官方文档、套餐、Key与许可后再开启；`OPENALEX_API_KEY`只在后端，`OPENALEX_MAX_DAILY=10`；每次默认2篇，最多5篇，缓存7天，间隔至少1秒 |
| `RESEND_API_KEY` / `EMAIL_FROM` | 无配置保持“邮件服务待配置”；配置后再做真实送达外部验收 |

摘要单次最大1800输出Token，输入摘要截取7000字符。预算按UTC日期计数，费用按实际供应商单价计算；调用数与输出上限不等于货币限额。无密钥时不会付费调用。不要一次性提交1590篇全量AI任务。

## 人工发布与检查

确认隔离迁移通过后，才由人员运行：

```bash
docker compose -f deploy/docker-compose.yml up -d --no-deps fanscope-api
curl --fail https://fanscope-api.adapttochina.com/api/health
curl -i -X OPTIONS -H 'Origin: https://fanscope.pages.dev' -H 'Access-Control-Request-Method: POST' https://fanscope-api.adapttochina.com/api/lab/login
curl --fail https://fanscope-api.adapttochina.com/api/system-status
```

然后人工发布 `web/` 到现有Cloudflare Pages，继续使用当前 `web/config.js`。Nginx和Docker仍只将API绑定宿主机127.0.0.1:8787；内存限制仍为420MB。检查旧账号登录、密码修改/登出、普通成员/管理员边界，以及1440/1024/390页面。

Crossref每期刊状态在 `scan_windows` 持久化。`paused` 是已完成一部分窗口、待下一轮续跑；`failed` 保留失败窗口。只有所有目标窗口完成才记录本轮 `last_success`。停止/重启后继续，游标不可用则重放同窗。DOI去重防重复插入，历史补录不会加入新文通知。低密度日窗和极高密度窗可有不同扫描耗时，不能把候选期刊数当成覆盖量。

管理员可从健康页续跑，或使用现有管理员密钥调用异步接口（密钥不持久保存在浏览器）：

```bash
curl --fail -X POST -H "X-Admin-Key: $ADMIN_KEY" -H 'Content-Type: application/json' -d '{"journalId":"jmir"}' https://fanscope-api.adapttochina.com/api/admin/scan
```

返回202只表示排队；随后刷新system-status核对窗口完成，不能把202视为全量同步成功。再核验SSM；实查最新发表、全部历史、未知日期、DOI/出版社文章页及邮件静默行为。

## 期刊和排名人工维护

新增候选默认禁用。合法RSS或Crossref来源需先核验刊名、ISSN、官方网址及实际同步结果；不运行CNKI爬虫。当前中文稳定RSS尚未接入，管理员仍可使用 `/api/admin/import` 添加审核过的公开文章元数据。中文来源和英文Q1分别维护，不把出版社官网首页作为文章页。

`POST /api/admin/journal-review` 接受 `id,rank_system,rank_year,rank_category,rank_evidence_url,manual_confirmation:true`。中文仅接受 `CSSCI_source`/`CSSCI_extended` 与南京大学官方证据；英文仅接受 `JCR_Q1` 与Clarivate官方证据。**操作人员必须实际看过官方目录/授权JCR年度类别**，接口不代替付费目录核验、不自动验证链接可访问。审核只更新排名，不启用新监测源。数据源接入/启用仍需独立审核和部署配置，不能仅凭候选排名开启。

`POST /api/admin/enrich-openalex` 显式触发有界补全；`POST /api/admin/analyze` 可用 `limit,journal,topic` 有界补分析；`POST /api/admin/research-brief` 用 `market,journal,topic,period` 生成有证据的简报。均要求 `X-Admin-Key`。文章页提供校园网提示，FanScope不代理或绕过订阅全文。

## Lab 人工验收

1. 普通成员可查看全部项目公开进度及共享论文表；只能修改自己/被关联为共同作者的论文。项目编辑要求导师/组管或项目管理员；普通项目成员没有编辑权。
2. 里程碑按完成权重/总权重计算，无里程碑不显示百分比；探索性模板只显示阶段。任务阻碍独立登记，AI总结不会直接变成阻碍或猜百分比。
3. Excel只上传到登录后的管理员预览接口；逐行确认阶段和实际账户后提交。FAN/Fan/杨帆等不会自动映射；accepted与published严格分开。规范标题重复跳过，近似冲突需要人工处理。不导入项目/经费/专报工作表。
4. DOCX/PDF/粘贴保存为独立原始记录，上传者及导师才能下载；即使看得到项目公开进度，其他成员也不获得原始访谈文件。新上传不覆盖旧文件。同一文档可生成多个现有项目/任务/成员建议，全部pending；只有有权人员逐条审批才写入，并保留原文证据与审计。
5. 旧论文私人备注和旧私人下一步仅保留在内部归档，不再通过API输出、更新、审查建议或显示时间线。个人非论文近况仍限本人及导师。

## 回滚（仅人员操作）

维护窗口停止所有API/CLI连接，保留升级后数据库和原始文档副本，记录迁移后的变更，不能直接在新数据库上运行破坏性逆迁移。使用原镜像及升级前一致性快照恢复到**另一个隔离卷**先验证，再由人员切换应用到该恢复卷；不要删除原 `fanscope_data`。确认owner/权限及健康、旧账号和计数后再恢复业务。

如果必须恢复原路径，先停所有连接，将当前 `.sqlite`/`-wal`/`-shm` 成套移动至隔离归档目录，然后从验证过的快照恢复主文件，不能让旧WAL作用于恢复后的数据库。该路径会舍弃上线后的业务更新，需要先人工导出或重放，不能默默丢失。**不要执行清库、重置volume或force push。**

## 本地浏览器复现

安装Python Playwright并准备Chromium（或用 `BROWSER_EXECUTABLE` 指定已安装浏览器），Node22+和 `api/npm ci`：

```bash
python scripts/browser-acceptance.py
```

仅绑定本地4173/8787；先确认端口空闲。脚本创建独立临时数据库，写合成验收记录，拦截所有外部模型请求，结束时删除临时数据库并停止自己启动的服务。截图及日志在忽略的 `work/browser-acceptance/`。不要将其改成生产数据库路径，也不要把真实Excel用于公开截图。
