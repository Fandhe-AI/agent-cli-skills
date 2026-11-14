---
name: init-codex
description: >
  Codex 体系（AGENTS.md 管理区間・.codex の hooks / rules / agents・スキル 9 件）を初期セットアップ。
  「codex セットアップして」「.codex 作って」「Codex 用に整備して」で使用。--no-verify・force push を hook で止める。
  既存は update-codex、OpenCode は init-opencode、Claude Code は init-claude、ai-review 用 AGENTS.md は setup-repo-guards。
model: opus
user-invocable: true
argument-hint: "<対象リポジトリのパス（省略時はカレントディレクトリ）>"
---

# init-codex

任意のリポジトリに OpenAI Codex 向けの体系を初期セットアップする。作るものは次のとおり。

- `AGENTS.md` の管理区間（日本語出力・Conventional Commits・`--no-verify` 禁止・計画承認後の実装）
- `.codex/hooks.json` と `.codex/hooks/`（PreToolUse の禁止ガードと SessionStart のリマインダー）
- `.codex/rules/agent-guard.rules`（補助の宣言層）と `.codex/agents/*.toml`（標準サブエージェント）
- ワークフロースキル 9 件（`.agents/skills/` と `skills-lock.json`）

既存の `.codex/` があるリポジトリには `update-codex` を使う。OpenCode は `init-opencode`、
Claude Code は `init-claude` の担当で、既存の `.claude/` があってもエラーにしない（併用できる）。

このスキルは実行するエージェントを問わない（Codex・OpenCode・Claude Code のどれからでも実行できる）。
特定のエージェント機構には依存せず、シェルコマンドとファイル操作だけで進める。

## 使い方

```
init-codex [対象リポジトリのパス]
```

パスを省略した場合はカレントディレクトリを対象とする。以降の `<target>` は対象リポジトリのルート、
`<skill-dir>` はこの SKILL.md があるディレクトリ（`assets/` はその直下）を指す。
`assets/` はこのスキルのものだけを参照し、他のスキルのディレクトリは参照しない。

## 前提条件

- `git` が使え、対象が git リポジトリであること（`git -C <target> rev-parse --show-toplevel` で確認）
- `bash` が使えること（`agents-md-block.sh` の実行と hook の起動に使う。無い環境では hook が動かないため、導入を先に案内する）
- `jq` が使えること（hook が判定に使う。無い環境では hook が fail-closed で全コマンドを拒否するため、導入を先に案内する）
- `gh` が使え、認証済みであること（`gh auth status`。ワークフロースキルが使う）
- `npx` が使えること（スキル導入に使う。`skills` CLI は固定版 `SKILLS_CLI_VERSION` で実行する。値と更新手順は付録を参照）
- `codex` が使えること（検証で `codex execpolicy check` を使う。無い場合も生成は進められるが、その検証は「未検証」と報告する）

## フロー

### Step 1: 前提を確認する

```bash
for c in git bash jq gh npx codex; do
  command -v "$c" >/dev/null 2>&1 && echo "ok: $c" || echo "missing: $c"
done
gh auth status
git -C "<target>" rev-parse --show-toplevel
```

`git`・`bash`・`jq`・`gh`・`npx` のどれかが無い、または `gh` が未認証なら、導入または `gh auth login` を案内して中断する。
`codex` だけが無い場合は続行し、報告に「rules の検証は未実施」と書く。
以降の `<target>` には `git rev-parse --show-toplevel` が返したルートを使う。

### Step 2: 対象リポジトリを調査する

```bash
cd "<target>"
ls -a
ls -d .codex 2>/dev/null || echo ".codex なし"
ls -l AGENTS.md 2>/dev/null || echo "AGENTS.md なし"
grep -c 'agent-cli-skills:agents-md:start' AGENTS.md 2>/dev/null || true
ls .agents/skills 2>/dev/null || echo ".agents/skills なし"
ls -d .claude 2>/dev/null || echo ".claude なし"
cat skills-lock.json 2>/dev/null | head -20 || true
```

把握する情報と扱い。

| 項目 | 扱い |
|------|------|
| 既存の `.codex/` | あれば**中断**し、`update-codex` へ誘導する（このスキルは既存の `.codex/` に書かない） |
| `AGENTS.md` | あれば管理区間の外は変えない。`setup-repo-guards` のレビュー観点集などが入っていてよい。管理区間（`agent-cli-skills:agents-md:start`）が既にあれば中身だけ差し替わる |
| `.agents/skills/` | 9 スキルのうち導入済みのものは入れ直さない（Step 4-4 で差分だけ入れる） |
| `.claude/` | あっても**エラーにしない**。このスキルは `.claude/` に触れない |
| 主要言語・ビルドとテストのコマンド | 構成案の AGENTS.md 追記方針と報告に使う |

### Step 3: 構成案を提示して承認を得る

調査結果をもとに次を一覧で**ユーザーに提示し、承認を得てから**次の Step へ進む。承認なしでは何も書かない。

| 区分 | 作るもの | 補足 |
|------|---------|------|
| AGENTS.md | 管理区間（新規作成・追記・差し替えのどれか） | `agents-md-block.sh --check` で結果語彙を先に示す。管理区間の外は変えない |
| hook | `.codex/hooks/agent-guard.sh`・`codex-pretooluse.sh`・`codex-session-start.sh` と `.codex/hooks.json` | PreToolUse（`^Bash$`）と SessionStart。判定は 1 本の bash スクリプトに集約 |
| rules | `.codex/rules/agent-guard.rules` | force push と `--no-verify` の典型形だけを forbidden にする補助層 |
| agents | `.codex/agents/` の `researcher.toml`・`implementer.toml`・`reviewer.toml` | model は書かず親を継承する |
| スキル | 未導入のワークフロースキル（9 件のうち） | `.agents/skills/` に導入。Codex 上の動作は保証しない（Step 8 参照） |

構成案には次も明記する。

- 書き込み経路: Codex のセッション内で実行している場合、`.codex/`・`.agents/` は読み取り専用のため
  権限昇格の承認を求める（Step 5）
- trust: project trust と `/hooks` での hook trust はユーザーが自分で行う（Step 6）
- ガードは best-effort の攻撃面削減で、承認境界ではない（注意事項参照）

AGENTS.md の結果語彙を事前に確認する。

```bash
bash "<skill-dir>/assets/scripts/agents-md-block.sh" \
  --target "<target>/AGENTS.md" --block "<skill-dir>/assets/agents-md-block.md" --check
```

最終行の `AGENTS_MD_BLOCK_RESULT <語彙>` が `error-*`（マーカーが片方だけ・2 組以上・フェンス閉じ忘れ・シンボリックリンク等）なら、
ファイルを変えずに原因を報告して中断する。

### Step 4: 生成する

承認後、次の順で生成する。Codex のセッション内で実行している場合は、書き込みを伴う各コマンドを
権限昇格つきで要求する（拒否されたときの経路は Step 5）。

#### 4-1. `.codex/` 一式を配置する

```bash
ASSETS="<skill-dir>/assets"
TARGET="<target>"

mkdir -p "${TARGET}/.codex/hooks" "${TARGET}/.codex/rules" "${TARGET}/.codex/agents"
cp "${ASSETS}/hooks/agent-guard.sh" "${ASSETS}/hooks/codex-pretooluse.sh" \
   "${ASSETS}/hooks/codex-session-start.sh" "${TARGET}/.codex/hooks/"
cp "${ASSETS}/codex/hooks.json" "${TARGET}/.codex/hooks.json"
cp "${ASSETS}/codex/rules/agent-guard.rules" "${TARGET}/.codex/rules/"
cp "${ASSETS}/codex/agents/"*.toml "${TARGET}/.codex/agents/"
chmod +x "${TARGET}/.codex/hooks/"*.sh
```

- `hooks.json` の `command` は `$(git rev-parse --show-toplevel)` から解決するため、パスの書き換えは不要
- `command` にトークン・パスワードを埋め込まない。入力をそのまま展開しない
- agents の `developer_instructions` は、対象リポジトリの言語・構成に合わせて必要なら追記する（承認済みの範囲で）

#### 4-2. AGENTS.md の管理区間を書く

```bash
bash "${ASSETS}/scripts/agents-md-block.sh" \
  --target "${TARGET}/AGENTS.md" --block "${ASSETS}/agents-md-block.md"
echo "exit=$?"
```

最終行の結果語彙と終了コードで判定する。

| 結果語彙 | 終了コード | 意味と対応 |
|---------|-----------|-----------|
| `created` / `appended` / `replaced` / `unchanged` | 0 | 成功。`unchanged` は既に最新 |
| `error-usage` | 1 | 引数の誤り。コマンドを見直す |
| `error-block-unreadable` / `error-block-empty` / `error-symlink` / `error-target` / `error-io` | 2 | 入出力・前提の問題。原因を報告して中断 |
| `error-markers` / `error-fence` / `error-block-marker` | 4 | マーカー・フェンスの不整合。ファイルは変わっていない。手で直すよう案内して中断 |

32768 バイトを超えると stderr に警告が出る（Codex は AGENTS.md を合計 32 KiB までしか読まない）。
警告が出たら報告に載せる。

#### 4-3. 追加の指示を提案する（任意）

調査で把握したビルド・テストのコマンドがあれば、管理区間の**外**への追記をユーザーに提案する。
承認がなければ追記しない。この追記はユーザーが明示承認した別操作であり、`agents-md-block.sh` の「区間の外はバイト不変」の保証が
及ぶ範囲（スクリプト実行時）とは別である。追記後も管理区間のマーカーとその中身は変えない。
管理区間の中身は `assets/agents-md-block.md` から差し替わるため、手で編集しない。

#### 4-4. ワークフロースキルを導入する

9 スキルのうち、`<target>/.agents/skills/<name>` が既にあるものは入れ直さない。未導入のものだけを導入する。

```bash
cd "<target>"
# skills CLI (vercel-labs/skills) は固定版でのみ実行する（未固定 npx はレジストリ
# 乗っ取り時の任意コード実行経路になる）。正の定義箇所・更新手順は付録を参照。
SKILLS_CLI_VERSION="1.5.23"   # 正の定義箇所。更新手順は付録を参照

skill_args=()
for s in create-commit create-pr create-issue implement-issue implement-issue-tree \
         implement-review implement-review-pr update-docs comment-code; do
  if [ -e ".agents/skills/${s}" ]; then
    echo "導入済みのためスキップ: ${s}"
  else
    skill_args+=(-s "${s}")
  fi
done

if [ "${#skill_args[@]}" -eq 0 ]; then
  echo "9 スキルとも導入済み"
else
  npx --yes "skills@${SKILLS_CLI_VERSION}" add Fandhe-AI/agent-cli-skills "${skill_args[@]}" -a codex -a opencode -y || {
    echo "エラー: skills@${SKILLS_CLI_VERSION} の実行が失敗した（該当版の不存在・レジストリ障害・書き込み拒否等、原因は問わない）。未固定 npx へのフォールバックは行わない。原因を確認してから再実行する。" >&2
    exit 1
  }
fi
```

- `-a codex -a opencode` は `.agents/skills/<name>` の実体だけを作り、既存の `.claude/skills/` には触れない。
  このため導入したスキルは Claude Code の一覧には出ない。Claude Code 側は `init-claude` / `update-claude` の担当
- `skills-lock.json` が生成・更新され、各エントリに `skillPath` があることを確認する

### Step 5: Codex のセッション内で実行している場合の書き込み経路

Codex の既定 sandbox は `.git`・`.agents`・`.codex` を読み取り専用にする。Codex のセッション内で実行している場合、
Step 4-1 と 4-4 の書き込みは拒否され得る。OpenCode・Claude Code・端末から実行している場合は、この Step を飛ばして直接書く。

**経路 A（主）: 承認による昇格。** 書き込みを伴うコマンド（`mkdir -p`・`cp`・`npx ... add`）を権限の昇格つきで要求し、
ユーザーの承認を得て実行する。承認が得られ、書き込みが成功したら Step 6 へ進む。

**経路 B（代替）: 退避と案内。** 昇格が拒否された・要求できなかった場合は、生成物を書き込み可能な
`<target>/_/codex-setup/` に書き、移動と導入のコマンドをユーザーに提示して実行してもらう。

```bash
STAGE="<target>/_/codex-setup"
ASSETS="<skill-dir>/assets"

# 既に存在する退避先は以前の作業や利用者のファイルを含み得るため使わない（ユーザーに確認して中断する）
[ ! -e "${STAGE}" ] || { echo "退避先が既に存在する: ${STAGE}"; exit 1; }
mkdir -p "${STAGE}/.codex/hooks" "${STAGE}/.codex/rules" "${STAGE}/.codex/agents"
cp "${ASSETS}/hooks/agent-guard.sh" "${ASSETS}/hooks/codex-pretooluse.sh" \
   "${ASSETS}/hooks/codex-session-start.sh" "${STAGE}/.codex/hooks/"
cp "${ASSETS}/codex/hooks.json" "${STAGE}/.codex/hooks.json"
cp "${ASSETS}/codex/rules/agent-guard.rules" "${STAGE}/.codex/rules/"
cp "${ASSETS}/codex/agents/"*.toml "${STAGE}/.codex/agents/"
```

`AGENTS.md` はリポジトリ直下で書き込める場合が多いため、Step 4-2 のとおり直接書く。書き込めない場合だけ、
`--target` を `${STAGE}/AGENTS.md` にして書き、移動を案内する（既存の AGENTS.md があるときは上書き移動せず、
利用者に `agents-md-block.sh` の実行を案内する）。

Step 4-1 が途中まで成功してから 4-4 で拒否された場合など、`<target>/.codex/` が既にあることがある。
このとき `mv _/codex-setup/.codex .codex` はしない（`.codex/.codex/` に入り反映されない）。
ディレクトリ単位では動かさず、ファイル単位で次の分岐にする。移動前に必ず宛先の有無を確認し、`mv -n` には頼らない
（BSD と GNU で戻り値が異なる）。

| 宛先の状態 | 動作 |
|-----------|------|
| 無い | 宛先の親を作って移動する |
| 有り・内容が同一 | 退避側のファイルを捨てる |
| 有り・内容が異なる | 移動せず差分を提示し、上書きするかを利用者が判断する（agent ファイルは既存を保持してスキップし、失敗に数えない） |

ユーザーに提示するコマンド（ユーザー自身が、権限のある端末で実行する）。

```bash
cd "<target>"
rc=0
place() {   # $1=退避側のファイル $2=宛先。移動または同一なら 0、差分ありなら 1
  [ -e "$1" ] || return 0   # 退避側が無い（配置済み）なら何もしない
  if [ ! -e "$2" ]; then
    mkdir -p -- "$(dirname -- "$2")" && mv -- "$1" "$2"
  elif cmp -s -- "$1" "$2"; then
    rm -f -- "$1"
  else
    echo "差分あり（移動しない）: $2"; diff -u -- "$2" "$1"; return 1
  fi
}
S="_/codex-setup/.codex"
for f in agent-guard.sh codex-pretooluse.sh codex-session-start.sh; do
  place "${S}/hooks/${f}" ".codex/hooks/${f}" && chmod +x ".codex/hooks/${f}" || rc=1
done
place "${S}/hooks.json" ".codex/hooks.json" || rc=1
place "${S}/rules/agent-guard.rules" ".codex/rules/agent-guard.rules" || rc=1
for a in "${S}/agents/"*.toml; do
  [ -e "${a}" ] || continue
  d=".codex/agents/$(basename -- "${a}")"
  if [ -e "${d}" ] && ! cmp -s -- "${a}" "${d}"; then
    echo "既存を保持（スキップ）: ${d}"   # 利用者の編集を守る。失敗には数えない
  else
    place "${a}" "${d}" || rc=1
  fi
done
[ "${rc}" -eq 0 ] || echo "差分のあるファイルは未反映。内容を確認し、上書きするなら手動で mv する"

# ワークフロースキルの導入（未導入のものだけ -s を付ける）
SKILLS_CLI_VERSION="1.5.23"   # Step 4-4 と同じ固定版
skill_args=()
for s in create-commit create-pr create-issue implement-issue implement-issue-tree \
         implement-review implement-review-pr update-docs comment-code; do
  [ -e ".agents/skills/${s}" ] || skill_args+=(-s "${s}")
done
[ "${#skill_args[@]}" -eq 0 ] || npx --yes "skills@${SKILLS_CLI_VERSION}" add Fandhe-AI/agent-cli-skills "${skill_args[@]}" -a codex -a opencode -y
```

提示後は、ユーザーが実行を終えたと伝えるまで Step 6 以降へ進まない。実行後に Step 7 の検証を行う。

**後始末。** 経路 B で `_/codex-setup/` を使った場合、ユーザーの移動が済んだら、**自分が作ったファイルだけ**を個別に削除し、
空になったディレクトリだけ `rmdir` で消す。`rm -rf` は使わない。`_/` 配下に他の内容があれば残す。

```bash
# 自分が作ったパスだけを 1 つずつ消し、深い方から rmdir する（空でなければ rmdir は失敗して残る）
# AGENTS.md は、退避先へ書いた場合だけ存在する
rm -f -- "<target>/_/codex-setup/AGENTS.md"
rmdir "<target>/_/codex-setup/.codex/hooks" "<target>/_/codex-setup/.codex/rules" \
      "<target>/_/codex-setup/.codex/agents" "<target>/_/codex-setup/.codex" 2>/dev/null
rmdir "<target>/_/codex-setup" 2>/dev/null
rmdir "<target>/_" 2>/dev/null
```

`_/codex-setup/` が `.gitignore` に入っているかを確認し、入っていなければコミット対象に含めないよう案内する。

### Step 6: trust を案内する

hook は **project trust** と `/hooks` での **hook trust** の**両方**が揃うまで、**黙って skip される**。
このスキルは trust を**自分では書かず、承認もしない**。ユーザー自身が次のどちらかを行うよう案内する。

1. `~/.codex/config.toml` に対象プロジェクトの trust を追記する（ユーザーが自分で編集する）

   ```toml
   [projects."<target の絶対パス>"]
   trust_level = "trusted"
   ```

2. または、対象リポジトリで Codex を起動したときの trust 確認で、ユーザーが信頼を選ぶ

そのうえで、Codex の中で `/hooks` を開き、追加された hook（PreToolUse・SessionStart）を内容を確認して承認する。
新規・変更した hook は承認するまで実行されない。

- `--dangerously-bypass-hook-trust` など、trust を迂回するオプションは案内しない
- `.codex/rules/agent-guard.rules` は project trust だけで効く（hook trust は不要）。hook が trust 待ちの間も、
  典型形の禁止だけは効く

### Step 7: 動作を検証する

次を実行し、出力と終了コードで確認する。

```bash
cd "<target>"

# 1) rules: force push が forbidden になる（codex が無ければ「未検証」と報告）
codex execpolicy check --rules .codex/rules/agent-guard.rules -- git push --force origin main
echo "exit=$?"

# 2) アダプタに deny 入力を流して deny JSON が返る
printf '%s' '{"tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}' \
  | bash .codex/hooks/codex-pretooluse.sh
echo "exit=$?"

# 3) allow 入力は何も出力されず exit 0
printf '%s' '{"tool_name":"Bash","tool_input":{"command":"git commit -m x"}}' \
  | bash .codex/hooks/codex-pretooluse.sh
echo "exit=$?"

# 4) サブエージェント（agent_id あり）のマージが deny される
printf '%s' '{"tool_name":"Bash","agent_id":"verify","tool_input":{"command":"gh pr merge 1"}}' \
  | bash .codex/hooks/codex-pretooluse.sh
echo "exit=$?"

# 5) hooks.json が妥当な JSON
jq . .codex/hooks.json >/dev/null && echo "hooks.json: OK"

# 6) AGENTS.md の管理区間が 1 つ
grep -c 'agent-cli-skills:agents-md:start' AGENTS.md
```

期待値。

| 確認 | 期待 |
|------|------|
| 1) execpolicy | 結果の decision が `forbidden`、終了コード 0 |
| 2) deny 入力 | stdout に `"permissionDecision":"deny"` を含む JSON、exit 0 |
| 3) allow 入力 | stdout 空、exit 0 |
| 4) サブエージェントのマージ | `"permissionDecision":"deny"` を含む JSON、exit 0 |
| 5) hooks.json | `hooks.json: OK` |
| 6) 区間数 | `1` |

加えて、`.agents/skills/` に 9 スキルがあり、`skills-lock.json` が妥当な JSON であることを確認する
（`jq . skills-lock.json >/dev/null && echo OK`）。期待と異なる結果が 1 つでもあれば、
原因（`jq` の有無・パス・配置漏れ）を特定して直すまで完了と報告しない。

アダプタの入力検証は hook が実際に呼ばれることの証明ではない。実セッションでの確認を案内する場合は、
**対象リポジトリでは危険なコマンドを実行させない**。実リモートから切り離した使い捨てリポジトリだけで行う。

```bash
SANDBOX="$(mktemp -d)"
git init --bare "${SANDBOX}/origin.git"
git init "${SANDBOX}/work" && cd "${SANDBOX}/work"
git remote add origin "${SANDBOX}/origin.git"   # origin はローカルの bare のみ
# 対象の .codex/ をここへコピーし、trust 済みの Codex をこのディレクトリで起動して
# `git commit --no-verify` と `git push --force` が拒否され、`git commit -m x` が通ることを確かめる
```

確認後は `${SANDBOX}` を利用者が自分で削除する。`rm -rf` は案内しない。使い捨てを用意できないときは、実セッションの確認は行わず「未検証」と報告する。

### Step 8: 結果を報告する

報告項目。

- 作成・更新したファイル一覧（AGENTS.md の結果語彙・`.codex/` 配下・`skills-lock.json`）
- 導入したスキルと、導入済みで飛ばしたスキル
- Step 7 の各検証の結果（証拠として出力・終了コードを引用）。未実施のものは「未検証」と明記
- trust が未完了であれば、hook はまだ効かないこと（rules だけが効く）と、Step 6 の操作
- 次の点を必ず明記する。
  - ワークフロースキル 9 件は Codex 上の動作を、後続の計画（スキルのツール中立化）が終わるまで**保証しない**。導入しただけの状態である
  - ガードは best-effort の攻撃面削減で、**承認境界ではない**。実強制はサーバー側の branch protection と人間によるマージ
  - 9 スキルは `-a codex -a opencode` で入れたため `.claude/skills` には出ない。Claude Code の一覧にも出したい場合は
    `init-claude` / `update-claude` の担当
  - OpenCode にも同じ体系を入れるなら `init-opencode`（AGENTS.md の管理区間は共有され 1 つのまま）
  - 既存体系の差分を後から充実させるなら `update-codex`

## 検証

完了とみなす条件は、Step 7 の 6 項目が期待どおりで、証拠（出力と終了コード）を報告に引用していること。
具体的には次のとおり。

- `codex execpolicy check ...` が forbidden（codex 未導入なら「未検証」と明記）
- アダプタが deny 入力で deny JSON、allow 入力で空出力（どちらも exit 0）
- `jq . .codex/hooks.json` が成功し、AGENTS.md の管理区間の開始マーカー数が 1
- `.agents/skills/` に 9 スキルがあり、`skills-lock.json` が妥当

「動くはず」での完了報告はしない。実行していない検証は未検証と書く。

## 注意事項

- 既存の `.codex/` があれば中断して `update-codex` を案内する。このスキルは既存の `.codex/` を上書きしない
- ユーザーの構成案承認なしに何も書かない
- **trust を自動化しない。** `~/.codex/config.toml` へ書き込まず、`/hooks` の承認もしない。`--dangerously-bypass-hook-trust` は案内しない
- Codex のセッション内では `.codex/`・`.agents/` が読み取り専用。権限昇格の承認を求め、拒否されたら Step 5 の退避経路へ切り替える
- `agents-md-block.sh` は AGENTS.md の管理区間の外をバイト単位で変えない。マーカーが不整合なら書かずに中断する。区間は常に 1 つ（ユーザーが明示承認した区間外への追記は別操作）
- **ガードの残存ギャップ**:
  - メインセッションでの `$'...'` による難読化は通る（難読化の拒否はサブエージェントのみ）
  - フックの無効化・alias の定義（`-c` / `--config-env` / `git config` の `core.hooksPath` と `alias.*`、先頭の `HUSKY=0` / `HUSKY_SKIP_HOOKS=1`）は検出して deny する。拾えないのは、利用者の設定ファイルに既にある alias・`include.path`・`GIT_CONFIG_*` 環境変数・`SKIP=`・別の呼び出しで export 済みの `HUSKY`、`env -S` で代入だけ渡し後続に git を置く形（上流 Fandhe-AI/agent-cli-skills#782 で追跡）
  - `bash -c` / `sh -c` / `eval`・ヒアドキュメントや here-string の中身、`$(…)` 内の引用符の食い違いは見ない
  - base64 復元・変数間接呼び出し・ブレース / glob 展開などの文字列照合で見抜けない形は通る。rules は先頭一致のため `git push origin main --force` 等は拾えない
- `skills` CLI は固定版で実行する。失敗しても未固定 `npx` へフォールバックしない（付録参照）
- コマンドへ渡すパスやスキル名は常に `"${var}"` でクォートする。外部入力を `bash -c` や `eval` へ渡さない
- `--no-verify` を含むコマンドを hook や手順に仕込まない
- コミットを伴う場合は対象リポジトリの規約（CLAUDE.md / AGENTS.md / CONTRIBUTING 等）に従う。規約が無ければ `type(scope): subject`（subject は 72 文字以内）とし、`--no-verify` は使わない（このスキル自体はコミットしない）
- 出力・報告は日本語で書く

## 付録: skills CLI のバージョン固定と更新手順

**Why**: `npx skills add` をバージョン未固定で実行すると、npx はローカルキャッシュに無い場合レジストリのその時点の最新版を確認なしで即時取得・実行する。`skills`（vercel-labs/skills）パッケージが乗っ取られた場合、これは任意コード実行の経路になる。exact 版（`X.Y.Z`。dist-tag・`^` / `~` レンジは禁止）への固定が信頼アンカーになる。

**固定版の決め方**:
1. `npm view skills version` で現在の latest を確認する
2. `npm view skills repository.url` が `vercel-labs/skills` であることを確認する
3. `npm view skills time --json` 等で公開日時が不自然でないことを確認する

**更新手順**:
1. Step 4-4 フェンス内の `SKILLS_CLI_VERSION` を更新する（このスキル内での正の定義箇所はここ。Step 5 の案内フェンスも同じ値に揃える）
2. `node --test skills/init-codex/tests/*.test.mjs` で exact semver・実行行の固定を検証する
3. 1 リポジトリで実際に実行し、差分が正常であることを確認する
4. `chore(init-codex): skills CLI を X.Y.Z へ更新` でコミットする
5. 同じ `skills` CLI を固定する `init-claude` / `update-claude` / `update-codex` / `init-opencode` / `update-opencode` / `sync-skills-lock` の同名節も同時更新することを推奨する（値の同期は必須ではないが、乖離した場合はどちらかの節にその旨を記録する）

**fail-closed**: 固定版が解決できない場合（該当版の不存在・レジストリ障害等どの原因でも）は `npx` が非ゼロ終了し停止する。未固定 `npx skills add` へのフォールバック再試行は行わない。
