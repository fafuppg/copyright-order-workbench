# 软著订单工作台

用于个人软著订单管理的 Web 应用，支持 AI 截图预填、新单与多轮返工、客户联系方式、邮件交付和处理历史。

## 功能

- 新单与补正独立列表，按日期、客户合并展示；双击编辑，勾选完成或代提交时即时反馈，失败恢复原状态。
- AI 对话与截图提取，录入前人工确认；可查询和整理任务、客户与模板。
- 关联返工链路、独立补正、撤销补正和完整任务历史。
- SMTP 发信、IMAP 收发记录同步和已读同步；成功发信后完成任务。
- 纯正文邮件、多文件和压缩包混合附件；富文本模板支持系统自带附件。
- 客户填报凭据加密保存；可选浏览器扩展辅助版权中心账号预填，不自动提交或处理验证码。
- MySQL 业务记录、截图与模板附件持久保存；备份与恢复。

## 运行环境

需要 Node.js 22.12+（当前开发环境为 Node.js 26）、npm 和已有 MySQL 服务。本项目不会安装本地 MySQL。

```sh
npm ci
cp .env.example .env
```

编辑本机 `.env`，填写数据库连接、管理员密码和 `SECRET_KEY`（32 字节随机数据的十六进制表示）。可在终端生成密钥：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

请先在 MySQL 中建立应用数据库并配置专用账号权限。首次启动会建立业务表和管理员账号。

```sh
npm run build
npm start
```

访问 `http://127.0.0.1:3210`，使用 `.env` 中设置的管理员账号和密码。macOS 也可双击 `启动工作台.command`。运行后在设置中配置 AI、SMTP 和 IMAP；留空的邮件和 AI 密钥不随源码提供。

如数据库通过 SSH 隧道访问，将 `.env` 中 `DB_TUNNEL=true`、`DB_PORT=13316`，并在本机创建 `.private/connection.json`（字段为 `host`、`user`、`password`）和经核验的 `.private/known_hosts`。隧道依赖安装方式：

```sh
python3 -m venv .private/venv
.private/venv/bin/pip install paramiko
```

## 文件与数据

- 源码只包含程序和空白配置示例，不含真实账号密码、客户记录、截图、邮箱内容或私人邮件模板。
- `.env`、`.private/`、`data/` 和私人文档均被 Git 排除。
- 普通发送附件临时存于 `data/attachments`，发送成功后清理；模板附件存入 MySQL，可重复发送，不依赖原始本地路径。
- 附件每封最多 10 个；临时文件单个上限 110 MB，模板附件单个上限 10 MB。实际发信还受 MIME 编码后总量与邮件服务商限制。
- 浏览器扩展源码在 `extensions/copyright-login`，安装方式见该目录说明。仅支持配置中的本机工作台地址。

## 开发与验证

```sh
npm run dev
npm run check
npm run build
```

`npm test` 包含数据库集成测试，只能连接专用的 `copyright_workbench_test` 测试数据库；测试会清空该测试库。请先准备隔离的测试库和对应连接权限。测试按串行运行，避免多个套件相互清理数据；邮件测试使用本机模拟服务或模拟传输器。

## 备份与部署

设置页可导出完整业务备份，也可执行 `npm run backup`，输出位于 `.private/backups`。业务备份可能含客户资料和邮件，不应提交到公开仓库。

```sh
npm run restore -- /absolute/path/to/backup.json
```

恢复要求目标数据库没有业务记录。请另行安全保存 `.env` 和 `SECRET_KEY`，用于解密已有设置及客户填报凭据。

提供 `Dockerfile` 和 `compose.yaml`，部署需自行配置现有 MySQL。容器示例使用 Linux host 网络；生产环境应通过 HTTPS 反向代理访问，设置 `COOKIE_SECURE=true`。临时文件使用独立卷。本应用面向单用户、单实例使用，不应同时运行多个发信工作进程。

技术栈：React、TypeScript、Vite、Fastify、MySQL、Tiptap、Nodemailer、ImapFlow。
