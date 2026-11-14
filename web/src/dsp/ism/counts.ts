/**
 * How many decoders each Sub-GHz family runs, for the family chips. Kept as plain numbers so the page does not pull
 * every decoder into its bundle; test/ism-counts.mjs fails the build when they drift from the registries.
 */
export const ISM_COUNTS = { weather: 25, remotes: 68, cars: 28 } as const;
