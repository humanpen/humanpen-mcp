# humanpen-mcp

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-stdio-000000.svg)](https://modelcontextprotocol.io)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933.svg)](https://nodejs.org)

English · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

[Website](https://humanpen.net) · [Pricing](https://humanpen.net/pricing) · [Developer docs](https://humanpen.net/developers)

> **Keywords:** ai humanizer, mcp server, model context protocol, turnitin ai detection, reduce ai score, humanize ai text, bypass ai detection, docx ai humanizer, ai content rewriter, ai writing tool, claude mcp, cursor mcp, ithenticate ai report

**Humanize what's flagged. Preserve the rest.** An MCP server for [HumanPen](https://humanpen.net) — a document-level AI humanizer that can humanize an entire document, rewrite user-selected passages, or automatically target flagged text from a Turnitin / iThenticate AI-detection report, editing `.docx` / `.pptx` files in place while preserving formatting, tables, images, citations, and formulas. Also converts citations between 12 styles, condenses to a word budget, and translates between 12 languages.

```bash
claude mcp add humanpen -s user -e HUMANPEN_API_KEY=hp_your_key -- npx -y humanpen-mcp
```

## Features

- **Selective rewriting by detection report** — import a Turnitin / iThenticate AI Writing Report to pinpoint flagged passages; unflagged content is never touched
- **Format in, format out** — a DOCX comes back as a DOCX, a PPTX as a PPTX; formatting, tables, images, and formulas survive intact and the result is still editable
- **Academic structure preserved** — in-text citations, reference lists, footnotes, TOC fields, cross-references, figure numbering, equations, and special formatting are treated as protected objects
- **No error injection** — restructures meaning and syntax to change expression; never adds grammar mistakes, spelling errors, or awkward sentences as a detection strategy
- **Full-length documents** — no per-input word limit; a single file can be up to 100 MB, no splitting into text boxes
- **Free to keep going** — still flagged? Re-humanize for free with a fresh report until the AI rate falls to `*` or 0%
- **Word-count control (experimental)** — set a min/max word range to keep the output within a target length
- **Pay per rewrite** — billed on words actually changed, not the whole document; failed and cancelled jobs cost nothing; credits never expire

## Get a key

Sign up at <https://humanpen.net> and create a key at
<https://humanpen.net/settings/api-keys>. New accounts start with free credits,
enough to put a document through and see what comes back.

The key goes in an environment variable, never in a URL. URLs end up in server
logs, proxy logs, shell history and screenshots.

## Install

<details open>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add humanpen -s user -e HUMANPEN_API_KEY=hp_your_key -- npx -y humanpen-mcp
```

`-s user` puts it in every project. The default scope is `local`, which
loads the server only in the directory you ran the command from — and looks
like a broken install the first time you open Claude Code somewhere else.

If your version rejects `-e` ([reported
upstream](https://github.com/anthropics/claude-code/issues/62332)), use the JSON
form:

```bash
claude mcp add-json humanpen -s user '{"command":"npx","args":["-y","humanpen-mcp"],"env":{"HUMANPEN_API_KEY":"hp_your_key"}}'
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
<summary><b>CodeBuddy / WorkBuddy</b></summary>

```bash
codebuddy mcp add --scope user humanpen -- npx -y humanpen-mcp
```

It also reads `${VAR}` in its config, so the key can stay in your environment
instead of the file:

```json
{ "mcpServers": { "humanpen": {
  "command": "npx", "args": ["-y", "humanpen-mcp"],
  "env": { "HUMANPEN_API_KEY": "${HUMANPEN_API_KEY}" }
} } }
```

`~/.codebuddy/.mcp.json` for every project, `<project>/.mcp.json` for one.
</details>

<details>
<summary><b>Gemini CLI</b></summary>

It has `gemini mcp add`, but the argument order differs between versions — run
`gemini mcp add --help` and follow the usage line it prints. Pass the key with
`-e HUMANPEN_API_KEY=...` and the scope with `-s user`; the default is
`project`, which is only the directory you ran it in.
</details>

<details>
<summary><b>Claude Desktop</b></summary>

In `claude_desktop_config.json`. **Use the absolute path to `npx`** — run
`which npx` and paste the result: a desktop app is launched by the OS with a
minimal `PATH`, so the bare name that works in your terminal often is not found
here, and the only symptom is that the tools never appear.

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
| `humanize_document` | Rewrite a `.docx`/`.pptx` to read as human-written and score lower on AI detectors. Optionally take a detection report, or passages you choose, to rewrite only those. Length can be held to a whole-document word range, or to per-passage ranges (experimental — limiting words weakens AI-rate reduction). | yes |
| `free_rehumanize` | Continue a finished `humanize_document` job for **free**: upload a fresh detection report for its result and only the still-flagged passages are rewritten. Once per job, with a daily cap; the report must match that result. | free |
| `fix_citations` | Convert in-text citations and the reference list to APA 7, MLA 9, Harvard, Chicago, IEEE, Vancouver, GB/T 7714, AMA, ACS or OSCOLA. Body text untouched. | yes |
| `condense_document` | Shorten a `.docx` to a target word count, or only chosen passages, each to its own budget, keeping structure and citations. Condense by rewriting sentences, or by deleting whole low-value sentences and keeping the rest verbatim. | yes |
| `translate_document` | Translate `.docx`/`.pdf`/`.pptx`/`.xlsx`/`.epub`/`.html`/`.txt` between 12 languages, keeping layout. | yes |
| `read_detection_report` | Read a Turnitin or iThenticate AI Writing report: overall AI percentage and the flagged passages. | free |
| `check_job` | Look up a job and download its result. | free |
| `list_jobs` | List your document jobs, newest first, with their status and credits. | free |
| `cancel_job` | Cancel a queued or running job; its reserved credits are returned. | free |
| `retry_job` | Run a failed or cancelled job again with the same settings. | yes |
| `get_credit_balance` | Credits remaining. | free |
| `start_project` | Hand a research, data analysis or writing task to HumanPen's cloud agents, with local files as its input: they scope it with you, propose a plan, do the work, have it reviewed and deliver files. Needs a key created with **Research projects** ticked. | once a plan is confirmed |
| `get_project` | Where a project stands: what it needs from you, the scoping questions or the plan, the agents' last message, the deliveries. | free |
| `wait_for_project` | Wait until a project needs you or has finished. | free |
| `act_on_project` | Confirm the plan, answer questions, top up, take the work as it is, pause, resume, cancel, give feedback. | confirming, topping up |
| `message_project` | Write to the agents, with files: more context, or changes after a delivery (a new round). While they work they read it after the step they are on; `deliver_now` hands it over at once. | yes |
| `download_delivery` | Save a delivered version as a zip. | free |
| `rename_project` | Give a project a new name. `start_project` takes a `title` too; without one, a name is made from the request. | free |
| `list_projects` | Your projects, newest first, with their state and what each needs from you: finds a project started in another conversation. | free |
| `delete_project` | Delete a project with its files and deliveries, stopping any work under way. It cannot be undone. | free; credits held are settled by use |

## Three things worth knowing

**Jobs take minutes; tool calls do not.** Each operation waits about 55 seconds
— enough for most documents — then returns a `job_id` with a note to call
`check_job`. The work continues on the server either way; nothing is lost by the
tool returning early.

**`ai_percent` can be `null`, and that is usually good news.** Turnitin prints
`*` instead of a number whenever AI writing comes in **under 20%** — it will not
quantify that band, because too much of it is false positives. So `null` means
"under 20%, and Turnitin will say no more", never "0%" and never "no result".

**A research project asks before it spends.** Its plan comes back to you to confirm with
`act_on_project` (it is then charged by what it uses; there is no price up front), unless you start it with `autonomy` and a `max_credits` you are willing to spend: then it confirms
plans that fit, answers with the recommended answers and goes on by itself, never past that cap for the whole
project. A project runs for minutes to hours; `wait_for_project` waits about 55 seconds at a time, so call it again
until the project needs you or is done.

## Questions people ask

**Will this bring a Turnitin AI score down?**
Usually under 20% in one pass with `balanced` — the threshold below which
Turnitin prints `*` instead of a number. If it misses, hand the result back with
the new report; only the passages still flagged get rewritten.

**Does it work with iThenticate too?**
Yes — pass either report. The format is read from the file.

**Is my document sent to the model?**
No. It uploads the file and answers with a path. A 40-page paper costs no tokens.

## Privacy Policy

Documents you pass to a tool are uploaded over HTTPS to HumanPen's API
(`api.humanpen.net`) for processing; results are written back to your disk, and
processed files are kept server-side for about 7 days so `check_job`, `retry_job`
and the free re-humanize pass can find them. Document contents never enter the model's
context. The full policy — what is collected, retention, and how to reach us —
is at <https://humanpen.net/legal/privacy>.

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
  operations as an Agent Skill, if you would rather not run a server
- [humanpen.net](https://humanpen.net)

Apache-2.0
