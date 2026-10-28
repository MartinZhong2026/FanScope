# 首页、趋势、AI 批次及中英切换验收

基于最新 `main`：`e7203bb97615b177582de1d93d8e9599cd1081ce`。这是开发验收，未合并、未部署；没有连接生产数据库、读取生产批次账本或操作正在运行的 DeepSeek 任务。

## 修改与统计口径

- 首页保留「最近发现」。桌面与移动端独立读取最近90个日历日、日期精确到日且有效的论文，按发表日期倒序取3篇。排除未来日期、月／年精度、不合法日期及演示记录；历史补录的收录时间不影响排序。无符合条件记录则显示空状态。
- 小样本、类别很少或时间点不足时优先条形图，明确显示观察期合计。多序列使用独立换行图例；期刊全称使用可选中的 HTML 文本。长列表可滚动，不靠截断名称控制布局。样本按单位分别展示，小于5篇时显示逐篇数值。
- 每个维度独立按论文去重计数。主题是题名／摘要关键词初筛，不声称 AI 证据。研究方法、设计、来源及样本重新验证当前输入哈希、原文引文、置信度、允许类别和数值证据。成功返回 JSON 不等于有效证据。分布保留无日期的已知记录；时间图只用日期可用记录，并使用相应有效样本口径。空分母的比率在接口为 `null`，图中说明不适用。
- 批次进度是“已处理／总数”，与分析成功、缓存复用、有效证据、证据不足、失败、等待及运行中分别显示。已报告用量估算、用量未知预留及未定价请求分开；任何请求缺价格时总额显示未知。预留不声称为供应商实际扣费。失败说明使用安全错误代码，不返回原始供应商响应。
- 批次详情为只读投影。沿用已有缓存、原子请求预留和中断保护，不重建既有批次、不增加自动重试或模型调用。人工重试明确提示可能再次收费。未修改数据库 schema、账号角色、授权接口和模型工作队列。
- 顶部提供中文／English 切换，使用 `fanscope-language` 本地偏好，跨页面和 Lab 工作台保留。切换不请求服务器，不重建页面、登录状态或未保存表单；图表重新绘制对应语言标签。论文、用户姓名、业务记录和证据引文保留原文。默认中文、原暗色主题及主题偏好不变。

## 截图

所有数据均明确标注为隔离验收样本，不能作为真实论文或生产批次进度。基线从上述 main 的独立 worktree 运行原始前后端；修复版本使用同一份 `quality-browser-server.mjs` 样本。两者均使用全新 SQLite 文件和阻止外部网络调用的测试 transport。局部截图隐藏固定导航，避免导航覆盖证据内容。

| 内容 | 修改前 | 修改后 | English |
| --- | --- | --- | --- |
| 390px 首页 | [前](before/390-home.png) | [后](after/390-home.png) | [EN](english/390-home.png) |
| 390px 小样本研究方法 | [前](before/390-methods.png) | [后](after/390-methods.png) | [EN](english/390-methods.png) |
| 1440px 趋势 | [前](before/1440-trends.png) | [后](after/1440-trends.png) | [EN](english/1440-trends.png) |
| 1440px 期刊全称 | [前](before/1440-journals.png) | [后](after/1440-journals.png) | [EN](english/1440-journals.png) |
| 390px 200/164篇批次 | [前](before/390-batches.png) | [后](after/390-batches.png) | [EN](english/390-batches.png) |
| 390px 首页无符合论文 | 不适用 | [空状态](after/390-empty-home.png) | [EN](english/390-empty-home.png) |

完整截图另包含320px和768px。批次样本模拟200篇已处理164篇，以及164篇处理结束但包含失败；不是生产中的真实执行结果。少量证据样本为3篇分析成功、2篇具有可核验证据，覆盖率66.7%、缺失率33.3%。

## 复现

```bash
cd api
npm ci --ignore-scripts
npm test
npm audit --omit=dev
cd ..
node scripts/check-sensitive.mjs
git diff --check

# 每轮必须使用新的 work/*.sqlite，不复用已被审批验收修改的测试库。
DATABASE_PATH="$PWD/work/mobile-review.sqlite" node --experimental-sqlite api/test/mobile-browser-server.mjs
# 另一个终端：
python scripts/bilingual-browser-acceptance.py --webkit
python scripts/mobile-browser-acceptance.py --webkit
python scripts/dark-reference-acceptance.py

# 停止上述本地 fixture 进程后，再创建质量验收 fixture；不启动真实模型 worker。
DATABASE_PATH="$PWD/work/quality-review.sqlite" node --experimental-sqlite api/test/quality-browser-server.mjs
# 另一个终端：
python scripts/quality-browser-acceptance.py --output work/quality-review
python scripts/quality-browser-acceptance.py --language en --output work/quality-review-en
```

## 已完成检查

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Node 22.23.4 全量测试 | 139 / 139 | [日志](checks/node22-tests.txt) |
| Node 24.19.0 全量测试 | 139 / 139 | [日志](checks/node24-tests.txt) |
| Chromium / WebKit 业务回归 | 99项通过；0异常、0意外管理写入 | [结果](checks/mobile-results.json) |
| 暗色参考与空状态 | 35项通过 | [结果](checks/dark-results.json) |
| 中英往返、登录、表单及原文保留 | 13组布局通过 | [结果](checks/bilingual-results.json) |
| 质量验收：中文 / English | 各16项通过；0外部请求、0写入 | [中文](after/results.json) / [EN](english/results.json) |
| npm audit（生产依赖） | 0漏洞 | [日志](checks/npm-audit.txt) |
| 敏感文件／凭据模式扫描 | 通过 | [日志](checks/sensitive-scan.txt) |

移动布局覆盖320、375、390、430、768及1440px，浅色与深色；WebKit覆盖关键业务路由、原生弹窗和中英切换。另见 [Lab English 登录](lab-english/chromium-390-login-en.png)、[手机项目页](lab-english/chromium-390-projects-en.png)、[桌面项目页](lab-english/chromium-1440-projects-en.png)。重新验证证据时保留原提供商、模型及提取时间，不将只读校验伪装成一次新的 AI 分析。

CI 安装 Playwright 1.62.0 Chromium / WebKit 及系统依赖，执行上述完整流程并上传浏览器结果。此开发环境无 root 权限；本地 WebKit 所需 Debian 库在工作区解包，浏览器实际运行通过。物理 iOS／Android 设备不在无头浏览器覆盖范围内。
