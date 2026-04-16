---
name: sync-skills-lock
description: skills-lock.json の computedHash を upstream の最新状態と照合して更新する。contribute-skill でのマージ後、または upstream 側の更新をローカルに反映した後に使用する。
argument-hint: "[skill-name] (省略時は全スキル)"
user-invocable: true
---

# sync-skills-lock

ルート直下の `skills-lock.json` の `computedHash` を、upstream リポジトリの現状と照合して更新します。

## 対象ファイル

- **ルート**: 呼び出し元リポジトリ直下の `skills-lock.json` — このスキルが唯一編集するファイル
- **除外**: submodule 配下の `skills-lock.json` — submodule 境界を跨がないため **絶対に触らない**

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

**安全弁**: clone 前に必ず `source` フィールドが信頼された prefix で始まっていることを確認します。本スキルは `Fandhe-AI/` で始まる source のみを許可します（`contribute-skill` と同じポリシー）。想定外の source は skip してユーザーに警告します。`skills-lock.json` の改ざん・誤設定によって untrusted リポジトリから clone することを防ぐためです。

```bash
# source の検証（Fandhe-AI/ で始まらないエントリは skip）
case "$SOURCE" in
  Fandhe-AI/*)
    ;; # OK
  *)
    echo "警告: 想定外の source: $SOURCE — このスキルは skip します"
    continue
    ;;
esac
```

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

呼び出し元リポジトリ直下の `skills-lock.json` のみを更新します。submodule 配下の `skills-lock.json` は **絶対に触りません**（submodule 境界を跨がない）。

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

- **ルートの `skills-lock.json` のみを編集**：submodule 配下は手を付けない
- **source prefix 検証 (必須)**：`source` が `Fandhe-AI/` で始まらないエントリは clone せず skip する（`contribute-skill` と同じ安全弁）。`skills-lock.json` の改ざんや誤設定から防御するため
- **upstream の path 構造を事前確認**：`skills/<name>/` か `.agents/skills/<name>/` か
- **ハッシュ算出対象の一貫性**：上流側との合意が必要。初期は `SKILL.md` のみを推奨
- **sandbox 環境での `GIT_SSL_NO_VERIFY=1` 併用**：詳細は後述の「sandbox 環境での実行」節を参照
- **新スキルの取扱い**：ローカルに存在するが upstream に未登録のスキル（`contribute-skill`, `sync-skills-lock` 自身など）は、upstream マージ後に登録する。マージ前に `computedHash` を勝手に書き込まない

## sandbox 環境での実行

sandbox では中間 TLS 証明書の検証に通らない場合があります。ネットワーク越しの GitHub 操作には `GIT_SSL_NO_VERIFY=1` の併用を検討してください（ホスト側で allow 済みが前提）。

| 対象 | `GIT_SSL_NO_VERIFY=1` の要否 | コマンド例 |
|------|-----------------------------|-----------|
| upstream の取得 | 要 | `gh repo clone`, `git clone`, `git fetch`, `git pull`, `git ls-remote` |
| upstream への書き込み | 要（本スキルは read-only） | `git push` |
| GitHub API 操作 | 要 | `gh auth`, `gh api`, `gh pr view`, `gh issue view` など |
| ローカル操作 | 不要 | `git log`, `git diff`, `git status`, `git add`, `git commit`, `git switch`, ファイル I/O |

`GIT_SSL_NO_VERIFY=1` は TLS 検証を無効にするだけで、認証自体は別途必要です（`gh auth login` 済み OAuth トークン / SSH 鍵 / PAT）。信頼できないネットワーク下では使用しないでください。

## 既存スキルとの関係

- `contribute-skill` でスキル改修が upstream にマージされた後に本スキルを実行する運用を推奨
- `create-commit` の Conventional Commits を踏襲（Step 8）
