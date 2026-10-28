# 中文重点期刊授权批量导入 MVP

2026-10-26；基于本地 `de4aea5`、`99162f1`，开发分支 `feat/chinese-authorized-import-mvp`。本轮没有采集外部论文、调用真实 DeepSeek、访问 GitHub、推送或部署。没有取得新的真实期刊授权，也没有增加真实论文数量。

**已实现 UTF-8 CSV → 字段映射 → 隔离暂存 → 来源许可人工审查 → 论文证据人工审核 → 分批调用现有中文引擎入库。** RIS、XML 和提供方 API 数据统一到同一字段契约，但没有真实提供方导出样本，本轮不猜测其格式、不开发独立爬虫；具体映射见[字段说明](field-mapping.md)。请优先让授权提供方按四刊 CSV 模板交付。

## 普通用户操作步骤

1. 在 VS Code 打开本项目，选择“终端 → 新建终端”，运行：

   ```powershell
   cd C:\Users\martin\Documents\FanScope-Dev
   node scripts/chinese-import-local.mjs
   ```

2. 浏览器打开 **http://127.0.0.1:4175/chinese-import.html**。复制终端显示的“本次管理员密钥”，粘贴到页面顶部并点击“连接”。每次启动生成新密钥；不写入浏览器存储。也可从 FanScope 中文来源管理或工作台中的“打开授权导入工作台”进入。
3. 在“登记数据来源许可”填写出具方、被许可方、文档位置、截止日期、有关本地保存与展示的条款摘录，并选择文档明确覆盖的期刊。选择许可文档可在浏览器本机计算 SHA-256；文档本身不上传。若许可没有包含摘要，不勾选摘要范围，也不要上传摘要列内容。
4. 点击“保存为待审查许可”。在下方审查表中核验原文档、哈希、授权主体、刊物、数据年份、许可期限及本地展示范围，填写审查人和核验说明，再记录本地使用审查通过。**这一步记录人工审查结论，不认证文档真伪，也不授予公开再分发权。** 无法确认条款或来源权利时停留在待审查状态。
5. 在“上传文件”选择相应许可及 UTF-8 CSV，填写上传人和有权上传该文件的依据。根据表头下拉框检查映射；“发表日期”不能映射到入库日期。“记录证据位置”需能定位授权交付包中的原始题录、页码、记录 ID 或目录条目。点击“写入隔离暂存区”。
6. 检查预览中的期刊、ISSN、题名、作者、日期精度、DOI、原文 URL、文件行号和论文证据。错误行不能审核通过。下载错误行 JSON，对照原始授权数据修正 CSV 后重新上传；旧批次保持原样供审计。DOI 可空，作者或记录证据缺失则先补核，不编造。
7. 选择待审核行，填写论文证据审核人及核查说明。只有确实审核覆盖全部待审核行时才勾选“本批全部待审核记录”，否则按当前页勾选记录处理。点击“审核通过，等待分批入库”。**此时仍未写入论文库。** 不符合条件的待审核行可人工排除；已有校验错误的行保留错误状态。
8. 点击“处理下一批”或“连续处理已审核记录”。每次请求最多 100 条；可在当前批完成后暂停。刷新页面或重启后重新连接、选择原批次继续。已完成行不会再次执行；同一文件原样重传会恢复同一批次；新的交付批次中的重复论文也会由既有引擎去重，并保存本次审计。
9. 下载“来源审计 JSON”核对结果。返回 FanScope，在这个 **4175 工作副本**中搜索或筛选正式入库数据；该页面使用同一个工作库。原始 349 条主库及原先 4174 预览不会自动增加记录。

如果端口已被使用，先在自己启动该服务的终端按 `Ctrl+C`，再运行命令。若存在 `api/.env`，脚本会拒绝启动；不要把生产凭据交给此工作台。需要由本地维护人员妥善保管该文件后再使用隔离环境，脚本不会移动或覆盖它。

## 四刊模板

模板固定了期刊名、ID 和 ISSN；题名、作者占位文本必须替换，日期、原文 URL 等必须填入真实授权题录。占位行本身不满足入库条件，模板不代表授权证明或真实论文样本。

| 期刊 | journal_id | ISSN | 模板 |
|---|---|---|---|
| 中国社会科学 | china-social-sciences | 1002-4921 | [CSV](../../web/import-templates/china-social-sciences.csv) |
| 社会学研究 | candidate-6 | 1002-5936 | [CSV](../../web/import-templates/candidate-6.csv) |
| 管理世界 | management-world | 1002-5502 | [CSV](../../web/import-templates/management-world.csv) |
| 公共管理学报 | candidate-14 | 1672-6162 | [CSV](../../web/import-templates/candidate-14.csv) |

## 权限与证据的三层区别

| 层次 | 保存内容 | 不代表什么 |
|---|---|---|
| 上传文件权限 | 上传人、接收/上传权限依据、上传时间、文件 SHA-256 | 不证明文件中论文元数据可被再利用或再分发 |
| 数据来源许可 | 出具方、受许可方、文档位置及哈希、条款摘录、期刊范围、截止日期、摘要范围、审查人及说明 | 勾选或哈希不证明授权文档真实有效；审查结果只记录本地用途，不授予公开再分发权 |
| 论文记录证据 | 原题、刊名/ISSN、作者、发表日期及精度、URL、原始题录定位、CSV逻辑记录号与物理起始行、记录审核说明 | 文件本身或许可文档不能替代每条论文的真实性与归属证据 |

许可状态为 `pending`（待审查）、`reviewed_local_only`（已记录仅本地使用审查）、`revoked`（已撤销）。系统逐条核对刊物范围，入库前再次检查状态和到期日；摘要需另有范围。**许可的数据年份、附加条款、出具方权利链及文档真伪仍需人工核对；MVP不是法律授权自动判定器。** 不能确认时不批准记录。撤销许可后尚未处理的行会被阻止；已入库行及历史审计不会被静默删除，应由维护人员评估后续处置。

引擎兼容字段 `authorization` 中的 `https://fanscope.invalid/local-license/…` 是本地许可登记指针，不是公开授权网址；真实材料以登记文档位置、哈希和审计记录为准。论文 `source_verification_status=human_reviewed` 表示人工核查，不冒充提供方自动验证或 CSSCI 身份审核。

## 数据保护与工作区

| 位置 | 用途 |
|---|---|
| `work/chinese-bulk/fanscope-chinese.sqlite` | 原始349条主库，本轮只读，未变化 |
| `work/chinese-bulk/final/fanscope-chinese-backup.sqlite` | 原始独立备份，本轮只读，未变化 |
| `work/chinese-authorized-import/local.sqlite` | 首次启动从基线一致性复制的真实授权导入工作副本；以后启动复用，不覆盖 |
| `work/chinese-authorized-import/local-pre-import-backup.sqlite` | 本轮验收结束时另存的一致性工作副本备份，仍为349条 |
| `work/chinese-authorized-import/synthetic.sqlite` | 单独的合成验收库；与真实工作副本隔离 |
| `work/chinese-authorized-import/fixtures/` | 明确标识的百条、千条及错误样本合成 CSV |

新接口默认关闭，只允许开发模式且数据库位于 `work/chinese-authorized-import/`。正式运行模式拒绝使用。启动器只绑定本机回环地址，不读取 `api/.env`，清空付费服务密钥，关闭外部请求，不启动采集、邮件或AI后台任务。原有 `work/local-preview.mjs`、`.vscode/` 及 349 条预览没有改写。

暂存表、许可表、审核和审计表位于隔离工作库，正式论文表仍复用原有 `articles`。暂存或批准审核不会写入论文表。真正入库调用 `importChinese`，复用 DOI、期刊内标准化题名/作者/卷期/日期组合去重、URL 冲突判断与来源追溯，不维护另一套论文数据库。每条论文的提交与暂存行回执、审计事件处于同一事务；失败回滚当条，已完成行保留。

合成模式必须由 `--synthetic` 启动，文件中必须有“合成测试”题名和 `.invalid` 保留域名，入库标记为 `demo=1`；真实模式拒绝这些测试文件。合成模式发现非 demo 论文也拒绝执行。合成记录不计入真实论文统计、研究趋势或真实覆盖率。该检查可防止误操作，不是判断所有虚构论文的自动检测器。

备份新的工作副本前，先 `Ctrl+C` 正常停止服务，再复制整个 `work/chinese-authorized-import/` 目录；不要在运行时只拷贝一个 SQLite 主文件而忽略 WAL。原始基线和备份始终保留，可供恢复对照。

## 本轮验收

- 全量后端测试 **160/160**；新增定向测试覆盖格式/字段校验、暂存不入库、许可审查门槛、100与1000条规模、37条中断及新进程恢复、重复交付、错误行、跨刊范围、撤销许可、引擎冲突、事务故障回滚和管理员保护。
- 桌面1440px：100条合成记录导入成功；独立交付批次再次导入，新增0、重复100、审计回执100。
- 390px：1000条合成记录导入成功；100条后刷新并重新连接原批次继续；再次导入新增0、重复1000、审计回执1000。
- 两种浏览器尺寸均无整页横向溢出、无页面异常、无外部请求；错误报告下载成功。合成库真实论文查询均为0。
- 原始主库和备份各349条，完整性`ok`且哈希与保存基线相同；真实工作副本也为349条，没有新真实入库记录。

证据：[浏览器结果](browser/results.json)、[后端测试输出](api-tests.txt)、[保存状态](preservation.json)、[桌面暂存](browser/1440-staging.png)、[桌面完成](browser/1440-completed.png)、[390px暂存](browser/390-staging.png)、[390px完成](browser/390-completed.png)。这些截图和数量全部是合成验收，不是四刊真实收录成果。

复验命令：

```powershell
# 全量测试；补充本机已有解压/PDF工具路径，不安装新依赖
$env:PATH = 'C:\Program Files\Git\usr\bin;C:\Program Files\Git\mingw64\bin;' + $env:PATH
cd C:\Users\martin\Documents\FanScope-Dev\api
npm.cmd test

# 合成文件与独立验收服务；不要把合成文件导入真实工作副本
cd C:\Users\martin\Documents\FanScope-Dev
node scripts/chinese-import-fixtures.mjs
node scripts/chinese-import-local.mjs --synthetic
# 浏览器打开 http://127.0.0.1:4176/chinese-import.html
```

自动浏览器复验另开终端，将合成服务显示的当次密钥放入临时环境变量（不要提交密钥）：

```powershell
$env:PYTHONPATH = 'C:\Users\martin\Documents\FanScope-Dev\work\python-playwright'
$env:FANSCOPE_IMPORT_TEST_KEY = '复制本次合成服务密钥'
python scripts/chinese-import-browser-acceptance.py
```

## 已知边界

直接 RIS/XML/API 提供方适配暂未实现；提供方应优先按模板交付CSV，或在取得样本后验证转换。每文件5000条/8MB，超限按刊物或年份拆分；预览每页100条，错误报告可完整下载。CSV修正通过新批次保留历史，不直接编辑已批准行。没有自动发布、公开再分发、自动购买授权或 AI 分析入口；将来扩大用途需要另行确认许可和实现相应审核。
