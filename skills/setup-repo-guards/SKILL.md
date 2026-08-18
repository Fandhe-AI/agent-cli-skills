---
name: setup-repo-guards
description: >
  Fandhe-AI 組織標準の CI ガード一式（codex-review 導入 / AGENTS.md レビュー観点集 / 必須チェック集約ジョブ /
  branch protection ruleset・追加ガード）を対象リポジトリへ導入する。「リポジトリガード入れて」「CI ガード導入して」
  「branch protection セットアップ」「codex-review 導入して」「AGENTS.md 整備して」などで使用。
  複数リポジトリへの一括適用にも対応。.claude/ 体系の初期セットアップは init-claude、既存体系の充実は update-claude を参照。
model: opus
user-invocable: true
argument-hint: "<対象リポジトリ名 (owner/repo)> <public|private> [追加のリポジトリ...]"
---

# setup-repo-guards

対象リポジトリへ組織標準の CI ガード一式を導入する。導入するのは次の 4 点で、
Step 1 → 4 の順に、各 Step を PR → CI 全 pass → レビュースレッド resolve → squash merge で確定させてから次へ進む。

1. codex-review（PR 自動レビュー workflow の wrapper）
2. AGENTS.md（codex が読むレビュー観点集）
3. CI 必須チェックの集約ジョブ（`ci-complete` 等）
4. branch protection ruleset・リポジトリ追加ガード（GitHub API のみ、コミット不要）

この順序を守る理由: 「必須チェックに入れる集約ジョブが先に存在する」「AGENTS.md は PR の base コミット参照のため
マージ後の次の PR から実効」という依存関係が、この順で自然に満たされる。

## 使い方

```
setup-repo-guards Fandhe-AI/my-repo public
setup-repo-guards Fandhe-AI/repo-a public Fandhe-AI/repo-b private
```

- 第 1 引数: 対象リポジトリ名（`owner/repo`）
- 第 2 引数: visibility（`public` / `private`）。runner 方針の分岐に使う（public は ubuntu ホステッド、private は self-hosted。codex 実行ジョブのみ self-hosted codex runner の例外）
- 複数リポジトリへ一括適用する場合はリポジトリと visibility の組を列挙する。各リポジトリのセッション（または並列 agent）で順次消化する

## 前提条件

- `gh` CLI がインストールされ、対象リポジトリの admin 権限で認証済みであること（`command -v gh && gh auth status` で確認）
- `jq` がインストールされていること（`command -v jq` で確認）
- Fandhe-AI/actions（reusable workflow の提供元）への参照権限があること
- 対象リポジトリを clone 済みで、CLAUDE.md・既存 workflow を読める状態であること

## フロー

### Step 1: codex-review の導入（未導入の場合のみ）

`.github/workflows/codex-review.yml` を wrapper として追加し、Fandhe-AI/actions の reusable workflow
`codex-review.yml` を **commit SHA 固定**（`@main` 禁止）で参照する。

参照する SHA は**下記のレビュー済み SHA 定数**を使う。最新 main からの動的取得
（`gh api repos/Fandhe-AI/actions/commits/main`）は禁止する — 文字列上は commit SHA 固定でも、
導入のたびに未レビューの最新コードを取り込む「可動 ref の自動追従」と同じであり、
サプライチェーン対策（レビュー済み SHA 固定）を弱体化する（fandhe-frontend PR #1311 codex P1）。

```bash
# レビュー済み SHA 定数（内容精査済み。既存導入リポジトリ fandhe-frontend の
# .github/workflows/codex-review.yml が参照している SHA と同一）
sha="fed9c07d98367f77e5e2b63bca38843f46feee96"
```

定数の更新手順（新しい SHA を採用したくなった場合）:

1. 旧 SHA → 新 SHA の差分を精査する:
   `gh api "repos/Fandhe-AI/actions/compare/<旧SHA>...<新SHA>"` または Web UI の compare で、
   reusable workflow 本体（fork PR 拒否・fail-closed 検証・資格情報スキャン等）の変更内容を確認する
2. 問題がないと判断してから、本 SKILL.md のこの定数（full SHA）を書き換えるコミットを作成する
3. 以後の導入は更新後の定数を使う（導入時に動的取得へ戻さない）

- 書き方・fork PR 拒否等の適用条件は Fandhe-AI/actions の `docs/codex-review-runner-exception.md` と、
  既存導入リポジトリ（fandhe-frontend 等）の wrapper を参照して揃える
- runner 方針: CI ジョブは public なら ubuntu ホステッド、private なら self-hosted。
  codex 実行ジョブのみ self-hosted codex runner の例外。`post_feedback` ジョブは資格情報に触れないため
  `ubuntu-latest` を明示する
- `CODEX_HOME_DIR` variable は設定しない

### Step 2: AGENTS.md（codex のレビュー観点集）の追加

codex の既定 prompt は **PR の base コミットの AGENTS.md** をレビュー基準として読む。
リポジトリルートに日本語で新規作成する（既存があれば基準を弱めず不足観点を追記する）。

必須 3 観点を、必ず**対象リポジトリ固有の具体項目**に落とし込んで書く（別リポジトリ用の記述を流用しない）:

1. **セキュリティ観点**: 秘密情報混入・インジェクション・依存監査・権限最小化など、リポジトリの実態に即して
2. **アーキテクチャ・設計整合の観点**: CLAUDE.md・設計文書の責務境界・規約整合
3. **再利用・アセット化の観点**: 汎用実装の分離・ハードコード回避・転用容易性・ドキュメント整備

加えて:

- CLAUDE.md / `.claude/rules/` / 設計文書から抽出したリポジトリ固有観点を整理する
- 重大度区分 P0（マージブロック）/ P1（強く推奨）/ P2（提案）を付け、**P1 の定義は CI ゲートの実挙動
  （codex ジョブは P1 でも fail する）と矛盾させない**
- カスタム prompt（`.github/codex/prompts/review.md`）が既にある場合は二重管理を避ける:
  観点の正は AGENTS.md、enforcement（完了判定・機械格上げ）の正は review.md という役割分担にし、
  review.md へは AGENTS.md 読み取りの最小追記のみ行う
- 参考実例: fandhe-backend / fandhe-frontend / Fandhe-AI/actions / agent-cli-skills の AGENTS.md
- 注意: 新基準はマージ後の**次の PR から**実効（base 参照仕様）

### Step 3: CI 必須チェックの集約ジョブ整備

複数ジョブを持つ workflow には集約ジョブ（`ci-complete` 等）を追加する:
全ジョブを `needs:` に列挙し、`if: always()` を付け、`toJSON(needs)` を jq で判定する。

- **fail-closed を厳守**: `skipped` の許容は「条件付きジョブ（`if:` を持つジョブ）」の**明示リストに限定**し、
  他ジョブは success のみ受理する（skipped 全許容は fail-open として codex に P1 指摘される）。
  change detection ゲートがある場合はゲート出力に基づき「skip が正しい状況」でのみ skipped を受理する
- 集約ジョブには `permissions: {}` を付け、「ジョブ追加時は needs への追加が必要」のコメントを書く
- Fandhe-AI/actions の reusable workflow（lint-docs 等）を使っている場合、集約ジョブ
  （`lint-docs / lint-docs-complete` 等）が入った SHA まで参照をバンプすればチェック 1 件に集約できる
- YAML の `name:` に ` #` や「: 」を含む場合は必ずクォートする（未クォートだと API 報告名が途中で切れ、
  必須チェック名として不安定になる）

### Step 4: branch protection / リポジトリ設定（GitHub API のみ、コミット不要）

- マージ設定（`gh api -X PATCH repos/...`）: squash のみ（merge commit / rebase 禁止）、
  マージ後ブランチ自動削除、auto-merge 許可、squash タイトル = PR_TITLE / 本文 = PR_BODY
- ruleset `main-protection`（target: branch、`~DEFAULT_BRANCH`、enforcement: active、bypass_actors 空）:
  - deletion 禁止 / non_fast_forward（force push 禁止）
  - pull_request: required_approving_review_count 0（人間 approver 不在の AI 運用。レビューゲートは
    codex の必須チェックで担保）・required_review_thread_resolution true・allowed_merge_methods ["squash"]
  - required_status_checks（**strict false は必須**。true にすると 1 件マージするたびに他の open PR の
    base が陳腐化し、implement-issue-tree の並列ランが収束しなくなる。strict は鮮度制御であって
    bypass 不能性の制御ではないため、false でもクライアント側自動マージの G0 は通過する。
    詳細は `.claude/rules/ruleset-policy.md`）: **[<集約ジョブ>, （集約できない別 workflow の常時チェック）,
    codex-review / codex]** の最小集合
  - 自動マージ（implement-issue-tree の `autoMerge: true`）を使う場合、required_status_checks の
    各エントリに発行元 App の `integration_id` を束縛する（未束縛だと G0 が `issuer-unbound` で辞退する）。
    **ruleset を PUT で更新した後は必ず下記「検証」の 3 軸スイープを実行する**（`PUT` は
    `required_status_checks.parameters` を丸ごと置換するため束縛が落ち得る。複数リポへ一括適用する
    場合は全リポで実行する）
- 必須チェック選定の注意（重要な落とし穴）:
  - 直近 PR の check runs で「**常に報告される**」チェックのみ選ぶ。workflow レベル paths フィルタで
    実行されないことがあるチェックは入れない（マージが永久ブロックされる）。ジョブレベル条件の skipped は可
  - Cursor Bugbot 等の外部アプリ、codex-review / post_feedback は必須にしない
  - **チェック名が変わる PR をマージするときは、マージ前に ruleset を新チェック名へ PUT で置換する**
    （旧名のままだと CI 全 pass でも「Expected」のまま BLOCKED になる）。PUT は GET した JSON の
    required_status_checks のみ差し替えて送る
- 追加ガード: secret scanning + push protection / Dependabot alerts + automated security fixes /
  （public なら）private vulnerability reporting / タグ運用があれば tag ruleset（deletion・non_fast_forward）/
  GITHUB_TOKEN 既定権限 read 化（**全 workflow の permissions: 明示を確認してから**）/
  Actions の PR 作成・承認許可は自動 PR 運用（update-external 等）が無ければ false /
  （private なら）forking 禁止 / 未使用の wiki・projects 無効化
- プラン制限（403/422）に当たった項目は「ユーザー操作が必要」として記録し、他を続行する

## 検証

各 Step の完了は以下で確認する:

```bash
repo="Fandhe-AI/<REPO>"
# Step 1: wrapper の存在と SHA 固定（@main が残っていないこと）
grep -n "uses: Fandhe-AI/actions" .github/workflows/codex-review.yml
# Step 2: AGENTS.md の存在と P0/P1/P2 定義
grep -n "P0\|P1\|P2" AGENTS.md | head
# Step 3: 直近 PR の check runs で集約ジョブが報告されること
gh pr checks "$(gh pr list --repo "${repo}" --state merged --limit 1 --json number --jq '.[0].number')" --repo "${repo}"
# Step 4: ruleset とマージ設定
gh api "repos/${repo}/rulesets" --jq '.[] | {id, name, enforcement}'
gh api "repos/${repo}" --jq '{allow_squash_merge, allow_merge_commit, allow_rebase_merge, delete_branch_on_merge, allow_auto_merge}'

# Step 4-a: 一括更新後の 3 軸スイープ（strict / bypass_actors / integration_id 残存）
# PUT した ruleset 単体ではなく branch target の全 ruleset を掃く（org 継承は source_type でルーティング）。
# コマンド全文・判定表は .claude/rules/ruleset-policy.md の「一括更新後の検証」節を参照
org="${repo%%/*}"
gh api "repos/${repo}/rulesets" \
  --jq '.[] | select(.target == "branch") | [(.id|tostring), .name, (.source_type // "unknown")] | @tsv' |
while IFS=$'\t' read -r id name src; do
  case "${src}" in
    Repository)   path="repos/${repo}/rulesets/${id}" ;;
    Organization) path="orgs/${org}/rulesets/${id}" ;;
    *)            echo "UNKNOWN source_type: ${name} (${src}) — 手動確認"; continue ;;
  esac
  gh api "${path}" --jq '{
    name: .name, enforcement: .enforcement, bypass: (.bypass_actors | length),
    strict: ([.rules[]? | select(.type=="required_status_checks") | .parameters.strict_required_status_checks_policy] | first),
    total:   ([.rules[]? | select(.type=="required_status_checks") | .parameters.required_status_checks[]?] | length),
    unbound: [.rules[]? | select(.type=="required_status_checks") | .parameters.required_status_checks[]? | select(.integration_id == null) | .context]
  }'
done

# Step 4-b: classic branch protection を別枠で掃く（defaultBranchRef 解決・@uri エンコード・HTTP status 分岐）
db=$(gh repo view "${repo}" --json defaultBranchRef --jq '.defaultBranchRef.name')
db_enc=$(printf '%s' "${db}" | jq -sRr '@uri')
code=$(gh api -i "repos/${repo}/branches/${db_enc}/protection" 2>/dev/null | awk 'NR==1{print $2}')
case "${code}" in
  200) gh api "repos/${repo}/branches/${db_enc}/protection" --jq \
         '{strict: (.required_status_checks.strict // "none"), unbound: [.required_status_checks.checks[]? | select(.app_id == null) | .context]}' ;;
  404) echo "classic BP なし（${db}）" ;;
  *)   echo "判定不能 (HTTP ${code:-?}) — Administration: read 権限を確認。green と扱わない" ;;
esac
```

最終確認として、導入後に小さな PR を 1 件流し、codex-review の実行・必須チェックの報告・
squash merge のみ許可・スレッド resolve 必須が実際に効いていることを観察する。

## 完了報告

Step ごとの PR 番号、AGENTS.md の観点構成、ruleset の最終必須チェック一覧、適用できなかった項目
（理由付き）を表でまとめて報告する。

## よくある失敗

| 問題 | 回避策 |
|------|--------|
| 集約ジョブの skipped 全許容が fail-open として codex に P1 指摘される | Step 3: skipped 許容を条件付きジョブの明示リストに限定する |
| チェック名変更 PR が CI 全 pass でも BLOCKED（ruleset が旧名のまま「Expected」待ち） | Step 4: マージ前に ruleset を新チェック名へ PUT で置換する |
| 未クォート `name:` の ` #` 以降が切れて API 報告名が不安定になる | Step 3: name に ` #` や「: 」を含む場合はクォート必須 |
| paths フィルタ付き workflow のチェックを必須にするとマージが永久ブロックされる | Step 4: 常に報告されるチェックのみ必須化する |
| 参考ファイルの取り違え（別リポジトリ用 AGENTS.md の混入）を codex が検出 | Step 2: 対象リポジトリ固有の具体項目に落とし込む |
| AGENTS.md の P1 定義と CI ゲート実挙動（P1 でも fail）の矛盾を codex が指摘 | Step 2: P1 定義をゲート実挙動と矛盾させない |
| GITHUB_TOKEN read 化で暗黙 write 依存の workflow が壊れる | Step 4: 全 workflow の permissions 明示を確認してから適用する |
| ruleset を PUT したら `integration_id` 束縛が落ち、自動マージが静かに止まる（strict と bypass だけ見ると全 green に見える） | Step 4-a: PUT 後に 3 軸スイープ（`select(.integration_id==null)`）を実行する |
| 旧 ruleset / classic BP の掃き漏らしで未束縛・strict=true が残る | Step 4-a/4-b: 全 branch ruleset を列挙して掃き、classic BP は `defaultBranchRef` 解決 + status 分岐で別枠確認する |
| AGENTS.md に自動マージの G0 契約を書く際 strict を要件として列挙し、実装より強い契約が codex P0 の根拠になる | Step 2: G0 契約を書くなら strict は「意図的な非要件」と明記する（`.claude/rules/ruleset-policy.md`） |

## 注意事項

- コミットは日本語 Conventional Commits 形式で作成し、対象リポジトリのコミット規約・フッター運用に従う。`--no-verify` は使用しない
- シェル変数は `"${var}"` 形式でクォートする
- codex の指摘が正当なら修正で応える（テスト・ゲートの弱体化やスキップでごまかさない）。
  スレッドへ対応内容を返信して resolve してからマージする
- スコープ外の発見は Issue 化をユーザーに提案する（勝手に起票しない）
- このスキルはネットワーク越しの GitHub 操作（ruleset の PUT・workflow の配布）を必須とする。該当コマンドはコマンド単位で sandbox 無効にして実行する（`docs/sandbox-tls.md` 参照）。ネットワーク遮断を解除できない環境では実行できない
