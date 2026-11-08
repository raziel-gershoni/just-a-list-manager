# List type missed while disconnected

**Status:** parked (2026-11-08). Found while fixing the same gap for the categories switch. Not a
regression. Nothing is built.

## The gap

A type change reaches other devices only through the realtime `lists` UPDATE
(`src/hooks/useListRealtime.ts`). The catch-up after a rejoin, `refreshItems` in
`src/hooks/useListData.ts`, re-reads the items and the categories switch, but not the type. So a
device that was disconnected when the owner changed the type keeps the old one until the list is
reopened (`fetchItems`, the full load, reads it from the list summary).

## Way to close it

Carry `type` on the items GET answer (`app/api/lists/[id]/items/route.ts`), the same way
`categories_enabled` is carried now: the route already selects `type` from `lists`. `refreshItems`
then applies it when it is in the answer, with a generation guard like the switch's, so an answer
that left before a type change on screen can't put back the old type. An old server's answer
without the field leaves the type as it is.
