# sandbox 環境での GitHub 操作

sandbox 環境（App Sandbox、企業 proxy、自己署名証明書環境など）では、中間 TLS 証明書の検証に通らない場合があります。ネットワーク越しの GitHub 操作には `GIT_SSL_NO_VERIFY=1` の併用を検討してください（ホスト側で allow 済みが前提）。

## コマンド分類と要否

| 対象 | `GIT_SSL_NO_VERIFY=1` の要否 | コマンド例 |
|------|-----------------------------|-----------|
| リモート取得 | 要 | `gh repo clone`, `git clone`, `git fetch`, `git pull`, `git ls-remote` |
| リモート書き込み | 要 | `git push` |
| GitHub API 操作 | 要 | `gh auth`, `gh api`, `gh pr ...`, `gh issue ...`, `gh project ...`, `gh label ...` |
| ローカル操作 | 不要 | `git log`, `git diff`, `git status`, `git add`, `git commit`, `git switch`, ファイル I/O |

## 使用例

```bash
# sandbox で clone する場合
GIT_SSL_NO_VERIFY=1 gh repo clone Fandhe-AI/agent-cli-skills /tmp/work

# push する場合
GIT_SSL_NO_VERIFY=1 git push -u origin feat/my-change

# API 経由で PR を作る場合
GIT_SSL_NO_VERIFY=1 gh pr create --draft --base main
```

## 注意事項

- `GIT_SSL_NO_VERIFY=1` は **TLS 検証を無効にするだけ** で、認証自体は別途必要です（`gh auth login` 済み OAuth トークン / SSH 鍵 / PAT）
- 信頼できないネットワーク下では使用しないでください（中間者攻撃のリスク）
- 本オプションを恒常的に有効にせず、sandbox 環境下でのワークアラウンドとしてのみ使用してください
- `.claude/settings.local.json` の許可リストに `GIT_SSL_NO_VERIFY=1 gh ...` 等を明示的に allow しておくと、Claude Code からの呼び出しが通ります

## スキルごとの判定値

各スキルの SKILL.md 末尾「sandbox 環境での実行」節（または同等の注意事項）は、次の 5 判定値のいずれか 1 つを
自スキルの性質として宣言します。判定は次の 2 点のみで行い、それ以外を根拠にしません。

- (a) ネットワーク到達性を要するか（`git fetch` / `git push` / `gh ...` 等を呼ぶか）
- (b) ワークスペース外への書き込みを行うか

**「ファイルシステムへの書き込みが必要」を sandbox 不可の根拠にしないこと。** ワークスペース内への書き込み
（`_/reports/` 等、リポジトリ配下）は sandbox の可否を左右する要素ではなく、判定に使えるのは上記 (a)(b) の
2 点のみです。

| 判定値 | 定義 |
|--------|------|
| `不要` | ネットワーク越しの操作を行わない |
| `一部要` | 主要フローはネットワーク不要。一部の任意ステップのみネットワークを要する |
| `要（本スキルは read-only）` | 全ステップがネットワーク越しの操作だが、すべて読み取りで書き込みを行わない |
| `要（本スキルは主に API 経由）` | ネットワーク越しの GitHub API 呼び出し（書き込みを含む）を主に使う |
| `要` | `git push` 等、リモートへの書き込みを含む |

各 SKILL.md には自スキルの判定 1 行のみを書き、判定の詳細・全スキル一覧はこの節（本ファイル）を参照させます
（`.claude/rules/skill-authoring.md` の「sandbox 節の定型文」も参照）。

## 全スキル判定一覧

| スキル | 判定 | 根拠 |
|--------|------|------|
| `create-html-report` | 不要 | renderer は純ローカルの Python（`_/reports/` 配下へ出力、ネットワーク呼び出しなし） |
| `implement-review` | 一部要 | 読み取り専用レビュー本体（`git diff` ベース）はローカル完結。out-of-scope の Issue 起票・コメント投稿（`gh`）のみ任意でネットワークを要する |
| `implement-issue` | 一部要 | 計画作成・実装・テスト実行はローカル完結。`gh issue view` はユーザーからの Issue 本文直接受け取りで代替可能なため任意ステップとなり、`git push` と合わせてこの2つのみネットワークを要する |
| `project-view-status` | 要（本スキルは read-only） | `gh project view` / `item-list` / `field-list` の読み取りのみで構成。書き込み系サブコマンドを含まない |
| `implement-review-pr` | 要（本スキルは read-only） | 既定は `gh pr view` / `gh pr checks` の読み取り。`gh pr review` の投稿は任意ステップ |
| `create-issue` | 要（本スキルは主に API 経由） | `gh issue create` / `gh api .../sub_issues` |
| `create-pr` | 要 | `git push` + `gh pr create` |
| `contribute-skill` | 要 | fork・push・PR 作成 |
| `sync-skills-lock` | 要 | 上流リポジトリの取得・反映 |
| `setup-repo-guards` | 要 | ruleset の PUT・workflow の配布 |
| `implement-issue-tree` | 要 | `git fetch` / `git push` / PR 作成・マージ |
| `project-init` | 要（本スキルは主に API 経由） | Project v2 作成・フィールド設定 |
| `project-add-items` | 要（本スキルは主に API 経由） | `gh project item-create` / `item-edit` |
| `project-create-issues` | 要（本スキルは主に API 経由） | ドラフト → Issue 変換 |
| `project-update-items` | 要（本スキルは主に API 経由） | `gh project item-edit` |
| `project-sync-issues` | 要（本スキルは主に API 経由） | 同期 workflow 生成・一括補正 |
| `project-archive-done` | 要（本スキルは主に API 経由） | `gh project item-archive` |
| `setup-firebase-hosting` | 一部要 | `bootstrap-firebase.sh`（GCP/Firebase 認証）はネットワーク必須。`firebase.json` 作成・ローカル検証はネットワーク不要（既存の記述のまま） |

## 実測記録

測定日: 2026-08-18。目的: 読み取り専用フロー（`implement-review` の中核である `git diff` ベースの
レビュー）がネットワーク遮断下でも完走し、かつワークスペース内（ワークツリー配下）に新規・更新
ファイルを発生させないことを実測で確認する（Issue #367 AC4）。

HTTPS プロキシの黒穴化だけでは不十分（本リポジトリの origin は SSH のため、SSH transport は
`HTTPS_PROXY` を無視して素通りし偽陽性になる）。HTTPS と SSH の両経路を同時に塞いだ。

```bash
DENY="HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 NO_PROXY= GIT_SSH_COMMAND=/usr/bin/false"

# (1) 読み取り専用フローの中核が完走すること
env ${DENY} git diff origin/main...HEAD --stat
echo "diff exit=$?"

# (2) 同条件でネットワーク操作は確かに失敗すること（遮断が効いている証明）
env ${DENY} git fetch origin main
echo "fetch exit=$?"

# (3) gh もネットワーク遮断下で失敗すること（project-view-status 等の read-only 判定の根拠）
env ${DENY} gh api rate_limit
echo "gh exit=$?"
```

実測結果（本 worktree、ブランチ `fix/367-sandbox-readonly-skills` 上で実行）:

- `env ${DENY} git diff origin/main...HEAD --stat` → 完走（`diff exit=0`）
- `env ${DENY} git fetch origin main` → 失敗（非 0。SSH 到達不能で遮断が効いていることを確認）
- `env ${DENY} gh api rate_limit` → 失敗（非 0。プロキシ接続拒否）
- 上記 (1) の前後で `git status --porcelain` の差分なし、かつ `find . -path ./.git -prune -o -newer <mark> -print`
  が空（ワークスペース内（ワークツリー配下）に限り新規・更新ファイルなし。ワークスペース外は未観測）

限界の明示: 本測定は「ネットワーク遮断相当」の模擬であり、Claude Code sandbox 実装そのものの測定では
ない。プロキシ変数や SSH コマンドの扱いは環境依存のため、運用開始・再開のたびに再測が望ましい。加えて
上記の `git status` / `find .` はいずれもカレントワークツリー配下のみを観測するため、ワークスペース外
（ホームディレクトリ・システム領域等）への書き込みの有無はこの実測の対象外であり、「全域確認」を
主張するものではない。
