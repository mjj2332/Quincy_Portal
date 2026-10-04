-- Project Deadline provenance (#484). deadline_source records who set the Deadline: automatic (the system
-- gave a Project that gained a shoot date its Automatic Deadline), manual (a person saved it) or none (no Deadline).
-- It is one bare ADD COLUMN whose CHECK references only its own column, so it is not a table rebuild and adds no
-- trigger (docs/lessons.md, the no-triggers entry). The CHECK is deliberately not tied to deadline_at, because many
-- fixtures insert deadline_at directly and the read model treats a held Deadline that is not automatic as manual.
ALTER TABLE projects ADD COLUMN deadline_source text NOT NULL DEFAULT 'none'
  CHECK (deadline_source IN ('automatic', 'manual', 'none'));
--> statement-breakpoint
-- Every Deadline held today was set by a person. Nothing is created, rescheduled or notified here:
-- existing Projects are never given an Automatic Deadline retroactively.
UPDATE projects SET deadline_source = 'manual' WHERE deadline_at IS NOT NULL;
