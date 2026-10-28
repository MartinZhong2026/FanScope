# 中文期刊来源调查与 RSS 接入

调查日期：2026-10-25。基线 main@7a18ed4。**没有取得成功读取的真实 RSS/Atom XML，RSS 可用为 0；没有新启用任何期刊。** 下表依据本次网页搜索返回的刊方、主办单位及国家文献平台页面；《社会》《中国软科学》《社会保障评论》目录另已直接打开，其他部分仅取得索引证据；索引可见不代表当前服务器可抓取，也不代表允许自动批量采集。

“官方目录可用”表示发现刊方目录/刊方发布的目录订阅说明，不表示已实现 HTML 抓取。“尚未确认”表示没有完成可靠刊方实时来源确认，暂走人工导入，不等于证明没有 RSS。“只能人工导入”需要排除其他可靠公开来源的证据，本次不作这种绝对断言。

| 期刊 | 结论 | 证据和后续措施 |
|---|---|---|
| 社会保障评论 | 官方目录可用 | [刊方 CNKI 独立门户](https://sbpl.cbpt.cnki.net/journal/portal/sbpl/client/index)，目录可检索；无已验证 RSS |
| 社会学评论 | 官方目录可用 | [人大刊方页面](https://src.ruc.edu.cn/CN/home)，网页直接打开超时；未确认 RSS XML |
| 公共管理评论 | 官方目录可用 | [刊方目录](https://gogl.cbpt.cnki.net/portal)，无已验证 RSS |
| 人口研究 | 官方目录可用 | [官方 RSS 说明](https://rkyj.ruc.edu.cn/CN/rss/showRssInfo.do)公布当期目录 https://rkyj.ruc.edu.cn/CN/rss_dqml_1000-6087.xml；XML 阅读工具不可访问，不能标 RSS 可用 |
| 中国人口科学 | 尚未确认 | [国家平台公开目录](https://www.ncpssd.org/journal/details.aspx?gch=97725X&langType=1&nav=1)；不等同已确认刊方订阅源 |
| 人口与经济 | 尚未确认 | [国家平台目录](https://ncpssd.org/journal/details?gch=95683X)，刊方 RSS 未确认 |
| 人口学刊 | 尚未确认 | [吉林大学介绍](https://hssra.jlu.edu.cn/xsqk/rkxk.htm)，主办证据不等同实时目录/RSS |
| 人口与发展 | 官方目录可用 | [北京大学期刊目录](https://ccj.pku.edu.cn/journal/info?jid=99049&viid=15872092)，未确认 RSS |
| 社会学研究 | 尚未确认 | [刊方旧年度目录 PDF](https://shxyj.ajcass.com/Admin/UploadFile/20130926008/2019-11-19/Issue/0oh2pnqx.pdf)；没有据此声称当前自动源可用；排除自称官网的商业投稿站 |
| 社会 | 官方目录可用 | [当期目录](https://www.society.shu.edu.cn/CN/1004-8804/current.shtml)、[RSS 说明](https://www.society.shu.edu.cn/CN/rss/showRssInfo.do)公布 https://www.society.shu.edu.cn/CN/rss_dqml_1004-8804.xml；尚未读取 XML，保持未配置 |
| 社会发展研究 | 尚未确认 | [国家平台目录](https://ncpssd.org/journal/details?gch=72041X&langType=1&num=2&years=2024)，刊方当前 RSS 未确认 |
| 社会建设 | 官方目录可用 | [人大刊方目录](https://shjs.ruc.edu.cn/)，未确认 RSS |
| 妇女研究论丛 | 尚未确认 | [国家平台目录](https://www.ncpssd.cn/journal/details?gch=82596X)，刊方自动订阅源未确认 |
| 残疾人研究 | 尚未确认 | [国家平台目录](https://www.ncpssd.cn/journal/details?gch=71362X)，刊方自动订阅源未确认 |
| 公共管理学报 | 官方目录可用 | [刊方独立门户](https://gggl.cbpt.cnki.net/portal/journal/portal/client/advSearchResult)，未确认 RSS |
| 公共管理与政策评论 | 官方目录可用 | [人大刊方 RSS 说明](https://ggglyzc.ruc.edu.cn/CN/rss/showRssInfo.do)有分栏目 XML；页面直接打开超时；没有把说明页当 XML 填入 rss_url |
| 中国行政管理 | 官方目录可用 | [刊方目录](https://www.cpaj.com.cn/)，未确认稳定 RSS |
| 治理研究 | 尚未确认 | [维普目录](https://www.cqvip.com/journal/80561A/80561A)，搜索命中商业“官网”不作可信刊方证据 |
| 电子政务 | 尚未确认 | [中国科学院主办机构介绍](https://www.las.cas.cn/qk/202112/t20211202_6286197.html)，未确认当前目录订阅源 |
| 中国软科学 | 官方目录可用 | [刊方目录](https://www.cssm.com.cn/zgrkx/home)，未确认 RSS；与《软科学》是不同期刊，禁止误匹配 |

合计：官方目录可用 11，尚未确认 9，RSS 可用 0，只能人工导入 0。实际运行服务器仍需独立确认 TLS、DNS、文章字段及访问许可。公开目录样本可见真实题名（例如《社会》“从分娩记忆看中国女性产痛的代际变迁与社会意涵”），但本次没有把目录样本冒充成功 RSS 采集结果。

## 实现与运行边界

- journals 增加 `rss_url TEXT NOT NULL DEFAULT ''`，增量可重复执行；只在一次性迁移中补入既有配置的非空地址，不覆盖管理员修改。所有中文配置地址均为空，没有编造 feed 地址。Lab 表和论文原始字段不变。
- 来源管理提供测试、保存并暂停、验证并启用、暂停。API `/api/admin/journal-source/rss` 统一管理员校验。保存和启用都重新读取、验证来源；测试不保存。暂停会使在途旧启用操作失效，防止稍后被旧结果重新开通。换地址清除本刊旧 checkpoint，首次同步不发送历史新增通知。
- 逐刊 `rss_allowed_hosts` 是代码审核的精确主机名单，不允许管理员仅靠 URL 输入任意放行新主机；白名单为空的期刊保持待配置。已批准主机表示有刊方归属证据，不表示已有可用 feed。新来源必须先独立审查并通过配置 PR。
- 仅 HTTPS、默认端口、无凭证和 IP 字面量；解析全部 DNS 地址并拒绝私网/本地/保留地址，连接固定到已检查 IP，TLS 仍校验原主机证书。所有重定向拒绝，避免开放跳转和 DNS rebinding。20 秒请求上限、流式 2MB 限制；不继承通用代理重写目标。受限代理环境需提供受控出口，不能因此取消地址检查或证书验证。
- RSS 2 / RSS 1 RDF / Atom 使用 XML parser，拒绝 DTD/ENTITY 和坏 XML。验证频道名与期刊名一致，至少一条有标题、合格链接、有效日期的文章；文章链接也需在该刊批准主机内。Atom 优先 alternate 链接和 published 日期。格式不符或不确定时拒绝启用。
- DOI 优先去重；无 DOI 用完整 URL 的 SHA-256 稳定 ID。监测另按同刊 URL 检查旧数据，避免旧版 guid ID 与新版哈希 ID 重复导入。不会删除或重写旧论文。
- 本次没有连接约 2,549 篇真实生产论文数据库。新增自动测试用 **2,549 篇合成论文**和 Lab 用户/项目/稿件运行迁移两次，逐项核对旧字段、完整性；生产库副本仍需人工备份及验收。

## 验证

`npm test` 包含原有监测、Lab、缓存/预算回归及新增 RSS 测试。新增测试覆盖解析、日期/期刊归属、旧 ID 去重、私网和混合 DNS、重定向、响应体限制、管理员认证、保存/启停、新进程 URL 持久化、暂停与在途验证的竞争，以及 2,549 篇合成迁移。

浏览器在 390px/1440px 对四个 RSS 按钮各执行一次真实 HTTP 请求：未批准主机的测试/保存/启用均 422，暂停 200；成功生命周期在注入 XML 的单元测试验证。没有把 Mock 结果当真实在线 RSS 验证。证据位于 [rss-acceptance](rss-acceptance/)。

只创建 Draft PR，不合并、不部署。上线前用一致性 SQLite 副本验证真实规模和备份恢复，不复制正在写入的主库文件来代替一致性备份，保留 Docker 数据卷。
