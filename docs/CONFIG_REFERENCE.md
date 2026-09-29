# 設定リファレンス

`sfdx-pipeline.config.yml` の全キーです。編集後は必ず `npx sfdx-devops-kit validate`
を実行してください。問題のある YAML パスと、必要な GitHub Secrets を出力します。

[English version](CONFIG_REFERENCE.en.md)

---

## トップレベル

| キー                  | 型     | 既定値         | 説明                               |
| --------------------- | ------ | -------------- | ---------------------------------- |
| `version`             | string | `"1.0"`        | 現在は `1.0` のみ対応              |
| `project_name`        | string | ディレクトリ名 | 生成ドキュメントに表示されます     |
| `environments`        | map    | —              | 最低 1 つ必要                      |
| `pipeline_settings`   | map    | 下記参照       | ステージ設定                       |
| `ai_assist`           | map    | 下記参照       | rtk-sf 連携                        |
| `backlog_integration` | map    | 下記参照       | 課題キー・ステータス・MCP サーバー |

---

## `environments.<key>`

```yaml
environments:
  st:
    alias: "STSandbox"
    type: "sandbox"
    is_test_target: true
    deploy_manifest: "manifest/package.xml"
    auth_secret: "SF_CUSTOM_SECRET"
```

| キー              | 型            | 必須 | 説明                                                                                  |
| ----------------- | ------------- | ---- | ------------------------------------------------------------------------------------- |
| `alias`           | string        | ○    | Salesforce CLI が認識している org 別名またはユーザー名                                |
| `type`            | enum          | ○    | `sandbox` / `production` / `scratch` / `developer`                                    |
| `is_test_target`  | bool          | —    | CI の検証・E2E の既定ターゲット。**ちょうど 1 つ**の環境のみ設定可、production は不可 |
| `deploy_manifest` | string        | —    | `--manifest` の値                                                                     |
| `source_dir`      | string        | —    | `--source-dir` の値                                                                   |
| `metadata`        | string / list | —    | `--metadata` の値                                                                     |
| `auth_secret`     | string        | —    | 導出される Secret 名を上書き                                                          |

**デプロイセレクタは 1 環境につき 1 つだけ。** `sf project deploy start` は
`--manifest` / `--source-dir` / `--metadata` の併用を拒否するため、2 つ書いた時点で
検証エラーになります（デプロイ失敗を待ちません）。いずれも無い場合は、プロジェクトの
既定パッケージディレクトリがデプロイされます。

Secret 名は `SF_<KEY>_AUTH_URL` として導出されます（`st` → `SF_ST_AUTH_URL`、
`pre-prod` → `SF_PRE_PROD_AUTH_URL`）。

**環境数に上限はありません。** 開発者別 sandbox・SIT・pre-prod・研修 org を含む
10 環境構成の実例は [パイプラインサンプル](PIPELINE_SAMPLES.md) を参照してください。

---

## `pipeline_settings`

以下の順に実行されます。各ステージは `enabled`（bool、必須）を取ります。

### `lint` / `prettier`

| キー            | 既定値                                                | 説明                           |
| --------------- | ----------------------------------------------------- | ------------------------------ |
| `command`       | `npm run pipeline:lint` / `npm run pipeline:prettier` | 任意のコマンドに置き換え可     |
| `fail_on_error` | `true`                                                | `false` なら失敗を記録して継続 |

ゲート用のスクリプトは `init` が `pipeline:` 名前空間で追加します。理由は名前の衝突です
— `sf project generate --template standard` で作られたプロジェクトでは `prettier` が
**`prettier --write`**（整形）として定義されており、`npm run prettier` をゲートにすると
作業ツリーを書き換えて必ず成功します。また同テンプレートの `lint` には
`--no-error-on-unmatched-pattern` が無いため、LWC がまだ無いプロジェクトでは違反 0 件でも
exit 2 で失敗します。

`doctor` はこの 2 点を検出します。

```text
✖ prettier command   "prettier" runs `--write`: it rewrites files and always passes.
✔ lint command       "lint" has no --no-error-on-unmatched-pattern: ESLint exits 2 …
```

失敗したステージは、ツールの出力（ESLint の違反一覧など）をそのまま表示します。
`exit 1` だけを見て原因を探し直す必要はありません。

### `code_analyzer`

| キー                 | 既定値                       | 説明                                                                                     |
| -------------------- | ---------------------------- | ---------------------------------------------------------------------------------------- |
| `engine`             | `code-analyzer`              | `code-analyzer`（v5、`sf code-analyzer run`）または `scanner`（legacy `sf scanner run`） |
| `rule_selector`      | `Recommended`                | v5 のセレクタ（エンジン・深刻度・タグの組み合わせ）                                      |
| `pmd_rule_set`       | `""`                         | legacy エンジンのみ → `--pmdconfig`                                                      |
| `config_file`        | 未設定                       | v5 → `--config-file`（`code-analyzer.yml`）                                              |
| `severity_threshold` | `3`                          | **この深刻度以上**で失敗。1 Critical / 2 High / 3 Moderate / 4 Low / 5 Info              |
| `target`             | `force-app`                  | v5 は `--workspace`、legacy は `--target`                                                |
| `output_file`        | `code-analyzer-results.json` | ゲート判定に解析され、CI では成果物として保存                                            |

PMD・CPD・SFGE は Java 製エンジンです。JDK 11 以上が無いと起動に失敗し、キットは
それを「コード違反」ではなく**環境問題**として報告します。`rule_selector: eslint`
なら Java 不要です。

### `validate_deploy` / `deploy`

`enabled` のみ。コマンドは環境と `unit_test` から導出されます。

```text
sf project deploy start --json --target-org <alias> [<セレクタ>] --test-level <level> [--dry-run] --wait 60
```

CI は pull request 以外のイベントでのみ `deploy` を実行します（フォークからの PR が
org にデプロイできないようにするため）。

### `unit_test`

| キー                 | 既定値          | 説明                                                                     |
| -------------------- | --------------- | ------------------------------------------------------------------------ |
| `test_level`         | `RunLocalTests` | `NoTestRun` / `RunSpecifiedTests` / `RunLocalTests` / `RunAllTestsInOrg` |
| `tests`              | `[]`            | `RunSpecifiedTests` のとき必須                                           |
| `coverage_threshold` | `75`            | 0〜100                                                                   |

このステージはコマンドを実行しません。Apex テストは検証デプロイの中で実行され、
ゲートはその結果を読むため、テストは 1 回だけ走ります。カバレッジを測定できない場合
（例: `NoTestRun`）は、黙って合格させず**失敗**させます。

### `integration_test` / `e2e_test`

| キー      | 既定値                  | 説明                      |
| --------- | ----------------------- | ------------------------- |
| `tool`    | `newman` / `playwright` | または `custom`           |
| `command` | ツール既定              | `tool: custom` のとき必須 |

### `documentation`

| キー         | 既定値   | 説明                                                         |
| ------------ | -------- | ------------------------------------------------------------ |
| `tool`       | `rtk-sf` | 対応しているのはこれのみ                                     |
| `doc_type`   | `all`    | `all` / `function_matrix` / `sequence_diagrams` / `erd` など |
| `output_dir` | `docs`   | 生成先                                                       |

rtk-sf が利用できない場合はスキップされます（`ai_assist.rtk_sf.required: true` を
指定した場合を除く）。

---

## `ai_assist.rtk_sf`

```yaml
ai_assist:
  rtk_sf:
    enabled: true
    required: false
    python: "python3"
    index_on_setup: true
    register_mcp: true
```

| キー             | 既定値    | 説明                                                  |
| ---------------- | --------- | ----------------------------------------------------- |
| `enabled`        | `true`    | 既定で統合                                            |
| `required`       | `false`   | `true` にすると未導入時にスキップではなくビルド失敗   |
| `python`         | `python3` | rtk-sf を導入した Python インタプリタ                 |
| `index_on_setup` | `true`    | `setup` / `setup-project.sh` が `rtk_sf index` を実行 |
| `register_mcp`   | `true`    | `setup` / `setup-project.sh` が MCP サーバーを登録    |

---

## `backlog_integration`

```yaml
backlog_integration:
  project_key: "PROJ"
  branch_pattern: "([A-Z][A-Z0-9_]*-\\d+)"
  status_mapping:
    in_progress: "処理中"
    review_ready: "処理済み"
    closed: "完了"
  status_ids: {}
  comment_format: "markdown"
  mcp:
    server_name: "backlog"
    runtime: "docker"
    toolsets: "space,project,issue"
    tool_prefix: ""
  deliverables:
    post_on_review: true
    include_package_xml: true
    include_pr_link: true
    include_non_metadata: true
```

| キー                                | 既定値                   | 説明                                                               |
| ----------------------------------- | ------------------------ | ------------------------------------------------------------------ |
| `project_key`                       | `""`                     | 他プロジェクトのキーは拒否されるため、誤ったチケットを動かしません |
| `branch_pattern`                    | `([A-Z][A-Z0-9_]*-\d+)`  | ブランチ名に対して大文字小文字を区別せず照合                       |
| `status_mapping.*`                  | 処理中 / 処理済み / 完了 | 3 つとも必須                                                       |
| `status_ids`                        | `{}`                     | ステータス**名 → 数値 ID**。カスタムステータス用                   |
| `comment_format`                    | `markdown`               | `markdown` または `backlog`。プロジェクトの表示形式に合わせる      |
| `mcp.server_name`                   | `backlog`                | `.mcp.json` での登録名                                             |
| `mcp.runtime`                       | `docker`                 | `docker` または `npx`                                              |
| `mcp.toolsets`                      | `space,project,issue`    | 有効化するトールセット                                             |
| `mcp.tool_prefix`                   | `""`                     | サーバーを `--prefix` 付きで起動している場合に指定                 |
| `deliverables.post_on_review`       | `true`                   | `/sfdx-review` が成果物一覧を投稿                                  |
| `deliverables.include_package_xml`  | `true`                   | チケット単位の manifest を含める                                   |
| `deliverables.include_pr_link`      | `true`                   | PR の URL を含める（`gh` で解決、未作成時は比較リンク）            |
| `deliverables.include_non_metadata` | `true`                   | テスト・CI・ドキュメントの変更を折りたたみで併記                   |

### ステータス ID について

[nulab/backlog-mcp-server](https://github.com/nulab/backlog-mcp-server) には
**ステータス一覧を返すツールが存在しません**（v0.20.4 の 63 ツールを実測して確認）。
そのため、ステータス名から ID を実行時に解決できません。Backlog 標準のステータスは
全プロジェクト共通の固定 ID を持ち、自動で解決されます。

| 名称                 | ID  |
| -------------------- | --- |
| 未対応 / Open        | 1   |
| 処理中 / In Progress | 2   |
| 処理済み / Resolved  | 3   |
| 完了 / Closed        | 4   |

カスタムステータスを使うプロジェクトは明示指定してください。

```yaml
status_ids:
  レビュー待ち: 5
  リリース待ち: 6
```

標準にもなく `status_ids` にも無い名称は `validate` が警告します。その場合スキルは
コメントだけ投稿し、「ステータスは変更しなかった」と報告します。**ID を推測することは
ありません** — 誤った ID は無関係な状態へチケットを動かしてしまうためです。

### `--enable-toolsets` の注意

トールセットは**フラグを繰り返して**指定します。公式ドキュメントにあるカンマ区切り
（`--enable-toolsets space,project,issue`）は v0.20.4 では**ツールが 0 個**になり、
連携が無言で機能しなくなります。`.mcp.json` テンプレートは繰り返し形式を使っており、
`doctor` はカンマ形式を検出して失敗させます。

### 資格情報

`BACKLOG_DOMAIN` と `BACKLOG_API_KEY` は環境変数に置き、`.mcp.json` が受け渡します。
この設定ファイルやリポジトリに書いてはいけません。

---

## 解決結果の確認

```bash
npx sfdx-devops-kit validate          # エラー・警告・必要な Secrets
npx sfdx-devops-kit plan --env st     # ステージ・ゲート・実行コマンド
npx sfdx-devops-kit plan --json       # 機械可読（`enabled` マップを含む）
npx sfdx-devops-kit backlog --phase review_ready   # 課題キー・statusId・MCP 呼び出し
npx sfdx-devops-kit doctor            # ツールチェーン・Java・rtk-sf・Backlog 連携
```
