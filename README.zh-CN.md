# humanpen-mcp

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-stdio-000000.svg)](https://modelcontextprotocol.io)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933.svg)](https://nodejs.org)

[English](README.md) · 简体中文 · [日本語](README.ja.md)

[官网](https://humanpen.net) · [价格](https://humanpen.net/pricing) · [开发者文档](https://humanpen.net/developers)

> **关键词：** 降AI, AI降重, AI humanizer, MCP server, Turnitin AI检测, 降低AI率, AIGC检测, AI改写工具, DOCX降AI, Claude MCP, Cursor MCP

**哪里标红改哪里，保留格式降 AI。** [HumanPen](https://humanpen.net) 的 MCP server——文档级 AI humanizer，支持全文降 AI，也支持自定义修改片段，还可基于 Turnitin/iThenticate AI 率检测报告自动指定修改片段，定点改写 `.docx` / `.pptx` 中被标记的文本，同时原样保留排版、表格、图片、引文、公式等。另支持 12 种引用格式转换、按目标字数缩写、12 种语言互译。

```bash
claude mcp add humanpen -s user -e HUMANPEN_API_KEY=hp_your_key -- npx -y humanpen-mcp
```

## 功能特性

- **精准定位改写范围** — 导入 Turnitin / iThenticate AI Writing Report 自动定位标红段落；未标记的内容不进入改写范围
- **原格式进、原格式出** — DOCX 处理后仍是 DOCX，PPTX 处理后仍是 PPTX，排版、表格、图片、公式原样保留，结果可继续编辑
- **保护学术结构** — 文内引用、参考文献、脚注、目录域、交叉引用、图表编号、公式和特殊排版被识别为重点保护对象
- **不靠制造错误降 AI** — 通过理解语义和重构句法改变表达，不把语法错误、拼写错误或生硬句子作为策略
- **完整处理长文** — 没有单次输入词数上限，单文件可达 100 MB，不必手工拆成多个文本框
- **免费继续降** — 仍有标红？凭新检测报告免费继续降，直到满意为止
- **目标词数控制（试验中）** — 可设定 min/max 词数区间，让改写结果落在目标范围内
- **只按实际修改量计费** — 按改写词数扣费，不按全文；失败或取消不收费；积分不过期

## 获取 API Key

在 <https://humanpen.net> 注册，然后到 <https://humanpen.net/settings/api-keys>
创建 key。新账号有赠送积分，够跑一篇文档看看效果。

Key 放在环境变量里，绝不放进 URL——URL 会留在服务端日志、代理日志、shell 历史和
截图里。

## 安装

<details open>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add humanpen -s user -e HUMANPEN_API_KEY=hp_your_key -- npx -y humanpen-mcp
```

`-s user` 让它在所有项目里都可用。默认的 `local` 只在你执行命令的那个目录下加载，
换个文件夹打开 Claude Code 就找不到它了，看起来像装失败。

如果你的版本不认 `-e`（[上游已有反馈](https://github.com/anthropics/claude-code/issues/62332)），
用 JSON 形式：

```bash
claude mcp add-json humanpen -s user '{"command":"npx","args":["-y","humanpen-mcp"],"env":{"HUMANPEN_API_KEY":"hp_your_key"}}'
```
</details>

<details>
<summary><b>OpenAI Codex</b></summary>

写进 `~/.codex/config.toml`：

```toml
[mcp_servers.humanpen]
command = "npx"
args = ["-y", "humanpen-mcp"]
env = { HUMANPEN_API_KEY = "hp_your_key" }
```
</details>

<details>
<summary><b>CodeBuddy / WorkBuddy</b></summary>

```bash
codebuddy mcp add --scope user humanpen -- npx -y humanpen-mcp
```

它的配置支持 `${VAR}` 展开，所以密钥可以留在环境变量里、不落进文件：

```json
{ "mcpServers": { "humanpen": {
  "command": "npx", "args": ["-y", "humanpen-mcp"],
  "env": { "HUMANPEN_API_KEY": "${HUMANPEN_API_KEY}" }
} } }
```

全局写 `~/.codebuddy/.mcp.json`，单项目写 `<项目根>/.mcp.json`。
</details>

<details>
<summary><b>Gemini CLI</b></summary>

它有 `gemini mcp add`，但参数顺序各版本不同——跑 `gemini mcp add --help`，照它
打印的 usage 来。密钥用 `-e HUMANPEN_API_KEY=...`，范围用 `-s user`；它默认是
`project`，只在你执行命令的那个目录下生效。
</details>

<details>
<summary><b>Claude Desktop</b></summary>

写进 `claude_desktop_config.json`。**`npx` 要写绝对路径**——跑一下 `which npx`
把结果贴进去：桌面应用由系统启动，`PATH` 是极简的，终端里能用的短名在这里常常
找不到，而唯一的症状就是工具一直不出现。

```json
{
  "mcpServers": {
    "humanpen": {
      "command": "npx",
      "args": ["-y", "humanpen-mcp"],
      "env": { "HUMANPEN_API_KEY": "hp_your_key" }
    }
  }
}
```
</details>

<details>
<summary><b>Cursor / Windsurf / Cline</b></summary>

三者格式一致——Cursor 在 `.cursor/mcp.json`，Windsurf 在
`~/.codeium/windsurf/mcp_config.json`，Cline 在它的 MCP 设置面板：

```json
{
  "mcpServers": {
    "humanpen": {
      "command": "npx",
      "args": ["-y", "humanpen-mcp"],
      "env": { "HUMANPEN_API_KEY": "hp_your_key" }
    }
  }
}
```
</details>

<details>
<summary><b>OpenCode</b></summary>

写进 `opencode.json`——它的字段名和别家略有不同：

```json
{
  "mcp": {
    "humanpen": {
      "type": "local",
      "command": ["npx", "-y", "humanpen-mcp"],
      "environment": { "HUMANPEN_API_KEY": "hp_your_key" }
    }
  }
}
```
</details>

<details>
<summary><b>VS Code</b>——让 key 不落进配置文件</summary>

```json
{
  "mcp": {
    "inputs": [
      { "type": "promptString", "id": "humanpenKey", "description": "HumanPen API key", "password": true }
    ],
    "servers": {
      "humanpen": {
        "command": "npx",
        "args": ["-y", "humanpen-mcp"],
        "env": { "HUMANPEN_API_KEY": "${input:humanpenKey}" }
      }
    }
  }
}
```

VS Code 只问一次，然后存进它自己的密钥库，不会出现在你可能提交的文件里。
</details>

<details>
<summary><b>从源码安装</b>，或在 npm 包发布之前</summary>

```bash
git clone https://github.com/humanpen/humanpen-mcp
cd humanpen-mcp && npm install && npm run build
```

然后把客户端配置里的 `npx -y humanpen-mcp` 换成
`node /path/to/humanpen-mcp/dist/index.js`。
</details>

任何 MCP 客户端都能用：它就是一个用 `npx -y humanpen-mcp` 启动、环境变量里带
`HUMANPEN_API_KEY` 的标准 stdio server。

## 工具

| 工具 | 作用 | 计费 |
| --- | --- | --- |
| `humanize_document` | 重写 `.docx`/`.pptx`，让它读起来像人写的、在 AI 检测器上得分更低。可传入检测报告只改被标出的段落；可限定整篇字数区间，或逐段各设区间（试验功能——限定字数会削弱降 AI 效果）。 | 是 |
| `free_rehumanize` | 对已完成的 `humanize_document` 任务**免费**继续降一次：用该结果的新检测报告，只改写仍被标红的片段。每个任务一次、每日有上限，报告须与该结果匹配。 | 免费 |
| `fix_citations` | 把文内引用和参考文献列表转成 APA 7、MLA 9、Harvard、Chicago、IEEE、Vancouver、GB/T 7714、AMA、ACS 或 OSCOLA。正文不动。 | 是 |
| `condense_document` | 把 `.docx` 缩写到目标字数，保留结构和引文。 | 是 |
| `translate_document` | 在 12 种语言之间翻译 `.docx`/`.pdf`/`.pptx`/`.xlsx`/`.epub`/`.html`/`.txt`，保持排版。 | 是 |
| `read_detection_report` | 读 Turnitin/iThenticate 的 AI Writing 报告：总体 AI 率与被标出的段落。 | 免费 |
| `check_job` | 查任务并下载结果。 | 免费 |
| `get_credit_balance` | 剩余积分。 | 免费 |

## 两件值得知道的事

**任务是分钟级的，工具调用不是。** 每个操作等约 55 秒——对多数文档足够——然后
返回 `job_id` 并提示调用 `check_job`。无论如何服务端都在继续跑，工具提前返回不会
丢任何东西。

**`ai_percent` 可能是 `null`，而这通常是好消息。** 当 AI 率**低于 20%** 时，
Turnitin 打印的是 `*` 而不是数字——这一档它拒绝给出具体数值，因为其中误判太多。
所以 `null` 的意思是「低于 20%，Turnitin 不肯多说」，既不是 0，也不是「没结果」。

## 常见问题

**能把 Turnitin 的 AI 率降下来吗？**
`balanced` 版一般一次就能降到 20% 以下——这正是 Turnitin 改打 `*`、不再给数字的
门槛。没到位就把结果连同新报告再传一次，只重写仍被标出的片段。

**iThenticate 的报告也支持吗？**
支持，两种都能传，格式从文件自动识别。

**我的文档会进模型上下文吗？**
不会。上传文件，返回一个路径。40 页的论文不消耗任何 token。

## 开发

```bash
npm install
npm run build
HUMANPEN_API_KEY=hp_... node selftest.mjs sample.docx report.pdf
```

`selftest.mjs` 会拉起构建产物、像真实客户端一样用 stdio 讲 JSON-RPC——验证的是
协议、工具注册、stdout 干净程度和一次真实任务，而不只是「函数能跑」。它需要真实
key 且会消耗积分，所以定位是**发版前的检查**，不是 CI 步骤。

## 相关链接

- [API 文档](https://api.humanpen.net/v1/docs.md) ·
  [OpenAPI schema](https://api.humanpen.net/v1/openapi.json)
- [humanpen-skill](https://github.com/humanpen/humanpen-skill)——同样的能力做成
  Agent Skill，不想跑 server 就用它
- [humanpen.net](https://humanpen.net)

Apache-2.0
