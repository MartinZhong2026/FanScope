# V1.6 首次 Pages 发布 HTTP 400 修复与重新验收

## 已确认的失败位置

基线 `59c59eb93fb30a791187288d93dec77de6167d37`。检查 [Pages deploy #3 的 publish 日志](https://github.com/MartinZhong2026/FanScope/actions/runs/40811211625/job/123241700007)，调用栈指向 `runPages():123`，对应：

```text
GET /accounts/<account_id>/pages/projects/fanscope/deployments?env=production&per_page=100
```

项目详情 GET 和旧 Git 渠道校验已经成功；错误发生在产物校验、当前生产版本识别和 Wrangler 上传之前。不是上传接口、rollback 接口或 `activeProduction()` 内单部署 GET 返回的 400。原 `cf()` 丢弃了 Cloudflare 的 `errors`，所以不能从这份旧日志恢复真实错误码或错误正文，也不能把 Mock 中的示例错误码当作线上证据。

代码问题是部署列表使用大页大小 `100`、只读取第一页并丢弃分页信息，同时 `inspect` 完全没有覆盖该请求。修复使用 `25` 条一页并遍历生产历史，校验返回数组、部署身份和分页信息，达到分页上限或发现不完整/重复结果时拒绝发布。`per_page=100` 是本次 400 的首要参数嫌疑；由于没有原始错误正文，也没有使用真实密钥重放请求，页大小限制归因仍需修复后只读检查确认，不能宣称已经实测线上成功。

## API 契约及保留的保护

[Cloudflare 官方部署列表 API](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/list/) 定义 `env=production|preview`、`page`、`per_page`，响应为 `success`、`errors`、数组 `result` 和可选 `result_info`。当前文档没有注明此接口的 `per_page` 最大值。`result_info` 包含可选 `page/per_page/total_pages/total_count`；`total_count` 可能统计未过滤结果，不用于推断生产列表已读完。缺少分页元数据时继续读取到短页/空页，服务器返回较小 `per_page` 时使用其实际值。

`cf()` 现在记录 HTTP 方法、隐藏账户 ID 的 endpoint、HTTP 状态，以及最多五条 Cloudflare 数字错误码与脱敏消息；不记录请求头、原始响应正文、环境变量、项目配置或底层网络异常。非 JSON、HTTP 200 但 `success=false`、缺失 `result` 和网络错误均安全失败。Token、账户 ID、凭据字段、URL、邮箱和控制字符会被脱敏/清理，单条消息限制长度。

生产 `inspect` 现在还会读取全部生产部署，阻断未完成任务，并通过 `activeProduction()` 检查当前正式版本及不可变地址的文件内容。指定的 `PAGES_CURRENT_DEPLOYMENT_ID` 必须与单部署 GET 返回的 UUID 一致。只读检查不上传、不回滚。

保留：旧 Git 生产和预览自动构建双关闭检查、SHA/产物校验、当前生产内容逐字节校验、未完成部署阻断、相同 SHA 验证后防重发、失败新版本的所有权判定与自动回滚。没有修改 workflow 权限、CD 开关、Cloudflare 设置、生产密钥、数据库或腾讯云 Docker。

## 重新验收（由管理员在批准合并后执行）

1. 修复 PR 的 Linux `FanScope checks` 全部成功且审查完成后，由用户决定合并。保持 `PAGES_CD_ENABLED=false`、`BACKEND_CD_ENABLED=false`；本修复不会代为合并或开启开关。
2. 等待合并后**当前 main SHA** 的完整 checks 成功。手动运行 `FanScope Pages deploy`，branch=`main`、operation=`inspect`。新日志应显示项目 GET、`deployments?env=production&per_page=25&page=1`（必要时后续页）均 HTTP 200，并输出 `activeProductionId`。检查该 UUID 确为正式域名当前版本，且与不可变地址关键文件比较成功。不要用旧版 #2 的 inspect 成功代替此检查。
3. 若仍失败，按脱敏诊断处理，保持开关关闭：400 查看错误码与参数消息；401/403 核对 `pages-production` Environment 中 Token 是否有效、Account Resources 是否包含该 Account ID、是否具备 **Account → Cloudflare Pages → Edit**（发布/回滚需要写权限；只读列表接受 Pages Read 或 Write）。项目不存在则核对账户与 `fanscope` 项目名。不要因此增加 DNS、Zone 或全局 API Key 权限。
4. 若旧站无 release marker 或无法唯一确定版本，在 Cloudflare Deployments 确认**当前正在服务的成功生产部署** UUID，填写 GitHub `pages-production` Environment Variable `PAGES_CURRENT_DEPLOYMENT_ID`，重新运行 inspect。不能直接选最新部署，也不能跳过内容比较。Git 自动构建提示未关闭时，管理员须核对 `fanscope` 的生产自动构建关闭、预览为 None，再重试。
5. 只有用户明确批准首次前端发布后，管理员才把 `PAGES_CD_ENABLED=true`。后端保持 false。对最新 main SHA 的 `FanScope checks` 执行 **Re-run all jobs**，让其成功完成触发自动发布；不要重跑旧 SHA 的 #13，也不要只重跑旧失败的 publish #3 来代替全链路验收。
6. 验收 publish 成功、正式 `/` 和 `/lab/` 正常、`config.js` 指向现有生产 API、`release.json.commit` 等于该完整 main SHA、Cloudflare 没有旧 Git 渠道的第二次部署。再次重跑同 SHA checks，应显示 `already verified; no duplicate deployment`，且不新增部署。自动回滚失败路径在 Mock 中验证；不为验收制造生产故障。若失败，先关闭 Pages CD，再依据诊断与既有手册处理。

## 本地验证记录

- Windows Node `v24.21.0`：`node --experimental-sqlite --test api/test/pages-api.test.mjs api/test/cicd-v16.test.mjs`：19/19，通过；全部 Cloudflare 调用和上传均为 Mock。
- `python -m unittest discover -s scripts/cicd/tests -v`：17/17，通过；仅合成数据库。
- `node --check scripts/cicd/pages.mjs`、Git Bash `bash -n scripts/ci-fixture-server.sh deploy/cicd/install-host.sh`、`node scripts/check-sensitive.mjs`、`git diff --check`：通过。
- Windows 首次全量 `cd api; npm test`：205 项，204 通过、1 失败（现有文档上传测试返回 500，系统 PATH 未提供 `unzip`/`pdftotext`）；此时尚未加入三项流程回归测试。未删除或跳过该测试，Linux 完整结果以 PR Actions 为准。
- 本机 Docker Desktop 虽响应 Linux daemon 查询，但枚举镜像返回已有 blob 的 `input/output error`，本地 Linux Docker 构建/演练无法完成；没有清理 Docker 存储。Linux 构建、API 全套及 Chromium/WebKit 浏览器验收由原 PR workflow 执行。
