# humanpen-mcp

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-stdio-000000.svg)](https://modelcontextprotocol.io)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933.svg)](https://nodejs.org)

[English](README.md) · [简体中文](README.zh-CN.md) · 日本語

[公式サイト](https://humanpen.net) · [料金](https://humanpen.net/pricing) · [開発者ドキュメント](https://humanpen.net/developers)

> **キーワード:** AI ヒューマナイザー, MCP サーバー, Turnitin AI 検出, AI 検出スコア低減, DOCX AI 書き換え, AI 検出回避, Claude MCP, Cursor MCP

**指摘された箇所だけ書き直す。フォーマットはそのまま。** [HumanPen](https://humanpen.net) の MCP サーバー——文書レベルの AI ヒューマナイザーです。文書全体の AI 率低減、ユーザー指定箇所の書き直し、Turnitin / iThenticate の AI 率検出レポートに基づく指摘箇所の自動特定と書き直しに対応し、`.docx` / `.pptx` のレイアウト、表、画像、引用、数式をそのまま保持します。12 種の引用形式変換、語数指定の要約、12 言語間の翻訳にも対応します。

```bash
claude mcp add humanpen -s user -e HUMANPEN_API_KEY=hp_your_key -- npx -y humanpen-mcp
```

## 特長

- **検出レポートで改写範囲を特定** — Turnitin / iThenticate の AI Writing レポートを読み込み、指摘された段落だけを書き直します。指摘のない部分は一切触れません
- **元のフォーマットで入り、元のフォーマットで返る** — DOCX は DOCX のまま、PPTX は PPTX のまま。レイアウト、表、画像、数式はそのまま保持され、結果はそのまま編集できます
- **学術構造を保護** — 文中引用、参考文献、脚注、目次フィールド、相互参照、図表番号、数式、特殊書式は保護対象として扱われます
- **エラー注入なし** — 意味と構文を再構成して表現を変えます。文法ミスやスペルミス、不自然な文を検出回避の手段にはしません
- **長文をそのまま処理** — 入力語数の上限なし。1 ファイル最大 100 MB、テキストボックスに分割する必要はありません
- **文書はモデルのコンテキストに入らない** — ファイルをアップロードし、パスを返すだけ。40 ページの論文でもトークンゼロ、会話ログにも残りません
- **1 回の呼び出しで完結** — アップロード、ポーリング、ダウンロード、保存まで一括。ジョブ ID のポーリングループは不要
- **書き直した分だけ課金** — 実際に変更された語数で課金。文書全体ではありません。失敗・キャンセルは無料。クレジットに有効期限なし

## API キーの取得

<https://humanpen.net> で登録し、<https://humanpen.net/settings/api-keys> で
キーを作成します。新規アカウントには無料クレジットが付くので、文書を 1 本
通して結果を確かめられます。

キーは環境変数に置き、URL には決して入れません。URL はサーバーログ、プロキシ
ログ、シェル履歴、スクリーンショットに残ります。

## インストール

<details open>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add humanpen -s user -e HUMANPEN_API_KEY=hp_your_key -- npx -y humanpen-mcp
```

`-s user` ですべてのプロジェクトから使えます。既定の `local` はコマンドを実行した
ディレクトリでしか読み込まれず、別の場所で Claude Code を開くとインストールに
失敗したように見えます。

お使いのバージョンが `-e` を受け付けない場合（[上流で報告済み](https://github.com/anthropics/claude-code/issues/62332)）は
JSON 形式で：

```bash
claude mcp add-json humanpen -s user '{"command":"npx","args":["-y","humanpen-mcp"],"env":{"HUMANPEN_API_KEY":"hp_your_key"}}'
```
</details>

<details>
<summary><b>OpenAI Codex</b></summary>

`~/.codex/config.toml` に：

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

設定で `${VAR}` 展開が使えるため、キーを環境変数に置いたままにできます：

```json
{ "mcpServers": { "humanpen": {
  "command": "npx", "args": ["-y", "humanpen-mcp"],
  "env": { "HUMANPEN_API_KEY": "${HUMANPEN_API_KEY}" }
} } }
```

全体は `~/.codebuddy/.mcp.json`、プロジェクト単位は `<project>/.mcp.json`。
</details>

<details>
<summary><b>Gemini CLI</b></summary>

`gemini mcp add` がありますが、引数の順序はバージョンによって異なります——
`gemini mcp add --help` が表示する usage に従ってください。キーは
`-e HUMANPEN_API_KEY=...`、スコープは `-s user`（既定の `project` は実行した
ディレクトリのみ）。
</details>

<details>
<summary><b>Claude Desktop</b></summary>

`claude_desktop_config.json` に。**`npx` は絶対パスで指定してください**——
`which npx` の結果を貼ります。デスクトップアプリは OS から最小限の `PATH` で
起動されるため、端末で動く短い名前がここでは見つからないことが多く、症状は
「ツールが現れない」だけです。

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

3 つとも同じ形式です——Cursor は `.cursor/mcp.json`、Windsurf は
`~/.codeium/windsurf/mcp_config.json`、Cline は MCP 設定パネル：

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

`opencode.json` に——キー名だけ他と少し異なります：

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
<summary><b>VS Code</b> — キーを設定ファイルに残さない方法</summary>

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

VS Code は一度だけ入力を求め、シークレットストアに保存します。コミットしうる
ファイルには残りません。
</details>

<details>
<summary><b>ソースから</b>、または npm 公開前に</summary>

```bash
git clone https://github.com/humanpen/humanpen-mcp
cd humanpen-mcp && npm install && npm run build
```

クライアント設定の `npx -y humanpen-mcp` を
`node /path/to/humanpen-mcp/dist/index.js` に置き換えてください。
</details>

MCP クライアントであれば何でも動きます。これは `npx -y humanpen-mcp` で起動し、
環境変数に `HUMANPEN_API_KEY` を持つ、ごく普通の stdio サーバーです。

## ツール

| ツール | 内容 | 課金 |
| --- | --- | --- |
| `humanize_document` | `.docx`/`.pptx` を人が書いたように書き直し、AI 検出スコアを下げます。検出レポートを渡して指摘箇所だけを書き直せます。仕上がりの文字数は全体の範囲、または段落ごとの範囲で指定できます（試験的機能——文字数を制限すると AI 率低減の効果が弱まります）。 | あり |
| `free_rehumanize` | 完了済みの `humanize_document` ジョブを**無料**で続行：その結果の新しい検出レポートを渡し、まだ指摘された箇所だけを書き直します。ジョブごとに1回、1日の上限あり。レポートはその結果に一致している必要があります。 | 無料 |
| `fix_citations` | 文中引用と参考文献一覧を APA 7、MLA 9、Harvard、Chicago、IEEE、Vancouver、GB/T 7714、AMA、ACS、OSCOLA に変換します。本文は変更しません。 | あり |
| `condense_document` | `.docx` を目標字数まで短縮します。構成と引用は保持されます。 | あり |
| `translate_document` | `.docx`/`.pdf`/`.pptx`/`.xlsx`/`.epub`/`.html`/`.txt` を 12 言語間で翻訳し、レイアウトを保ちます。 | あり |
| `read_detection_report` | Turnitin / iThenticate の AI Writing レポートを読み、全体の AI 率と指摘箇所を返します。 | 無料 |
| `check_job` | ジョブを照会し、結果をダウンロードします。 | 無料 |
| `get_credit_balance` | 残りクレジット。 | 無料 |

## 知っておくとよい 2 点

**ジョブは分単位、ツール呼び出しはそうではありません。** 各操作は約 55 秒待ち——
多くの文書はこれで足ります——その後 `job_id` と「`check_job` を呼ぶこと」という
注記を返します。いずれにせよサーバー側の処理は続くので、早く返っても失われる
ものはありません。

**`ai_percent` が `null` になるのは、多くの場合よい知らせです。** AI 検出率が
**20% を下回る**とき、Turnitin は数値ではなく `*` を出力します。その区間は
誤検出が多すぎるため、数値を出さない方針だからです。つまり `null` は「20% 未満、
Turnitin はそれ以上言わない」であって、0 でも「結果なし」でもありません。

## よくある質問

**Turnitin の AI 率は下がりますか。**
`balanced` なら通常 1 回で 20% 未満——Turnitin が数値をやめて `*` を出す境目——
まで下がります。届かなければ、結果と新しいレポートをもう一度渡せば、まだ指摘の
ある箇所だけが書き直されます。

**iThenticate のレポートにも対応していますか。**
はい。どちらも渡せます。形式はファイルから判別します。

**文書はモデルのコンテキストに送られますか。**
いいえ。ファイルをアップロードし、パスを返すだけです。40 ページの論文でも
トークンは消費しません。

## 開発

```bash
npm install
npm run build
HUMANPEN_API_KEY=hp_... node selftest.mjs sample.docx report.pdf
```

`selftest.mjs` はビルド成果物を起動し、実際のクライアントと同じように stdio 上で
JSON-RPC を話します。関数が返ることではなく、プロトコル、ツール登録、stdout の
クリーンさ、そして実ジョブ 1 件を検証します。実キーが必要でクレジットを消費する
ため、CI ではなくリリース前チェックとして位置づけています。

## リンク

- [API ドキュメント](https://api.humanpen.net/v1/docs.md) ·
  [OpenAPI スキーマ](https://api.humanpen.net/v1/openapi.json)
- [humanpen-skill](https://github.com/humanpen/humanpen-skill) — 同じ機能を
  Agent Skill として。サーバーを動かしたくない場合はこちら
- [humanpen.net](https://humanpen.net)

Apache-2.0
