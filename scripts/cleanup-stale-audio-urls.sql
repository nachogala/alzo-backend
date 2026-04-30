-- One-shot cleanup of legacy ephemeral audio URLs.
-- Forces the FE to regenerate audio (via /api/affirmation/today + voice clone pipeline)
-- because /audio/% and /uploads/% paths predate the Railway persistent volume mount
-- and are no longer served by the new server (B48 voice persistence fix).
-- Safe to run multiple times (idempotent).
UPDATE affirmations SET audioUrl = NULL WHERE audioUrl LIKE '/audio/%';
UPDATE journal_entries SET audioUrl = NULL WHERE audioUrl LIKE '/uploads/%';
