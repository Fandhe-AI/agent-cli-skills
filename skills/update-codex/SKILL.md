---
name: update-codex
description: >
  既存の Codex 体系（AGENTS.md 管理区間・.codex の hooks / rules / agents・スキル 9 件）を診断し承認後に追補。
  「codex 体系アップデート」「.codex 充実させて」「Codex 整備して」で使用。利用者の hooks・agent は消さない。
  新規は init-codex、OpenCode は update-opencode、Claude Code は update-claude、ai-review 用 AGENTS.md は setup-repo-guards。
model: opus
user-invocable: true
argument-hint: "<対象リポジトリのパス（省略時はカレントディレクトリ）>"
---

# update-codex

既存の Codex 体系を診断し、理想形との差分をギャップ一覧で提示して、ユーザーが承認した項目だけを追補する。
対象は次のとおり。

- `AGENTS.md` の管理区間（`agent-cli-skills:agents-md:start` から `end` まで）
- `.codex/hooks.json`（自エントリだけを追加・更新し、利用者が足したエントリは順序を含めて変えない）
- `.codex/hooks/*.sh` と `.codex/rules/agent-guard.rules`（`assets/` との差分）
- `.codex/agents/*.toml`（無いものだけ追加候補）
- ワークフロースキル 9 件の導入状況（`.agents/skills/`）

`.codex/` が無いリポジトリには（AGENTS.md の管理区間の有無に関わらず）`init-codex` を使う。OpenCode は `update-opencode`、
Claude Code は `update-claude` の担当で、既存の `.claude/` があってもエラーにしない（併用できる）。

このスキルは実行するエージェントを問わない（Codex・OpenCode・Claude Code のどれからでも実行できる）。
特定のエージェント機構には依存せず、シェルコマンドとファイル操作だけで進める。

## 使い方

```
update-codex [対象リポジトリのパス]
```

パスを省略した場合はカレントディレクトリを対象とする。以降の `<target>` は対象リポジトリのルート、
`<skill-dir>` はこの SKILL.md があるディレクトリ（`assets/` はその直下）を指す。
`assets/` はこのスキルのものだけを参照し、他のスキルのディレクトリは参照しない。

## 前提条件

- `git` が使え、対象が git リポジトリであること（`git -C <target> rev-parse --show-toplevel` で確認）
- `bash` が使えること（`agents-md-block.sh`・`codex-hooks-merge.sh` の実行と hook の起動に使う。無い環境では hook が動かないため、導入を先に案内する）
- `jq` が使えること（`codex-hooks-merge.sh` と hook が使う。無い環境では hook が fail-closed で全コマンドを拒否するため、導入を先に案内する）
- `gh` が使え、認証済みであること（`gh auth status`。ワークフロースキルが使う）
- `npx` が使えること（スキル追加に使う。`skills` CLI は固定版 `SKILLS_CLI_VERSION` で実行する。値と更新手順は付録を参照）
- `codex` が使えること（検証で `codex execpolicy check` を使う。無い場合も追補は進められるが、その検証は「未検証」と報告する）

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

### Step 2: 既存体系を診断する

診断は**読み取りだけ**で行い、この Step では何も書かない。

```bash
cd "<target>"
ASSETS="<skill-dir>/assets"

ls -d .codex 2>/dev/null || echo ".codex なし"
ls -l AGENTS.md 2>/dev/null || echo "AGENTS.md なし"
grep -c 'agent-cli-skills:agents-md:start' AGENTS.md 2>/dev/null || true
```

`.codex/` が無い場合は、AGENTS.md の管理区間の有無に関わらず `init-codex` を案内して**終了**する（何も書かない）。
`.codex/` があるときだけ診断を続ける。

#### 2-1. AGENTS.md の管理区間

```bash
bash "${ASSETS}/scripts/agents-md-block.sh" \
  --target "<target>/AGENTS.md" --block "${ASSETS}/agents-md-block.md" --check
echo "exit=$?"
```

最終行の `AGENTS_MD_BLOCK_RESULT <語彙>` を読む。

| 語彙 | 意味 | ギャップ |
|------|------|---------|
| `unchanged` | 管理区間が最新 | なし |
| `replaced` | 区間はあるが内容が古い | 差し替え候補 |
| `appended` | AGENTS.md はあるが区間が無い | 追記候補 |
| `created` | AGENTS.md が無い | 新規作成候補 |
| `error-*` | マーカー片方・2 組以上・フェンス閉じ忘れ・シンボリックリンク等 | ファイルを変えずに原因を報告して中断 |

`replaced` のときは、現在の区間の全文（`start` から `end` までの行）と `assets/agents-md-block.md` を並べて提示する
（区間の中身は管理対象で、手で編集した内容は差し替えで消えるため、見せて承認を取る）。
`--check` が `replaced` を返した時点で区間は最新と異なるので、行単位の差分を厳密に取る必要はなく、区間全文の提示で足りる。

#### 2-2. `.codex/hooks.json`

```bash
bash "${ASSETS}/scripts/codex-hooks-merge.sh" \
  --target "<target>/.codex/hooks.json" --template "${ASSETS}/codex/hooks.json" --check
echo "exit=$?"
```

最終行の `CODEX_HOOKS_MERGE_RESULT <語彙>` を読む。

| 語彙 | 意味 | ギャップ |
|------|------|---------|
| `unchanged` | 自エントリが最新 | なし |
| `added` | 自エントリが無い（または一部だけ無い） | 追加候補 |
| `updated` | 自エントリの内容が違う | 更新候補 |
| `created` | hooks.json が無い | 新規作成候補 |
| `error-matcher` | 自エントリ `codex-pretooluse.sh` が matcher `^Bash$` 以外のグループにある（exit 4） | ファイルを変えずに停止。利用者の matcher は書き換えない。該当グループの matcher を確認して手で直すか、自エントリを `^Bash$` のグループへ移すよう案内して中断 |
| `error-*`（上記以外） | 不正な JSON・型の不整合・自エントリの重複・symlink 等 | ファイルを変えずに原因を報告して中断 |

自エントリは、`command` が `.codex/hooks/codex-pretooluse.sh` または `.codex/hooks/codex-session-start.sh` を
含むハンドラ。それ以外は利用者のエントリとして一切変えない。更新前に、利用者のエントリ数を控える
（Step 7 で同じ値であることを確認する）。

```bash
jq '[.hooks[]?[]?.hooks[]? | select(((.command // "") | tostring
      | (contains(".codex/hooks/codex-pretooluse.sh") or contains(".codex/hooks/codex-session-start.sh"))) | not)] | length' \
  "<target>/.codex/hooks.json"
```

hooks.json が無いときはこの控えは 0 とする。

#### 2-3. hooks スクリプトと rules

```bash
for f in agent-guard.sh codex-pretooluse.sh codex-session-start.sh; do
  if [ -f ".codex/hooks/${f}" ]; then
    cmp -s "${ASSETS}/hooks/${f}" ".codex/hooks/${f}" && echo "同一: ${f}" || echo "差分あり: ${f}"
  else
    echo "なし: ${f}"
  fi
done
if [ -f .codex/rules/agent-guard.rules ]; then
  cmp -s "${ASSETS}/codex/rules/agent-guard.rules" .codex/rules/agent-guard.rules \
    && echo "同一: agent-guard.rules" || echo "差分あり: agent-guard.rules"
else
  echo "なし: agent-guard.rules"
fi
```

「差分あり」のファイルは、`diff -u .codex/hooks/<f> "${ASSETS}/hooks/<f>"` の結果を示す。
利用者が手で変更している可能性があるため、差し替えは差分を提示して承認を取る（Step 3 で個別に確認する）。
「なし」のファイルは追加候補。

#### 2-4. agents

```bash
for a in researcher implementer reviewer; do
  if [ -f ".codex/agents/${a}.toml" ]; then
    cmp -s "${ASSETS}/codex/agents/${a}.toml" ".codex/agents/${a}.toml" \
      && echo "同一: ${a}.toml" || echo "差分あり: ${a}.toml"
  else
    echo "なし: ${a}.toml"
  fi
done
ls .codex/agents 2>/dev/null
```

- 無い標準 agent（`researcher.toml`・`implementer.toml`・`reviewer.toml`）だけを追加候補にする
- 既存の同名ファイルは**差分を示すだけで上書きしない**。利用者が望んだ場合に限り、利用者自身が反映する
- 上記 3 つ以外の agent ファイルは利用者のものとして触れない

#### 2-5. ワークフロースキル 9 件

```bash
for s in create-commit create-pr create-issue implement-issue implement-issue-tree \
         implement-review implement-review-pr update-docs comment-code; do
  [ -e ".agents/skills/${s}" ] && echo "導入済み: ${s}" || echo "未導入: ${s}"
done
cat skills-lock.json 2>/dev/null | head -20 || true
```

未導入のものだけを追加候補にする。導入済みのスキルは入れ直さない。

#### 2-6. trust 状態（案内のみ）

hook は project trust と `/hooks` での hook trust の両方が揃うまで黙って skip される。
trust の状態はこのスキルが読み書きせず、確認方法を案内するだけにする（Step 6）。

### Step 3: ギャップ一覧を提示して承認を得る

診断結果を次の表で**ユーザーに提示し、承認を得てから**次の Step へ進む。承認なしでは何も書かない。
項目ごとに承認・見送りを確認し、承認された項目だけを実行する。

| 区分 | 現状 | 提案 | 破壊性 |
|------|------|------|--------|
| AGENTS.md 管理区間 | 診断の語彙（created / appended / replaced / unchanged） | 作成・追記・差し替え | `replaced` は区間内の手編集が消える。区間の外は変えない |
| hooks.json | 診断の語彙（created / added / updated / unchanged） | `codex-hooks-merge.sh` で自エントリのみ追加・更新 | 利用者エントリは変えない（空白の整形のみ変わり得る） |
| hooks スクリプト | なし / 差分あり / 同一 | 追加、または差分提示のうえ差し替え | 差し替えは手編集が消える。差分を見せて承認 |
| rules | なし / 差分あり / 同一 | 追加、または差分提示のうえ差し替え | 同上 |
| agents | 無いもの / 差分ありのもの | 無いものだけ追加。差分ありは提示のみ | なし（上書きしない） |
| スキル | 未導入の一覧 | 未導入のものだけ `.agents/skills/` に追加 | なし（既存は触れない） |
| trust | 案内のみ | Step 6 の操作を案内 | なし |

ギャップ一覧には次も明記する。

- 書き込み経路: Codex のセッション内で実行している場合、`.codex/`・`.agents/` は読み取り専用のため
  権限昇格の承認を求める（Step 5）
- ガードは best-effort の攻撃面削減で、承認境界ではない（注意事項参照）
- 実行しない項目（ギャップなし・見送り）も表に残し、何を変えないかが分かるようにする

### Step 4: 承認された項目を追補する

承認後、承認された項目だけを次の順で実行する。実行している環境で分岐する。

- OpenCode・Claude Code・端末から実行している場合: この Step のコマンドで直接書く
- Codex のセッション内で実行している場合: 書き込みを伴う各コマンドを権限昇格つきで要求する（経路 A）。
  拒否された・要求できなかった場合は Step 5 の経路 B（退避と案内）へ切り替える

#### 4-1. hooks スクリプトと rules を配置する

承認された分だけ配置する。差し替えを承認されなかったファイルは触れない。

```bash
ASSETS="<skill-dir>/assets"
TARGET="<target>"

mkdir -p "${TARGET}/.codex/hooks" "${TARGET}/.codex/rules" "${TARGET}/.codex/agents"

# Step 3 で承認されたファイル名だけを列挙する（例は全件承認の場合。見送ったものは配列から外す・空にしてよい）
approved_hooks=(agent-guard.sh codex-pretooluse.sh codex-session-start.sh)
approved_rules=(agent-guard.rules)
approved_agents=(researcher implementer reviewer)   # 「なし」の標準 agent だけを入れる

for f in "${approved_hooks[@]}"; do
  cp "${ASSETS}/hooks/${f}" "${TARGET}/.codex/hooks/${f}"
  chmod +x "${TARGET}/.codex/hooks/${f}"
done
for f in "${approved_rules[@]}"; do
  cp "${ASSETS}/codex/rules/${f}" "${TARGET}/.codex/rules/${f}"
done
# agent は既存の同名ファイルを上書きしない（既存なら飛ばす）
for a in "${approved_agents[@]}"; do
  dst="${TARGET}/.codex/agents/${a}.toml"
  [ -e "${dst}" ] || cp "${ASSETS}/codex/agents/${a}.toml" "${dst}"
done
```

- `hooks.json` の `command` は `$(git rev-parse --show-toplevel)` から解決するため、パスの書き換えは不要
- `command` にトークン・パスワードを埋め込まない。入力をそのまま展開しない
- 利用者が置いた `.codex/hooks/` 内の他のスクリプトには触れない（`chmod` も承認済みファイルだけに行う）

#### 4-2. hooks.json を更新する

hooks.json は**手で編集しない**。必ず `codex-hooks-merge.sh` で更新する。

```bash
bash "${ASSETS}/scripts/codex-hooks-merge.sh" \
  --target "${TARGET}/.codex/hooks.json" --template "${ASSETS}/codex/hooks.json"
echo "exit=$?"
```

最終行の結果語彙と終了コードで判定する。

| 結果語彙 | 終了コード | 意味と対応 |
|---------|-----------|-----------|
| `created` / `added` / `updated` / `unchanged` | 0 | 成功。`unchanged` は既に最新 |
| `error-usage` | 1 | 引数の誤り。コマンドを見直す |
| `error-no-jq` / `error-symlink` / `error-io` / `error-template` / `error-target` | 2 | 入出力・前提の問題。原因を報告して中断 |
| `error-json` / `error-type` / `error-duplicate` | 4 | hooks.json の内容の不整合。ファイルは変わっていない。手で直すよう案内して中断 |
| `error-matcher` | 4 | 自エントリ `codex-pretooluse.sh` が matcher `^Bash$` 以外のグループにあるため、書かずに停止した（利用者の matcher は書き換えない）。該当グループの matcher を確認して手で直すか、自エントリを `^Bash$` のグループへ移すよう案内して中断 |

`error-*` が返ったら、以降の項目へ進まず、原因と対処を報告して**中止**する。

#### 4-3. AGENTS.md の管理区間を書く

```bash
bash "${ASSETS}/scripts/agents-md-block.sh" \
  --target "${TARGET}/AGENTS.md" --block "${ASSETS}/agents-md-block.md"
echo "exit=$?"
```

| 結果語彙 | 終了コード | 意味と対応 |
|---------|-----------|-----------|
| `created` / `appended` / `replaced` / `unchanged` | 0 | 成功 |
| `error-usage` | 1 | 引数の誤り。コマンドを見直す |
| `error-block-unreadable` / `error-block-empty` / `error-symlink` / `error-target` / `error-io` | 2 | 入出力・前提の問題。原因を報告して中断 |
| `error-markers` / `error-fence` / `error-block-marker` | 4 | マーカー・フェンスの不整合。ファイルは変わっていない。手で直すよう案内して中断 |

32768 バイトを超えると stderr に警告が出る（Codex は AGENTS.md を合計 32 KiB までしか読まない）。
警告が出たら報告に載せる。管理区間の外はバイト単位で変わらない。

#### 4-4. 未導入のワークフロースキルを追加する

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
  Claude Code 側は `init-claude` / `update-claude` の担当
- `skills-lock.json` が更新され、各エントリに `skillPath` があることを確認する

### Step 5: Codex のセッション内で実行している場合の書き込み経路

Codex の既定 sandbox は `.git`・`.agents`・`.codex` を読み取り専用にする。Codex のセッション内で実行している場合、
Step 4-1・4-2・4-4 の書き込みは拒否され得る。OpenCode・Claude Code・端末から実行している場合は、この Step を飛ばして直接書く。

**経路 A（主）: 承認による昇格。** 書き込みを伴うコマンド（`mkdir -p`・`cp`・`codex-hooks-merge.sh`・`npx ... add`）を
権限の昇格つきで要求し、ユーザーの承認を得て実行する。書き込みが成功したら Step 6 へ進む。

**経路 B（代替）: 退避と案内。** 昇格が拒否された・要求できなかった場合は、承認済みの生成物を書き込み可能な
`<target>/_/codex-setup/` に書き、移動とスキル導入のコマンドをユーザーに提示して実行してもらう。
hooks.json は既存ファイルのコピーに対してマージを実行し、結果をユーザーが置き換える。

```bash
STAGE="<target>/_/codex-setup"
ASSETS="<skill-dir>/assets"

# 既に存在する退避先は以前の作業や利用者のファイルを含み得るため使わない（ユーザーに確認して中断する）
[ ! -e "${STAGE}" ] || { echo "退避先が既に存在する: ${STAGE}"; exit 1; }
mkdir -p "${STAGE}/.codex/hooks" "${STAGE}/.codex/rules" "${STAGE}/.codex/agents"
MANIFEST="${STAGE}/.created-paths"   # 作ったファイルの記録（後始末で使う）
: > "${MANIFEST}"

# 承認されたファイル名だけを列挙して退避先へ置く（Step 4-1 と同じ配列。見送ったものは外す）
approved_hooks=(agent-guard.sh codex-pretooluse.sh codex-session-start.sh)
approved_rules=(agent-guard.rules)
approved_agents=(researcher implementer reviewer)   # 「なし」の標準 agent だけ

for f in "${approved_hooks[@]}"; do
  cp "${ASSETS}/hooks/${f}" "${STAGE}/.codex/hooks/${f}" && printf '%s\n' "${STAGE}/.codex/hooks/${f}" >> "${MANIFEST}"
done
for f in "${approved_rules[@]}"; do
  cp "${ASSETS}/codex/rules/${f}" "${STAGE}/.codex/rules/${f}" && printf '%s\n' "${STAGE}/.codex/rules/${f}" >> "${MANIFEST}"
done
for a in "${approved_agents[@]}"; do
  cp "${ASSETS}/codex/agents/${a}.toml" "${STAGE}/.codex/agents/${a}.toml" && printf '%s\n' "${STAGE}/.codex/agents/${a}.toml" >> "${MANIFEST}"
done

# hooks.json: 既存のコピーに自エントリだけをマージする（既存が無ければテンプレートから作られる）
if [ -f "<target>/.codex/hooks.json" ]; then
  cp "<target>/.codex/hooks.json" "${STAGE}/.codex/hooks.json"
fi
bash "${ASSETS}/scripts/codex-hooks-merge.sh" \
  --target "${STAGE}/.codex/hooks.json" --template "${ASSETS}/codex/hooks.json"
printf '%s\n' "${STAGE}/.codex/hooks.json" >> "${MANIFEST}"
```

AGENTS.md を退避先へ書いた場合は、そのパス（`${STAGE}/AGENTS.md`）も `${MANIFEST}` に追記する。

`AGENTS.md` はリポジトリ直下で書き込める場合が多いため、Step 4-3 のとおり直接書く。書き込めない場合は、
既存の AGENTS.md を `${STAGE}/AGENTS.md` へコピーしてから `--target "${STAGE}/AGENTS.md"` で書き、置き換えを案内する。

update では `<target>/.codex/` が既にある。したがって `mv _/codex-setup/.codex .codex` は使わない
（`.codex/.codex/` に入り反映されない）。ディレクトリ単位では動かさず、**承認済みのファイルだけ**をファイル単位で
次の分岐で反映する。ワイルドカードで全件を動かさず、移動前に必ず宛先の有無を確認する（`mv -n` には頼らない。
BSD と GNU で戻り値が異なる）。

| 宛先の状態 | 動作 |
|-----------|------|
| 無い | 宛先の親を作って移動する |
| 有り・内容が同一 | 退避側のファイルを捨てる |
| 有り・内容が異なる | 移動せず差分を提示する。承認済みの更新（hooks・rules・hooks.json）は、差分を確認した利用者が `APPLY_DIFF=1` を付けて再実行したときだけ置き換える。agent ファイルは利用者の編集を守るため、`APPLY_DIFF=1` でも置き換えず、退避側のファイルは削除する |

ユーザーに提示するコマンド（ユーザー自身が、権限のある端末で実行する）。配列には承認済みの名前だけを入れて渡す。

```bash
cd "<target>"
rc=0
place() {   # $1=退避側のファイル $2=宛先 $3=overwrite なら APPLY_DIFF=1 のとき差分ありでも置き換える
  [ -e "$1" ] || return 0   # 退避側が無い（反映済み）なら何もしない
  if [ ! -e "$2" ]; then
    mkdir -p -- "$(dirname -- "$2")" && mv -- "$1" "$2"
  elif cmp -s -- "$1" "$2"; then
    rm -f -- "$1"
  elif [ "${3:-}" = overwrite ] && [ "${APPLY_DIFF:-}" = 1 ]; then
    mv -f -- "$1" "$2"
  else
    echo "差分あり（移動しない）: $2"; diff -u -- "$2" "$1"; return 1
  fi
}
S="_/codex-setup/.codex"
approved_hooks=(agent-guard.sh codex-pretooluse.sh codex-session-start.sh)   # 承認済みだけに書き換える
approved_rules=(agent-guard.rules)
approved_agents=(researcher implementer reviewer)   # 承認された名前だけを入れる

for f in "${approved_hooks[@]}"; do
  place "${S}/hooks/${f}" ".codex/hooks/${f}" overwrite && chmod +x ".codex/hooks/${f}" || rc=1
done
for f in "${approved_rules[@]}"; do place "${S}/rules/${f}" ".codex/rules/${f}" overwrite || rc=1; done
for a in "${approved_agents[@]}"; do
  if [ -e "${S}/agents/${a}.toml" ] && [ -e ".codex/agents/${a}.toml" ] \
     && ! cmp -s -- "${S}/agents/${a}.toml" ".codex/agents/${a}.toml"; then
    echo "既存を保持（スキップ・退避側は削除）: .codex/agents/${a}.toml"   # 利用者の編集を守る。失敗には数えない
    rm -f -- "${S}/agents/${a}.toml"   # 退避側は不要。残すと後始末の rmdir が失敗する
  else
    place "${S}/agents/${a}.toml" ".codex/agents/${a}.toml" || rc=1
  fi
done
# hooks.json の更新を承認した場合だけ（マージ済みのコピーで置き換える）
place "${S}/hooks.json" ".codex/hooks.json" overwrite || rc=1
[ "${rc}" -eq 0 ] || echo "差分のあるファイルは未反映。内容を確認し、承認済みの更新なら APPLY_DIFF=1 で再実行する"

# 未導入のワークフロースキルの追加（未導入のものだけ -s を付ける）
SKILLS_CLI_VERSION="1.5.23"   # Step 4-4 と同じ固定版
skill_args=()
for s in create-commit create-pr create-issue implement-issue implement-issue-tree \
         implement-review implement-review-pr update-docs comment-code; do
  [ -e ".agents/skills/${s}" ] || skill_args+=(-s "${s}")
done
[ "${#skill_args[@]}" -eq 0 ] || npx --yes "skills@${SKILLS_CLI_VERSION}" add Fandhe-AI/agent-cli-skills "${skill_args[@]}" -a codex -a opencode -y
```

提示後は、ユーザーが実行を終えたと伝えるまで Step 6 以降へ進まない。実行後に Step 7 の検証を行う。

**後始末。** 経路 B で `_/codex-setup/` を使った場合、ユーザーの反映が済んだら、**自分が作ったファイルだけ**を個別に削除し、
空になったディレクトリだけ `rmdir` で消す。`rm -rf` は使わない。`_/` 配下に他の内容があれば残す。

```bash
STAGE="<target>/_/codex-setup"
MANIFEST="${STAGE}/.created-paths"
# 記録したパスだけを 1 件ずつ削除する（ワイルドカードで一括削除しない）
if [ -f "${MANIFEST}" ]; then
  while IFS= read -r p; do
    case "${p}" in "${STAGE}/"*) rm -f -- "${p}" ;; esac   # 退避先の外は消さない
  done < "${MANIFEST}"
  rm -f -- "${MANIFEST}"
fi
rmdir "${STAGE}/.codex/hooks" "${STAGE}/.codex/rules" "${STAGE}/.codex/agents" "${STAGE}/.codex" 2>/dev/null
rmdir "${STAGE}" 2>/dev/null
rmdir "<target>/_" 2>/dev/null
```

記録に無いファイルが残ったディレクトリは `rmdir` が失敗して残る。残ったファイルは利用者のものとして触れず、報告に書く。

`_/codex-setup/` が `.gitignore` に入っているかを確認し、入っていなければコミット対象に含めないよう案内する。

### Step 6: trust を案内する

hook は **project trust** と `/hooks` での **hook trust** の**両方**が揃うまで、**黙って skip される**。
hook スクリプトや hooks.json を更新すると、更新した hook は再承認するまで実行されない場合がある。
このスキルは trust を**自分では書かず、承認もしない**。ユーザー自身が次のどちらかを行うよう案内する。

1. `~/.codex/config.toml` に対象プロジェクトの trust を追記する（ユーザーが自分で編集する）

   ```toml
   [projects."<target の絶対パス>"]
   trust_level = "trusted"
   ```

2. または、対象リポジトリで Codex を起動したときの trust 確認で、ユーザーが信頼を選ぶ

そのうえで、Codex の中で `/hooks` を開き、追加・変更された hook（PreToolUse・SessionStart）を内容を確認して承認する。

- `--dangerously-bypass-hook-trust` など、trust を迂回するオプションは案内しない
- `.codex/rules/agent-guard.rules` は project trust だけで効く（hook trust は不要）

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

# 7) 利用者の hooks.json エントリ数（Step 2-2 で控えた値と同じであること）
jq '[.hooks[]?[]?.hooks[]? | select(((.command // "") | tostring
      | (contains(".codex/hooks/codex-pretooluse.sh") or contains(".codex/hooks/codex-session-start.sh"))) | not)] | length' \
  .codex/hooks.json

# 8) 再診断: 承認した項目が unchanged になる
bash "<skill-dir>/assets/scripts/codex-hooks-merge.sh" \
  --target .codex/hooks.json --template "<skill-dir>/assets/codex/hooks.json" --check
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
| 7) 利用者エントリ数 | Step 2-2 の控えと同じ値 |
| 8) 再診断 | `CODEX_HOOKS_MERGE_RESULT unchanged`（hooks.json の更新を承認した場合） |

加えて、追加を承認したスキルが `.agents/skills/` にあり、`skills-lock.json` が妥当な JSON であることを確認する
（`jq . skills-lock.json >/dev/null && echo OK`）。期待と異なる結果が 1 つでもあれば、原因を特定して直すまで
完了と報告しない。見送った項目に関する確認は「見送り」と書き、失敗として扱わない。

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

- 診断で見つけたギャップと、承認・見送りの内訳
- 作成・更新したファイル一覧（AGENTS.md の結果語彙・hooks.json の結果語彙・`.codex/` 配下・`skills-lock.json`）
- 追加したスキルと、導入済みで飛ばしたスキル
- 上書きしなかったもの（差分を示しただけの agent・見送った差し替え）
- Step 7 の各検証の結果（証拠として出力・終了コードを引用）。未実施のものは「未検証」と明記
- trust が未完了であれば、hook はまだ効かないこと（rules だけが効く）と、Step 6 の操作
- 次の点を必ず明記する。
  - ワークフロースキル 9 件は Codex 上の動作を、後続の計画（スキルのツール中立化）が終わるまで**保証しない**
  - ガードは best-effort の攻撃面削減で、**承認境界ではない**。実強制はサーバー側の branch protection と人間によるマージ
  - 9 スキルは `-a codex -a opencode` で入れたため `.claude/skills` には出ない。Claude Code 側は `update-claude` の担当
  - OpenCode 側の体系は `update-opencode`（AGENTS.md の管理区間は共有され 1 つのまま）

## 検証

完了とみなす条件は、Step 7 の項目が期待どおりで、証拠（出力と終了コード）を報告に引用していること。
具体的には次のとおり。

- `codex execpolicy check ...` が forbidden（codex 未導入なら「未検証」と明記）
- アダプタが deny 入力で deny JSON、allow 入力で空出力（どちらも exit 0）
- `jq . .codex/hooks.json` が成功し、AGENTS.md の管理区間の開始マーカー数が 1
- 更新後の利用者の hooks.json エントリ数が更新前と同じ
- 追加を承認したスキルが `.agents/skills/` にあり、`skills-lock.json` が妥当

「動くはず」での完了報告はしない。実行していない検証は未検証と書く。

## 注意事項

- `.codex/` が無いリポジトリでは（AGENTS.md の管理区間の有無に関わらず）何も書かず、`init-codex` を案内して終了する
- ユーザーの承認なしに何も書かない。診断（Step 2）は読み取りだけで行う
- hooks.json は `codex-hooks-merge.sh` 以外で編集しない。`error-*` が返ったら中止して報告し、手で直さない
- 利用者の hooks.json エントリ・利用者の agent ファイルは消さない。標準 agent の既存の同名ファイルも上書きしない
- hooks スクリプト・rules・AGENTS.md の管理区間の差し替えは手編集を消し得るため、差分を示して承認を取る
- **trust を自動化しない。** `~/.codex/config.toml` へ書き込まず、`/hooks` の承認もしない。`--dangerously-bypass-hook-trust` は案内しない
- Codex のセッション内では `.codex/`・`.agents/` が読み取り専用。権限昇格の承認を求め、拒否されたら Step 5 の退避経路へ切り替える
- `agents-md-block.sh` は AGENTS.md の管理区間の外をバイト単位で変えない。マーカーが不整合なら書かずに中断する。区間は常に 1 つ
- **ガードの残存ギャップ**:
  - メインセッションでの `$'...'` による難読化は通る（難読化の拒否はサブエージェントのみ）
  - フックの無効化・alias の定義（`-c` / `--config-env` / `git config` の `core.hooksPath` と `alias.*`、先頭の `HUSKY=0` / `HUSKY_SKIP_HOOKS=1`）は検出して deny する。拾えないのは、利用者の設定ファイルに既にある alias・`include.path`・`GIT_CONFIG_*` 環境変数・`SKIP=`・別の呼び出しで export 済みの `HUSKY`、`env -S` で代入だけ渡し後続に git を置く形（上流 Fandhe-AI/agent-cli-skills#782 で追跡）
  - `bash -c` / `sh -c` / `eval`・ヒアドキュメントや here-string の中身、`$(…)` 内の引用符の食い違いは見ない
  - base64 復元・変数間接呼び出し・ブレース / glob 展開などの文字列照合で見抜けない形は通る。rules は先頭一致のため `git push origin main --force` 等は拾えない
- `skills` CLI は固定版で実行する。失敗しても未固定 `npx` へフォールバックしない（付録参照）
- コマンドへ渡すパスやスキル名は常に `"${var}"` でクォートする。外部入力を `bash -c` や `eval` へ渡さない
- `--no-verify` を含むコマンドを hook や手順に仕込まない。`rm -rf` は使わない
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
2. `node --test skills/update-codex/tests/*.test.mjs` で exact semver・実行行の固定を検証する
3. 1 リポジトリで実際に実行し、差分が正常であることを確認する
4. `chore(update-codex): skills CLI を X.Y.Z へ更新` でコミットする
5. 同じ `skills` CLI を固定する `init-claude` / `update-claude` / `init-codex` / `init-opencode` / `update-opencode` / `sync-skills-lock` の同名節も同時更新することを推奨する（値の同期は必須ではないが、乖離した場合はどちらかの節にその旨を記録する）

**fail-closed**: 固定版が解決できない場合（該当版の不存在・レジストリ障害等どの原因でも）は `npx` が非ゼロ終了し停止する。未固定 `npx skills add` へのフォールバック再試行は行わない。
