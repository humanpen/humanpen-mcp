# humanpen-mcp

**让你的 AI Agent 真正会处理文档。** 一个 MCP server，让 Claude、Codex、Cursor
以及任何 MCP 客户端能直接对硬盘上的 `.docx`、`.pptx`、`.pdf` 动手：降低 AI 检测
率、转换参考文献格式、按字数缩写、或者翻译——排版、表格、图片、引文和公式全部
保持原样。

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-stdio-000000.svg)](https://modelcontextprotocol.io)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933.svg)](https://nodejs.org)

[English](README.md) · 简体中文 · [日本語](README.ja.md)

```bash
claude mcp add humanpen -e HUMANPEN_API_KEY=hp_your_key -- npx -y humanpen-mcp
```

> *「这是我的论文和 Turnitin 报告——只改被标红的部分，然后把参考文献转成 IEEE 格式。」*
>
> Agent 读报告、只重写被标出的段落、转换引文格式，最后把两个文件路径交给你。
> 整个过程它没有读过论文正文。

## 为什么不直接把文字贴进对话

**它处理的是文件本身，不是文字的副本。** 把一章贴进对话，回来的是一段散文——
标题层级没了、表格没了、图表编号没了、参考文献列表没了、公式没了。HumanPen 改的
是文档本身、返回的也是文档，产出用 Word 打开还是原来的样子。

**文档内容不进入模型上下文。** server 从硬盘读文件、上传、然后只回一个写好的
路径。一篇 40 页的论文不消耗你任何 token，也不会被抄进对话记录里。

**可以由检测报告来指挥。** 把 Turnitin 或 iThenticate 的 AI Writing 报告 PDF 一并
给它，它就**只**重写报告标出的那些段落，其余部分逐字节不动。为了改四分之一的
内容而重写整篇，正是引文和原意被破坏的原因。

**一次工具调用 = 一个完整任务。** server 负责上传、轮询、下载、把结果存到源文件
旁边。不会出现「先给你个 job id，记得自己去查」这种让模型跟丢的循环。

## 获取 API Key

在 <https://humanpen.net/settings> 创建。新账号赠送 100 积分——够处理一篇 1000 词
的文档。计费为**实际处理**每 1000 词 100 积分，每个任务最低 10 积分。
**失败和取消的任务不计费。**

Key 放在环境变量里，绝不放进 URL——URL 会留在服务端日志、代理日志、shell 历史和
截图里。

## 安装

<details open>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add humanpen -e HUMANPEN_API_KEY=hp_your_key -- npx -y humanpen-mcp
```

如果你的版本不认 `-e`（[上游已有反馈](https://github.com/anthropics/claude-code/issues/62332)），
用 JSON 形式：

```bash
claude mcp add-json humanpen '{"command":"npx","args":["-y","humanpen-mcp"],"env":{"HUMANPEN_API_KEY":"hp_your_key"}}'
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
<summary><b>Claude Desktop</b></summary>

写进 `claude_desktop_config.json`：

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
| `humanize_document` | 重写 `.docx`/`.pptx`，让它读起来像人写的、在 AI 检测器上得分更低。可传入检测报告，只改被标出的段落。 | 是 |
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

**`ai_percent` 可能是 `null`，而 `null` 不等于 0。** 当提交文本太短、无法评估时，
报告打印的是 `*` 而不是数字。把它当成「AI 率 0%」是在替别人下没下过的结论。

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
  Claude Code 技能，不想跑 server 就用它
- [humanpen.net](https://humanpen.net)

Apache-2.0
