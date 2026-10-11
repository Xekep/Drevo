-- Resolve a bearer link without disclosing its archive in the URL. The existing
-- global UNIQUE(token_hash) bounds lookup to one row. This capability grants
-- SELECT only; mutation and every other table retain their usual archive RLS.
-- Multi-statement execution is one transaction; concurrent startup migrations
-- serialize the policy replacement without taking a second pool connection.
SELECT pg_advisory_xact_lock(186743291);
DROP POLICY IF EXISTS invitation_token_lookup ON archive_invitations;
CREATE POLICY invitation_token_lookup ON archive_invitations FOR SELECT
  USING (
    token_hash = NULLIF(current_setting('drevo.invitation_token_hash', true), '')
    AND revoked_at IS NULL
    AND expires_at > to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
