/**
 * sessionStorage flag: this launch's single-list auto-open on Home is used up. Home sets it on
 * its first active-view load; the provider sets it at bootstrap when the launch does not start
 * on Home and loads its route (a signed-out web launch sent to /login does not), so Back from a
 * list the launch opened stays on Home.
 */
export const AUTO_OPENED_SINGLE_LIST_KEY = "autoOpenedSingleList";
