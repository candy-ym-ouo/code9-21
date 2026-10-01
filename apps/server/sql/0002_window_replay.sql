-- 0002_window_replay.sql
-- 历史窗口可重放：记录每次判定的完整输入口径（机位 + 条件 + 当次预报切片 + 提供方 + 算法版本）。
-- 旧行该列为 NULL：视为"重构前历史窗口"，仍保留原 verdict/reasons 供查看，仅重放接口返回 replayable=false。
ALTER TABLE repro_window ADD COLUMN input_snapshot TEXT;
