# Hosted seller Postgres migration status

The owner-only importer is a staging step, not a service cutover. Hosted requests
still use the encrypted `seller_state` snapshot and `Phase3App` SQLite state.
Do not remove `seller_state`, switch Render traffic, or treat an import report as
proof that the Postgres-backed seller service is ready.

## Stage existing data

1. Pause all hosted seller writes, including provisioning and hosted exits.
2. Apply `backend/sql/seller-service.sql` to the Supabase database.
3. Set `SUPABASE_DB_URL` and the existing `SELLER_STATE_KEY` in the operator's
   private environment. The direct Postgres connection verifies TLS certificates.
4. Run `supercuts-hosted-seller-import --writes-paused` from the owner environment.

The importer reads the existing encrypted snapshots through server-only
PostgREST, checks each seller signer against the catalog identity, imports
encrypted SQLite rows and artifacts in one transaction per seller, reads every
row back, and checks that catalog, snapshot revisions, and payment claims did
not change during import. Repeating it with the same source is safe. Different
source state fails closed. Existing snapshots remain rollback archives.

The importer reports `serviceCutoverReady: false`. Runtime cutover requires
replacing all synchronous hosted SQLite paths (negotiation, x402, v2 transport,
note recovery, and exit queue) with Postgres transactions, then testing restart
and ambiguous external responses. No hosted service deployment should follow
from the staging import alone.
