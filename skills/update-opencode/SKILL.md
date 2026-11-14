---
name: update-opencode
description: >
  既存の OpenCode 体系を診断し差分を承認後に追補。「opencode 体系アップデート」「.opencode 充実させて」「opencode.jsonc 更新して」で使用。
  対象は opencode.jsonc の deny 規則・plugin ガード・.opencode/agents・AGENTS.md 管理区間・スキル 9 件。
  新規は init-opencode、Codex は update-codex、Claude Code は update-claude。利用者の規則・agent は消さない。
model: opus
user-invocable: true
argument-hint: "<対象リポジトリのパス（省略時はカレントディレクトリ）>"
---

# update-opencode

既存の OpenCode 体系を診断し、理想形との差分を一覧で提示して、ユーザーが承認した項目だけを追補する。
診断の対象は次の 5 つ。

- `AGENTS.md` の管理区間（日本語出力・Conventional Commits・`--no-verify` 禁止・計画承認後の実装）
- 設定ファイル（`permissions` / `policies` の deny 規則。補助の宣言層）
- ガード（`.opencode/hooks/agent-guard.sh` と `.opencode/plugins/agent-guard/index.js`。主判定）
- `.opencode/agents/*.md`（標準サブエージェント。researcher / implementer / reviewer）
- ワークフロースキル 9 件（`.agents/skills/` と `skills-lock.json`）

利用者が足した規則・agent・設定は消さない。OpenCode の設定も `.opencode/agents`・`.opencode/plugins`・`.opencode/hooks` も無いリポジトリでは `init-opencode` を使う。
Codex は `update-codex`、Claude Code は `update-claude` の担当で、既存の `.claude/` があってもエラーにしない（併用できる）。

このスキルは実行するエージェントを問わない（Codex・OpenCode・Claude Code のどれからでも実行できる）。
特定のエージェント機構には依存せず、シェルコマンドとファイル操作だけで進める。
Codex のセッション内では書き込みが sandbox に拒否され得るため、その場合は Step 5-5 の経路で進める。

## 使い方

```
update-opencode [対象リポジトリのパス]
```

パスを省略した場合はカレントディレクトリを対象とする。以降の `<target>` は対象リポジトリのルート、
`<skill-dir>` はこの SKILL.md があるディレクトリ（`assets/` はその直下）を指す。
`assets/` はこのスキルのものだけを参照し、他のスキルのディレクトリは参照しない。

## 前提条件

- `git` が使え、対象が git リポジトリであること
- `bash`・`jq`・`node` が使えること（plugin が `bash` を spawn してガードを実行する。ガードが `jq` を、設定のマージが `node` を使う。`jq` が無いとガードが fail-closed で全 shell コマンドを拒否するため、導入を先に案内する）
- `gh` が使え、認証済みであること（`gh auth status`。ワークフロースキルが使う）
- `npx` が使えること（スキル補完に使う。`skills` CLI は固定版 `SKILLS_CLI_VERSION` で実行する。値と更新手順は付録を参照）
- `opencode` が使えること（検証で `opencode debug config` / `opencode debug agents` を使う。無い場合も追補は進められるが、その検証は「未検証」と報告する）

## フロー

### Step 1: 前提を確認する

```bash
for c in git bash jq node gh npx opencode; do
  command -v "$c" >/dev/null 2>&1 && echo "ok: $c" || echo "missing: $c"
done
gh auth status
git -C "<target>" rev-parse --show-toplevel
```

`git`・`bash`・`jq`・`node`・`gh`・`npx` のどれかが無い、または `gh` が未認証なら、導入または `gh auth login` を案内して中断する。
`opencode` だけが無い場合は続行し、報告に「debug config / debug agents の検証は未実施」と書く。
以降の `<target>` には `git rev-parse --show-toplevel` が返したルートを使う。

### Step 2: 既存の体系を調査する

```bash
cd "<target>"
for f in opencode.jsonc opencode.json .opencode/opencode.jsonc; do
  [ -e "$f" ] && echo "設定あり: $f" || echo "設定なし: $f"
done
ls -a .opencode 2>/dev/null || echo ".opencode なし"
ls .opencode/agents 2>/dev/null || echo ".opencode/agents なし"
ls -l AGENTS.md 2>/dev/null || echo "AGENTS.md なし"
ls .agents/skills 2>/dev/null || echo ".agents/skills なし"
head -20 skills-lock.json 2>/dev/null || true
```

**OpenCode の設定（`opencode.jsonc`・`opencode.json`・`.opencode/opencode.jsonc`）も、`.opencode/agents`・`.opencode/plugins`・
`.opencode/hooks` も、どれも無い**場合は、`init-opencode` を案内して終了する（このスキルは何も書かない。init-opencode の中断条件と対称）。

設定ファイルが複数ある場合は、実際に効くものを対象にし、その旨を利用者に提示する。

| 状況 | 対象にする設定 |
|------|---------------|
| `.opencode/opencode.jsonc` がある | これ。`opencode.jsonc` を**全上書き**するため、直下の設定は効かない |
| 直下の `opencode.jsonc` だけがある | これ |
| 直下の `opencode.json` だけがある | これ |
| 直下に `opencode.jsonc` と `opencode.json` が両方ある | どちらが効くか断定せず、利用者に確認する（下記のとおり読み込まれているソースと件数は確かめられるが、優先関係は断定しない） |
| 設定が 1 つも無く `.opencode/` だけがある | 直下の `opencode.jsonc` を新規作成する |

以降、対象の設定ファイルのパスを `<config>` と書く。

`opencode debug config --standalone` の出力は、合成後の設定ではなく**設定ソースごとの `{info,path,type}` の配列**である
（グローバル設定・プロジェクトの設定ファイル・ディレクトリが別の要素になり、トップレベルに `.permissions` は無い）。
読み込まれているソースと件数だけを確かめるなら、次のようにする（規則の中身は出さない）。

```bash
opencode debug config --standalone \
  | jq -er '.[] | select((.info | type) == "object") | "\(.path) permissions=\((.info.permissions // []) | length) policies=\((.info.policies // []) | length)"'
```

配列でない出力や jq の失敗は「検証不能」であり、0 件とは読まない。

### Step 3: 診断する（読み取りのみ）

次のコマンドはどれも何も書かない。

```bash
cd "<target>"
ASSETS="<skill-dir>/assets"

# (a) AGENTS.md 管理区間
bash "${ASSETS}/scripts/agents-md-block.sh" \
  --target "<target>/AGENTS.md" --block "${ASSETS}/agents-md-block.md" --check
echo "exit=$?"

# (b) 設定（template の deny 規則が <config> にあるか）
node "${ASSETS}/scripts/opencode-config-merge.mjs" \
  --target "<config>" --template "${ASSETS}/opencode/opencode.jsonc" --check
echo "exit=$?"

# (c) ガードと plugin（assets との一致）
cmp -s "${ASSETS}/hooks/agent-guard.sh" .opencode/hooks/agent-guard.sh \
  && echo "guard: 一致" || echo "guard: 不在または差分あり"
cmp -s "${ASSETS}/opencode/plugins/agent-guard/index.js" .opencode/plugins/agent-guard/index.js \
  && echo "plugin: 一致" || echo "plugin: 不在または差分あり"

# (d) agents（無い / 同一 / 差分あり）
for a in researcher implementer reviewer; do
  f=".opencode/agents/${a}.md"
  if [ ! -e "$f" ]; then echo "agent 不在: ${a}"
  elif cmp -s "${ASSETS}/opencode/agents/${a}.md" "$f"; then echo "agent 一致: ${a}"
  else echo "agent 差分あり: ${a}"; fi
done

# (e) 9 スキルの導入状況
for s in create-commit create-pr create-issue implement-issue implement-issue-tree \
         implement-review implement-review-pr update-docs comment-code; do
  [ -e ".agents/skills/${s}" ] && echo "導入済み: ${s}" || echo "未導入: ${s}"
done
```

結果語彙の読み方。

| 診断 | 語彙・終了コード | 意味 |
|------|-----------------|------|
| (a) | `created` / `appended` / `replaced` | 区間を作る・追記・差し替えが必要（`replaced` は区間の中身が現状と違う） |
| (a) | `unchanged` | 最新 |
| (a) | `error-*` | マーカーが片方だけ・2 組以上・フェンス閉じ忘れ・シンボリックリンク等。ファイルは変わっていない。原因を報告して、この項目は対象外にする |
| (b) | `created`（0） | 設定ファイルが無く、template をそのまま作る |
| (b) | `merged`（0） | 不足する規則を各配列の末尾へ追加する。自分の規則が、自分の規則以外の全要素より後ろにあるときだけ既存とみなす。利用者の規則が自分の規則より後ろにあれば、自分の規則を末尾へ再追加する（最後に一致した規則が勝つため、後ろの allow に負けないようにする） |
| (b) | `unchanged`（0） | 追加すべき規則が無い |
| (b) | `needs-manual`（3） | コメントまたは末尾カンマがあり、不足規則がある。自動では書かない（Step 5-2 参照） |
| (b) | `error-*`（1）/ `error-usage`（2） | JSON が読めない・配列でない・symlink 等。中止して報告する |

(b) の `--check` は書かない。`needs-manual` のときは、追加すべき規則が JSON で stdout に出る。

### Step 4: ギャップ一覧を提示して承認を得る

診断結果を次の表で**ユーザーに提示し、承認を得てから**次の Step へ進む。**承認なしでは何も書かない。**
項目ごとに承認を取り、承認された項目だけを実行する。

| 区分 | 現状 | 追補の内容 | 備考 |
|------|------|-----------|------|
| AGENTS.md | (a) の語彙 | 管理区間の作成・追記・差し替え | 区間の外は変えない |
| 設定 | (b) の語彙・対象 `<config>` | 不足する deny 規則を末尾へ追加 | 下記の追加位置を明示する |
| ガード | 不在 / 差分 / 一致 | 不在なら追加。差分があれば差分を提示して差し替えの可否を問う | 利用者が変更している可能性がある |
| plugin | 不在 / 差分 / 一致 | 同上 | 同上 |
| agents | 不在のものだけ | 不在の agent を追加 | 既存の同名ファイルは上書きしない。差分は提示のみ。利用者の agent は触らない |
| スキル | 未導入のもの | 未導入のものだけ導入 | 導入済みは入れ直さない |

ギャップ一覧には次を必ず明記する。

- **設定の追加位置**: 追加する deny 規則は `permissions` / `policies` の**各配列の末尾**に置く。
  OpenCode は**最後に一致した規則が勝つ**ため、末尾に置いた deny は、利用者が先に書いた allow より**優先される**。
  利用者の規則の件数と順序は変えない。自分の規則が既にあっても、その後ろに利用者の規則があれば末尾へ再追加する（語彙は `merged`）。
  この優先関係を承認前に利用者へ伝え、了承を得る
- 設定の追加は `opencode-config-merge.mjs` だけで行い、手で編集しない
- **edit の deny が加わる**: 配る deny 規則には、ガード本体・plugin・設定ファイルへの `edit`（`*.opencode/hooks/*`・`*.opencode/plugins/*`・`*.opencode/plugin/*`（単数形も OpenCode v2.2.7 が plugin として読み込む）・`opencode.jsonc`・`*/opencode.jsonc`・`opencode.json`・`*/opencode.json`。先頭の `*` は、サブディレクトリから起動したときの `../.opencode/...` や絶対パスにも一致させるため）の deny が含まれる。
  追加後は main のエージェントも、write・edit・patch のツールでこれらを書き換えられなくなる（このスキルのシェルコマンドは対象外）。承認前に利用者へ伝える
- ガードは best-effort の攻撃面削減で、承認境界ではない（注意事項参照）
- 9 スキルは `.claude/skills` には出ない（Claude Code 側は `update-claude` の担当）
- OpenCode の組み込みスキル ID（`opencode`・`report`・`browser`）と同名のスキルは警告なしで上書きされる。9 スキルは該当しない

差分の提示には `diff -u "<assets の該当ファイル>" "<target の該当ファイル>"` を使う。出力に秘密が含まれていないかを確認してから見せる。

### Step 5: 追補する

承認された項目だけを、次の順で実行する。Codex のセッション内で実行している場合は、書き込みを伴う各コマンドを
権限昇格つきで要求し、拒否されたら Step 5-5 の経路へ切り替える。OpenCode・Claude Code・端末から実行している場合は直接書く。
実行前に、設定に既存の規則がある場合は件数と順序の基準値を控える（Step 6 で使う）。

```bash
cd "<target>"
set -o pipefail
# SHA-256 は sha256sum（GNU）が無ければ shasum -a 256（macOS）を使う
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; }
CFG="$(pwd -P)/<config の相対パス>"   # debug config の path は物理パスで返る。例: <target>/opencode.jsonc

# debug config は設定ソースごとの {info,path,type} の配列。path が CFG の要素の .info を取り出す。
# 配列でない・該当要素が 1 件でないときは失敗する（0 件扱いにしない）
proj_info() {
  opencode debug config --standalone | jq -ce --arg p "${CFG}" '
    if type != "array" then error("出力が配列でない") else . end
    | [.[] | select(.path == $p and (.info | type) == "object")] as $m
    | if ($m | length) == 1 then $m[0].info else error("該当要素が 1 件でない") end'
}
# [permissions, policies] を返す。stdin から読み、配列でなければ失敗する。
# 更新後（Step 6 の 7）と同じ射影・-S（キー順を正規化）にして、控えの出どころが違っても比べられる形にする
rules_of() {
  jq -cSe 'def arr(k): (.[k] // []) | if type == "array" then . else error("\(k) が配列でない") end;
    [arr("permissions"), arr("policies")]'
}

# 更新前の permissions / policies の件数とハッシュ（内容は表示しない）。
# 控えは検証用であって更新の前提ではない。取れなくても更新は止めず「未取得」とする。
# 1) debug config から 2) だめなら設定ファイル（コメントなしの JSON のとき）から 3) それも失敗なら未取得
before="$(proj_info | rules_of)" && [ -n "${before}" ] || before=""
if [ -z "${before}" ]; then
  before="$(rules_of < "${CFG}")" && [ -n "${before}" ] || before=""
fi
if [ -n "${before}" ]; then
  printf '%s' "${before}" | jq -r '"permissions=\(.[0] | length) policies=\(.[1] | length)"'
  printf '%s\n' "${before}" | sha256 | awk '{print $1}'
else
  echo "更新前: 未取得（Step 6 の 7) は検証不能になる。更新は続ける）"
fi
unset before
```

設定ファイルがまだ無い（Step 3 (b) が `created`）場合は該当要素が無いため、この取得は行わず、更新前を「件数 0・空」として Step 6 の 7) を省く。

`opencode debug config` の出力にはグローバル設定（`~/.config/opencode` など）由来の秘密が含まれ得る。
**全文を表示・保存しない。** 上のように `jq` で件数とハッシュだけを抜き出す。
`opencode` が無い場合や `debug config` の取得に失敗した場合は、設定ファイルが `jq` で読める形式（コメントなしの JSON）のときだけファイルから同じ射影で控える。
それも失敗したら「更新前: 未取得」と出して更新は続け、Step 6 の 7) は「検証不能（更新前を取得できなかった）」とする。一致とは扱わない。

#### 5-1. AGENTS.md の管理区間

```bash
bash "<skill-dir>/assets/scripts/agents-md-block.sh" \
  --target "<target>/AGENTS.md" --block "<skill-dir>/assets/agents-md-block.md"
echo "exit=$?"
```

| 結果語彙 | 終了コード | 意味と対応 |
|---------|-----------|-----------|
| `created` / `appended` / `replaced` / `unchanged` | 0 | 成功 |
| `error-usage` | 1 | 引数の誤り。コマンドを見直す |
| `error-block-unreadable` / `error-block-empty` / `error-symlink` / `error-target` / `error-io` | 2 | 原因を報告して中断 |
| `error-changed` | 2 | 読み込んだあとに AGENTS.md が他で書き換えられたため、上書きせずに止めた（ファイルは変わっていない）。別のエディタ・セッションの作業が終わってから 1 回だけ再実行し、続けて出るなら原因を報告して中断 |
| `error-markers` / `error-fence` / `error-block-marker` | 4 | 手で直すよう案内して中断（ファイルは変わっていない） |

32768 バイトを超えると stderr に警告が出る。出たら報告に載せる。

#### 5-2. 設定（opencode-config-merge.mjs）

```bash
node "<skill-dir>/assets/scripts/opencode-config-merge.mjs" \
  --target "<config>" --template "<skill-dir>/assets/opencode/opencode.jsonc"
echo "exit=$?"
```

| 結果語彙 | 終了コード | 対応 |
|---------|-----------|------|
| `created` / `merged` / `unchanged` | 0 | 成功 |
| `needs-manual` | 3 | **何も書かれていない。** stdout の JSON は**不足分だけ**（`permissions` / `policies` ごとの、追加すべき規則の配列。全件ではない）。利用者に提示し、各配列の**末尾**へ、出力の配列の**要素だけ**を貼るよう案内する（外側の `{` `}` やキー名は貼らない。直前の要素の後ろにカンマを足す）。既存の自分の規則は消さず、全件を貼り直さない。貼った後に `--check` を再実行し、`unchanged` になることを確認する。ならなければ貼り間違いとして原因を一緒に探す |
| `error-usage` | 2 | コマンドを見直す |
| `error-changed` | 1 | 読み込んだあとに設定ファイルが他で書き換えられたため、上書きせずに止めた（ファイルは変わっていない）。別のエディタ・セッションの作業が終わってから 1 回だけ再実行し、続けて出るなら原因を報告して中断 |
| その他の `error-*` | 1 | 中止して原因を報告する。手で書き直して続行しない |

自分の規則が既に配列の前の方にあり、その後ろに利用者の規則がある場合も、出力には再追加分として含まれる。貼ると同じ規則が前後に 2 つ残るが、
最後に一致した規則が勝つため害はない（前の古い複製を消すかは利用者が決める。消さなくても `unchanged` になる）。

`needs-manual` の理由は、コメントや末尾カンマを JSON として書き戻すと消えるためである。
未知キーは OpenCode が黙って捨てるので、壊れた設定は気づかれない。壊すくらいなら止める。

#### 5-3. ガード・plugin・agents

```bash
ASSETS="<skill-dir>/assets"
TARGET="<target>"

# Step 4 で承認された項目の名前だけをエージェントが埋める（承認なしなら空のまま。全件を並べない）。
# approved_add: 不在のガード・plugin の追加（名前は guard / plugin）
# approved_replace: 差分があり、差し替え（上書き）が承認されたガード・plugin（名前は guard / plugin）
# approved_agents: 不在の標準 agent の追加（名前は researcher / implementer / reviewer）
# 例: ガードの追加と researcher だけ承認したなら approved_add=(guard) approved_agents=(researcher)
approved_add=()
approved_replace=()
approved_agents=()

# place <guard|plugin> <add|replace>: add は不在のときだけ配置し、replace は上書きする
place() {
  local src dst
  case "$1" in
    guard)  src="${ASSETS}/hooks/agent-guard.sh"; dst="${TARGET}/.opencode/hooks/agent-guard.sh" ;;
    plugin) src="${ASSETS}/opencode/plugins/agent-guard/index.js"; dst="${TARGET}/.opencode/plugins/agent-guard/index.js" ;;
    *) echo "警告: ガード・plugin に無い名前のため処理しない: $1" >&2; return 0 ;;
  esac
  if [ "$2" = add ] && [ -e "${dst}" ]; then
    echo "既存のため追加しない（差し替えは approved_replace で承認する）: $1"; return 0
  fi
  mkdir -p "$(dirname "${dst}")" && cp "${src}" "${dst}" || return 1
  if [ "$1" = guard ]; then chmod +x "${dst}"; fi
  echo "配置した: $1 ($2)"
}
for k in "${approved_add[@]}"; do place "${k}" add; done
for k in "${approved_replace[@]}"; do place "${k}" replace; done

for a in "${approved_agents[@]}"; do
  case "${a}" in
    researcher|implementer|reviewer) ;;
    *) echo "警告: 標準 agent に無い名前のため処理しない: ${a}" >&2; continue ;;
  esac
  mkdir -p "${TARGET}/.opencode/agents"
  # 既存は上書きしない（不在のものだけ追加する）
  [ -e "${TARGET}/.opencode/agents/${a}.md" ] || cp "${ASSETS}/opencode/agents/${a}.md" "${TARGET}/.opencode/agents/${a}.md"
done
```

- plugin は `import.meta.url` から `../../hooks/agent-guard.sh` を解決するため、相対配置を崩さない
- 差し替えは `diff -u` を見せて承認された名前だけを `approved_replace` に入れる。承認がなければ配列は空のままで、ガード・plugin のどちらにも触れない（`chmod +x` もガードを配置したときだけ走る）
- `approved_add`・`approved_replace`・`approved_agents` と 5-4 の `approved_skills` は、Step 4 で承認された項目の名前だけをエージェントが埋める。配列に無いものは、不在・未導入でも追加しない。既知の名前（ガード・plugin の `guard` / `plugin`、標準 3 agent、標準 9 スキル）に無い名前は警告して処理しない
- 既存の同名 agent は上書きしない。差分は提示するだけで、取り込むかは利用者が決める。利用者が作った別名の agent には触れない
- `ask` は使わない（`--auto` 下で自動承認されるため、deny だけを使う）
- 秘密情報（トークン・パスワード）をどのファイルにも書かない

#### 5-4. ワークフロースキルの補完

承認されたスキルのうち未導入のものだけを導入する（承認リストと未導入項目の共通部分）。承認されていないスキル・導入済みのスキルは触れない。

```bash
cd "<target>"
# skills CLI (vercel-labs/skills) は固定版でのみ実行する（未固定 npx はレジストリ
# 乗っ取り時の任意コード実行経路になる）。正の定義箇所・更新手順は付録を参照。
SKILLS_CLI_VERSION="1.5.23"   # 正の定義箇所。更新手順は付録を参照

# Step 4 で承認された未導入スキル名だけを入れる（承認結果からエージェントが埋める。
# 例: create-commit だけ承認したなら (create-commit)。全件を並べない・承認なしなら空にする）
approved_skills=(create-commit)
known_skills=" create-commit create-pr create-issue implement-issue implement-issue-tree implement-review implement-review-pr update-docs comment-code "

skill_args=()
for s in "${approved_skills[@]}"; do
  case "${known_skills}" in
    *" ${s} "*) ;;
    *) echo "警告: 標準 9 スキルに無い名前のため処理しない: ${s}" >&2; continue ;;
  esac
  if [ -e ".agents/skills/${s}" ]; then
    echo "導入済みのためスキップ: ${s}"
  else
    skill_args+=(-s "${s}")
  fi
done

if [ "${#skill_args[@]}" -eq 0 ]; then
  echo "承認されたスキルは追加不要（承認なし、またはすべて導入済み）"
else
  npx --yes "skills@${SKILLS_CLI_VERSION}" add Fandhe-AI/agent-cli-skills "${skill_args[@]}" -a codex -a opencode -y || {
    echo "エラー: skills@${SKILLS_CLI_VERSION} の実行が失敗した（該当版の不存在・レジストリ障害等、原因は問わない）。未固定 npx へのフォールバックは行わない。原因を確認してから再実行する。" >&2
    exit 1
  }
fi
```

- `-a codex -a opencode` は `.agents/skills/<name>` の実体だけを作り、既存の `.claude/skills/` には触れない
- `skills-lock.json` が更新され、各エントリに `skillPath` があることを確認する

#### 5-5. Codex のセッション内で実行している場合の書き込み経路

Codex の既定 sandbox は `.git`・`.agents`（`npx skills add` の書き込み先）・`.codex` を読み取り専用にする。`.opencode/` や
`opencode.jsonc` も、sandbox の設定によっては書き込みを拒否され得る。Codex のセッション内で実行している場合、
5-1〜5-4 の書き込みコマンド（`mkdir -p`・`cp`・`agents-md-block.sh`・`npx ... add`）は権限の昇格つきで要求し、
ユーザーの承認を得て実行する。拒否された・要求できなかった場合は、実行できなかったコマンドをそのままユーザーに提示し、
権限のある端末で実行してもらう。ユーザーが実行を終えたと伝えるまで Step 6 へ進まず、実行後に Step 6 の検証を行う。
OpenCode・Claude Code・端末から実行している場合は、この節を飛ばして直接書く。

### Step 6: 動作を検証する

次を実行し、出力と終了コードで確認する。`debug config` は全文を表示・保存しない。

```bash
cd "<target>"
set -o pipefail
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; }
CFG="$(pwd -P)/<config の相対パス>"   # Step 5 と同じ値

# Step 5 と同じ定義（debug config はソースごとの配列。該当要素が取れなければ失敗し、0 件扱いにしない）
proj_info() {
  opencode debug config --standalone | jq -ce --arg p "${CFG}" '
    if type != "array" then error("出力が配列でない") else . end
    | [.[] | select(.path == $p and (.info | type) == "object")] as $m
    | if ($m | length) == 1 then $m[0].info else error("該当要素が 1 件でない") end'
}

# 1) permissions / policies が解決後の設定に残っている（未知キーは黙って消えるため必須）
if info="$(proj_info)" && [ -n "${info}" ]; then
  printf '%s' "${info}" | jq -er '
    def arr(k): (.[k] // []) | if type == "array" then . else error("\(k) が配列でない") end;
    "permissions_deny_shell=\([arr("permissions")[] | select(.action=="shell" and .effect=="deny")] | length) permissions_deny_edit=\([arr("permissions")[] | select(.action=="edit" and .effect=="deny")] | length) policies_deny=\([arr("policies")[] | select(.effect=="deny")] | length) permissions_total=\(arr("permissions") | length) policies_total=\(arr("policies") | length)"'
  echo "exit=$?"
else
  echo "検証不能: debug config の出力から ${CFG} の要素を取り出せない（0 件とは扱わない）"
fi

# 2) 承認した agent が見える（出力は表示せず名前の有無だけ見る。<承認した agent> は Step 4 で承認した名前だけを空白区切りで入れる。見送った agent は含めない）
out="$(opencode debug agents --standalone 2>&1)"; rc=$?
echo "debug agents exit=${rc}"
for a in <承認した agent>; do
  printf '%s' "${out}" | grep -qw -- "${a}" && echo "agent ok: ${a}" || echo "agent missing: ${a}"
done
unset out

# 3) ガード: force push が deny される
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

# 7) 利用者の規則が先頭に保たれている（N・M は Step 5 で控えた更新前の件数、BEFORE_HASH は Step 5 で控えたハッシュ）
# 失敗・空出力は「検証不能」で止める。jq が失敗した空入力のハッシュ（e3b0c442…）を「同一」と読まない
EMPTY_SHA="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
BEFORE_HASH="<Step 5 で控えたハッシュ。「更新前: 未取得」だったときは空>"
if [ -z "${BEFORE_HASH}" ]; then
  echo "7) 検証不能（更新前を取得できなかった）。一致とは扱わない"
elif after_hash="$(printf '%s' "${info}" | jq -cSe --argjson n "<更新前の permissions 件数>" --argjson m "<更新前の policies 件数>" '
      def arr(k): (.[k] // []) | if type == "array" then . else error("\(k) が配列でない") end;
      [arr("permissions")[:$n], arr("policies")[:$m]]' | sha256 | awk '{print $1}')" \
   && [ -n "${after_hash}" ] && [ "${after_hash}" != "${EMPTY_SHA}" ] \
   && [ -n "${BEFORE_HASH}" ] && [ "${BEFORE_HASH}" != "${EMPTY_SHA}" ]; then
  [ "${after_hash}" = "${BEFORE_HASH}" ] && echo "7) 一致" || echo "7) 不一致"
else
  echo "7) 検証不能（jq の失敗・空出力・ハッシュ未取得）。一致とは扱わない"
fi
unset info
```

期待値。

| 確認 | 期待 |
|------|------|
| 1) 設定の残存 | `permissions_deny_shell` と `policies_deny` が 1 以上、`permissions_deny_edit` が 7 以上、終了コード 0。0 なら未知キーとして消えている。`検証不能` と出たら完了とせず、出力の形・`<config>` のパスを確かめる |
| 2) agents | `debug agents exit=0` かつ承認した agent がすべて `agent ok`（承認した agent が無ければ exit=0 のみ） |
| 3) force push | 最終行 `AGENT_GUARD_RESULT deny force-push`、終了コード 2 |
| 4) 通常コミット | 最終行 `AGENT_GUARD_RESULT allow`、終了コード 0 |
| 5) サブエージェントのマージ | 最終行が `AGENT_GUARD_RESULT deny ...`、終了コード 2 |
| 6) 区間数 | `1` |
| 7) 利用者の規則 | `7) 一致`（更新前の先頭 N 件・M 件のハッシュと同一）。件数は更新前以上で、利用者の規則の件数と順序が先頭に保たれている。`7) 不一致` / `7) 検証不能`（更新前を取得できなかった場合を含む）は完了としない |

7) は、更新前の配列が更新後の配列の先頭と同じであることの確認である（追加は末尾だけのため）。
更新前に件数 0 だった場合は N・M を 0 として、空配列同士の一致を確かめる。
`info` は `path` で選んだ設定ソース 1 つ分であり、グローバル設定など他のソースの規則は混ざらない。ハッシュが一致しない場合は、`<config>` を直接読んで利用者の規則が先頭から動いていないかを切り分け、原因を特定するまで完了と報告しない。`検証不能` は「同一」ではなく、jq の失敗や出力形の想定違いを直してから再実行する。

加えて、追加を承認したスキルが `.agents/skills/` にあり、`skills-lock.json` が妥当な JSON であること（`jq . skills-lock.json >/dev/null && echo OK`）を確認する。
標準 3 agent・9 スキルの全件存在は要求しない。承認されなかった項目は検証の対象外として「見送り」と書き、失敗として扱わない（未承認の項目を入れて埋めない）。`opencode` が無く 1) 2) 7) を実行できなかった場合は「未検証」と書く。`検証不能` と出た項目も未検証として扱い、合格と書かない。

3)〜5) は plugin を介さずガードを直接検査するもので、plugin が実セッションで呼ばれることの証明ではない。
実セッションでの確認を案内する場合は、**対象リポジトリでは危険なコマンドを実行させない**。
実リモートから切り離した使い捨てリポジトリだけで行う。

```bash
SANDBOX="$(mktemp -d)"
git init --bare "${SANDBOX}/origin.git"
git init "${SANDBOX}/work" && cd "${SANDBOX}/work"
git config user.name t && git config user.email t@example.invalid   # 使い捨てのローカル設定。対照の git commit も通す
git remote add origin "${SANDBOX}/origin.git"   # origin はローカルの bare のみ
# 初期コミットを作り bare へ初回 push しておく（force push の拒否を remote の sha で判定できるようにする）
git commit --allow-empty -m "chore: init"
git push -u origin HEAD
git ls-remote origin   # 実行前の sha を控える
# 対象の .opencode/ と opencode.jsonc をここへコピーし、OpenCode をこのディレクトリで起動して
# `git push --force` が拒否されることを確かめる
```

プロンプトには「使い捨てリポジトリでのガードの動作テストである」ことを明示する。配布した AGENTS.md の指示により、
モデルが禁止コマンドを自分から実行しないことがあるためである。判定はモデルの発言ではなく、拒否メッセージ
（`Permission denied: shell` / `agent-guard:`）と副作用の無さ（`git ls-remote origin` の sha が実行前と同じ）で行う。

確認後は `${SANDBOX}` を利用者が自分で削除する。`rm -rf` は案内しない。使い捨てを用意できないときは、実セッションの確認は行わず「未検証」と報告する。

### Step 7: 結果を報告する

- ギャップ一覧と、承認・見送り・対象外の別
- 追加・更新したファイル（AGENTS.md の結果語彙・設定の結果語彙・`.opencode/` 配下・`skills-lock.json`）
- 差し替えなかった差分（agent・ガード・plugin）と、その差分の要約
- Step 6 の各検証の結果（出力・終了コードを引用）。未実施のものは「未検証」と明記
- 次の点を明記する。
  - 追加した deny 規則は各配列の末尾にあり、最後に一致した規則が勝つため、利用者の allow より優先される
  - ガード本体・plugin・設定ファイルへの `edit` は deny される（main のエージェントにも効く）。変えたいときは人間が端末・エディタで行う
  - ワークフロースキル 9 件は OpenCode 上の動作を後続の計画（スキルのツール中立化）が終わるまで**保証しない**
  - ガードは best-effort の攻撃面削減で、**承認境界ではない**。実強制はサーバー側の branch protection と人間によるマージ
  - Codex にも同じ体系を入れるなら `init-codex` / `update-codex`（AGENTS.md の管理区間は共有され 1 つのまま）

## 検証

完了とみなす条件は、承認された項目について Step 6 の確認が期待どおりで、証拠を報告に引用していること。

- `opencode debug config --standalone` の出力のうち `<config>` に対応する要素の jq 抜粋で deny 規則が残り、更新前の利用者の規則が先頭に保たれている（`検証不能` は不合格）
- `opencode debug agents --standalone` が終了コード 0 で、承認した agent が見える（見送った agent は「見送り」と報告し失敗にしない）
- ガードが force push で deny、通常コミットで allow、サブエージェントのマージで deny を返す
- AGENTS.md の管理区間の開始マーカー数が 1
- `opencode-config-merge.mjs --check` が `unchanged`（`needs-manual` 経由で手で追加した場合も含む）
- 追加を承認したスキルが `.agents/skills/` にあり、`skills-lock.json` が妥当（見送ったスキルは「見送り」と報告し失敗にしない）

「動くはず」での完了報告はしない。実行していない検証は未検証と書く。

## 注意事項

- OpenCode の設定も `.opencode/agents`・`.opencode/plugins`・`.opencode/hooks` も無いリポジトリでは何も書かず `init-opencode` を案内する
- ユーザーの承認なしに何も書かない。承認された項目だけを実行する
- 設定は必ず `opencode-config-merge.mjs` で更新する。手で編集しない。`needs-manual` では利用者が手で追加し、`--check` で `unchanged` を確認する。`error-*` は中止して報告する
- 追加する deny は各配列の末尾に置く。最後に一致した規則が勝つため、利用者の allow より優先される。承認前に必ず説明する
- `.opencode/opencode.jsonc` は `opencode.jsonc` を全上書きする。実際に効く 1 つだけを対象にし、両方を作らない
- ガード・plugin・設定ファイルは `edit` の deny の対象で、write・edit のツールでは書けない。OpenCode のセッション内でこのスキルを実行するエージェントは、記載のシェルコマンド（`cp`・`node opencode-config-merge.mjs`）だけで書く。拒否されたら、そのコマンドを利用者に提示して端末で実行してもらう（deny を外す設定変更はしない）
- ガード・plugin の差し替えは差分を提示して承認を取る。既存の同名 agent は上書きしない。利用者の agent は触らない
- **`opencode debug config` の全文を表示・保存しない。** グローバル設定由来の秘密が含まれ得る。`jq` で件数・ハッシュ・プロジェクト由来のキーだけを抜き出す
- 未知キーは黙って消える。更新後は `debug config` でキーの残存を必ず確認する。`ask` は `--auto` で自動承認されるため使わない
- `agents-md-block.sh` は AGENTS.md の管理区間の外をバイト単位で変えない。マーカーが不整合なら書かずに中断する。区間は常に 1 つ
- 読み取り専用の agent（researcher / reviewer）は shell を使えない
- 読み取り専用の agent（researcher / reviewer）の配布版は、`.env` 系・`.envrc`・`.npmrc`・`.netrc`・`.git-credentials`・`.pypirc`・`*.pem`・`*.key`・`*.p12`・`*.pfx`・SSH 秘密鍵（`id_rsa`・`id_ed25519` と `id_rsa_<名前>` の形）・名前が `credentials` / `credentials.json` のファイルの `read` も権限で deny する（OpenCode v2.2.7 の実機で、`.npmrc`・`*.pem`・`.aws/credentials`・`.envrc`・`.netrc`・`.git-credentials`・`.pypirc`・`.ssh/id_rsa`・`.ssh/id_ed25519`・`*.key`・`*.p12`・`*.pfx` の read が `Permission denied: read` になり、`src/credentials_service.ts`・`src/keyboard.ts`・`.ssh/id_rsa.pub` は読めることを確認した）。**この deny が入るのは、このスキルが新しく追加する agent だけ**で、導入済みの researcher / reviewer は上書きしないため入らない。既存の agent に入れたいときは、利用者が `.opencode/agents/` の該当ファイルへ `read` の deny を足す（配布版の `researcher.md` の `permissions` が見本）。`*credentials*` や `*id_rsa*` のように広げないのは、名前に含むだけのソース・公開鍵まで止めて調査を妨げるため（`id_rsa_work.pub` のように `id_rsa_` で始まる公開鍵は止まる）。
  - **大文字小文字は区別して照合される**（v2.2.7 の実機で、`.env` の deny が `.ENV`・`.eNv` の read を止めないことを確認した。`[eE]` のような文字クラスの glob も効かなかった）。大文字小文字を区別しないファイルシステム（macOS・Windows の既定）では、`.env` を `.ENV` と綴るだけで deny をすり抜けて同じファイルを読める。配布する deny は実在しうる代表的な変種（`*.ENV`・`*.ENV.*`・`*.Env`・`*.Env.*`・`*.PEM`）だけを足しており、任意の綴り（`.eNv` など）は止められない。この限りで読み取りの deny は秘密情報の完全な遮断ではなく、事故を減らす層と位置づける
  - 上記以外の秘密のファイル（`.NETRC` などの大文字の変種、`*.jks`・`*.kdbx` など）は対象外で、必要なら `.opencode/agents/` の deny に利用者が足す
- plugin がガードを同期実行して待つ時間は、1 つの shell 実行（resources の全件）で合計 10 秒まで（1 回は 5 秒まで）。超えたら残りのコマンドは実行せず deny にする。待っている間は OpenCode 全体のイベントループが止まるため、件数に比例して固まるのを防ぐ上限である
- **ガードの残存ギャップ**:
  - メインセッションでの `$'...'` による難読化は通る（難読化の拒否はサブエージェントのみ）
  - フックの無効化・alias の定義（`-c` / `--config-env` / `git config` の `core.hooksPath` と `alias.*`、先頭の `HUSKY=0` / `HUSKY_SKIP_HOOKS=1`）は検出して deny する。拾えないのは、利用者の設定ファイルに既にある alias・`include.path`・`GIT_CONFIG_*` 環境変数・`SKIP=`・別の呼び出しで export 済みの `HUSKY`、`env -S` で代入だけ渡し後続に git を置く形
  - `bash -c` / `sh -c` / `eval`・ヒアドキュメントや here-string の中身、`$(…)` 内の引用符の食い違いは見ない
  - ガード本体・plugin・設定ファイルの保護は `edit` の deny（write・patch を含む）と plugin の edit 判定が担う。シェルでの書き換え（`echo … >`・`sed -i`・`cp`・`mv` 等）は止めない。シンボリックリンク経由の書き換えも検証していない。`.opencode/tool(s)/`・`command(s)/`・`agents/`・`skills/` は edit の deny の対象外（v2.2.7 の実機では tool(s)・command(s) は読み込まれず実行もされなかった。agents と skills は利用者が育てる前提の資産）。`plugins` に任意のディレクトリを列挙する設定は `opencode.jsonc` の保護に頼る。配布先の git の差分で気づく運用に頼る
  - base64 復元・変数間接呼び出し・ブレース / glob 展開などの文字列照合で見抜けない形は通る。`permissions` / `policies` は字面一致のため順序違いは拾えない（plugin が止める）
- ガードは `jq` が無い・入力を読めない・plugin から呼べないときに deny へ倒れる（fail-closed）
- `skills` CLI は固定版で実行する。失敗しても未固定 `npx` へフォールバックしない（付録参照）
- コマンドへ渡すパスやスキル名は常に `"${var}"` でクォートする。外部入力を `bash -c` や `eval` へ渡さない
- `--no-verify` を含むコマンドを plugin や手順に仕込まない
- コミットを伴う場合は対象リポジトリの規約（CLAUDE.md / AGENTS.md / CONTRIBUTING 等）に従う。規約が無ければ `type(scope): subject`（subject は 72 文字以内）とし、`--no-verify` は使わない（このスキル自体はコミットしない）
- 出力・報告は日本語で書く

## sandbox 環境での実行

ローカルの診断・差分提示・ファイル更新はネットワーク不要で、sandbox 内でも実行できる。一方、Step 5-4 の `npx skills add`（skills CLI による GitHub からのスキル取得。不足スキルを承認した場合のみ）と前提確認の `gh auth status` はネットワークを要する。該当コマンドだけをコマンド単位で sandbox 無効にして実行する。ネットワーク遮断を解除できない環境では、その手順だけ実行できない（ローカル完結の手順は進められる）。

書き込み制限（既存の代替経路の対象）はネットワーク遮断とは別の問題であり、それぞれの記述に従う。

## 付録: skills CLI のバージョン固定と更新手順

**Why**: `npx skills add` をバージョン未固定で実行すると、npx はローカルキャッシュに無い場合レジストリのその時点の最新版を確認なしで即時取得・実行する。`skills`（vercel-labs/skills）パッケージが乗っ取られた場合、これは任意コード実行の経路になる。exact 版（`X.Y.Z`。dist-tag・`^` / `~` レンジは禁止）への固定が信頼アンカーになる。

**固定版の決め方**:
1. `npm view skills version` で現在の latest を確認する
2. `npm view skills repository.url` が `vercel-labs/skills` であることを確認する
3. `npm view skills time --json` 等で公開日時が不自然でないことを確認する

**更新手順**:
1. Step 5-4 フェンス内の `SKILLS_CLI_VERSION` を更新する（このスキル内での正の定義箇所はここ 1 箇所のみ）
2. `node --test skills/update-opencode/tests/*.test.mjs` で exact semver・実行行の固定を検証する
3. 1 リポジトリで実際に実行し、差分が正常であることを確認する
4. `chore(update-opencode): skills CLI を X.Y.Z へ更新` でコミットする
5. 同じ `skills` CLI を固定する `init-claude` / `update-claude` / `init-codex` / `update-codex` / `init-opencode` / `sync-skills-lock` の同名節も同時更新することを推奨する（値の同期は必須ではないが、乖離した場合はどちらかの節にその旨を記録する）

**fail-closed**: 固定版が解決できない場合（該当版の不存在・レジストリ障害等どの原因でも）は `npx` が非ゼロ終了し停止する。未固定 `npx skills add` へのフォールバック再試行は行わない。
