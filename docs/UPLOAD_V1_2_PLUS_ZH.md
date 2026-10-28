# 把本次 ZIP 更新上传 GitHub（不覆盖 main）

本文件是源码压缩包，**GitHub 不能通过“上传 ZIP 文件”来自动替换其内部源码**。应在本地解压并提交文件，继续维护 PR #1 的同一条功能分支。

### Windows / PowerShell 参考步骤

1. 本机安装 Git；在不含其他个人文件的工作目录执行：

```powershell
git clone --branch feat/fanscope-v1.2-monitor-lab https://github.com/MartinZhong2003/FanScope.git
cd FanScope
```

2. 将 ZIP 内 `FanScope/` **目录下的全部内容**（包括 `.github` 等隐藏目录）复制到刚克隆的 `FanScope/` 对应位置，选择覆盖同名文件。不要复制私人 `.env`、真实 Excel、数据库或任何账号密钥。

3. 审核改动并提交（在 PowerShell 的 FanScope 目录中）：

```powershell
git status
git add web/app.js web/index.html web/mobile-ui.js web/mobile.css web/lab/app.js web/lab/index.html web/lab/lab-mobile.css api/src/lab.mjs api/test/lab-documents.test.mjs api/test/mobile-ui.test.mjs docs/V1_2_PLUS_CHANGELOG.md docs/UPLOAD_V1_2_PLUS_ZH.md
git diff --cached --stat
git commit -m "feat: mobile app launcher and Meetfolio transcript imports"
git push origin feat/fanscope-v1.2-monitor-lab
```

4. 查看现有 [Draft PR #1](https://github.com/MartinZhong2003/FanScope/pull/1)，新提交应自动加入。**不需要创建第二个 PR**，也不要立刻合并部署。等待 CI，再按 `docs/OPERATIONS_V1_2.md` 做生产升级前备份。

如 GitHub 拒绝推送（例如远端已有新提交），应先 `git fetch`/审查差异再 rebase，不要 `--force`。不熟悉命令时可让懂 Git 的同学协助，避免覆盖同伴工作。
