---
name: contribute-skill
description: ローカルで改修した .agents/skills/ 配下のスキルを upstream リポジトリ (Fandhe-AI/agent-cli-skills 等) へ PR として投稿する。skills-lock.json の source を読み、外部リポジトリへ貢献する際に使用する。
argument-hint: "<skill-name> (例: contribute-skill create-pr)"
user-invocable: true
---

# contribute-skill

ローカルで改修した `.agents/skills/<skill-name>/` を、`skills-lock.json` に記録された upstream リポジトリへ PR として投稿します。

## 前提条件

- `gh` CLI がインストールされ認証済みであること（対象 org への push / PR 権限が必要）
- 対象スキルが `skills-lock.json` に登録されていること
- 対象スキルのローカル改修が最新のコミットに含まれ、作業ツリーが clean であること

## 責務の分離

- **create-pr**: 現在のリポジトリ内でカレントブランチから base へ PR を作成する
- **contribute-skill**: 別リポジトリ（upstream）へ clone → 変更反映 → push → PR 作成を行う

外部リポジトリ貢献は clone / path 変換 / 異なる認証境界が関わるため、別スキルとして分離しています。

## フロー

### Step 1: 引数を検証する

```bash
SKILL_NAME="$ARGUMENTS"
# 引数が空の場合: .agents/skills/ を列挙してユーザーに選ばせる
```

対象ディレクトリ: `.agents/skills/<SKILL_NAME>/`
存在しなければエラーで中止します。

### Step 2: upstream を特定する

ルートの `skills-lock.json` を読み、`skills.<SKILL_NAME>.source` を取り出します。

```bash
# Python を使わず jq が使えるなら jq で（CLI にあれば）
```

- `source` が `Fandhe-AI/` で始まらない場合は **エラーで中止** します（安全弁：見知らぬリポジトリへ意図せず push しないため）。
- `sourceType` が `github` であることも確認します。

### Step 3: 変更内容を確認する

```bash
git log --oneline -- .agents/skills/<SKILL_NAME>/
git diff HEAD~1 HEAD -- .agents/skills/<SKILL_NAME>/
```

ユーザーに「この改修内容で upstream に PR を作ってよいか」を確認します。

### Step 4: セキュリティチェック（必須）

`create-pr` と同様に以下をレビューします。

- 認証・認可の実装漏れ
- API キー・シークレットのハードコーディング
- XSS の可能性（ドキュメントでも外部埋め込みが含まれる場合）
- 入力バリデーションの欠如
- OWASP Top 10

問題があれば upstream 貢献を中止し、ユーザーに警告します。

### Step 5: 作業用ディレクトリを用意する

```bash
UID_VAL=$(id -u)
TS=$(date +%Y%m%d-%H%M%S)
WORKDIR="/tmp/claude-${UID_VAL}/contribute-${SKILL_NAME}-${TS}"
mkdir -p "$WORKDIR"
```

`$TMPDIR` が設定されていればそちらを優先します（サンドボックス互換）。

### Step 6: upstream を clone する

```bash
# sandbox 環境では GIT_SSL_NO_VERIFY=1 の併用を検討
GIT_SSL_NO_VERIFY=1 gh repo clone Fandhe-AI/<repo> "$WORKDIR/upstream"
cd "$WORKDIR/upstream"
```

デフォルトブランチ（`main` / `master` 等）を確認します。

### Step 7: 変更を反映する

upstream 側でスキルがどのパス構造に置かれているか確認します。

- 典型パターン 1: `skills/<SKILL_NAME>/`
- 典型パターン 2: `.agents/skills/<SKILL_NAME>/`

対応するパスへローカルの `.agents/skills/<SKILL_NAME>/` 配下をコピーします。

```bash
# 例: upstream 側が skills/<name>/ の場合
cp -R "<local-repo>/.agents/skills/<SKILL_NAME>/." "$WORKDIR/upstream/skills/<SKILL_NAME>/"
```

### Step 8: 差分を確認する

```bash
cd "$WORKDIR/upstream"
git status
git diff
```

ユーザーに差分を見せ、内容が意図通りか確認します。

### Step 9: ブランチ作成・コミット

```bash
SLUG=$(date +%Y%m%d)
git switch -c "contribute/<SKILL_NAME>-${SLUG}"
git add <変更パス>
git commit -m "$(cat <<'EOF'
<type>(<scope>): <subject>

ローカルの .agents/skills/<SKILL_NAME>/ からの貢献。

EOF
)"
```

- Conventional Commits 形式
- `--no-verify` は使用しない（pre-commit フックを通す）
- co-author は付けない（ローカル規約に合わせる）

### Step 10: push と PR 作成

```bash
GIT_SSL_NO_VERIFY=1 git push -u origin "contribute/<SKILL_NAME>-${SLUG}"

GIT_SSL_NO_VERIFY=1 gh pr create \
  --repo Fandhe-AI/<repo> \
  --base main \
  --title "<type>(<scope>): <subject>" \
  --body "$(cat <<'EOF'
## Summary

- <SKILL_NAME> の改修内容（箇条書き）

## Source

ローカルの [ideas リポジトリ](../../) 側で改修後、`/contribute-skill <SKILL_NAME>` により投稿。

## Test plan

- [ ] SKILL.md を実際に Claude Code で実行
- [ ] Conventional Commits に沿ったメッセージ生成を確認
- [ ] エッジケース確認

EOF
)"
```

Draft PR を作成する場合は `--draft` を付けます（デフォルトはユーザー確認の上で決定）。

### Step 11: PR URL を返す & 後処理案内

- PR URL をユーザーに返す
- 「マージされたら `/sync-skills-lock` を実行して `skills-lock.json` の `computedHash` を更新してください」と案内
- 作業用ディレクトリ `$WORKDIR` は残したまま（成否が確定するまで）

## 注意事項

- **source が Fandhe-AI/ 以外の場合は中止**：意図しない外部リポジトリへの push を防ぐ
- **セキュリティ問題が見つかった場合は中止**：修正後に再実行
- **sandbox 環境では `GIT_SSL_NO_VERIFY=1` を必要に応じて併用**（`.claude/settings.local.json` で allow 済）
- **upstream のパス構造は事前確認**：`skills/<name>/` か `.agents/skills/<name>/` かは upstream によって異なる
- **既に同名の branch がある場合**：日時スラッグで回避するか、ユーザーに確認

## 既存スキルとの関係

- Step 4 のセキュリティチェック、Step 9 の Conventional Commits、Step 10 の PR body は `create-pr/SKILL.md` の流儀を踏襲
- マージ後は `/sync-skills-lock` で `skills-lock.json` の `computedHash` を更新
