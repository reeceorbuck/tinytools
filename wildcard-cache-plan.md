# Wildcard Cache Matching Plan

## Goal

Extend the current client-side navigation cache so cached partial results can be
reused when the visible route changes in predictable ways, even if the fetch URL
differs from the destination URL.

The intended model is:

- A cached result can advertise a wildcard path pattern such as
  `/appointments/2025-04-01/*`.
- Wildcards represent URL parts that do not materially affect the cached partial
  result.
- Matching is conservative. If the cache does not fully account for every
  relevant URL change, the runtime must ignore the cache and use the server.

## Core Principles

1. Cache entries describe reusable partial update results, not full-page layout
   regions.
2. Matching is based on URL changes and the actual ids updated by the cached
   fragment.
3. A wildcard cache entry is valid only when it fully accounts for the changes
   that occurred in the navigation.
4. If cache coverage is incomplete, no cached fragment should be replayed for
   that navigation.
5. Authored local templates remain fallback placeholders, not the preferred
   source of truth when a real cached result is available.
6. The visible URL path represents server-rendered location/state, while query
   params in the visible URL should ideally only represent client-side display,
   prefill, or manipulation of already-fixed server data.
7. Intercepted fetch URLs may still be useful capture-time provenance, but
   replay matching should be driven by visible navigation semantics rather than
   by the internal partial endpoint that originally produced the cached result.

## URL Semantics Rule

The plan should assume the following design target:

- The visible URL path is the canonical representation of server-rendered data
  location.
- Query params shown in the browser URL bar should ideally not change what
  server-rendered content is sent back.
- Visible query params may still affect client-side display state, prefill, UI
  filters, and local manipulation of already-loaded data.
- Intercepted fetch URLs may still carry route-transition details during
  capture, but those internal request details should not become the primary
  replay key when cached content is later reused for visible navigation.

Implications:

1. Exact-route cache reuse for visible navigation should primarily key off the
   visible path, not visible query params.
2. Visible query params should only affect cache matching if a route explicitly
   still depends on them during the transition period while the codebase is not
   yet fully aligned with this design goal.
3. Wildcard-capable cache entries should be matched from visible URL change
   semantics and updated-id coverage, not from the internal fetch URL that was
   used to obtain the cached fragment.
4. Long term, visible query params should become increasingly irrelevant for
   server-content cache identity unless a route explicitly still depends on
   them.

Note:

- Existing routes in the codebase may not yet strictly follow this ideal.
- The implementation should therefore allow transitional exceptions, but the
  design direction should remain path-centric for visible URLs.

## Important Constraints

### 1. Multiple changed segments must remain a single cache entry

If a navigation changes two or more path segments, the runtime must create a
single cache entry that represents those changes together.

Example:

- From: `/appointments/2025-04-01/123`
- To: `/appointments/2025-04-02/456`

The cache entry may need a pattern like:

- `/appointments/2025-04-02/456`
- or a wildcard form derived from the response contract

But it must not be split into two separate cache templates like:

- `/appointments/2025-04-02/*`
- `/appointments/*/456`

Reason:

- The runtime has no reliable way to determine which updated ids came from which
  changed URL segment.
- Splitting them would create ambiguous composition rules and risk replaying
  mismatched partial content.

### 2. Cache matching is all-or-nothing for changed URL components

The runtime should stop after the first valid match only if that match fully
accounts for every modified URL component relevant to the navigation.

If a navigation changes multiple URL components and the cache only accounts for
some of them, then:

- no cached fragment should be used at all
- the navigation should proceed to the server fetch

Example:

- From: `/appointments/2025-04-01/123?operator=a`
- To: `/appointments/2025-04-02/123?operator=b`

If the runtime only has a cache entry that accounts for the date change but not
the operator change, that cache must be ignored.

## Proposed Cache Model

Extend the current runtime cache so it can handle both the existing exact-route
snapshot behavior and the proposed wildcard-compatible partial-result reuse.

The intent is not to introduce a separate caching system. The existing feature
set should remain the foundation, with the new behavior treated as a broader
matching and storage capability inside the same overall cache model.

### Existing exact-route behavior

- Purpose: replay previously visited visible routes
- Strength: back/forward style reuse
- Key: canonical route path

### Proposed wildcard enhancement

- Purpose: replay partial server responses when a later navigation has a
  compatible URL change pattern
- Strength: reuse of intercepted fetch results such as
  `/appointments/api/set-date`
- Relationship to existing behavior: exact-route reuse remains the simplest case
  within the same cache model, while wildcard-compatible reuse adds a more
  expressive matching mode when correctness can still be proven
- Key shape:
  - wildcard-compatible visible path pattern
  - changed-component coverage rules
  - updated id set

## Terminology

### Canonical path

The destination route visible in the address bar, for example:

- `/appointments/2025-04-01/123`

### Fetch path

The intercepted request path actually used for the partial fetch, for example:

- `/appointments/api/set-date`

### Wildcard path pattern

A path pattern derived from the navigation relationship, for example:

- `/appointments/2025-04-01/*`
- `/appointments/*/123`

### Changed component

Any path segment or relevant query key whose value differs between `fromUrl` and
`toUrl`.

For visible-URL matching, "relevant query key" should be interpreted narrowly
and only for routes that still materially depend on visible query params.

## Matching Semantics

### 1. Compute changed URL components

For every intercepted navigation, compare `fromUrl` and `toUrl`.

Produce a list of changed components such as:

- path segment 1 changed: date
- path segment 2 changed: patientId
- query key changed: operator

Only these changed components matter when deciding whether a cached entry is
eligible.

However, visible query params should not automatically be treated as server-data
changes. The default assumption should be:

- visible path changes are server-data changes
- visible query changes are client-display changes unless a route explicitly
  proves otherwise
- internal fetch request details may explain how the cached fragment was
  originally produced, but they should not be matched directly when deciding
  whether that fragment can be replayed for a later visible navigation

### 2. Candidate cache entries

For wildcard-capable cache reuse, gather entries that match:

- wildcard path pattern compatible with `toUrl`
- changed-component coverage compatible with the navigation
- updated ids and fragment scope compatible with the intended replay

For exact-route reuse, visible query params should usually be ignored.

For wildcard-capable entries, any captured fetch request details should be
treated as provenance unless they have already been translated into explicit
visible-navigation matching rules.

### 3. Coverage requirement

A cache entry is valid only if it accounts for all changed URL components.

If no single cache entry accounts for all changed components, the runtime must:

- skip wildcard cache replay
- fall through to the server fetch

### 4. Stop-after-match rule

The runtime may stop on the first wildcard cache match only if that match is a
full match.

If the match is partial coverage, it must be treated as no match.

This means there is no opportunistic partial replay when the navigation contains
unmatched URL changes.

### 5. No compositing of separate cache entries for different changed segments

Even if multiple cache entries together appear to cover all changed URL
components, they must not be combined if those components changed together in a
single navigation.

Reason:

- the runtime cannot know which ids were updated because of which specific URL
  change
- combining cache fragments would create silent correctness errors

## How Entries Should Be Created

### Source of truth

Wildcard entries should be created from actual successful partial server
responses, not from authored loading templates.

### Creation timing

After a successful partial fetch response is received and before it is
discarded, store:

- the fragment to replay
- the ids updated by the fragment
- the fetch URL as optional provenance about how the fragment was obtained
- the visible `fromUrl` and `toUrl`
- the changed URL components
- the derived wildcard path pattern for that specific navigation

### Entry shape

Suggested conceptual shape:

```ts
type WildcardCacheEntry = {
  canonicalToPath: string;
  wildcardPath: string;
  changedComponents: Array<
    | {
      kind: "path";
      index: number;
      from: string | undefined;
      to: string | undefined;
    }
    | { kind: "query"; key: string; from: string | null; to: string | null }
  >;
  updatedIds: string[];
  html: string;
  sourceFetchUrl?: string;
  createdAt: number;
};
```

## Matching Order

Recommended local replay order:

1. Exact runtime route snapshot match
2. Wildcard-capable entry match with full changed-component coverage
3. Authored local loading template
4. Network fetch

This order ensures:

- real cached content wins over placeholders
- placeholders remain useful when no safe cached content exists

## Query Parameters

Query handling should focus on visible URL semantics for replay eligibility.

### Visible URL query params

Visible query params should ideally not define server-content identity.

Examples:

- UI filter state
- prefilled input state
- client-only display modes

Rules:

- by default, visible query params should not prevent exact-route reuse
- they should only participate in wildcard cache coverage if a route still
  materially changes server output based on those query params
- the long-term goal is to phase out visible-query dependence for server data

### Intercepted fetch URL query params

Intercepted fetch URL query params may help explain how a cached fragment was
produced, but they should not be used as replay keys when the fetch URL differs
from the visible destination URL.

Examples:

- `operator`
- `page`
- any form-driven GET value that changes server output

Rules:

- if a fetch query value matters, that meaning should be reflected in explicit
  changed-component or compatibility metadata derived from the visible
  navigation
- raw fetch query keys should not by themselves decide replay eligibility
- empty-string cleanup can still happen before capture so provenance remains
  consistent

## Authoring Rules

Authored local templates should not produce wildcard-capable cache entries.

They remain:

- immediate loading-state placeholders
- generic local fallbacks

They should not be treated as authoritative reusable data.

## SSE Interaction

SSE routing should remain based on canonical tracked paths, not wildcard cache
aliases.

However, if an SSE update changes ids that exist inside a cached wildcard entry,
that cached entry should be patched in place so later fallback replay stays
fresh.

This means wildcard-capable cache entries should participate in the same
freshness update path as existing exact-route cache entries.

## Implementation Phases

### Phase 1: Metadata capture

- Capture the ids updated by each successful partial response.
- Capture `fromUrl`, `toUrl`, and `fetchUrl`.
- Compute changed URL components.

### Phase 2: Wildcard entry storage

- Extend the current runtime cache representation so it can also store
  wildcard-capable entries in addition to existing exact-route entries.
- Store exact and wildcard path representations.

### Phase 3: Matching engine

- Add compatibility logic for wildcard path and query matching.
- Enforce full changed-component coverage.
- Reject partial coverage.

### Phase 4: Replay path

- Replay cached wildcard partial results through the same incoming HTML pipeline
  used for live responses.
- Ensure the replay path activates scripts and updates matching ids exactly as a
  normal partial response would.

### Phase 5: Freshness integration

- Patch wildcard cache entries when SSE updates arrive and touch ids contained
  in those entries.

## Concrete Example: Appointments Set-Date

Example navigation:

- Visible from: `/appointments/2025-04-01/123?operator=a`
- Visible to: `/appointments/2025-04-02/123?operator=a`
- Fetch URL: `/appointments/api/set-date`

Derived facts:

- changed path segment: date
- unchanged path segment: patientId
- unchanged query key: operator

Possible wildcard path:

- `/appointments/2025-04-02/*`

This entry is valid for replay only if:

- it fully accounts for the only changed component, which is date
- its wildcard pattern still matches the destination navigation shape
- its updated ids are the right fragment to replay for that navigation

Another navigation:

- Visible from: `/appointments/2025-04-01/123?operator=a`
- Visible to: `/appointments/2025-04-02/456?operator=b`

Derived facts:

- changed path segment: date
- changed path segment: patientId
- changed query key: operator

Rules:

- one combined cache entry may match this exact change pattern
- two smaller entries must not be combined
- if no single full-coverage cache entry exists, fetch from the server

## Open Decisions

1. How aggressively to normalize query params for GET partial endpoints.
2. Whether wildcard path patterns should be stored as strings or as parsed
   segment arrays.
3. How exact-route and wildcard-capable entries should be represented within the
   same runtime cache structure.
4. Whether the first version should support POST wildcard caching or stay GET
   only.

## Recommended First Version

Start conservative:

- GET only
- one cache entry must fully cover all changed URL components
- no composition of multiple entries
- authored local templates excluded from wildcard cache creation

That gives useful reuse without making correctness dependent on ambiguous
inference.
