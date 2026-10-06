-- Removes exactly what picker-people.sql inserted, by its fixed `550a0000-` UUIDs. LOCAL-ONLY (#550).
-- Fenced on `__quincy_local_capability` like the insert file: against a database without that table (production)
-- every statement fails, and without the capability row it deletes nothing.
-- Anything the app attached to the throwaway project (activity events, comments) must be removed first
-- or the project delete is refused by its foreign keys; reset the local D1 instead if that happens.
DELETE FROM project_members WHERE id LIKE '550a0000-%' AND project_id = '550a0000-0000-4000-8000-000000000010' AND EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = 'scheduling-fixtures');
DELETE FROM projects WHERE id = '550a0000-0000-4000-8000-000000000010' AND EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = 'scheduling-fixtures');
DELETE FROM user WHERE id LIKE '550a0000-%' AND EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = 'scheduling-fixtures');
