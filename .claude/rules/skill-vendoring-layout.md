# スキル配置レイアウト方針

downstream リポジトリにおけるスキルの配置（`.claude/skills/` と `.agents/skills/` の関係）と、
配置差を理由に同期構成を変更してよいかの判断基準。

## 決定: 配置の混在を許容する（2026-08-18・オーナー判断）

`.claude/skills/<name>` が **symlink（git tree mode `120000`）でも実ディレクトリ（`040000`）でも
どちらでもよい**。配置を揃えるための移行は行わない。

| 配置 | リポジトリ数（2026-08-18 実測） | 例 |
|------|--------------------------|-----|
| symlink（`120000`） | 19 | 大半のリポジトリ |
| 実ディレクトリ（`040000`） | 3 | `yadori` / `life-plan-app` / `baby-tasks-app` |

**Why:** 当初この差は日次スキル同期 CI が失敗する根因とされていた（イシュー #256）。
しかし**実ディレクトリのままでも同期が成功する**ことが 3 リポジトリで実測され、前提が崩れた。

| リポジトリ | run | 結果 |
|-----------|-----|------|
| `baby-tasks-app` | [31981615238](https://github.com/Fandhe-AI/baby-tasks-app/actions/runs/31981615238)（schedule） | `Update agent skills` success |
| `yadori` | [32058767791](https://github.com/Fandhe-AI/yadori/actions/runs/32058767791) | success・同期 PR #666 作成 |
| `life-plan-app` | [32052423709](https://github.com/Fandhe-AI/life-plan-app/actions/runs/32052423709) | スキル更新完走・push 到達 |

同期が壊れないなら、配置統一は「Claude Code のスキル解決挙動へ影響しうる変更を 3 リポジトリへ
加える」コストだけを払って得るものが無い。個別事情で失敗するケースは、イシュー #265 で追加した
**更新対象スキルを限定する入力**で回避できる。

**同一リポジトリ内でスキルごとに配置が異なる状態も許容する。** `npx skills update <name> --project`
は対象スキルの実体だけを `.agents/skills/<name>/` へ移し `.claude/skills/<name>` をそこへの symlink に
張り替えるため、CLI 経由で個別更新したスキルだけ配置が変わる。`life-plan-app` #204 /
`baby-tasks-app` #15 で実際にそうなっており、この状態を正として受け入れる（revert しない）。

**How to apply:**
- 配置差を理由にリポジトリの構成変更 PR を出さない。同期が失敗した場合は**まず失敗ログで
  根因を確認**する（配置を疑う前に。配置は同期失敗の十分条件ではないことが実測済み）
- 特定スキルだけ同期を外す必要がある場合は、配置を変えるのではなく `skills-update` の
  対象限定入力（#265）を使う
- 配置を判別する必要があるときは git tree mode を見る（`120000` = symlink / `040000` = 実ディレクトリ）:

  ```bash
  r="<repo>"
  csha=$(gh api "repos/Fandhe-AI/${r}/git/trees/main" --jq '.tree[]|select(.path==".claude")|.sha')
  ssha=$(gh api "repos/Fandhe-AI/${r}/git/trees/${csha}" --jq '.tree[]|select(.path=="skills")|.sha')
  gh api "repos/Fandhe-AI/${r}/git/trees/${ssha}" --jq '.tree[]|"\(.mode) \(.path)"'
  ```

- **本リポジトリ（`agent-cli-skills`）はこの方針の対象外。** 上流ソースとして
  `skills/<name>/` を実体、`.claude/skills/<name>` をそこへの symlink とする構成を維持する
  （`.github/scripts/check-skill-structure.sh` が CI で検証している）

## 関連

- `./delegation-impl.md` — スキル本体の編集フロー
- `skills/sync-skills-lock/SKILL.md` — lock ファイル同期の手順
