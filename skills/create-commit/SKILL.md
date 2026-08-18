---
name: create-commit
description: Conventional Commits 形式で git コミットを作成する。staged 差分から type/scope を推定し、breaking change やシークレット混入 (.env 等) を検出。pre-commit フックを必ず通す (`--no-verify` 不可)。「コミットして」「git commit」「変更を記録して」などで使用。
model: haiku
---

# create-commit

変更内容を分析して Conventional Commits 形式でコミットを作成します。

## フロー

### Step 1: 変更内容を確認する

```bash
git status
git diff --staged
```

staged がない場合は `git diff` も確認してユーザーに staging を案内する。

### Step 2: シークレット混入チェック（必須）

コミット実行前に、staged 差分へ秘密情報が含まれていないことを確認する。

検査は **(a) 機械照合** と **(b) 目視レビュー** の 2 段構えである。(a) だけでは不十分であり、
**(b) は (a) が何も検出しなかった場合でも必ず実施する**（理由は後述の「機械照合の限界」）。

#### (a) 機械照合

**先に自己テストを通す。** `grep` の実装差（BSD grep / GNU grep / ugrep）で BRE の `\+` の解釈が
割れ、正規表現が構文エラーになることがある。エラーになった `grep` は非ゼロで終わるため、
`... || echo "検出なし"` の形だと**秘密情報があっても「検出なし」と報告される**（fail-open）。
既知の陽性サンプルを検出できなければ、以降の検査結果を信用せずコミットを中止する。

```bash
# 陽性サンプルが 3 種すべて検出できることを確認する。1 つでも外したら検査は信用できない
{
  printf '+++ b/x\n+password: Hunter2Hunter2Hunter2\n' \
    | grep -E '^\+' | grep -vE '^\+\+\+' \
    | grep -qiE '(password|passwd|secret)[[:space:]]*[:=][[:space:]]*[^[:space:]]{8,}' \
  && printf '+db: postgres://u:p@h:5432/d\n' \
    | grep -qE '[a-zA-Z][a-zA-Z0-9+.-]*://[^[:space:]/@]+:[^[:space:]/@]+@' \
  && printf '+t: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27u\n' \
    | grep -qE 'eyJ[A-Za-z0-9_=-]{8,}\.eyJ[A-Za-z0-9_=-]{8,}\.[A-Za-z0-9_=-]{8,}'
} || { echo "エラー: シークレット検査の正規表現が機能していない（grep 実装差の可能性）。コミットを中止する" >&2; exit 1; }
```

```bash
# 1. 認証情報ファイルの検出（.env・秘密鍵等）。追加・変更（--diff-filter=ACMR）のみを対象とし、
# 削除コミット（漏洩した .env の除去等の是正コミット）はブロックしない。
# .env.example 等のテンプレートと公開鍵（.pub）は除外する。
git diff --staged --name-only --diff-filter=ACMR \
  | grep -E '(^|/)\.env(\..+)?$|(^|/)(id_rsa|id_ed25519)(\..+)?$|\.(pem|p12|pfx|key)$' \
  | grep -vE '\.(example|sample|template|pub)$' || echo "認証情報ファイル: 検出なし"

# 2. 高信頼パターンの検出。追加行（^+。ファイルヘッダ +++ は除外）のみを対象とし、
# 漏洩済みシークレットの削除（- 行）を妨げない。
# 一致したら誤検知の可能性が低いため、原則そのまま中止する。
#   前半 … ベンダー固有のトークン形式と秘密鍵ヘッダー
#   後半 … JWT（3 セグメント）と、認証情報を埋め込んだ接続文字列（scheme://user:pass@host）
git diff --staged --diff-filter=ACMR \
  | grep -E '^\+' | grep -vE '^\+\+\+' \
  | grep -E 'sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]+|AIza[0-9A-Za-z_-]{35}|BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY|eyJ[A-Za-z0-9_=-]{8,}\.eyJ[A-Za-z0-9_=-]{8,}\.[A-Za-z0-9_=-]{8,}|[a-zA-Z][a-zA-Z0-9+.-]*://[^[:space:]/@]+:[^[:space:]/@]+@' \
  || echo "高信頼パターン: 検出なし"

# 3. 代入形パターンの検出。password= / client_secret= / aws_secret_access_key= のように
# 「鍵名 + 区切り + 値」の形を拾う。値の形式は問わないため誤検知が出やすく、
# 環境変数参照・プレースホルダは除外したうえで、残ったものを**ユーザーへ提示して確認**する。
# （除外側を広く取っているため、ここでの「検出なし」は不在の証明にはならない。(b) を必ず行う）
git diff --staged --diff-filter=ACMR \
  | grep -E '^\+' | grep -vE '^\+\+\+' \
  | grep -iE '(password|passwd|secret|client_secret|api_?key|access_?token|auth_?token|aws_secret_access_key|private_?key)[[:space:]]*[:=][[:space:]]*[^[:space:]]{8,}' \
  | grep -vE '\$\{|\$\(|%[A-Za-z_]+%|process\.env|os\.environ|ENV\[|getenv|<[A-Za-z_][A-Za-z0-9_-]*>|\*\*\*|REDACTED|redacted|CHANGEME|changeme|placeholder|PLACEHOLDER|dummy|DUMMY|xxxx|XXXX|example\.com|your[-_]?(password|secret|key|token)' \
  || echo "代入形パターン: 検出なし"

# 4. 認証情報ファイルのリネームの検出。上記の名前照合はリネーム後の新パスにしか働かないため、
# 旧パスが認証情報パターンに一致するリネーム（例: .env → config.txt）を別途検出する。
# .env の中身（KEY=VALUE 形式）は上記の高信頼パターンに一致しないことが多く、
# 名前照合が主防御線であるため、名前を変えて内容が残るケースを見逃さない。
git diff --staged --name-status --diff-filter=R \
  | cut -f2 \
  | grep -E '(^|/)\.env(\..+)?$|(^|/)(id_rsa|id_ed25519)(\..+)?$|\.(pem|p12|pfx|key)$' \
  | grep -vE '\.(example|sample|template|pub)$' || echo "認証情報ファイルのリネーム: 検出なし"
```

1・2・4 のいずれかが検出された場合は**コミットを中止**し、ユーザーに警告して該当ファイルの
unstage・該当行の除去を案内する。例示値・プレースホルダ等の誤検知と判断できる場合のみ、
ユーザーの明示確認を得てから続行する。

3 が検出された場合は中止せず、**該当行をユーザーへ提示して実値かどうかを確認**したうえで
判断する（実値ならコミットを中止する）。3 は誤検知率が構造的に高いため自動中止にはしない。

リネーム（4）が検出された場合は、シークレットの内容が新しいファイル名の下に残っていないかを
確認し、残っている場合は中止する。削除のみのコミット（`.env` の削除・漏洩キーの除去）は
検出対象外でありそのまま続行してよいが、**認証情報ファイルの削除（D）と別名ファイルの追加（A）が
同一コミットに含まれる場合**は、内容が別名で追加し直されていないか（実質的なリネームでないか）を
差分で確認してから続行する。

#### (b) 目視レビュー（機械照合が「検出なし」でも必須）

```bash
# 追加行のみを対象に、秘密情報の観点で staged 差分を読む
git diff --staged --diff-filter=ACMR | grep -E '^\+' | grep -vE '^\+\+\+'
```

追加行を読み、次の観点で秘密情報が含まれていないかを判断する。

| 観点 | 例 |
|------|-----|
| 任意名の認証情報 | `dbPass`・`clientKey`・`token2` 等、上記の鍵名リストに無い変数名 |
| 構造化ファイル内の実値 | `config.yml` / `settings.json` / `*.tf` / k8s manifest に直接書かれたパスワード |
| 高エントロピー文字列 | 用途不明の長いランダム文字列（base64・hex） |
| 接続情報の断片 | ホスト名・ポート・ユーザー名と値がセットで並んでいる箇所 |
| バイナリ・エンコード済み | base64 でエンコードされた認証情報（k8s Secret の `data:` 等） |

秘密情報と判断した、または判断が付かない場合は**コミットを中止**し、ユーザーへ該当箇所を提示して確認する。

#### 機械照合の限界（この手順の契約）

(a) はパターン照合であり、**網羅的な検出ではない**。次のものは原理的に検出できない。

- 任意の変数名に代入された認証情報（鍵名リストに載っていないもの）
- 値の形式に規則性が無い認証情報（多くの自社発行トークン・DB パスワード）
- 3 の除外パターンに偶然一致してしまう実値

したがって Step 2 の契約は「(a) が検出しなければ安全」ではなく、
**「(a) で明白なものを機械的に落とし、(b) で残りを人が判断する」**である。
組織側で GitHub の secret scanning / push protection を有効化している場合、それは
push 時点の**追加の**防御線であり、この手順の代替にはならない（ローカルコミット時点では働かない）。

### Step 3: Conventional Commits type を決定する

| type | 用途 |
|------|------|
| `feat` | 新機能 |
| `fix` | バグ修正 |
| `docs` | ドキュメントのみの変更 |
| `refactor` | 機能変更なしのコードリファクタリング |
| `test` | テストの追加・修正 |
| `chore` | ビルドプロセス・補助ツール等の変更 |
| `style` | コードスタイルのみの変更（空白、フォーマット等） |
| `build` | ビルドシステムや外部依存関係の変更 |
| `ci` | CI 設定の変更 |
| `perf` | パフォーマンス改善 |

### Step 4: scope を推定する

変更ファイルのパスから scope を推定する。
複数にまたがる場合は省略可。

### Step 5: コミットメッセージを生成してユーザーに確認する

フォーマット: `type(scope): subject`

例:
```
feat(auth): ソーシャルログイン機能を追加
fix(api): レスポンスのエラーハンドリングを修正
refactor(ui): コンポーネント構造を整理
```

ユーザーに提案して確認を取る。

### Step 6: コミットを実行する

```bash
git commit -m "$(cat <<'EOF'
type(scope): subject

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

**重要**: `--no-verify` は絶対に使用しない（pre-commit フックを迂回しない）。

## 検証

コミット完了後、以下で確認する。

```bash
git log --oneline -3
```

- 最新コミットのメッセージが `type(scope): subject` 形式になっているか確認する
- `git show --stat HEAD` で変更ファイルの一覧が意図通りかを確認する

## よくある失敗

| 問題 | 回避策 |
|------|--------|
| 複数の関心事を 1 コミットに混ぜる | 関心事ごとに `git add -p` で staging を分けて別コミットにする |
| type を誤選定する（バグ修正に `feat`、機能追加に `fix`）| Step 3 の type 表を参照し、差分の意図を優先して選ぶ |
| シークレットチェックを飛ばして type 決定に進む | Step 2 は省略不可。検出時はコミットを中止してユーザーに警告する |
| `--no-verify` でフックを回避しようとする | フック失敗の原因を調査・修正してから再コミットする（回避は禁止） |
| 件名が 72 文字を超える | scope を省略するか subject を短縮する。詳細は body に書く |

## 注意事項

- Breaking change がある場合は `!` を付ける: `feat!: ...` または body に `BREAKING CHANGE:` を記述
- 件名は命令形・現在形で記述（日本語可）
- 件名は 72 文字以内
- `.env` や認証情報ファイルが含まれる場合は警告してコミットを中止する（Step 2 で必ず検出する）
