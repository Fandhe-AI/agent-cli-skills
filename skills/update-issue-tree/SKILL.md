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

# ツリーマップの正本。"PARENT CHILD" を 1 行ずつ記録する（issue 番号同士の親子エッジ）。
# Step 3 の NEW_PARENT_IS_CURRENT / OLD_PARENT_IS_CURRENT はこのファイルを参照して
# 判定する（API を叩き直さない。ページネーションを再度踏まないため）。
TREE_EDGES_FILE=$(mktemp -t update-issue-tree-edges.XXXXXX)

# PARENT 直下の sub-issues を取得（ページネーション対応）し、エッジを記録して返す。
# gh api が失敗した場合（認証・通信エラー等）は空応答を「sub-issue なし」と
# 誤解釈しないよう、その場で非ゼロ終了する（呼び出し元は $? を検査すること）。
fetch_sub_issues() {
  local PARENT="${1}"
  local PAGE=1
  while true; do
    RESULT=$(gh api \
      "repos/{owner}/{repo}/issues/${PARENT}/sub_issues?per_page=100&page=${PAGE}") || return 1
    echo "${RESULT}" | jq -r --arg parent "${PARENT}" '.[] | "\($parent) \(.number)"' >> "${TREE_EDGES_FILE}"
    echo "${RESULT}"
    COUNT=$(echo "${RESULT}" | jq 'length')
    if [ "${COUNT}" -lt 100 ]; then break; fi
    PAGE=$((PAGE + 1))
  done
}

# ルートから再帰的にツリー全階層を構築する（子の子も辿る）。
build_tree() {
  local PARENT="${1}"
  local CHILDREN
  CHILDREN=$(fetch_sub_issues "${PARENT}" | jq -s 'add | .[].number') || return 1
  for CHILD in ${CHILDREN}; do
    build_tree "${CHILD}" || return 1
  done
}
build_tree "${ROOT_NUMBER}"
```

各 issue の `state`（open / closed）・ラベル・タイトルを記録してツリーマップを作成する。`TREE_EDGES_FILE` は Step 3 完了まで保持する（削除しない）。

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

Step 3 のループへ入る前に、失敗記録用のログファイルを一度だけ初期化する（未初期化のまま `>>` すると空リダイレクトになり DELETE/POST の失敗を記録できず、シェルによっては `set -e` 下で中断し得る）。

```bash
# Step 3 の per-issue ループ開始前に一度だけ実行する
FAILED_REASSIGNMENTS_LOG=$(mktemp -t update-issue-tree-failed.XXXXXX)
```

対象 issue が Step 1 で取得済みのツリーマップ（`TREE_EDGES_FILE`）上で `OLD_PARENT` の直下に**居るか**、および既に `NEW_PARENT` の直下に**居るか**をまず確認する（`GET .../sub_issues` を新規に叩き直さない。ページネーションを再度踏むため、Step 1 の全件取得結果を正とする）。

- 既に `NEW_PARENT` 直下に**居る場合**: 前回ランで DELETE/POST とも完了済みとみなし、DELETE・POST の両方を skip して次の issue へ進む（`NEW_PARENT_IS_CURRENT=true` の分岐。再実行を失敗扱いしない冪等な早期終了）
- `NEW_PARENT` 直下に**居らず**、`OLD_PARENT` 直下に**居る場合**: DELETE を実行する。失敗したら POST へ進まず、その issue を失敗リストへ記録して次の issue へ進む（`OLD_PARENT_IS_CURRENT=true` の分岐）
- `NEW_PARENT` 直下にも `OLD_PARENT` 直下にも**居ない場合**（前回ラン途中断等で DELETE のみ完了し POST 未実行）: DELETE を skip して POST のみ実行する（`OLD_PARENT_IS_CURRENT=false` の分岐。冪等な修復）

```bash
# sub_issue_id は issue 番号ではなく database id を渡す（GitHub sub-issues API 仕様）
ISSUE_ID=$(gh api "repos/{owner}/{repo}/issues/${ISSUE_NUMBER}" --jq '.id')

# NEW_PARENT_IS_CURRENT / OLD_PARENT_IS_CURRENT は Step 1 の TREE_EDGES_FILE から
# 都度算出する（未初期化のまま参照しない。前回イテレーションの値を持ち越さない）。
# TREE_EDGES_FILE 自体が読めない場合（想定外の破損・削除等）は判定不能として
# fail-closed し、DELETE・POST とも実行せず失敗リストへ記録して次の issue へ進む。
NEW_PARENT_IS_CURRENT=false
OLD_PARENT_IS_CURRENT=false
if [ ! -r "${TREE_EDGES_FILE}" ]; then
  echo "${ISSUE_NUMBER}: TREE_EDGES_FILE unreadable, parent membership undetermined (fail-closed, skip)" >> "${FAILED_REASSIGNMENTS_LOG}"
  continue
fi
if grep -qx "${NEW_PARENT} ${ISSUE_NUMBER}" "${TREE_EDGES_FILE}"; then
  NEW_PARENT_IS_CURRENT=true
elif grep -qx "${OLD_PARENT} ${ISSUE_NUMBER}" "${TREE_EDGES_FILE}"; then
  OLD_PARENT_IS_CURRENT=true
fi

if [ "${NEW_PARENT_IS_CURRENT}" = "true" ]; then
  # Step 1 のツリーマップ上で既に新親配下 → 前回ランで完了済み。DELETE/POST とも不要
  continue
fi

if [ "${OLD_PARENT_IS_CURRENT}" = "true" ]; then
  # 既存の親から外す。sub_issues API はエンドポイントが追加/削除で非対称。
  #   追加: POST .../issues/{n}/sub_issues  （複数形）
  #   削除: DELETE .../issues/{n}/sub_issue （単数形。GitHub 仕様であり揃えてはならない）
  # 複数形のまま DELETE すると 404 になり、旧親から外れないまま次の POST が
  # 422 (Sub issue may only have one parent) で必ず失敗する。
  if ! gh api \
    --method DELETE \
    "repos/{owner}/{repo}/issues/${OLD_PARENT}/sub_issue" \
    -F "sub_issue_id=${ISSUE_ID}"; then
    # gh api のエラーは stdout に出るため、grep ではなく終了コードで成否判定する。
    # DELETE 失敗時は POST へ進まず、失敗リストへ記録して次の issue へ進む
    # （ラン全体を止めると復旧が難しくなるため per-issue skip とする）
    echo "${ISSUE_NUMBER}: DELETE from #${OLD_PARENT} failed" >> "${FAILED_REASSIGNMENTS_LOG}"
    continue
  fi
fi

# 新しい親へ紐付ける。追加は複数形 sub_issues（DELETE と非対称）
if ! gh api \
  --method POST \
  "repos/{owner}/{repo}/issues/${NEW_PARENT}/sub_issues" \
  -F "sub_issue_id=${ISSUE_ID}"; then
  echo "${ISSUE_NUMBER}: POST to #${NEW_PARENT} failed" >> "${FAILED_REASSIGNMENTS_LOG}"
  continue
fi

# 付け替え後の確認: 新親の sub_issues に対象番号が現れ、旧親から消えていること。
# Step 1 の fetch_sub_issues（per_page=100 ページ走査）を再利用し、gh api の終了コードも
# 個別に検査する（認証・通信エラー等で空応答になった場合を「消えた」と誤判定しない）。
# 代入を `if ! VAR=$(cmd)` の条件式内で行う（`VAR=$(cmd)` を単独の行に置くと、
# set -e 下では fetch_sub_issues 失敗時にこの行自体でシェルが即終了し、
# 直後の `if [ $? -ne 0 ]` に到達できず FAILED_REASSIGNMENTS_LOG へ記録されない）。
if ! NEW_PARENT_SUB_ISSUES=$(fetch_sub_issues "${NEW_PARENT}"); then
  echo "${ISSUE_NUMBER}: GET sub_issues for new parent #${NEW_PARENT} failed (confirmation skipped)" >> "${FAILED_REASSIGNMENTS_LOG}"
else
  echo "${NEW_PARENT_SUB_ISSUES}" | jq -s 'add | .[].number' | grep -qx "${ISSUE_NUMBER}" \
    || echo "${ISSUE_NUMBER}: not found under new parent #${NEW_PARENT} after reassignment" >> "${FAILED_REASSIGNMENTS_LOG}"
fi

if ! OLD_PARENT_SUB_ISSUES=$(fetch_sub_issues "${OLD_PARENT}"); then
  echo "${ISSUE_NUMBER}: GET sub_issues for old parent #${OLD_PARENT} failed (confirmation skipped)" >> "${FAILED_REASSIGNMENTS_LOG}"
else
  echo "${OLD_PARENT_SUB_ISSUES}" | jq -s 'add | .[].number' | grep -qx "${ISSUE_NUMBER}" \
    && echo "${ISSUE_NUMBER}: still present under old parent #${OLD_PARENT} after reassignment" >> "${FAILED_REASSIGNMENTS_LOG}"
fi
```

Step 3 完了後、`${FAILED_REASSIGNMENTS_LOG}` の内容を確認し、失敗・要確認として記録された issue をユーザーへ報告する。

### Step 4: 孤児 issue を再配置する

どの親にも紐付いていない孤児 issue を適切な Phase 親へ紐付ける。  
Phase が不明な issue はタイトル・本文を読んで判断し、判断できない場合はユーザーに確認する。

```bash
# sub_issue_id は database id を渡す（issue 番号ではない）
ORPHAN_ID=$(gh api "repos/{owner}/{repo}/issues/${ORPHAN_NUMBER}" --jq '.id')
gh api \
  --method POST \
  "repos/{owner}/{repo}/issues/${PHASE_NUMBER}/sub_issues" \
  -F "sub_issue_id=${ORPHAN_ID}"
```

### Step 5: 必要に応じて新 Phase 親を新設する

既存 Phase に収まらない新規タスクが多い場合、新 Phase 親 issue を作成してルートへ紐付ける。

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
| 付け替え失敗（要手動対応） | N 件 |

付け替え失敗が 1 件でもある場合、「完了」とは報告せず、失敗した issue 番号と理由を明記した上で要対応事項として提示する。

### 現在の Phase 別サマリー
| Phase | 親 issue | open 件数 |
|-------|----------|----------|
| Phase 1 | #N | N 件 |

### 要確認事項（自動配置できなかった issue）
- #N: タイトル — 確認理由
```

## 検証

- ルート issue 本文の Phase 別表が更新されていることを確認する
- closed Phase 親の下に open issue が残置されていないことを確認する

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
| sub_issues の DELETE を複数形パス（`.../sub_issues`）で叩いて 404 になる | 削除のみ単数形 `.../sub_issue`。追加は複数形 `.../sub_issues`（GitHub 仕様。単複を揃えようとして戻さない）。旧親から外れないまま POST すると `Sub issue may only have one parent`（422）で必ず失敗する |
| `gh api` のエラー出力を grep して成否判定する | `gh api` のエラーは stdout に出るため grep では判定できない。`if ! gh api ...; then` で終了コードにより成否判定する |
| `sub_issue_id` に issue 番号をそのまま渡す | `sub_issue_id` は database id。`gh api "repos/{owner}/{repo}/issues/<number>" --jq '.id'` で取得してから渡す |
| DELETE 失敗を握りつぶして「棚卸し完了」と報告する | 失敗した issue は失敗リストへ記録し、Step 9 の完了レポートに必ず件数を出す。失敗リストが空でない限り「完了」と報告しない |

## 注意事項

- **棚卸し前に変更内容をユーザーに提示して確認を取る**（Step 2 参照）
- ページネーション: sub-issues が 100 件を超える場合は `per_page=100&page=N` でページングして全件取得する
- シェルコマンドの変数は必ず `"${var}"` でクォートする（コマンドインジェクション対策）
- `--no-verify` は絶対に使用しない
- **`gh issue create` は `--json` 非対応**。issue URL を stdout に出力するため、`| grep -oE '[0-9]+$'` で末尾の番号を抽出する
- **sub_issue_id は issue 番号ではなく database id**（GitHub 仕様）。追加は `POST .../issues/{n}/sub_issues`、削除は `DELETE .../issues/{n}/sub_issue` とエンドポイントのパスが単複で非対称（追加が複数形、削除が単数形）。いずれも `sub_issue_id` には `gh api "repos/{owner}/{repo}/issues/<number>" --jq '.id'` で取得した id を渡す。番号をそのまま渡すと誤った issue を操作する／404 になる
- 孤児 issue の Phase が判断できない場合は推測せずにユーザーへ確認する
- 付け替え（Step 3）で単数形 DELETE パスを使う際、操作対象の issue 番号を必ず確認してから実行する。DELETE が失敗した場合は POST を実行せず、失敗として記録する（複数形パスでの DELETE 誤用に戻さない）
- ツリー更新後は implement-issue-tree が post-order DFS で正しく消化できる構造になっているか確認する
