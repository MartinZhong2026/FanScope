# 数据来源、统计口径与已知限制

## 1. 用户真正关心的是什么？

FanScope 主要回答：目标期刊最近发表了什么？正在讨论哪些社会问题？采用横截面、纵向、重复横截面、质性等研究设计的文章各占多少？样本量在变大吗？我们有什么相似题目值得进一步阅读？

目前 v1 优先保证新文章更新，不将未取得全文时的未知方法视为某种设计。

## 2. 各数据源职责

| 来源 | v1 状态 | 说明 |
|---|---|---|
| Crossref /journals/{ISSN}/works | 已写入可执行代码 | 按 5 本期刊的 ISSN 扫描并用 from-index-date 增量更新；需要服务器与 Crossref 真正连通，无法保证出版社提交元数据的时效。 |
| OpenAlex | 暂未作为自动扫描链路 | 后续用于历史文章回填、主题和引用信息富化；不要误称本版本已经调用它。 |
| 国内期刊官方 RSS / Atom | 有通用解析器但暂无预置可验证 feed | 只有手动提供**真实、可用、允许访问**的期刊 feed 并开启后才自动监测。 |
| CSSCI / 知网 / 万方 | 暂无直连接口 | 允许在合法授权下将题录整理为 JSON 导入；不能批量绕过付费、反爬、登录限制。 |
| DeepSeek | 代码已经接入，默认需填 KEY | 仅据原始标题和公开摘要判断，不代表全文分析。 |
| Resend | 代码已经接入，需填 KEY 并验证发信域名 | 仅成功返回供应商接口后才提示发送。邮件最终投递也受垃圾箱/邮箱系统影响。 |

## 3. Crossref 重要技术细节

- `from-index-date` 监测元数据被 Crossref 索引/更新的时间，而非论文初次发表时间。UI 区分 `publication_date` 与 `discovered_at`。
- `ISSN` 必须实际核对；同刊可能有线上与纸本 ISSN，检索覆盖率需观察。
- 首页年度趋势基于**已收录**记录；在未完成跨年全量回填前，只能用于观察系统收录趋势，不代表完整期刊总体发文量。
- 同 DOI 文章可以在在线预发表和正式期号重复出现，以 DOI 去重，但没有 DOI 的 RSS 论文只在同来源按链接去重。
- 跨年历史大量回填可能达到 Crossref 页数限制。程序报告部分失败并保留检查点，不静默遗漏；完整回填需后续分页作业。

## 4. 国内外期刊分类规则

- `market='chinese'` 和 `market='international'` 永不自动互换。
- 当前候选 `rank_label` 明确写成 `... verify`。CSSCI 来源/扩展及 JCR 学科分区、年份没有经过校方许可数据库核对，**不要向用户显示确认的 Q1 标签**。
- 以后新增表 `journal_rankings(journal_id,scheme,year,category,quartile,source)`，而不是只有一个永久 Q1 布尔值。
- 在同一期刊内比较文章类型、年份、研究设计；对于样本量，定量/定性/机构数/人期观测数应分开。

## 5. 摘要级 DeepSeek 结构化提取

目前输出：`design`, `data_origin`, `method`, `sample_n`, `sample_unit`, `evidence`, `ai_summary`。

- 模型仅能看到 Crossref 元数据的摘要，不等于读过论文方法章节。
- 必须在摘要中找到与 `sample_n` 匹配的逐字证据片段才写入整数；否则样本数为 `null`。
- 调查项目有多个调查波次**不等于**论文一定用了纵向识别；需要作者文章明确说明。
- 定性研究通常不宜直接按“样本越大越好”评价；不同研究范式应分层比较。
- 关键词分类只是**初筛标签**，不能替代系统综述筛选或理论阐释。
- 当前不具备“实际稿件接受率预测”；缺少被拒稿总体数据。

## 6. 团队研究资产安全

本仓库不包含任何杨帆课题组私有数据或上传的 ZIP/PPT 原件。Lab Data 灰色禁用，无内部数据库 API 或上传入口。日后必须建立项目知情同意、授权、伦理审查、去标识化和访问控制流程。

## 7. 参考文档（核查时间 2026-10-24）

- Crossref REST 过滤器：https://www.crossref.org/documentation/retrieve-metadata/rest-api/rest-api-filters/
- Crossref API 使用建议：https://www.crossref.org/documentation/retrieve-metadata/rest-api/tips-for-using-the-crossref-rest-api/
- DeepSeek 官方：https://api-docs.deepseek.com/quick_start/pricing/
- Cloudflare Pages 构建：https://developers.cloudflare.com/pages/configuration/build-configuration/
- Cloudflare Pages 静态网站：https://developers.cloudflare.com/pages/framework-guides/deploy-anything/
- Resend 官方：https://resend.com/docs/send-with-nodejs
