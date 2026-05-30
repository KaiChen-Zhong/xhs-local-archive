# 交付说明

## 项目定位

本项目是小红书收藏/点赞卡片的本地整理工具。浏览器扩展负责采集当前页面中已可见或页面正常返回的卡片数据，Native Messaging 宿主负责本地数据库、媒体缓存、AI 分类和导出文件写入。

当前版本只整理卡片级数据：

- 标题
- 封面
- 作者
- noteId
- 来源 URL
- AI 分类路径

不打开帖子，不读取正文，不采集评论。

## 核心能力

- Chrome/Edge MV3 扩展侧栏。
- 收藏/点赞页手动采集。
- 低频受控扫描。
- 标题与封面驱动的 AI 分类。
- 五层以内受控 taxonomy tree。
- 待审分类批准/拒绝。
- 分类合并与锁定。
- 小红书式瀑布流分类浏览。
- 本地 Markdown、JSON、CSV、JSONL 导出。
- 本地删除。
- 诊断日志和自检报告。

## 目录说明

- `extension/`：浏览器扩展源码。
- `native-host/`：Native Messaging 本地宿主。
- `shared/`：扩展与宿主共用工具。
- `scripts/`：宿主安装、卸载、校验、自检脚本。
- `tests/`：自动化测试。
- `README.md`：安装、使用、测试说明。
- `SAFETY.md`：安全边界。
- `package.json`：Node.js 测试与检查入口。

## 不进入公开仓库的内容

- 本地归档数据库。
- 本地媒体缓存。
- AI 或 GitHub 密钥。
- 浏览器 profile、缓存、日志。
- 调研草稿和一次性规划文档。
- `.firecrawl/` 抓取资料。

## 安装概览

1. 安装 Node.js 20 或更高版本。
2. 在 Chrome/Edge 扩展管理页启用开发者模式。
3. 加载 `extension/` 目录。
4. 复制浏览器分配的扩展 ID。
5. 按 `README.md` 安装 Native Messaging 宿主。
6. 在扩展选项页检查本地宿主连通性。

## 验证命令

```bash
npm test
npm run self-test
npm run content-test
npm run worker-test
npm run bridge-test
```

`npm run check` 在具备 `sh` 的环境中可完整通过；纯 Windows PowerShell 环境下，最后的 macOS shell 脚本语法检查会因缺少 `sh` 失败，JavaScript 语法检查部分仍可执行。
