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
| 直下に `opencode.jsonc` と `opencode.json` が両方ある | どちらが効くか断定せず、利用者に確認する（`opencode debug config --standalone` のキー件数で確かめてよい） |
| 設定が 1 つも無く `.opencode/` だけがある | 直下の `opencode.jsonc` を新規作成する |

以降、対象の設定ファイルのパスを `<config>` と書く。

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
# 更新前の permissions / policies の件数とハッシュ（内容は表示しない）
opencode debug config --standalone \
  | jq -r '"permissions=\((.permissions // []) | length) policies=\((.policies // []) | length)"'
opencode debug config --standalone \
  | jq -c '[(.permissions // []), (.policies // [])]' | sha256
```

`opencode debug config` の出力にはグローバル設定（`~/.config/opencode` など）由来の秘密が含まれ得る。
**全文を表示・保存しない。** 上のように `jq` で件数とハッシュだけを抜き出す。
`opencode` が無い場合は、対象の設定ファイルを `jq` で読める形式のときだけ同様に控え、それ以外は「未検証」とする。

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
| `needs-manual` | 3 | **何も書かれていない。** stdout の JSON（追加すべき規則）を利用者に提示し、`permissions` と `policies` それぞれの**配列の末尾**に貼るよう案内する。貼った後に `--check` を再実行し、`unchanged` になることを確認する。ならなければ貼り間違いとして原因を一緒に探す |
| `error-usage` | 2 | コマンドを見直す |
| その他の `error-*` | 1 | 中止して原因を報告する。手で書き直して続行しない |

`needs-manual` の理由は、コメントや末尾カンマを JSON として書き戻すと消えるためである。
未知キーは OpenCode が黙って捨てるので、壊れた設定は気づかれない。壊すくらいなら止める。

#### 5-3. ガード・plugin・agents

```bash
ASSETS="<skill-dir>/assets"
TARGET="<target>"
mkdir -p "${TARGET}/.opencode/hooks" "${TARGET}/.opencode/plugins/agent-guard" "${TARGET}/.opencode/agents"

# 不在の場合だけ追加する（既存は上書きしない）
[ -e "${TARGET}/.opencode/hooks/agent-guard.sh" ] \
  || cp "${ASSETS}/hooks/agent-guard.sh" "${TARGET}/.opencode/hooks/agent-guard.sh"
chmod +x "${TARGET}/.opencode/hooks/agent-guard.sh"
[ -e "${TARGET}/.opencode/plugins/agent-guard/index.js" ] \
  || cp "${ASSETS}/opencode/plugins/agent-guard/index.js" "${TARGET}/.opencode/plugins/agent-guard/index.js"

# agents は不在のものだけ追加する
for a in researcher implementer reviewer; do
  [ -e "${TARGET}/.opencode/agents/${a}.md" ] || cp "${ASSETS}/opencode/agents/${a}.md" "${TARGET}/.opencode/agents/${a}.md"
done
```

- plugin は `import.meta.url` から `../../hooks/agent-guard.sh` を解決するため、相対配置を崩さない
- **ガード・plugin に差分があり、差し替えが承認された場合だけ**、`diff -u` を見せたうえで該当ファイルを `cp`（上書き）する。承認がなければ触らない
- 既存の同名 agent は上書きしない。差分は提示するだけで、取り込むかは利用者が決める。利用者が作った別名の agent には触れない
- `ask` は使わない（`--auto` 下で自動承認されるため、deny だけを使う）
- 秘密情報（トークン・パスワード）をどのファイルにも書かない

#### 5-4. ワークフロースキルの補完

未導入のものだけを導入する。導入済みは入れ直さない。

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

# 1) permissions / policies が解決後の設定に残っている（未知キーは黙って消えるため必須）
opencode debug config --standalone \
  | jq -r '"permissions_deny_shell=\([.permissions[]? | select(.action=="shell" and .effect=="deny")] | length) policies_deny=\([.policies[]? | select(.effect=="deny")] | length) permissions_total=\((.permissions // []) | length) policies_total=\((.policies // []) | length)"'
echo "exit=$?"

# 2) 3 つの agent が見える（出力は表示せず名前の有無だけ見る）
out="$(opencode debug agents --standalone 2>&1)"; rc=$?
echo "debug agents exit=${rc}"
for a in researcher implementer reviewer; do
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

# 7) 利用者の規則が先頭に保たれている（N・M は Step 5 で控えた更新前の件数）
opencode debug config --standalone \
  | jq -c --argjson n "<更新前の permissions 件数>" --argjson m "<更新前の policies 件数>" \
      '[(.permissions // [])[:$n], (.policies // [])[:$m]]' | sha256
```

期待値。

| 確認 | 期待 |
|------|------|
| 1) 設定の残存 | `permissions_deny_shell` と `policies_deny` が 1 以上、終了コード 0。0 なら未知キーとして消えている |
| 2) agents | `debug agents exit=0` かつ 3 件とも `agent ok` |
| 3) force push | 最終行 `AGENT_GUARD_RESULT deny force-push`、終了コード 2 |
| 4) 通常コミット | 最終行 `AGENT_GUARD_RESULT allow`、終了コード 0 |
| 5) サブエージェントのマージ | 最終行が `AGENT_GUARD_RESULT deny ...`、終了コード 2 |
| 6) 区間数 | `1` |
| 7) 利用者の規則 | 更新前の先頭 N 件・M 件のハッシュ（Step 5 の 2 本目）と同一。件数は更新前以上で、利用者の規則の件数と順序が先頭に保たれている |

7) は、更新前の配列が更新後の配列の先頭と同じであることの確認である（追加は末尾だけのため）。
更新前に件数 0 だった場合は N・M を 0 として、空配列同士の一致を確かめる。
ハッシュが一致しない場合は、グローバル設定の合成順による差かを `<config>` を直接読んで切り分け、原因を特定するまで完了と報告しない。

加えて `.agents/skills/` に 9 スキルがあり、`skills-lock.json` が妥当な JSON であること（`jq . skills-lock.json >/dev/null && echo OK`）を確認する。
承認されなかった項目は検証の対象外として「未実施（承認なし）」と書く。`opencode` が無く 1) 2) 7) を実行できなかった場合は「未検証」と書く。

3)〜5) は plugin を介さずガードを直接検査するもので、plugin が実セッションで呼ばれることの証明ではない。
実セッションでの確認を案内する場合は、**対象リポジトリでは危険なコマンドを実行させない**。
実リモートから切り離した使い捨てリポジトリだけで行う。

```bash
SANDBOX="$(mktemp -d)"
git init --bare "${SANDBOX}/origin.git"
git init "${SANDBOX}/work" && cd "${SANDBOX}/work"
git remote add origin "${SANDBOX}/origin.git"   # origin はローカルの bare のみ
# 対象の .opencode/ と opencode.jsonc をここへコピーし、OpenCode をこのディレクトリで起動して
# `git push --force` が拒否されることを確かめる
```

確認後は `${SANDBOX}` を利用者が自分で削除する。`rm -rf` は案内しない。使い捨てを用意できないときは、実セッションの確認は行わず「未検証」と報告する。

### Step 7: 結果を報告する

- ギャップ一覧と、承認・見送り・対象外の別
- 追加・更新したファイル（AGENTS.md の結果語彙・設定の結果語彙・`.opencode/` 配下・`skills-lock.json`）
- 差し替えなかった差分（agent・ガード・plugin）と、その差分の要約
- Step 6 の各検証の結果（出力・終了コードを引用）。未実施のものは「未検証」と明記
- 次の点を明記する。
  - 追加した deny 規則は各配列の末尾にあり、最後に一致した規則が勝つため、利用者の allow より優先される
  - ワークフロースキル 9 件は OpenCode 上の動作を後続の計画（スキルのツール中立化）が終わるまで**保証しない**
  - ガードは best-effort の攻撃面削減で、**承認境界ではない**。実強制はサーバー側の branch protection と人間によるマージ
  - Codex にも同じ体系を入れるなら `init-codex` / `update-codex`（AGENTS.md の管理区間は共有され 1 つのまま）

## 検証

完了とみなす条件は、承認された項目について Step 6 の確認が期待どおりで、証拠を報告に引用していること。

- `opencode debug config --standalone` の jq 抜粋で deny 規則が残り、更新前の利用者の規則が先頭に保たれている
- `opencode debug agents --standalone` が終了コード 0 で 3 agent が見える
- ガードが force push で deny、通常コミットで allow、サブエージェントのマージで deny を返す
- AGENTS.md の管理区間の開始マーカー数が 1
- `opencode-config-merge.mjs --check` が `unchanged`（`needs-manual` 経由で手で追加した場合も含む）
- `.agents/skills/` に 9 スキルがあり、`skills-lock.json` が妥当

「動くはず」での完了報告はしない。実行していない検証は未検証と書く。

## 注意事項

- OpenCode の設定も `.opencode/agents`・`.opencode/plugins`・`.opencode/hooks` も無いリポジトリでは何も書かず `init-opencode` を案内する
- ユーザーの承認なしに何も書かない。承認された項目だけを実行する
- 設定は必ず `opencode-config-merge.mjs` で更新する。手で編集しない。`needs-manual` では利用者が手で追加し、`--check` で `unchanged` を確認する。`error-*` は中止して報告する
- 追加する deny は各配列の末尾に置く。最後に一致した規則が勝つため、利用者の allow より優先される。承認前に必ず説明する
- `.opencode/opencode.jsonc` は `opencode.jsonc` を全上書きする。実際に効く 1 つだけを対象にし、両方を作らない
- ガード・plugin の差し替えは差分を提示して承認を取る。既存の同名 agent は上書きしない。利用者の agent は触らない
- **`opencode debug config` の全文を表示・保存しない。** グローバル設定由来の秘密が含まれ得る。`jq` で件数・ハッシュ・プロジェクト由来のキーだけを抜き出す
- 未知キーは黙って消える。更新後は `debug config` でキーの残存を必ず確認する。`ask` は `--auto` で自動承認されるため使わない
- `agents-md-block.sh` は AGENTS.md の管理区間の外をバイト単位で変えない。マーカーが不整合なら書かずに中断する。区間は常に 1 つ
- 読み取り専用の agent（researcher / reviewer）は shell を使えない
- **ガードの残存ギャップ**:
  - メインセッションでの `$'...'` による難読化は通る（難読化の拒否はサブエージェントのみ）
  - フックの無効化・alias の定義（`-c` / `--config-env` / `git config` の `core.hooksPath` と `alias.*`、先頭の `HUSKY=0` / `HUSKY_SKIP_HOOKS=1`）は検出して deny する。拾えないのは、利用者の設定ファイルに既にある alias・`include.path`・`GIT_CONFIG_*` 環境変数・`SKIP=`・別の呼び出しで export 済みの `HUSKY`、`env -S` で代入だけ渡し後続に git を置く形（上流 Fandhe-AI/agent-cli-skills#782 で追跡）
  - `bash -c` / `sh -c` / `eval`・ヒアドキュメントや here-string の中身、`$(…)` 内の引用符の食い違いは見ない
  - base64 復元・変数間接呼び出し・ブレース / glob 展開などの文字列照合で見抜けない形は通る。`permissions` / `policies` は字面一致のため順序違いは拾えない（plugin が止める）
- ガードは `jq` が無い・入力を読めない・plugin から呼べないときに deny へ倒れる（fail-closed）
- `skills` CLI は固定版で実行する。失敗しても未固定 `npx` へフォールバックしない（付録参照）
- コマンドへ渡すパスやスキル名は常に `"${var}"` でクォートする。外部入力を `bash -c` や `eval` へ渡さない
- `--no-verify` を含むコマンドを plugin や手順に仕込まない
- コミットを伴う場合は対象リポジトリの規約（CLAUDE.md / AGENTS.md / CONTRIBUTING 等）に従う。規約が無ければ `type(scope): subject`（subject は 72 文字以内）とし、`--no-verify` は使わない（このスキル自体はコミットしない）
- 出力・報告は日本語で書く

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
