---
description: >
  downstream リポジトリにおけるスキル配置（.claude/skills/<name> が symlink か
  実ディレクトリか）の混在を許容する方針。配置差を理由に同期構成やディレクトリ
  構成を変更しないこと、同期を外す場合は対象限定入力で行うことを定める。
applies_to: downstream リポジトリの構成を触る全作業
---

# スキル配置レイアウト方針

downstream リポジトリにおけるスキルの配置（`.claude/skills/<name>` が symlink か実ディレクトリか）と、
配置差を理由に同期構成を変更してよいかの判断基準。

## 決定: 配置の混在を許容する（2026-08-18・オーナー判断）

`.claude/skills/<name>` が **symlink（git tree mode `120000`）でも実ディレクトリ（`040000`）でも
どちらでもよい。同一リポジトリ内でスキルごとに異なっていてもよい。** 配置を揃えるための移行は行わない。

**Why:** この差は当初、日次スキル同期 CI が失敗する根因とされていた（イシュー #256）。
しかし**実ディレクトリのままでも同期が成功する**ことが 3 リポジトリで実測され、前提が崩れた。

| リポジトリ | run | 結果 |
|-----------|-----|------|
| `baby-tasks-app` | [31981615238](https://github.com/Fandhe-AI/baby-tasks-app/actions/runs/31981615238)（schedule） | `Update agent skills` success |
| `yadori` | [32058767791](https://github.com/Fandhe-AI/yadori/actions/runs/32058767791) | success・同期 PR #666 作成 |
| `life-plan-app` | [32052423709](https://github.com/Fandhe-AI/life-plan-app/actions/runs/32052423709) | スキル更新完走・push 到達 |

同期が壊れないなら、配置統一は「Claude Code のスキル解決挙動へ影響しうる変更を多数のリポジトリへ
加える」コストだけを払って得るものが無い。個別事情で同期を外す必要がある場合は、配置を変えるのでは
なくイシュー #265 で追加した**更新対象スキルを限定する入力**で回避する。

## フリート実測（2026-08-18・非 archived 120 リポ中 `.claude/skills` を持つ 32 リポ）

**`.claude/skills` ディレクトリ自体は全 32 リポで `040000`（実ディレクトリ）である。**
差が出るのはその**配下エントリ**（`.claude/skills/<name>`）の mode であり、混在が既に多数派である。

| 配下エントリの構成 | 件数 | リポジトリ |
|------------------|------|-----------|
| 全て symlink（`120000`） | 14 | `actions` `automation` `automation-spec` `baby-tasks-app` `brain-training-app` `desktop-automation-app` `fandhe-backend` `fandhe-frontend` `fandhe-multi-platform` `hobby-keyboard` `local-llm-server` `pronunciation-vocab-app` `rust-ai-library` `team-hub-spec` |
| 混在（`040000` と `120000`） | 16 | `agent-cli-skills` `agent-reference-skills` `aliz-corporate-web` `articles` `automation-app` `ideas` `life-plan-app` `local-server` `mcp_hub-spec` `mirror-ui` `pet-hub` `team-hub` `template-articles` `template-frontend-react_router` `template-ideas` `yadori` |
| 全て実ディレクトリ（`040000`） | 2 | `mcp_hub-app-frontend` `my-ime` |

「3 リポだけが実ディレクトリで他 19 リポは symlink」という当初の整理は**実測と一致しない**。
混在は特定リポの事故ではなく、フリート全体で常態である。

`npx skills update <name> --project` は対象スキルの実体だけを `.agents/skills/<name>/` へ移し
`.claude/skills/<name>` をそこへの symlink に張り替えるため、CLI 経由で個別更新したスキルだけ
配置が変わる。`life-plan-app` #204 / `baby-tasks-app` #15 で実際にそうなっており、
この状態を正として受け入れる（revert しない）。

## How to apply

- 配置差を理由にリポジトリの構成変更 PR を出さない。同期が失敗した場合は**まず失敗ログで
  根因を確認**する（配置を疑う前に。配置は同期失敗の十分条件ではないことが実測済み）
- 特定スキルだけ同期を外す必要がある場合は、配置を変えるのではなく `skills-update` の
  対象限定入力（#265）を使う
- 配置を判別するときは git tree mode を見る。**既定ブランチ名を `main` に決め打ちしない**
  （`master` 等のリポジトリで最初の呼び出しが 404 になる）。`git/trees/HEAD` は既定ブランチを
  指すため、ブランチ名を書かずに済む:

  ```bash
  r="<repo>"
  csha=$(gh api "repos/Fandhe-AI/${r}/git/trees/HEAD" --jq '.tree[]|select(.path==".claude")|.sha')
  ssha=$(gh api "repos/Fandhe-AI/${r}/git/trees/${csha}" --jq '.tree[]|select(.path=="skills")|.sha')
  gh api "repos/Fandhe-AI/${r}/git/trees/${ssha}" --jq '.tree[]|"\(.mode) \(.path)"'
  # 120000 = symlink / 040000 = 実ディレクトリ
  ```

  特定ブランチを調べる必要がある場合のみ、名前を明示的に解決してから渡す:

  ```bash
  br=$(gh repo view "Fandhe-AI/${r}" --json defaultBranchRef --jq '.defaultBranchRef.name')
  gh api "repos/Fandhe-AI/${r}/git/trees/${br}" --jq '.tree[]|select(.path==".claude")|.sha'
  ```

- **本リポジトリ（`agent-cli-skills`）はこの方針の対象外。** 上流ソースとして
  `skills/<name>/` を実体、`.claude/skills/<name>` をそこへの symlink とする構成を維持する
  （`create-skill` / `create-agent` の 2 件のみ実ディレクトリ。
  `.github/scripts/check-skill-structure.sh` が CI で検証している）

## 関連

- `./delegation-impl.md` — スキル本体の編集フロー
- `skills/sync-skills-lock/SKILL.md` — lock ファイル同期の手順
