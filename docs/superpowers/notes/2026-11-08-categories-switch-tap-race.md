# Categories switch taps that cross in flight

**Status:** parked (2026-11-08). Found in the Task 5 review of the categories switch plan. Not a
regression: the list type control has the same pattern today. Nothing is built.

## The gap

`saveCategoriesEnabled` in `app/(app)/list/[id]/page.tsx` sets the switch, PATCHes, and on a failed
save sets it back to `!enabled`. Taps are not serialised. If the owner taps again while the first
PATCH is still in flight, and the two saves finish in a different order than they were sent, the
switch on screen can end up out of step with the server until the list is reopened or a realtime
`lists` UPDATE arrives.

## Ways to close it

- **Disable the switch while a save is in flight.** Simplest; the type control would want the same.
- **Count saves and only roll back the latest one** (ignore a failure from an older tap).
