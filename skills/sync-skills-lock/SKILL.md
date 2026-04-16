---
name: sync-skills-lock
description: skills-lock.json の computedHash を upstream の最新状態と照合して更新する。contribute-skill でのマージ後、または upstream 側の更新をローカルに反映した後に使用する。
argument-hint: "[skill-name] (省略時は全スキル)"
user-invocable: true
---

# sync-skills-lock

ルート直下の `skills-lock.json` の `computedHash` を、upstream リポジトリの現状と照合して更新します。

## 対象ファイル

- **ルート**: `/Users/nancy/fandhe/_/ideas/skills-lock.json` — このスキルが唯一編集するファイル
- **除外**: `ideas/orchestra/skills-lock.json`, `ideas/automation/skills-lock.json` — サブモジュール配下のため **絶対に触らない**

## 前提条件

- `gh` CLI がインストールされ、認証済みであること
- ルート直下の `skills-lock.json` が存在すること

## フロー

### Step 1: 引数を確認する

```bash
TARGET="$ARGUMENTS"  # 空なら全スキル対象
```

引数ありの場合は該当スキルのみ処理、なしの場合は `skills-lock.json` の全エントリを対象にします。

### Step 2: upstream 一覧を集計する

`skills-lock.json` を読み、`source` フィールドごとにスキルをグルーピングします（同一リポへの fetch を 1 回にまとめるため）。

```
Fandhe-AI/agent-cli-skills:
  - create-commit
  - create-issue
  - ...
```

### Step 3: upstream を取得する

リポジトリごとに以下を実行:

```bash
UID_VAL=$(id -u)
TS=$(date +%Y%m%d-%H%M%S)
WORKDIR="/tmp/claude-${UID_VAL}/sync-skills-${TS}"
mkdir -p "$WORKDIR"

# sandbox で GIT_SSL_NO_VERIFY=1 を必要に応じて併用
GIT_SSL_NO_VERIFY=1 gh repo clone Fandhe-AI/<repo> "$WORKDIR/<repo>"
```

### Step 4: 各スキルの SHA256 を計算する

upstream 側のスキルパスを特定し（`skills/<name>/` もしくは `.agents/skills/<name>/`）、配下の全ファイルから安定した順で SHA256 を計算します。

ハッシュの対象は `SKILL.md` 単体か配下全体かを upstream の規約に合わせます（初期実装では `SKILL.md` のみを対象とし、今後 `references/` 等を含める場合は方針を明記してからアップデートします）。

```bash
# SKILL.md 単体の例
sha256sum "$WORKDIR/<repo>/skills/<name>/SKILL.md" | awk '{print $1}'
```

### Step 5: 差分を表示する

計算した新しい `computedHash` と現在の `computedHash` を比較し、テーブルで表示します。

```
| スキル名            | 現在の hash (頭10字) | 新しい hash (頭10字) | 差分 |
|--------------------|---------------------|---------------------|------|
| create-commit      | 80e2dd2232          | 80e2dd2232          | なし |
| contribute-skill   | （未登録）           | xxxxxxxxxx          | 新規 |
```

### Step 6: ユーザーに承認を求める

差分がある場合のみ、ユーザーに「この更新を適用してよいか」を確認します。承認がなければ中止します。

### Step 7: `skills-lock.json` を更新する

ルート直下の `skills-lock.json` のみを更新します。`ideas/orchestra/`, `ideas/automation/` 配下は **絶対に触りません**（submodule 境界を跨がない）。

```bash
# jq を使う例
jq '.skills."create-commit".computedHash = "<new-hash>"' \
  skills-lock.json > skills-lock.json.tmp && mv skills-lock.json.tmp skills-lock.json
```

JSON のフォーマット（インデント、キー順）は既存形式を維持します。

### Step 8: コミット提案

```bash
git add skills-lock.json
git commit -m "$(cat <<'EOF'
chore(skills-lock): upstream の最新ハッシュと同期

<変更内容の要約>
EOF
)"
```

ユーザーに commit してよいか確認します。差分がなかった場合はコミットせずその旨を伝えます。

## 注意事項

- **ルートの `skills-lock.json` のみを編集**：submodule 配下 (`ideas/orchestra/`, `ideas/automation/`) は手を付けない
- **upstream の path 構造を事前確認**：`skills/<name>/` か `.agents/skills/<name>/` か
- **ハッシュ算出対象の一貫性**：上流側との合意が必要。初期は `SKILL.md` のみを推奨
- **sandbox 環境では `GIT_SSL_NO_VERIFY=1` を併用**
- **新スキルの取扱い**：ローカルに存在するが upstream に未登録のスキル（`contribute-skill`, `sync-skills-lock` 自身など）は、upstream マージ後に登録する。マージ前に `computedHash` を勝手に書き込まない

## 既存スキルとの関係

- `contribute-skill` でスキル改修が upstream にマージされた後に本スキルを実行する運用を推奨
- `create-commit` の Conventional Commits を踏襲（Step 8）
