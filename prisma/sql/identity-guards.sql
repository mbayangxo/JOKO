-- J3 identity guards (idempotent). Applied after schema delivery, like
-- money-kernel.sql. See docs/JOKKO-J3-DESIGN.md.

-- 1. Append-only audit trails: no UPDATE, DELETE or TRUNCATE.
CREATE OR REPLACE FUNCTION j3_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'J3: % is append-only (% refused)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'P0001';
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['IdentityAuditEvent', 'RiskDecision', 'AdminAuditLog', 'CredentialSecurityEvent'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS j3_append_only_row ON %I', t);
    EXECUTE format('CREATE TRIGGER j3_append_only_row BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION j3_append_only()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS j3_append_only_truncate ON %I', t);
    EXECUTE format('CREATE TRIGGER j3_append_only_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION j3_append_only()', t);
  END LOOP;
END $$;

-- 2. Maker-checker: the approver is never the requester; the request payload
--    is immutable; a decided request is final.
CREATE OR REPLACE FUNCTION j3_admin_approval_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'J3: AdminApproval rows are never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF NEW."decidedBy" IS NOT NULL AND NEW."decidedBy" = NEW."requestedBy" AND NEW.status = 'executed' THEN
    RAISE EXCEPTION 'J3: maker-checker — the requester cannot approve their own request' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."payloadJson" IS DISTINCT FROM OLD."payloadJson" OR NEW."payloadHash" IS DISTINCT FROM OLD."payloadHash"
       OR NEW.action IS DISTINCT FROM OLD.action OR NEW."requestedBy" IS DISTINCT FROM OLD."requestedBy" THEN
      RAISE EXCEPTION 'J3: an approval request is immutable once created' USING ERRCODE = 'P0001';
    END IF;
    IF OLD.status <> 'requested' AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'J3: approval % is already %', OLD.id, OLD.status USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS j3_admin_approval_guard ON "AdminApproval";
CREATE TRIGGER j3_admin_approval_guard BEFORE UPDATE OR DELETE ON "AdminApproval"
  FOR EACH ROW EXECUTE FUNCTION j3_admin_approval_guard();

-- 3. Admin role grants: never deleted (revocation is a timestamp); nobody
--    approves a grant to themselves; the grant identity is immutable.
CREATE OR REPLACE FUNCTION j3_admin_role_grant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'J3: AdminRoleGrant rows are never deleted (revoke instead)' USING ERRCODE = 'P0001';
  END IF;
  IF NEW."approvedBy" IS NOT NULL AND (NEW."approvedBy" = NEW."adminUserId" OR NEW."approvedBy" = NEW."grantedBy") THEN
    RAISE EXCEPTION 'J3: a role grant needs an approver other than the grantee and the requester' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."adminUserId" IS DISTINCT FROM OLD."adminUserId" OR NEW.role IS DISTINCT FROM OLD.role
       OR NEW."grantedBy" IS DISTINCT FROM OLD."grantedBy" OR NEW."approvedBy" IS DISTINCT FROM OLD."approvedBy"
       OR (OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt")) THEN
    RAISE EXCEPTION 'J3: role grant identity is immutable; a revoked grant stays revoked' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS j3_admin_role_grant_guard ON "AdminRoleGrant";
CREATE TRIGGER j3_admin_role_grant_guard BEFORE INSERT OR UPDATE OR DELETE ON "AdminRoleGrant"
  FOR EACH ROW EXECUTE FUNCTION j3_admin_role_grant_guard();

-- 4. Business membership: rows are never deleted (removal is a status), so
--    history stays attributable to the person who created it.
CREATE OR REPLACE FUNCTION j3_business_member_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'J3: BusinessMember rows are never deleted (set status = removed)' USING ERRCODE = 'P0001';
END $$;
DROP TRIGGER IF EXISTS j3_business_member_guard ON "BusinessMember";
CREATE TRIGGER j3_business_member_guard BEFORE DELETE ON "BusinessMember"
  FOR EACH ROW WHEN (pg_trigger_depth() < 1) EXECUTE FUNCTION j3_business_member_guard();
