// 状態項目の照合用の射影（ホストの projectStateItem・state.sh verify と同じ: note 欄を除く。Issue #878）。
// テストが「実ファイル相当の項目のハッシュ」を作るときに使う。
export const noNote = (v) => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return v
  const { note: _note, ...rest } = v
  return rest
}
