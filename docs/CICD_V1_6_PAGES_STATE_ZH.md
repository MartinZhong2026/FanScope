# Pages 生产部署状态判断修复

## 失败证据与边界

基线 `533c7c5bdfb4276bfbdbb47a39e3f7a49a4430e2`。[Pages deploy #6](https://github.com/MartinZhong2026/FanScope/actions/runs/40815169701) 的只读 inspect 日志显示项目 GET、生产部署列表 GET（per_page=25）均 HTTP 200，随后 `runPages():178` 的历史列表 `some()` 抛出 pending 错误。旧判断没有输出记录身份，也没有检查阶段名称、结束证据或 `is_skipped`，将任何历史非终态阶段等同于正在部署；另一个问题是把任意阶段的 success 当成部署完成，未区分 build success 与 deploy success。

**该旧日志没有记录触发部署的 UUID 和阶段字段。当前会话没有可用的 Cloudflare API 凭据/连接，未调用真实 Cloudflare API，因此具体线上触发记录尚未确认。** 不把合成测试记录当成真实记录，不声称已在生产复现或通过。合并后新版只读 inspect 会通过 GitHub Actions 现有 Environment Secret 自动获取并诊断记录；无需用户手动复制部署列表或提供 Token。这不影响先完成代码修复、Mock 测试和 PR CI。

## 官方语义与判断策略

[Cloudflare 部署列表 API](https://developers.cloudflare.com/api/python/resources/pages/subresources/projects/subresources/deployments/methods/list/) 将 `latest_stage.status` 定义为阶段状态，阶段包括 queued/initialize/clone_repo/build/deploy；状态包括 success/idle/active/failure/canceled/skipped。`is_skipped` 独立表示部署是否被跳过；`started_on` 和 `ended_on` 可为空。[Wrangler 官方完成判断](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/pages/deploy.ts) 也同时检查阶段名 deploy 与状态 success。这些字段没有保证“超过某个时间的 idle/active 已经结束”。

`productionDeploymentState()` 分类如下；非 completed 记录必须再 GET 单部署详情，并核对 UUID 和 production 环境，详情读取失败或身份不一致时拒绝继续。列表中的非终态信息不会单独决定允许发布。

| 分类 | 证据 | 处理 |
| --- | --- | --- |
| completed | latest_stage 为 deploy/success，或明确 failure/canceled/skipped | 允许后续生产版本核验 |
| historical | 详情明确 is_skipped=true，或 stages 有带结束时间的终止阶段；没有已开始且尚未结束的 active 阶段冲突 | 允许后续核验，记录具体证据 |
| running | 详情有近期 active、有效开始时间、无结束时间；或近期 queued/idle、尚未开始、明确未跳过 | 阻断 inspect/deploy/rollback |
| unknown | 缺字段、未知阶段/状态、矛盾的跳过/执行证据、不一致时间、中间阶段 success、陈旧未结束记录或其他无法确认的情况 | 输出明确原因并阻断，要求调查 |

“近期”采用本地一小时诊断窗口，**不是 Cloudflare 的生命周期保证，也不是超时解锁机制**。超过窗口的未完成记录从 running 改报 unknown，仍然阻断。不会因为记录很旧、有更新的成功部署或单个阶段有 ended_on 就放行；没有结束证据的历史 idle/active 仍须调查。未开始的 active 占位阶段不能推翻明确的 is_skipped=true；已开始且未结束的 active 与跳过/结束证据冲突时仍报 unknown。

`assertProductionQuiescent()` 输出每条列表记录及必要的详情复核结果，返回复核后的记录供原 `activeProduction()` 使用。日志只序列化 `id`（遮蔽 UUID 中段）、`status`、`stage`、`started_on`、`ended_on`、`created_on`、`modified_on`、`is_skipped`；其中 status/stage/started_on/ended_on 来自 latest_stage，前缀包含固定分类/原因。时间标准化，未知状态/阶段不回显任意字符串。API 请求诊断中的单部署 UUID 同样遮蔽。不会输出 source、commit_message、env_vars、URL、Token、请求头或完整 API 对象。阻断错误明确建议保持两个 CD 开关关闭，在 Cloudflare Deployments 中按遮蔽 UUID 和阶段时间核对记录，等待运行任务结束或调查未知状态后再运行 inspect，不删除历史记录或绕过保护。

## 保留的生产保护

仍然读取并验证全部生产分页，拒绝不完整历史。保留 Git 自动生产及预览双关闭检查、当前生产 UUID 核验、正式域名与不可变部署文件比较、SHA/静态产物校验、已验证相同 SHA 不重复发布、新版本失败后的所有权判断与自动回滚。没有修改 workflows、CD 开关、真实凭据、Cloudflare 配置、数据库、腾讯云服务器或前端功能。

## Mock 与本地验证

```text
node --experimental-sqlite --test api/test/pages-state.test.mjs api/test/pages-api.test.mjs api/test/cicd-v16.test.mjs
python -m unittest discover -s scripts/cicd/tests -v
node --check scripts/cicd/pages.mjs
bash -n scripts/ci-fixture-server.sh deploy/cicd/install-host.sh
node scripts/check-sensitive.mjs
git diff --check
```

Windows Node v24.21.0：发布相关测试 27/27；Python 合成数据测试 17/17；语法、敏感扫描及 diff 检查通过。所有 Cloudflare 请求、上传与回滚为 Mock。Linux 全量 API、静态构建、Docker 合成数据演练和 Chromium/WebKit 验收交由原 GitHub Actions 验证，最终结果见修复 PR。

Mock 覆盖正常成功、历史 skipped/idle、有明确结束证据的遗留阶段、无结束证据的陈旧 idle/active、真实 active/queued、未知状态/缺字段/矛盾时间、取消部署、详情状态更新及身份错误、安全日志，以及同 SHA 防重复和历史异常存在时的失败自动回滚。

## 新版 inspect 验收标准

1. 用户审查修复 PR、确认 Linux CI 后自行决定合并。保持 `PAGES_CD_ENABLED=false` 与 `BACKEND_CD_ENABLED=false`；不要以自动发布验证状态诊断。
2. 在合并后的 main 上手动运行 `FanScope Pages deploy`，operation=inspect。检查项目与全部部署列表 GET 均成功，非 completed 记录均有对应详情 GET 与 `Pages deployment detail` 诊断。只读操作不得出现上传或 rollback POST。
3. 按遮蔽 UUID、状态、阶段和时间，在 Cloudflare 面板核对原阻断记录。如果确认历史跳过/结束，应显示 historical 及其证据，继续执行生产 UUID 和不可变内容校验；不能仅以“旧记录”作为通过理由。
4. 有真实 active/queued 时应非零退出并列出 running 记录；历史记录仍缺少结束证据或出现冲突时，应非零退出并列出 unknown 及具体原因。不要删除历史记录、取消真实部署或弱化保护来通过验收。
5. 无 running/unknown 后，只有原生产 UUID、版本及关键文件比较全部通过，inspect 才能成功并输出 `activeProductionId`。成功只证明只读预检通过，不代表生产已经发布。若仍失败，依据 Actions 的自动脱敏诊断与 Cloudflare 面板调查；无需手动导出完整响应、提供 Token、修改 Cloudflare 设置或开启 CD。
