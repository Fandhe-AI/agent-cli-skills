---
name: update-issue-tree
description: >
  既存の GitHub Issue ツリーを棚卸し・更新するスキル。「ツリーを棚卸しして」「イシューツリーを更新して」「トラッキング issue を整理して」で使用。
  ルートのトラッキング issue 番号を受け取り、sub_issues API でツリー全体を再帰取得 → closed 親下の残置 open issue 付け替え・孤児の再配置・新 Phase 親の新設・phase ラベル同期 →
  ルート issue 本文の Phase 別表・棚卸しセクションを再生成して更新する。
  ツリー新規作成は create-issue-tree、実装消化は implement-issue-tree を参照。
model: opus
user-invocable: true
argument-hint: "<ルートトラッキング issue 番号>"
---

# update-issue-tree

既存の Issue ツリーを棚卸しし、ルート issue 本文を最新状態に再生成する。
closed 親下に残置された open issue の付け替え・孤児の再配置・phase ラベルの同期を実施し、implement-issue-tree が post-order DFS で消化できる構造を維持する。

## 使い方

ルートのトラッキング issue 番号を引数として渡す。

```
update-issue-tree 42
```

## 前提条件

- `gh` CLI がインストールされ、認証済みであること（`gh auth status` で確認）
- 対象リポジトリへの Issue 書き込み権限があること

## フロー

### Step 1: ツリー全体を再帰取得する

ルート issue から sub_issues API を再帰的に呼び出し、全階層のツリー構造を取得する。  
ページネーションを考慮し、`per_page=100` で全件取得する。

```bash
ROOT_NUMBER="<ルート issue 番号>"

# ルート直下の sub-issues を取得（ページネーション対応）
fetch_sub_issues() {
  local PARENT="${1}"
  local PAGE=1
  while true; do
    RESULT=$(gh api \
      "repos/{owner}/{repo}/issues/${PARENT}/sub_issues?per_page=100&page=${PAGE}")
    echo "${RESULT}"
    COUNT=$(echo "${RESULT}" | jq 'length')
    if [ "${COUNT}" -lt 100 ]; then break; fi
    PAGE=$((PAGE + 1))
  done
}

# ルートから再帰的にツリーを構築
fetch_sub_issues "${ROOT_NUMBER}"
```

各 issue の `state`（open / closed）・ラベル・タイトルを記録してツリーマップを作成する。

### Step 2: 棚卸し対象を特定する

取得したツリーマップを分析し、以下のケースを特定する。

| ケース | 対応方針 |
|--------|---------|
| closed 親の下に open issue が残置されている | 適切な open Phase 親へ付け替え |
| どの親にも紐付いていない孤児 issue がある | 該当 Phase 親へ紐付け（Phase が不明な場合はユーザーに確認） |
| phase ラベルが親と一致しない issue がある | ラベルを同期 |
| 既存 Phase に収まらない新規タスクがある | 新 Phase 親の新設を検討 |
| 4h 超の issue が分解されていない | sub-issue に分解（create-issue-tree と同じ粒度基準） |

棚卸し対象の一覧をユーザーに提示し、方針確認を取ってから変更を実行する。

### Step 3: closed 親下の残置 open issue を付け替える

closed 親の下に残置されている open issue を、対応する open Phase 親へ移動する。
「旧親から DELETE → 新親へ POST」の 2 段操作と、その前後の冪等性判定・事後確認は
`scripts/reassign-sub-issue.sh` に集約されている（Issue #297。旧方式は SKILL.md 本文に
素の `gh api` を並べていたため、DELETE 失敗検知なしに POST へ進む等の欠陥があった）。

このスキルの配置ルートは導入形態（本リポジトリのソース／`npx skills add` による
vendoring／`.claude/skills/` symlink 経由）で異なる。呼び出し前に 3 レイアウトを順に確認し、
実在するものを採用する（implement-issue-tree の `scriptPath` 3 レイアウト・contribute-skill の
`LOCAL_SKILL_DIR` 解決と同じ考え方）。

```bash
for CANDIDATE in \
  "skills/update-issue-tree/scripts/reassign-sub-issue.sh" \
  ".agents/skills/update-issue-tree/scripts/reassign-sub-issue.sh" \
  ".claude/skills/update-issue-tree/scripts/reassign-sub-issue.sh"; do
  # 存在確認は -f のみで行う（-x にすると、npx skills add 等の vendoring で
  # 実行ビットが落ちたファイルを「存在しない」と誤検知し、3 レイアウトいずれにも
  # 見つからないという誤ったエラーメッセージになる）
  if [[ -f "${CANDIDATE}" ]]; then
    REASSIGN_SCRIPT="${CANDIDATE}"
    break
  fi
done
if [[ -z "${REASSIGN_SCRIPT:-}" ]]; then
  echo "エラー: reassign-sub-issue.sh が見つからない（3 レイアウトいずれにも存在しない）" >&2
  exit 1
fi
if [[ ! -x "${REASSIGN_SCRIPT}" ]]; then
  echo "警告: ${REASSIGN_SCRIPT} に実行権限がない（vendoring で実行ビットが失われた可能性）。bash 経由で実行する" >&2
fi

# 実行ビットの有無に関わらず bash 経由で起動する（上記の理由により、
# 直接実行 "${REASSIGN_SCRIPT}" に依存すると Permission denied になり得るため）
bash "${REASSIGN_SCRIPT}" \
  --issue "${ISSUE_NUMBER}" \
  --old-parent "${OLD_PARENT}" \
  --new-parent "${NEW_PARENT}"
echo "exit=$?"
```

**引数**

| 引数 | 必須 | 意味 |
|------|------|------|
| `--issue` | 必須 | 付け替え対象の issue 番号 |
| `--new-parent` | 必須 | 付け替え先の issue 番号 |
| `--old-parent` | 任意 | 現在の親（advisory。実測した現在の親と食い違う場合は実測値を優先する） |
| `--repo` | 任意 | `owner/name`。省略時は cwd の git remote から解決 |

**終了コードと `result=` 行**

stdout 最終行が `result=<state> issue=<n> new_parent=<n> old_parent=<n|->` の形式で
機械可読な内訳を返す。**非ゼロ終了は 1 件も握り潰さず、Step 9 の完了レポートの
「要確認事項」へ必ず記載する。**

| 終了コード | `state` | 意味 | 呼び出し側の扱い |
|-----------|---------|------|----------------|
| 0 | `reassigned` | DELETE→POST を実施 | 「付け替え」件数へ計上 |
| 0 | `already-attached` | 既に新親配下（no-op） | 件数へ計上しない |
| 0 | `posted-only` | 旧親配下になく POST のみ | 「孤児の再配置」件数へ計上（Step 4 と同一スクリプト） |
| 1 | — | 引数・使い方エラー | 実行者の誤り。修正して再実行 |
| 2 | — | 前提不備（`gh`/`jq` 不在・未認証・issue 取得不可） | 中断して原因を解消。要確認事項へ記載 |
| 3 | — | DELETE 失敗。**POST は実行していない** | 要確認事項へ記載。旧親配下のまま |
| 4 | — | POST 失敗 | 要確認事項へ記載。宙ぶらりん状態の可能性あり |
| 5 | — | 事後確認で新親配下に見つからない | 要確認事項へ記載。手動で実状態を確認 |
| 6 | — | 第三の親配下と判明（レース） | 要確認事項へ記載。同じコマンドで再実行する（`--old-parent` は advisory のため値の修正は不要。再実行時にスクリプトが現在の親を実測し直して DELETE→POST を行う） |

### Step 4: 孤児 issue を再配置する

どの親にも紐付いていない孤児 issue を適切な Phase 親へ紐付ける。
`--old-parent` を省略して同じスクリプトを呼ぶ（DELETE を飛ばして POST のみ実行される）。
Phase が不明な issue はタイトル・本文を読んで判断し、判断できない場合はユーザーに確認する。
`REASSIGN_SCRIPT` は Step 3 で解決済みの値をそのまま使う（未解決なら Step 3 と同じ 3 レイアウト
解決を先に実行する）。

```bash
"${REASSIGN_SCRIPT}" \
  --issue "${ORPHAN_NUMBER}" \
  --new-parent "${PHASE_NUMBER}"
echo "exit=$?"
```

### Step 5: 必要に応じて新 Phase 親を新設する

既存 Phase に収まらない新規タスクが多い場合、新 Phase 親 issue を作成してルートへ紐付ける。
（この POST は `reassign-sub-issue.sh` を使わない。たった今作成した、親を持たないことが
自明な issue への単発 POST であり、DELETE パス・冪等性判定の対象外のため）

```bash
# phase ラベルが存在しないリポジトリでは issue 作成が失敗するため、必ず事前作成する
# （作成済みの場合は失敗を無視して続行する）
gh label create "phase:N" --color "0075ca" 2>/dev/null || true

# gh issue create は URL を出力する（--json 非対応）。URL 末尾から番号を抽出する
NEW_PHASE_URL=$(gh issue create \
  --title "feat(phase-N): Phase N タイトル" \
  --label "phase:N" \
  --body "$(cat <<'EOF'
## 概要

Phase N の実装タスクをまとめる親 issue。

## タスク一覧

| Issue | タイトル | 分解 |
|-------|---------|------|
EOF
)")
NEW_PHASE_NUMBER=$(printf '%s' "${NEW_PHASE_URL}" | grep -oE '[0-9]+$')

# ルートへ紐付け。sub_issue_id は issue 番号ではなく database id を渡す（GitHub sub-issues API 仕様）
NEW_PHASE_ID=$(gh api "repos/{owner}/{repo}/issues/${NEW_PHASE_NUMBER}" --jq '.id')
gh api \
  --method POST \
  "repos/{owner}/{repo}/issues/${ROOT_NUMBER}/sub_issues" \
  -F "sub_issue_id=${NEW_PHASE_ID}"
```

### Step 6: phase ラベルを同期する

各 issue の phase ラベルが親 Phase と一致しているか確認し、不一致のラベルを修正する。

```bash
# ラベルを追加
gh issue edit "${ISSUE_NUMBER}" --add-label "phase:1"

# 古いラベルを削除
gh issue edit "${ISSUE_NUMBER}" --remove-label "phase:0"
```

### Step 7: 4h 超の issue を sub-issue に分解する

棚卸し中に 4h 超と判断した issue は、create-issue-tree と同じ粒度基準で sub-issue に分解する。
（この POST も `reassign-sub-issue.sh` を使わない。理由は Step 5 と同じ: 新規作成した
親なし issue への単発 POST）

```bash
# phase ラベルが存在しない場合に備えて事前作成する（作成済みなら no-op）
gh label create "phase:N" --color "0075ca" 2>/dev/null || true

# sub-issue を作成（URL 末尾から番号を抽出）
SUB_URL=$(gh issue create \
  --title "feat: サブタスク名" \
  --label "phase:N" \
  --body "...")
SUB_NUMBER=$(printf '%s' "${SUB_URL}" | grep -oE '[0-9]+$')

# 親 issue へ紐付け（sub_issue_id は database id）
SUB_ID=$(gh api "repos/{owner}/{repo}/issues/${SUB_NUMBER}" --jq '.id')
gh api \
  --method POST \
  "repos/{owner}/{repo}/issues/${ISSUE_NUMBER}/sub_issues" \
  -F "sub_issue_id=${SUB_ID}"
```

### Step 8: ルート issue 本文を再生成して更新する

棚卸し後の最新ツリー状態を反映したルート issue 本文を生成し、`gh issue edit` で更新する。

```bash
gh issue edit "${ROOT_NUMBER}" --body "$(cat <<'EOF'
## 概要

全 open issue を Phase 別に 1 ツリーへ整理。各 Phase 親 issue を sub-issues として紐付け。

## 棚卸しで実施した整理（YYYY-MM-DD）

- closed 親下の残置 issue の付け替え: N 件
- 孤児の再配置: N 件
- phase ラベル同期: N 件
- 新 Phase 親の新設: N 件

## Phase 別実装計画

| Phase | 親 issue | 直下 | 総 open 件数 |
|-------|----------|------|-------------|
| Phase 1 | #<phase1_number> タイトル | N | N |
| Phase 2 | #<phase2_number> タイトル | N | N |

### Phase 1: タイトル

| Issue | タイトル | 分解 |
|-------|---------|------|
| #N | タイトル | - |
| #N | タイトル | sub-issue あり |

## 運用

- 新規 issue は起票時に Phase 親へ紐付ける
- 実行順は sub-issues リスト順が正
- closed 親の下に open issue を残置しない
- implement-issue-tree が post-order DFS で消化可能な構造を維持する
EOF
)"
```

### Step 9: 棚卸し結果を報告する

```
## update-issue-tree 完了レポート

### 対象ルート issue
- #N: タイトル

### 棚卸し実施内容
| 操作 | 件数 |
|------|------|
| closed 親下の残置 issue 付け替え | N 件 |
| 孤児 issue の再配置 | N 件 |
| phase ラベル同期 | N 件 |
| 新 Phase 親の新設 | N 件 |
| 4h 超 issue の sub-issue 分解 | N 件 |

### 現在の Phase 別サマリー
| Phase | 親 issue | open 件数 |
|-------|----------|----------|
| Phase 1 | #N | N 件 |

### 要確認事項（自動配置できなかった issue）
- #N: タイトル — 確認理由
```

「closed 親下の残置 issue 付け替え」「孤児 issue の再配置」の件数は、Step 3 / Step 4 で
`reassign-sub-issue.sh` を呼んだ回数分の `result=` 行（`reassigned` / `posted-only`）から集計する。
非ゼロ終了（exit 1〜6）は 1 件も件数へ含めず、必ず「要確認事項」へ理由付きで記載する。

## 検証

- ルート issue 本文の Phase 別表が更新されていることを確認する
- closed Phase 親の下に open issue が残置されていないことを確認する
- Step 3 / Step 4 で呼んだ `reassign-sub-issue.sh` の各回について、`echo "exit=$?"` の値と
  `result=` 行を確認する。非ゼロ終了があれば Step 9 の要確認事項へ反映されているか確認する

```bash
# 全 sub-issues の state を確認
gh api "repos/{owner}/{repo}/issues/${ROOT_NUMBER}/sub_issues" \
  --jq '.[] | {number: .number, state: .state, title: .title}'

# Phase 親の sub-issues も確認
gh api "repos/{owner}/{repo}/issues/${PHASE_NUMBER}/sub_issues" \
  --jq '.[] | {number: .number, state: .state}'

# phase ラベルの同期確認（各 Phase 親直下で確認）
gh api "repos/{owner}/{repo}/issues/${PHASE_NUMBER}/sub_issues" \
  --jq '.[] | {number: .number, labels: [.labels[].name]}'
```

## よくある失敗

| 問題 | 回避策 |
|------|--------|
| 付け替えの DELETE が 404 になり、続く POST が 422 で失敗する | 削除のパスだけ単数形 `sub_issue`。複数形 `sub_issues` は 404 になり、旧親から外れないまま POST するため `Sub issue may only have one parent` で必ず失敗する（`reassign-sub-issue.sh` は DELETE 失敗時に POST へ進まないため、この連鎖失敗自体は起きない。手動で `gh api` を直接叩く場合の注意として記載を残す） |

## 注意事項

- **棚卸し前に変更内容をユーザーに提示して確認を取る**（Step 2 参照）
- ページネーション: sub-issues が 100 件を超える場合は `per_page=100&page=N` でページングして全件取得する（Step 1 のツリー全体取得に適用。`reassign-sub-issue.sh` は対象 issue の `parent_issue_url` を直接参照するため、付け替え判定自体にはページネーションが不要）
- シェルコマンドの変数は必ず `"${var}"` でクォートする（コマンドインジェクション対策）
- `--no-verify` は絶対に使用しない
- **`gh issue create` は `--json` 非対応**。issue URL を stdout に出力するため、`| grep -oE '[0-9]+$'` で末尾の番号を抽出する
- **sub_issues API（POST / DELETE）の `sub_issue_id` は issue 番号ではなく database id**（GitHub 仕様）。`gh api "repos/{owner}/{repo}/issues/<number>" --jq '.id'` で id を取得してから渡す。番号をそのまま渡すと誤った issue を操作する／404 になる（`reassign-sub-issue.sh` はこれを内部で解決するため、Step 3/4 で手動取得する必要はない）
- 孤児 issue の Phase が判断できない場合は推測せずにユーザーへ確認する
- sub_issues の DELETE API（付け替え時に旧親から外す操作）はパスが単数形 `sub_issue` である点に注意し、操作対象の issue 番号を必ず確認してから実行する
- ツリー更新後は implement-issue-tree が post-order DFS で正しく消化できる構造になっているか確認する
- Step 3 / Step 4 の付け替え処理は `scripts/reassign-sub-issue.sh` を使う。SKILL.md 本文へ素の `gh api` DELETE/POST を書き戻さない（状態変数の受け渡しがコードフェンス境界で壊れるクラスの欠陥に戻るため。詳細は `scripts/reassign-sub-issue.sh` 冒頭コメントと Issue #297 を参照）
