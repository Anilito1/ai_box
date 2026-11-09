-- A message is hidden by reports from enough different addresses, not by several pseudos made from one connection.
-- Same day-salted hash as users and posts.
ALTER TABLE reports ADD COLUMN ip_hash TEXT NOT NULL DEFAULT '';
