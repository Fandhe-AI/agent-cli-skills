## エージェント共通ルール（agent-cli-skills）

- 出力・報告・コミットメッセージの本文は日本語で書く。コード・コマンド・識別子は英語のまま。
- コミットは Conventional Commits（`type(scope): subject`）に従う。type は feat / fix / docs / refactor / test / chore / style / build / ci / perf。
- `--no-verify`（フック回避）と force push は禁止。hook でも機械的に止める。フックが失敗したら原因を直して再実行する。
- 実装は計画を作ってユーザーが承認してから始める。承認なしで実装に入らない。
- 使えるスキルは `.agents/skills/` 配下: create-commit / create-pr / create-issue / implement-issue / implement-issue-tree / implement-review / implement-review-pr / update-docs / comment-code。
- サブエージェントによるマージ・承認（approve）・リポジトリ設定の変更は hook で拒否される。これらは人間が行う。
