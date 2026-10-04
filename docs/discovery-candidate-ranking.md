# Candidate suggestion order

Automatic suggestions read only explicitly published person fields and separately
consented close-relative names. They do not assert that two people are identical;
the displayed reasons and contradictions are evidence for a person to review.

The server walks these tiers in order, with no claim of global numeric-score
ordering:

1. A bilateral, same-kind close-relative clue, the same published given name,
   and published birth years within two years. This can find a changed surname.
2. Exact published given name and current or birth surname, with the same
   published birth year.
3. The same name roles, with published birth years within two years.
4. The same name roles with another or unavailable published birth year.
5. Approximate name or place evidence from existing GIN-assisted lookups. This
   tier scans at most 96 raw matches per page and has a 500 ms SQL statement
   timeout; it is marked `approximate` and may be `partial`.

Tiers 1–4 use indexed keyset streams ordered by birth year, published name and
archive/person IDs. The relative tier uses the consent lookup index and
archive/person keyset. Lower tiers exclude matches from higher tiers, including
when a person matches both current and birth surnames. The cursor carries a
fingerprint of the source publication, its selected relative consents and the
ignored-list mode; changing those inputs requires restarting at page one.
Target publications and dismissals can change between pages, so pagination is
best effort under concurrent writes. A final locked check verifies the source,
every selected target, consents and caller access before any response bytes.

A source with more than 32 distinct consented relative clues or 128 selected
relative rows receives a `422 refineRequired` response; the UI links back to
publication settings. No consent is silently discarded. The approximate tier
can return a retryable `503` if its bounded SQL query exceeds the timeout.
Exact-name and relative queries have a 2 second SQL statement timeout; they
also return a retryable `503` if the local database cannot meet that bound.

The extra B-tree indexes are on published name roles and year only. There is no
materialized cross-archive pair table or shared generation counter. Numeric
evidence scores remain an explanation aid in the ranking helper, but are not
the ordering contract for the suggestion API.
