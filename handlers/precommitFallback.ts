import { Handlers } from "../clientTools.ts";

/**
 * TEMPORARY: fallback for browsers without `precommitHandler` (Safari).
 *
 * `intercept({ precommitHandler })` is how `data-nav-redirect` keeps (or sets)
 * the displayed URL. Browsers that lack it silently ignore the option, so the
 * destination URL (e.g. `/admin/api/update-user`) is committed instead. This
 * puts the intended URL back once the navigation has finished; a replace
 * during the navigation would abort it.
 *
 * Remove this file and its `redirectWithoutPrecommit` calls once every
 * supported browser has `NavigationPrecommitController`.
 */
export const precommitFallbackTools = new Handlers(import.meta.url, {
  redirectWithoutPrecommit: function (event: NavigateEvent, url: string) {
    if ("NavigationPrecommitController" in globalThis) return;
    const navigationApi = globalThis.navigation as Navigation & {
      precommitFallbackEvents?: WeakSet<NavigateEvent>;
    };
    // Both the body and client routers may ask for the same event.
    const handled = navigationApi.precommitFallbackEvents ??= new WeakSet();
    if (handled.has(event)) return;
    handled.add(event);

    const done = new AbortController();
    navigationApi.addEventListener("navigatesuccess", () => {
      done.abort();
      if (globalThis.location.href === url) return;
      navigationApi.navigate(url, {
        history: "replace",
        info: { onlyUpdateUrl: true },
      });
    }, { signal: done.signal });
    // Superseded or failed: leave the URL to whatever replaced it.
    navigationApi.addEventListener("navigateerror", () => done.abort(), {
      signal: done.signal,
    });
  },
});
