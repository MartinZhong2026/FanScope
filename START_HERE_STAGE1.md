# FanScope v1.3 阶段一：README FIRST

这是可直接覆盖 FanScope 仓库代码结构的完整源代码 ZIP，**不是安装包**，也不是预先部署的服务器。基于原 ZIP `FanScope-903f37e8a8ab95cebb2825dffede170f45d9deed.zip`，没有删除原来的 `api/`、`web/`、`deploy/`、`docs/`、`LICENSE`、`README.md` 和自动化测试。

## 上传到 GitHub 的正确方式

1. 下载并解压 ZIP，在 GitHub Desktop 中打开你本机已 clone 的 `FanScope` 项目。
2. **把 ZIP 内的所有文件及子文件夹复制到本机 FanScope 仓库根目录**（不是将外层 `FanScope/` 文件夹整个嵌套进去，也不是把 ZIP 文件原样提交）。允许替换同名文件。
3. GitHub Desktop 检查 Change List。确认没有 `.env`、API 密钥、数据库 `.sqlite`、`node_modules`、用户上传文档。
4. 建议建分支 `feat/fanscope-v13-stage1-data-engine`，提交并推送到 GitHub，开 PR 后查看 CI 测试再合并。**本 ZIP 不会自动修改你 GitHub 上的任何代码。**
5. 前端若自动发布，不代表腾讯云 API 也自动部署。**后端仍需在服务器按 `docs/V1_3_STAGE1_ZH.md` 备份、构建、测试再升级 Docker。**

## 这次改了什么？

- SQLite 持久化 DeepSeek 批处理和中断恢复；先创建暂停状态的任务、管理员确认后才运行。
- 缓存 v1.2 已解析论文，摘要发生变化才重新解析。
- Token 使用与预计人民币费用、预算保护。
- Crossref 期刊 ISSN + DOI + 期刊名实际来源校验，验证成功才允许开启。
- 监测健康页面显示真实 AI 解析覆盖率。
- 默认禁用以前不经确认的周期性 DeepSeek 自动分析。

**这只是第一阶段。** 深色全站 UI、科研图表、剩余 37 本期刊接入与中文期刊数据源适配，在下一次发 `continue` 后继续修改本版 ZIP。

详细操作与测试：`docs/V1_3_STAGE1_ZH.md`。
