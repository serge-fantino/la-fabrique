-- Lines added and removed between two commits of a project, from GitHub's
-- compare API. Two commits never change, so a pair is read only once.
CREATE TABLE diff_stats (
  repo TEXT NOT NULL COLLATE NOCASE,
  base TEXT NOT NULL,
  head TEXT NOT NULL,
  additions INTEGER NOT NULL,
  deletions INTEGER NOT NULL,
  files INTEGER NOT NULL,
  PRIMARY KEY (repo, base, head)
);
