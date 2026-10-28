# FanScope — 手工上传 GitHub → Cloudflare Pages → 曼谷服务器部署指南

> 建议在服务器上执行前先做一次已有服务快照。本文不要求新增服务器或购买新域名。

## A. 把 ZIP 上传 GitHub（无需 Codex）

最容易的方式：解压本 ZIP，新建 GitHub 仓库 `fanscope`，打开仓库 `Add file → Upload files`，将**解压目录里面的 `web`、`api`、`deploy`、`docs`、`examples` 文件夹和 `README.md`** 上传，确保它们位于**仓库根目录**。

如果浏览器拖拽整个文件夹没有保留子目录，使用 GitHub Desktop（File → Add Local Repository；没有仓库先 Create）提交并发布仓库，或者使用命令：

```powershell
cd .\FanScope-v1
git init
git add .
git commit -m "feat: FanScope research radar MVP"
git branch -M main
git remote add origin https://github.com/<YOUR_USER>/fanscope.git
git push -u origin main
```

**严禁提交真实 `api/.env` 或 SQLite 数据库。** 仓库建议先设为 Private，公开发布前再审查版权及账号配置。

## B. 曼谷服务器准备（请使用自己的真实 IP 登录）

先 SSH 到 Ubuntu 24.04。Docker Compose 假设已安装，检查：

```bash
sudo docker --version
sudo docker compose version
sudo nginx -t
```

如服务器已经有 Nginx，**不要直接安装第二个占用 80/443 的 Caddy 实例**。

把 GitHub 仓库 clone 到服务器（Private 仓库使用自己的 GitHub 认证方式）：

```bash
cd ~
git clone https://github.com/<YOUR_USER>/fanscope.git
cd fanscope
cp api/.env.example api/.env
nano api/.env
```

必须修改 `api/.env`：

```text
ADMIN_KEY=<一段你自己生成的至少24位随机字符串>
CROSSREF_CONTACT_EMAIL=<你自己的真实邮箱>
ALLOWED_ORIGINS=https://<PAGES_PROJECT>.pages.dev,http://127.0.0.1:4173
PUBLIC_FRONTEND_URL=https://<PAGES_PROJECT>.pages.dev
PUBLIC_API_URL=https://fanscope-api.<你已有的域名>
SCAN_INTERVAL_MINUTES=120
DATABASE_PATH=./data/fanscope.sqlite
```

**密钥生成命令（在服务器执行，复制输出到 `.env`）：**

```bash
openssl rand -hex 32
```

DeepSeek（可选但推荐）：

```text
DEEPSEEK_API_KEY=sk-xxxxxxxx
DEEPSEEK_MODEL=deepseek-flash
MAX_AI_PER_SCAN=10
```

邮件通知（你要求的功能，需要验证发信域名后才能生效）：

```text
RESEND_API_KEY=re_xxxxxxxxxx
EMAIL_FROM=FanScope <research@your-verified-domain.com>
```

到 [Resend](https://resend.com/) 账户后台验证你拥有的发信域名，并按其指示添加 DNS 记录。可以复用已有域名；不需为了发送邮件新购域名。已有 SPF、DKIM、MX 记录应谨慎合并，避免影响现有邮箱服务。

启动容器：

```bash
cd ~/fanscope
sudo docker compose -f deploy/docker-compose.yml up -d --build
sudo docker compose -f deploy/docker-compose.yml ps
sudo docker compose -f deploy/docker-compose.yml logs --tail=100 -f
```

新终端检查：

```bash
curl http://127.0.0.1:8787/api/health
curl http://127.0.0.1:8787/api/journals
```

输出应包含 `status:ok`；`emailConfigured:false` 意味着**尚未就绪，邮件不会发送**，应排查 Resend 密钥、发信域名与 PUBLIC_API_URL。

## C. 为后端添加可公开访问的 HTTPS（不买新域名）

如果 `adapttochina.com` 仍归你所有、DNS 在 Cloudflare，可使用它的**子域名**，例如 `fanscope-api.adapttochina.com`。名字可自行改。

1. 在 Cloudflare → 该域名 → DNS → Add record：A，名称 `fanscope-api`，值填曼谷服务器公网 IPv4。**先切换 DNS only（灰云）**。
2. 确保云服务器安全组允许 80/443，Ubuntu 防火墙已放行且原有网站不受影响。无需开放 8787 对公网。
3. 安装或确认 Nginx 和 Certbot：

```bash
sudo apt-get update
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

4. **只新增一个** `server_name` 配置文件：

```bash
sudo cp deploy/nginx-site.example.conf /etc/nginx/sites-available/fanscope-api
sudo nano /etc/nginx/sites-available/fanscope-api
# 将所有 fanscope-api.example.com 改成真实子域名
sudo ln -s /etc/nginx/sites-available/fanscope-api /etc/nginx/sites-enabled/fanscope-api
sudo nginx -t
sudo systemctl reload nginx
```

5. 申请 HTTPS 证书：

```bash
sudo certbot --nginx -d fanscope-api.<你拥有的域名>
```

6. 检查公网 `https://fanscope-api.<域名>/api/health` 能返回 JSON。需要 Cloudflare 代理时，确认域名正常签发证书后可开启橙云，并将 Cloudflare SSL 模式设为 Full (strict)。

**若你的服务器已经有其他证书、反向代理或端口冲突**，请根据现有布局合并一个新的 `server` 配置，不要复制覆盖原配置。请先检查 `sudo nginx -T` 和 `sudo ss -lntp`。

## D. 部署 Cloudflare Pages 前端

1. 在电脑或 GitHub 仓库中修改 `web/config.js` 的 `API_BASE_URL` 为上述**HTTPS 后端完整域名**，例如：

```js
window.FANSCOPE_CONFIG = {
  API_BASE_URL: 'https://fanscope-api.adapttochina.com'
};
```

2. 提交该更改到 GitHub（不要把 DeepSeek / Resend / ADMIN_KEY 写入该文件）。
3. Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to GitHub，选择 `fanscope` 仓库。
4. 设置如下：

| Pages 配置项 | 值 |
|---|---|
| Production branch | `main` |
| Framework preset | `None` / 静态网站 |
| Root directory | `web` |
| Build command | `exit 0` |
| Build output directory | `.`（相对于 web 根目录） |

5. 选择或确认项目名 `fanscope`（如果已经占用，使用其他名称），自动得到 `https://<PROJECT>.pages.dev`。
6. 进入网站，先看页眉“API 已连接”，再看「监测健康状态」。若无法连接，请核对浏览器 F12 → Network 中是否有 CORS、DNS、SSL 错误。
7. 若 Pages 站点与 `ALLOWED_ORIGINS` 里的域名不同，必须同步修改服务器 `.env` 然后 `sudo docker compose -f deploy/docker-compose.yml up -d` 让配置生效。

## E. 首次同步和持续监测

- `SCAN_ON_START=true`（默认）启动后尝试扫描 5 本启用的英文期刊。
- 首次默认回看最近14天的发表论文，**初始回填不发及时提醒**，避免第一天收到大量历史文章。
- 之后每120分钟查看 Crossref 的新索引/更新数据，按 DOI 去重；一篇论文在“Online First”和正式期号重复出现时原则上只保留一份。
- 运行/检查：

```bash
sudo docker compose -f deploy/docker-compose.yml logs --tail=150 fanscope-api
curl https://fanscope-api.<你的域名>/api/system-status
```

- 若想检查历史：`sudo docker compose -f deploy/docker-compose.yml exec fanscope-api node --experimental-sqlite src/cli.mjs scan --backfill --days=30`。**注意**初始 Crossref 单次最大页数限制：超过上限会报告部分失败并保留检查点，不会默默跳过。大规模三年历史建库不属于此轻量监测器的初始范围。
- 期刊列表维护：修改 `api/config/journals.json`，新建条目必须有稳定 ID / ISSN / 官方来源；重启容器（重新 build）让配置生效。

## F. 中文 C 刊接入步骤

`api/config/journals.json` 内有中文刊物候选，但 RSS URL 为空、`enabled:false`。这意味着**还未监测成功，不能假装有自动更新**。

**如果期刊官网公开并允许使用 RSS/Atom**：填写 `rss_url` 为真实官方地址，`enabled:true`，重新构建并重启 API。通用 RSS 解析器只支持标准字段，复杂格式可能需要开发专属 adapter；务必先观察 `last_success`、新增文章的真实 DOI / 链接。

**如果只有 CSSCI/知网授权结果**：从你有合法权限的来源整理题录，按 `examples/chinese-papers.json` 的字段替换真实内容，运行：

```bash
sudo docker cp ./your-real-papers.json fanscope-api:/tmp/papers.json
sudo docker exec fanscope-api node --experimental-sqlite src/cli.mjs import /tmp/papers.json
```

该 JSON 示例是模板，不是可以直接导入的真实论文。CSSCI 来源版/扩展版与 JCR 年度分区须另做授权与年份核验。

## G. 数据备份、密钥与安全

- 后端 SQLite 位于 Compose 持久卷 `fanscope_data`，不是 GitHub。
- 数据库使用 WAL；备份前可以安排维护窗口暂停容器，然后对 Compose 数据卷做快照，不要在写入中直接只复制 `.sqlite` 而漏掉 WAL。
- `api/.env`、GitHub Personal Access Token、DeepSeek 和 Resend API Key **不得**进入前端代码、公开仓库、聊天截图。
- 仅开放服务器公网的 Nginx 80/443，Docker API 只绑定 127.0.0.1。
- 服务器如位于境外、课题组在国内，需实际测试校园网络连接。国内研究人员的订阅邮箱属于个人信息，正式运行前请取得同意并提供退订。
- 当前 v1 只做论文公共元数据；**不得将课题组原始调查、访谈或群聊资料上传到本系统或第三方 AI**。

## H. 验收结果判定

`curl https://fanscope-api.<你的域名>/api/health` 必须 200；首页无 CORS 报错；英文期刊 `last_success` 有新时间；邮件服务 `emailConfigured:true`；用个人真实邮箱订阅后收到验证邮件并完成验证；后续相关新文章触发通知。详见 `docs/ACCEPTANCE-ZH.md`。
