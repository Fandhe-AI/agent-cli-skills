---
name: init-opencode
description: >
  OpenCode 体系（opencode.jsonc・.opencode の agents / plugin ガード・AGENTS.md 管理区間・スキル 9 件）を初期セットアップ。
  「opencode セットアップして」「opencode.jsonc 作って」「OpenCode 用に整備して」で使用。--no-verify・force push を plugin で止める。
  既存は update-opencode、Codex は init-codex、Claude Code は init-claude。
model: opus
user-invocable: true
argument-hint: "<対象リポジトリのパス（省略時はカレントディレクトリ）>"
---

# init-opencode

任意のリポジトリに OpenCode 向けの体系を初期セットアップする。作るものは次のとおり。

- `AGENTS.md` の管理区間（日本語出力・Conventional Commits・`--no-verify` 禁止・計画承認後の実装）
- `opencode.jsonc`（`permissions` / `policies`。典型形の force push と `--no-verify` を deny する補助の宣言層）
- `.opencode/plugins/agent-guard/index.js` と `.opencode/hooks/agent-guard.sh`（主判定のガード）
- `.opencode/agents/*.md`（標準サブエージェント。researcher / implementer / reviewer）
- ワークフロースキル 9 件（`.agents/skills/` と `skills-lock.json`）

既存の OpenCode 設定や `.opencode/` の agents・plugins があるリポジトリには `update-opencode` を使う。
Codex は `init-codex`、Claude Code は `init-claude` の担当で、既存の `.claude/` があってもエラーにしない（併用できる）。

このスキルは実行するエージェントを問わない（Codex・OpenCode・Claude Code のどれからでも実行できる）。
特定のエージェント機構には依存せず、シェルコマンドとファイル操作だけで進める。
Codex のセッション内では書き込みが sandbox に拒否され得るため、その場合は Step 4-5 の経路で進める。

## 使い方

```
init-opencode [対象リポジトリのパス]
```

パスを省略した場合はカレントディレクトリを対象とする。以降の `<target>` は対象リポジトリのルート、
`<skill-dir>` はこの SKILL.md があるディレクトリ（`assets/` はその直下）を指す。
`assets/` はこのスキルのものだけを参照し、他のスキルのディレクトリは参照しない。

## 前提条件

- `git` が使え、対象が git リポジトリであること（`git -C <target> rev-parse --show-toplevel` で確認）
- `bash` と `jq` が使えること（plugin が `bash` を spawn してガードを実行する。ガードが判定に使う。`jq` が無い環境ではガードが fail-closed で全 shell コマンドを拒否するため、導入を先に案内する）
- `gh` が使え、認証済みであること（`gh auth status`。ワークフロースキルが使う）
- `npx` が使えること（スキル導入に使う。`skills` CLI は固定版 `SKILLS_CLI_VERSION` で実行する。値と更新手順は付録を参照）
- `opencode` が使えること（検証で `opencode debug config` / `opencode debug agents` を使う。無い場合も生成は進められるが、その検証は「未検証」と報告する）

## フロー

### Step 1: 前提を確認する

```bash
for c in git bash jq gh npx opencode; do
  command -v "$c" >/dev/null 2>&1 && echo "ok: $c" || echo "missing: $c"
done
gh auth status
git -C "<target>" rev-parse --show-toplevel
```

`git`・`bash`・`jq`・`gh`・`npx` のどれかが無い、または `gh` が未認証なら、導入または `gh auth login` を案内して中断する。
`opencode` だけが無い場合は続行し、報告に「debug config / debug agents の検証は未実施」と書く。
以降の `<target>` には `git rev-parse --show-toplevel` が返したルートを使う。

### Step 2: 対象リポジトリを調査する

```bash
cd "<target>"
ls -a
for f in opencode.jsonc opencode.json .opencode/opencode.jsonc; do
  [ -e "$f" ] && echo "設定あり: $f" || echo "設定なし: $f"
done
ls -a .opencode 2>/dev/null || echo ".opencode なし"
ls -d .opencode/agents .opencode/plugins .opencode/hooks 2>/dev/null || true
ls -l AGENTS.md 2>/dev/null || echo "AGENTS.md なし"
grep -c 'agent-cli-skills:agents-md:start' AGENTS.md 2>/dev/null || true
ls .agents/skills 2>/dev/null || echo ".agents/skills なし"
ls -d .claude 2>/dev/null || echo ".claude なし"
head -20 skills-lock.json 2>/dev/null || true
```

把握する情報と扱い。

| 項目 | 扱い |
|------|------|
| `opencode.jsonc` / `opencode.json` / `.opencode/opencode.jsonc` | どれか 1 つでもあれば**中断**し、`update-opencode` へ誘導する（このスキルは既存の設定に書かない） |
| `.opencode/agents/`・`.opencode/plugins/`・`.opencode/hooks/` | どれかがあれば**中断**し、`update-opencode` へ誘導する。`.opencode/` が他の内容（`skills/` 等）だけなら続行する |
| `AGENTS.md` | あれば管理区間の外は変えない。`setup-repo-guards` のレビュー観点集などが入っていてよい。管理区間（`agent-cli-skills:agents-md:start`）が既にあれば中身だけ差し替わる |
| `.agents/skills/` | 9 スキルのうち導入済みのものは入れ直さない（Step 4-4 で差分だけ入れる） |
| `.claude/` | あっても**エラーにしない**。このスキルは `.claude/` に触れない |
| 主要言語・ビルドとテストのコマンド | 構成案の AGENTS.md 追記方針と報告に使う |

設定ファイルは `.opencode/opencode.jsonc` が `opencode.jsonc` を**全上書き**するため、1 形式に揃える必要がある。
このスキルは新規作成のときだけ動くので、設定はリポジトリ直下の `opencode.jsonc` に作る。

### Step 3: 構成案を提示して承認を得る

調査結果をもとに次を一覧で**ユーザーに提示し、承認を得てから**次の Step へ進む。承認なしでは何も書かない。

| 区分 | 作るもの | 補足 |
|------|---------|------|
| AGENTS.md | 管理区間（新規作成・追記・差し替えのどれか） | `agents-md-block.sh --check` で結果語彙を先に示す。管理区間の外は変えない |
| 設定 | `opencode.jsonc`（直下） | `permissions` / `policies` で典型形の deny。字面一致のため順序違いは止められない補助層 |
| ガード | `.opencode/hooks/agent-guard.sh` と `.opencode/plugins/agent-guard/index.js` | 主判定。plugin が `agent-guard.sh` を呼び、deny ならコマンドを止める。判定は 1 本の bash スクリプトに集約 |
| agents | `.opencode/agents/` の `researcher.md`・`implementer.md`・`reviewer.md` | researcher / reviewer は shell 不可の読み取り専用 |
| スキル | 未導入のワークフロースキル（9 件のうち） | `.agents/skills/` に導入。OpenCode 上の動作は保証しない（Step 6 参照） |

構成案には次も明記する。

- ガードは best-effort の攻撃面削減で、承認境界ではない（注意事項参照）
- 9 スキルは `.claude/skills` には出ない（Claude Code 側は `init-claude` / `update-claude` の担当）
- OpenCode の組み込みスキル ID（`opencode`・`report`・`browser`）と同名のスキルは警告なしで上書きされる。9 スキルは該当しない

AGENTS.md の結果語彙を事前に確認する。

```bash
bash "<skill-dir>/assets/scripts/agents-md-block.sh" \
  --target "<target>/AGENTS.md" --block "<skill-dir>/assets/agents-md-block.md" --check
```

最終行の `AGENTS_MD_BLOCK_RESULT <語彙>` が `error-*`（マーカーが片方だけ・2 組以上・フェンス閉じ忘れ・シンボリックリンク等）なら、
ファイルを変えずに原因を報告して中断する。

### Step 4: 生成する

承認後、次の順で生成する。

#### 4-1. ガード・設定・agents を配置する

```bash
ASSETS="<skill-dir>/assets"
TARGET="<target>"

mkdir -p "${TARGET}/.opencode/hooks" "${TARGET}/.opencode/plugins/agent-guard" "${TARGET}/.opencode/agents"
cp "${ASSETS}/hooks/agent-guard.sh" "${TARGET}/.opencode/hooks/agent-guard.sh"
chmod +x "${TARGET}/.opencode/hooks/agent-guard.sh"
cp "${ASSETS}/opencode/plugins/agent-guard/index.js" "${TARGET}/.opencode/plugins/agent-guard/index.js"
cp "${ASSETS}/opencode/agents/"*.md "${TARGET}/.opencode/agents/"
[ -e "${TARGET}/opencode.jsonc" ] || cp "${ASSETS}/opencode/opencode.jsonc" "${TARGET}/opencode.jsonc"
```

- plugin は `import.meta.url` から `../../hooks/agent-guard.sh` を解決するため、上の相対配置を崩さない（パスの書き換えは不要）
- `opencode.jsonc` は既存なら上書きしない（`[ -e ... ] ||` で飛ばす）。Step 2 で設定が無いことを確認済みだが、念のためである
- plugin は package.json も import も要らない素の object export。`ask` は使わない（`--auto` 下で自動承認されるため、deny だけを使う）
- agents の本文は、対象リポジトリの言語・構成に合わせて必要なら追記する（承認済みの範囲で）
- 秘密情報（トークン・パスワード）をどのファイルにも書かない

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

32768 バイトを超えると stderr に警告が出る（Codex が AGENTS.md を合計 32 KiB までしか読まないため、共有する場合に効く）。
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
    echo "エラー: skills@${SKILLS_CLI_VERSION} の実行が失敗した（該当版の不存在・レジストリ障害等、原因は問わない）。未固定 npx へのフォールバックは行わない。原因を確認してから再実行する。" >&2
    exit 1
  }
fi
```

- `-a codex -a opencode` は `.agents/skills/<name>` の実体だけを作り、既存の `.claude/skills/` には触れない。
  このため導入したスキルは Claude Code の一覧には出ない
- `skills-lock.json` が生成・更新され、各エントリに `skillPath` があることを確認する

#### 4-5. Codex のセッション内で実行している場合の書き込み経路

Codex の既定 sandbox は `.git`・`.agents`（`npx skills add` の書き込み先）・`.codex` を読み取り専用にする。`.opencode/` や
`opencode.jsonc` も、sandbox の設定によっては書き込みを拒否され得る。Codex のセッション内で実行している場合、
4-1・4-2・4-4 の書き込みコマンド（`mkdir -p`・`cp`・`agents-md-block.sh`・`npx ... add`）は権限の昇格つきで要求し、
ユーザーの承認を得て実行する。拒否された・要求できなかった場合は、実行できなかったコマンドをそのままユーザーに提示し、
権限のある端末で実行してもらう。ユーザーが実行を終えたと伝えるまで Step 5 へ進まず、実行後に Step 5 の検証を行う。
OpenCode・Claude Code・端末から実行している場合は、この節を飛ばして直接書く。

### Step 5: 動作を検証する

次を実行し、出力と終了コードで確認する。

`opencode debug config` の出力にはグローバル設定（`~/.config/opencode` など）由来の秘密が含まれ得る。
**全文を表示・保存しない。** `jq` でプロジェクト由来のキーの件数だけを抜き出す。

```bash
cd "<target>"
set -o pipefail

# 1) permissions / policies が解決後の設定に残っている（未知キーは黙って消えるため必須）
opencode debug config --standalone \
  | jq -r '"permissions_deny_shell=\([.permissions[]? | select(.action=="shell" and .effect=="deny")] | length) policies_deny=\([.policies[]? | select(.effect=="deny")] | length)"'
echo "exit=$?"

# 2) 3 つの agent が見える（plugin の setup 完了まで待つ。出力は表示せず名前の有無だけ見る）
out="$(opencode debug agents --standalone 2>&1)"; rc=$?
echo "debug agents exit=${rc}"
for a in researcher implementer reviewer; do
  printf '%s' "${out}" | grep -qw -- "${a}" && echo "agent ok: ${a}" || echo "agent missing: ${a}"
done
unset out

# 3) ガード: force push が deny される（最後の行が AGENT_GUARD_RESULT deny ...）
echo '{"command":"git push origin main --force","subagent":false}' | bash .opencode/hooks/agent-guard.sh
echo "exit=$?"

# 4) ガード: 通常のコミットは allow
echo '{"command":"git commit -m x","subagent":false}' | bash .opencode/hooks/agent-guard.sh
echo "exit=$?"

# 5) ガード: サブエージェントのマージが deny される
echo '{"command":"gh pr merge 1","subagent":true}' | bash .opencode/hooks/agent-guard.sh
echo "exit=$?"

# 6) AGENTS.md の管理区間が 1 つ
grep -c 'agent-cli-skills:agents-md:start' AGENTS.md
```

期待値。

| 確認 | 期待 |
|------|------|
| 1) 設定の残存 | `permissions_deny_shell` が 1 以上、`policies_deny` が 1 以上、終了コード 0。0 なら未知キーとして消えている |
| 2) agents | `debug agents exit=0` かつ 3 件とも `agent ok` |
| 3) force push | 最終行 `AGENT_GUARD_RESULT deny force-push`、終了コード 2 |
| 4) 通常コミット | 最終行 `AGENT_GUARD_RESULT allow`、終了コード 0 |
| 5) サブエージェントのマージ | 最終行が `AGENT_GUARD_RESULT deny ...`、終了コード 2 |
| 6) 区間数 | `1` |

加えて、`.agents/skills/` に 9 スキルがあり、`skills-lock.json` が妥当な JSON であることを確認する
（`jq . skills-lock.json >/dev/null && echo OK`）。期待と異なる結果が 1 つでもあれば、
原因（`jq` の有無・パス・配置漏れ・設定形式の取り違え）を特定して直すまで完了と報告しない。
`opencode` が無く 1) 2) を実行できなかった場合は「未検証」と書く。

3)〜5) は plugin を介さずガードを直接検査するもので、plugin が実セッションで呼ばれることの証明ではない。
実セッションでの確認を案内する場合は、**対象リポジトリでは危険なコマンドを実行させない**。
実リモートから切り離した使い捨てリポジトリだけで行う。

```bash
SANDBOX="$(mktemp -d)"
git init --bare "${SANDBOX}/origin.git"
git init "${SANDBOX}/work" && cd "${SANDBOX}/work"
git remote add origin "${SANDBOX}/origin.git"   # origin はローカルの bare のみ
# 対象の .opencode/ と opencode.jsonc をここへコピーし、OpenCode（`opencode run --auto` でもよい）を
# このディレクトリで起動して `git push --force` が拒否されることを確かめる（--auto でも deny は効く。ask を使わないため）
```

確認後は `${SANDBOX}` を利用者が自分で削除する。`rm -rf` は案内しない。使い捨てを用意できないときは、実セッションの確認は行わず「未検証」と報告する。

### Step 6: 結果を報告する

報告項目。

- 作成・更新したファイル一覧（AGENTS.md の結果語彙・`opencode.jsonc`・`.opencode/` 配下・`skills-lock.json`）
- 導入したスキルと、導入済みで飛ばしたスキル
- Step 5 の各検証の結果（証拠として出力・終了コードを引用）。未実施のものは「未検証」と明記
- 次の点を必ず明記する。
  - ワークフロースキル 9 件は OpenCode 上の動作を、後続の計画（スキルのツール中立化）が終わるまで**保証しない**。導入しただけの状態である
  - ガードは best-effort の攻撃面削減で、**承認境界ではない**。実強制はサーバー側の branch protection と人間によるマージ
  - 9 スキルは `-a codex -a opencode` で入れたため `.claude/skills` には出ない。Claude Code の一覧にも出したい場合は
    `init-claude` / `update-claude` の担当
  - Codex にも同じ体系を入れるなら `init-codex`（AGENTS.md の管理区間は共有され 1 つのまま）
  - 既存体系の差分を後から充実させるなら `update-opencode`

## 検証

完了とみなす条件は、Step 5 の 6 項目が期待どおりで、証拠（出力と終了コード）を報告に引用していること。
具体的には次のとおり。

- `opencode debug config --standalone` の jq 抜粋で `permissions` / `policies` の deny が 1 件以上残っている（opencode 未導入なら「未検証」と明記）
- `opencode debug agents --standalone` が終了コード 0 で、3 agent が見える
- ガードが force push で deny、通常コミットで allow、サブエージェントのマージで deny を返す
- AGENTS.md の管理区間の開始マーカー数が 1
- `.agents/skills/` に 9 スキルがあり、`skills-lock.json` が妥当

「動くはず」での完了報告はしない。実行していない検証は未検証と書く。

## 注意事項

- 既存の OpenCode 設定（`opencode.jsonc`・`opencode.json`・`.opencode/opencode.jsonc`）や `.opencode/` の agents・plugins・hooks があれば中断して `update-opencode` を案内する。このスキルは既存の設定を上書きしない
- ユーザーの構成案承認なしに何も書かない
- 設定は 1 形式に揃える。`.opencode/opencode.jsonc` は `opencode.jsonc` を全上書きするため、両方を作らない
- **`opencode debug config` の全文を表示・保存しない。** グローバル設定由来の秘密が含まれ得る。`jq` でプロジェクト由来のキーだけを抜き出す
- 未知キーは黙って消える。設定を書いたら `debug config` でキーの残存を必ず確認する。`ask` は `--auto` で自動承認されるため使わない
- `agents-md-block.sh` は AGENTS.md の管理区間の外をバイト単位で変えない。マーカーが不整合なら書かずに中断する。区間は常に 1 つ（ユーザーが明示承認した区間外への追記は別操作）
- 読み取り専用の agent（researcher / reviewer）は shell を使えない。差分は呼び出し元が渡す
- **ガードの残存ギャップ**:
  - メインセッションでの `$'...'` による難読化は通る（難読化の拒否はサブエージェントのみ）
  - `git -c core.hooksPath=` によるフックの無効化は検出しない
  - eval・base64 復元・変数間接呼び出しなどの文字列照合で見抜けない形は通る。`permissions` / `policies` は字面一致のため `git push origin main --force` 等の順序違いは拾えない（plugin が止める）
- ガードは `jq` が無い・入力を読めない・plugin から呼べないときに deny へ倒れる（fail-closed）。plugin が読み込めないと宣言層だけが効く
- `skills` CLI は固定版で実行する。失敗しても未固定 `npx` へフォールバックしない（付録参照）
- コマンドへ渡すパスやスキル名は常に `"${var}"` でクォートする。外部入力を `bash -c` や `eval` へ渡さない
- `--no-verify` を含むコマンドを plugin や手順に仕込まない
- コミットを伴う場合は `.claude/rules/conventional-commits.md` に従う（このスキル自体はコミットしない）
- 出力・報告は日本語で書く

## 付録: skills CLI のバージョン固定と更新手順

**Why**: `npx skills add` をバージョン未固定で実行すると、npx はローカルキャッシュに無い場合レジストリのその時点の最新版を確認なしで即時取得・実行する。`skills`（vercel-labs/skills）パッケージが乗っ取られた場合、これは任意コード実行の経路になる。exact 版（`X.Y.Z`。dist-tag・`^` / `~` レンジは禁止）への固定が信頼アンカーになる。

**固定版の決め方**:
1. `npm view skills version` で現在の latest を確認する
2. `npm view skills repository.url` が `vercel-labs/skills` であることを確認する
3. `npm view skills time --json` 等で公開日時が不自然でないことを確認する

**更新手順**:
1. Step 4-4 フェンス内の `SKILLS_CLI_VERSION` を更新する（このスキル内での正の定義箇所はここ 1 箇所のみ）
2. `node --test skills/init-opencode/tests/*.test.mjs` で exact semver・実行行の固定を検証する
3. 1 リポジトリで実際に実行し、差分が正常であることを確認する
4. `chore(init-opencode): skills CLI を X.Y.Z へ更新` でコミットする
5. 同じ `skills` CLI を固定する `init-claude` / `update-claude` / `init-codex` / `update-codex` / `update-opencode` / `sync-skills-lock` の同名節も同時更新することを推奨する（値の同期は必須ではないが、乖離した場合はどちらかの節にその旨を記録する）

**fail-closed**: 固定版が解決できない場合（該当版の不存在・レジストリ障害等どの原因でも）は `npx` が非ゼロ終了し停止する。未固定 `npx skills add` へのフォールバック再試行は行わない。
