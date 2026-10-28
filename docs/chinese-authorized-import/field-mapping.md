# 统一元数据契约与四刊映射

本轮实际支持UTF-8 CSV（含BOM、CRLF、带引号逗号、转义引号及字段内换行）。RIS/XML/API列为**待真实提供方样本验证的转换约定**，不是已实现解析器。不要因扩展名相同就认定不同供应商的标签语义一致。

| 统一CSV字段 | 必填与含义 | RIS候选标签（待验证） | JATS XML候选位置（待验证） |
|---|---|---|---|
| journal_id | 可选；存在时必须与刊名和ISSN共同匹配 | 交付清单映射 | 交付清单映射 |
| journal_title | 必填，正式刊名 | JO/JF/T2，须核标签含义 | journal-meta/journal-title-group/journal-title |
| issn | 必填，校验格式及校验位，精确匹配期刊 | SN，区分ISSN与ISBN | journal-meta/issn，按pub-type核对纸本/电子号 |
| title | 必填，真实原题；不翻译、不拼接 | TI/T1 | article-meta/title-group/article-title |
| authors | 必填；多作者按来源顺序，用分号分隔 | 多个AU/A1按原顺序合并 | contrib-group/contrib，区分作者和编辑，保留姓名顺序 |
| publication_date | 必填，发表日期；YYYY-MM-DD、YYYY-MM或YYYY | PY/Y1/DA需核语义及精度 | pub-date，依据pub-type/date-type核出版语义，不能用history接收日期 |
| doi | 可空；接受DOI或doi.org形式，统一规范化 | DO | article-id[@pub-id-type='doi'] |
| url | 必填，真实论文HTTPS原始落地链接，不是期刊首页 | UR/LK需验证目标类型 | self-uri或提供方永久链接；不能盲取PDF链接 |
| record_evidence | 必填，授权原始题录/交付包/页码/记录ID定位 | 交付清单或明确N1字段，不能任意认定全部注释为证据 | 文件路径+article-id或清单行号；原始节点位置 |
| volume / issue | 可空，卷/期原值 | VL / IS | article-meta/volume / issue |
| published_online_date | 可空，独立保存在线发表日期及精度 | 由提供方说明，不从入库时间推断 | 电子出版pub-date |
| published_print_date | 可空，独立保存纸本发表日期及精度 | 由提供方说明 | 纸本出版pub-date |
| source_updated_at | 可空，ISO来源更新时间；不用于发表量统计 | 数据交付侧独立字段 | 数据交付侧独立字段，不能盲用history日期 |
| abstract | 可空；须在许可中单独允许，缺失不编造 | AB/N2需核格式 | abstract；授权和结构化内容处理需另核 |

`publication_date`不足日精度时，映射到引擎的`publication_date_partial`，`date_precision`分别为`month`或`year`；不会补成每月1日。精确日记录使用`publication_date`。获取时间由系统记录，入库时间、来源更新时间和在线/纸本日期分别保留。摘要不足时保持`insufficient_abstract`，没有AI分析结果。

## 四刊固定映射

| 刊物 | 必须匹配的journal_title | 必须匹配的issn | 模板journal_id | 交付时特别核对 |
|---|---|---|---|---|
| 中国社会科学 | 中国社会科学 | 1002-4921 | china-social-sciences | 不能将《中国社会科学文摘》、英文Social Sciences in China或网站其他刊物混入；月刊期次与论文原题需对应 |
| 社会学研究 | 社会学研究 | 1002-5936 | candidate-6 | 与《社会学评论》《社会》区分；不得以入库年替代发表年；正文、书评/目录等类型需人工区分 |
| 管理世界 | 管理世界 | 1002-5502 | management-world | 按原始目录识别论文、书评、封面、编委会和培训广告；平台总条目数不能直接当论文数 |
| 公共管理学报 | 公共管理学报 | 1672-6162 | candidate-14 | 与《公共管理评论》《公共管理与政策评论》区分；网络首发和正式卷期分别保存，不创造正式发表日期 |

刊名允许既有规范化规则的标点/空白处理，不进行模糊刊名匹配。没有官方沿革或许可附件支持时，不能自行替换ISSN。模板不是CSSCI2025—2026来源身份或采集许可证明，原有排名核验状态不会被提升。

## 预览与错误处理

字段映射可在页面下拉框调整；同一CSV列不能同时映射成两个不同含义。CSV列数不符、身份不符、作者/题名/证据缺失、无效或未来日期、无效DOI/URL、超出许可期刊范围、未获摘要许可、合成/真实模式冲突均形成行级错误。日期字段可空的情况见表；必填发表日期不可空。

系统保留逻辑记录号和CSV物理起始行，字段内换行不会造成定位错位。暂存时只做静态校验和人工预览；与已入库论文的最终DOI/URL冲突由现有引擎在入库时再次判断，冲突行进入`engine_review`，不会覆盖错误期刊或错误题名。

作者缺失不能用“佚名”填数；没有DOI可保留空值并使用既有精确组合身份去重。同题名/近似题名不自动模糊合并。再次交付的重复论文保存独立的文件和来源审计；首次论文证据不会被第二个文件静默覆盖。

## 授权API数据的接入约定

本轮不调用任何提供方API，也不允许管理员粘贴任意URL让服务器抓取。已获授权的API响应应由提供方导出或经获准工具转换为上述CSV；每条`record_evidence`包含来源服务、响应/请求编号、记录ID和保存文件定位，另保留原始交付件及其哈希。不要把API Key放进CSV、证据URL、许可摘录或日志。

本地工作台自身的API也采用同一契约：

| 方法 / 相对`/api/admin/chinese-imports`路径 | 作用 |
|---|---|
| GET `/catalog` | 字段、必填列、格式/大小限制、工作区模式、期刊标识 |
| POST `/licenses` | 登记来源许可：issuer、licensee、documentRef、documentHash、grantExcerpt、expiresOn、journalIds、abstracts |
| POST `/licenses/:id/review` | reviewer、notes、action=`approve_local`或`revoke`；通过时须核对documentHash及localStorage/localDisplay范围 |
| POST `/inspect` | filename、format=`csv`、content，返回表头、建议映射及样本，不写论文库 |
| POST `/files` | filename、format、content、mapping、licenseId、synthetic、upload.operator/permissionRef；幂等写入暂存 |
| GET `/` | 最近100个批次及许可；均需管理员密钥 |
| GET `/batches/:id?offset=0&limit=100` | 批次与分页预览 |
| POST `/batches/:id/review` | reviewer、notes、action=`approve`或`reject`；numbers行号数组或allReady=true |
| POST `/batches/:id/step` | limit=1—100，提交下一组已审核行，允许重试/恢复 |
| GET `/batches/:id/errors?offset=0&limit=100` | 错误/引擎待复核/人工排除行；分页下载 |
| GET `/batches/:id/audit` | 本批事件及对应许可登记/审查历史，不混入同许可的其他批次 |

全部接口需要`X-Admin-Key`，只允许专用本地隔离库。旧`/api/admin/import`与`/api/admin/chinese-import`返回409，不再直接入库。审计包含原始交付元数据及许可信息，应按本机研究资料妥善保管，不随意对外分享。

## 下一格式的最小适配条件

收到RIS/XML/API真实授权样本后，先确定提供方、导出版本、许可证及字段字典；各取含多作者、缺DOI、月精度、在线首发、特殊字符和非论文条目的样本。人工确认上表映射和控制总数，再写一个文件转换适配器接入同一暂存流程。XML须拒绝DTD/外部实体，不下载全文，不另建采集引擎。
