-- Removes exactly what picker-people.sql inserted, by its fixed `qa550-` ids. LOCAL-ONLY (#550).
-- Fenced on `__quincy_local_capability` like the insert file: against a database without that table (production)
-- every statement fails, and without the capability row it deletes nothing.
-- Anything the app attached to the throwaway project (activity events, comments) must be removed first
-- or the project delete is refused by its foreign keys; reset the local D1 instead if that happens.
DELETE FROM project_members WHERE id LIKE 'qa550-member-%' AND project_id = 'qa550-project' AND EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = 'scheduling-fixtures');
DELETE FROM projects WHERE id = 'qa550-project' AND EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = 'scheduling-fixtures');
DELETE FROM user WHERE id LIKE 'qa550-user-%' AND EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = 'scheduling-fixtures');
