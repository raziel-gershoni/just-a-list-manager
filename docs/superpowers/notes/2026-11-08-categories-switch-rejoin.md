# Categories switch missed while disconnected

**Status:** parked (2026-11-08). Found in the Task 4 review of the categories switch plan. Not a
regression: the list type has the same limit today. Nothing is built.

## The gap

The switch reaches other devices only through the realtime `lists` UPDATE
(`src/hooks/useListRealtime.ts`). The catch-up after a realtime rejoin, `refreshItems` in
`src/hooks/useListData.ts`, re-reads the items and the categories, but not the list summary. So a
device that was disconnected when the owner flipped the switch keeps its old value until the list
is reopened:
- **Turned off while away:** the refresh brings items with no category and an empty category list,
  but `categoriesEnabled` stays `true`. The grouped view shows every item under "Sorting…", and
  `retrySorting` can't fix it, because the server refuses to sort while off.
- **Turned on while away:** the list stays flat until it is reopened.

## Ways to close it

- **Re-read the list summary on rejoin** (`/api/lists`, the same lookup `fetchItems` does) and apply
  `categories_enabled` (and `type`, which has the same gap). It costs one more request per
  reconnect.
- **Use the refresh answer as a cue:** an empty categories answer on a grocery list that still has
  unsorted items triggers a re-read of the switch. Cheaper, but only covers the off case.
