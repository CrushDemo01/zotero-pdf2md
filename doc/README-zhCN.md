# zotero-pdf2md

[English](../README.md)

`zotero-pdf2md` 是一个面向 Zotero 7 的插件，用来把 PDF 附件转换为 Markdown 源包、译文 Markdown，以及可直接预览的 HTML。

它的核心流程是：

- 使用 Mistral OCR 把 PDF 提取为结构化 Markdown
- 使用兼容 OpenAI 的 LLM API 做翻译或复核
- 本地生成 HTML 预览，并尽量内联图片，提升 Zotero 内外的显示稳定性

## 功能

- 右键 PDF 附件可执行：
  - `PDF 转 Markdown`
  - `PDF 转 Markdown 并翻译`
- 右键 Markdown 附件可执行：
  - `Markdown→HTML（快速）`
  - `Markdown→HTML（复核增强）`
- 自动把 `mistral.md`、`target.md`、`asset_index.md`、`*.preview.html` 挂到论文条目下
- 自动创建 Zotero note，用于结果摘要和 HTML 预览
- 使用原生 MathML 渲染公式，减少 Zotero 中的公式错乱

## 运行要求

- Zotero 7
- 开发环境需要 Node.js 20+
- Python 3.10+
- `MISTRAL_API_KEY`
- 一个兼容 OpenAI 的 LLM API Key / Base URL / Model

## 安装

### 普通用户

1. 从 Releases 下载最新的 `.xpi`
2. 在 Zotero 中打开 `工具 -> 插件`
3. 安装 `.xpi`
4. 打开插件设置，填写：
   - `Mistral API 密钥`
   - `LLM API 密钥`
   - `LLM Base URL`
   - `模型名称`

### 源码构建

```bash
npm install
npm run build
```

构建出的插件包在：

```text
.scaffold/build/zotero-pdf-2-md.xpi
```

## 开发

先复制开发环境配置：

```bash
cp .env.example .env
```

填好 Zotero 可执行文件和开发 profile 后运行：

```bash
npm start
```

也可以用辅助脚本：

```bash
./start-dev.sh
```

常用命令：

- `npm start`：开发模式与热重载
- `npm run build`：生产构建与 TypeScript 检查
- `npm run test`：运行测试
- `npm run lint:check`：检查格式和 lint
- `npm run lint:fix`：自动修复格式和 lint

## 插件配置项

设置页支持：

- 源语言
- 目标语言
- Python 路径
- `Mistral API 密钥`
- `LLM API 密钥`
- `LLM Base URL`
- `模型名称`
- `生成 HTML 后使用 LLM 复核 Markdown`
- `将 OCR 内联图片保存为本地文件`

不要把 API 密钥提交到仓库。密钥应只保存在 Zotero 插件设置或本地环境中。

## 仓库结构

- `src/`：TypeScript 插件代码
- `addon/`：Zotero 清单、首选项、本地化、内置 Python 脚本
- `addon/content/python/`：OCR、翻译、HTML 复核脚本
- `scripts/`：本地开发辅助脚本
- `doc/`：多语言说明文档

## 开源发布前检查

发布前建议至少检查：

1. `.env`、日志、生成的预览文件、本地测试文件没有进入提交
2. `npm run build` 通过
3. 在 Zotero 里实际测试四个右键动作
4. 检查设置页文本、生成附件、HTML 预览是否正常
5. 上传 `.scaffold/build/zotero-pdf-2-md.xpi` 到 GitHub Releases

## 许可证

AGPL-3.0-or-later，详见 [LICENSE](../LICENSE)。
