# humanpen-mcp

**Give your AI agent the ability to work on real documents.** An MCP server that
lets Claude, Codex, Cursor and any other MCP client take a `.docx`, `.pptx` or
`.pdf` on disk and lower its AI-detection score, convert its citations to
another style, condense it to a word budget, or translate it — with formatting,
tables, images, citations and formulas intact.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-stdio-000000.svg)](https://modelcontextprotocol.io)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933.svg)](https://nodejs.org)

English · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

```bash
claude mcp add humanpen -e HUMANPEN_API_KEY=hp_your_key -- npx -y humanpen-mcp
```

> *"Here's my thesis and the Turnitin report — rewrite just the flagged parts,
> then put the references in IEEE style."*
>
> The agent reads the report, rewrites only the passages it marked, converts the
> citations, and hands back two file paths. It never had to read the thesis.

## Why this instead of pasting text into the chat

**It works on the file, not on a copy of the text.** Paste a chapter into a chat
and you get prose back — no headings, no tables, no figure numbering, no
reference list, no equations. HumanPen edits the document itself and returns a
document, so what comes out still opens in Word looking like what went in.

**The document never enters the model's context.** The server reads the file
from disk, uploads it, and answers with the path it wrote. A 40-page paper costs
you no tokens and is not copied into a transcript.

**It can be guided by a detection report.** Give it the Turnitin or iThenticate
AI Writing PDF and it rewrites *only* the passages that report flagged, leaving
everything else byte-identical. Rewriting a whole document to fix a quarter of
it is how citations and meaning get damaged.

**One tool call is one finished job.** The server uploads, polls, downloads, and
saves the result next to the source. No "here's a job id, remember to check it"
loop for the model to lose track of.

## Get a key

Create one at <https://humanpen.net/settings>. New accounts get 100 free
credits — enough for a 1,000-word document. Pricing is 100 credits per 1,000
words actually processed, 10 credits minimum per job. **Failed and cancelled
jobs cost nothing.**

The key goes in an environment variable, never in a URL. URLs end up in server
logs, proxy logs, shell history and screenshots.

## Install

<details open>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add humanpen -e HUMANPEN_API_KEY=hp_your_key -- npx -y humanpen-mcp
```

If your version rejects `-e` ([reported
upstream](https://github.com/anthropics/claude-code/issues/62332)), use the JSON
form:

```bash
claude mcp add-json humanpen '{"command":"npx","args":["-y","humanpen-mcp"],"env":{"HUMANPEN_API_KEY":"hp_your_key"}}'
```
</details>

<details>
<summary><b>OpenAI Codex</b></summary>

In `~/.codex/config.toml`:

```toml
[mcp_servers.humanpen]
command = "npx"
args = ["-y", "humanpen-mcp"]
env = { HUMANPEN_API_KEY = "hp_your_key" }
```
</details>

<details>
<summary><b>Claude Desktop</b></summary>

In `claude_desktop_config.json`:

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

All three read the same shape — Cursor in `.cursor/mcp.json`, Windsurf in
`~/.codeium/windsurf/mcp_config.json`, Cline in its MCP settings panel:

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

In `opencode.json` — the key names differ slightly from everyone else's:

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
<summary><b>VS Code</b> — keeps the key out of the config file</summary>

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

VS Code prompts once and stores the key in its secret store, so it never lands
in a file you might commit.
</details>

<details>
<summary><b>From source</b>, or before the npm release lands</summary>

```bash
git clone https://github.com/humanpen/humanpen-mcp
cd humanpen-mcp && npm install && npm run build
```

Then point your client at `node /path/to/humanpen-mcp/dist/index.js` instead of
`npx -y humanpen-mcp`.
</details>

Any MCP client works: this is a plain stdio server started by
`npx -y humanpen-mcp` with `HUMANPEN_API_KEY` in its environment.

## Tools

| Tool | What it does | Credits |
| --- | --- | --- |
| `humanize_document` | Rewrite a `.docx`/`.pptx` to read as human-written and score lower on AI detectors. Optionally takes a detection report and rewrites only its flagged passages. | yes |
| `fix_citations` | Convert in-text citations and the reference list to APA 7, MLA 9, Harvard, Chicago, IEEE, Vancouver, GB/T 7714, AMA, ACS or OSCOLA. Body text untouched. | yes |
| `condense_document` | Shorten a `.docx` to a target word count, keeping structure and citations. | yes |
| `translate_document` | Translate `.docx`/`.pdf`/`.pptx`/`.xlsx`/`.epub`/`.html`/`.txt` between 12 languages, keeping layout. | yes |
| `read_detection_report` | Read a Turnitin or iThenticate AI Writing report: overall AI percentage and the flagged passages. | free |
| `check_job` | Look up a job and download its result. | free |
| `get_credit_balance` | Credits remaining. | free |

## Two things worth knowing

**Jobs take minutes; tool calls do not.** Each operation waits about 55 seconds
— enough for most documents — then returns a `job_id` with a note to call
`check_job`. The work continues on the server either way; nothing is lost by the
tool returning early.

**`ai_percent` can be `null`, and `null` is not zero.** A report prints `*`
instead of a number when the submission is too short to assess. Reporting that
as "0% AI" would be a claim nobody made.

## Development

```bash
npm install
npm run build
HUMANPEN_API_KEY=hp_... node selftest.mjs sample.docx report.pdf
```

`selftest.mjs` spawns the built server and talks JSON-RPC to it over stdio the
way a real client does — proving the protocol, the tool registrations, stdout
hygiene and one end-to-end job, not merely that the functions return. It needs a
live key and spends credits, so it is a pre-release check rather than a CI step.

## Links

- [API documentation](https://api.humanpen.net/v1/docs.md) ·
  [OpenAPI schema](https://api.humanpen.net/v1/openapi.json)
- [humanpen-skill](https://github.com/humanpen/humanpen-skill) — the same
  operations as a Claude Code skill, if you would rather not run a server
- [humanpen.net](https://humanpen.net)

Apache-2.0
