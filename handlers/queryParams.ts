import { Handlers } from "../clientTools.ts";

/** Helpers for reacting to changes in the URL's query parameters. */
export const queryParamTools: Handlers<{
  /**
   * Compares the current entry's query parameters with those of
   * `fromUrlString` and returns each key whose value changed, with its old
   * and new value (`null` when absent or empty).
   */
  queryParamChanges(
    fromUrlString: string | null,
  ): Map<string, { from: string | null; to: string | null }>;
}> = new Handlers(import.meta.url, {
  queryParamChanges: function (fromUrlString: string | null) {
    const newUrlString = navigation.currentEntry?.url;
    if (!newUrlString) {
      throw new Error("No currentEntry URL in queryParamChange");
    }
    const toUrl = new URL(newUrlString);
    const fromParams = new URL(fromUrlString ?? toUrl.origin).searchParams;

    const paramChanges = toUrl.searchParams.entries().toArray().map(
      ([key, value]) => {
        if (fromParams.get(key) === value) return null;
        return {
          key,
          from: fromParams.get(key),
          to: value || null,
        };
      },
    ).concat(
      fromParams.entries().toArray().map(([key, value]) => {
        if (toUrl.searchParams.has(key)) return null;
        return {
          key,
          from: value || null,
          to: null,
        };
      }),
    ).filter((change) => change !== null);
    const changeMap = new Map(paramChanges.map(({ key, ...rest }) => [
      key,
      rest,
    ]));
    return changeMap;
  },
});
