-- 0005 runtime grants. teeth_app gets exactly what the API needs: no DELETE anywhere, no
-- direct writes to the audit table, no DDL. Row-level security filters every tenant table.

GRANT USAGE ON SCHEMA public TO teeth_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'location', 'operatory', 'resource', 'org_counter', 'staff_member', 'credential',
    'patient', 'patient_contact', 'guardian_link', 'insurance_policy',
    'allergy', 'medication_statement', 'medical_condition', 'history_review', 'break_glass_grant',
    'appointment_type', 'appointment', 'appointment_resource', 'appointment_procedure', 'recall', 'waitlist_entry',
    'tooth_instance', 'encounter', 'encounter_note', 'clinical_finding', 'existing_restoration', 'diagnosis',
    'treatment_plan', 'planned_procedure', 'planned_procedure_event', 'procedure_occurrence', 'procedure_material',
    'anesthetic_event', 'media_object', 'encounter_version', 'attestation', 'amendment',
    'patient_pharmacy_preference', 'prescription', 'prescription_event',
    'user_session', 'outbox', 'pharmacy'
  ] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO teeth_app', t);
  END LOOP;
END $$;

GRANT SELECT ON organization, user_account, dental_position, billing_code, billing_code_rule TO teeth_app;
GRANT SELECT ON audit_event TO teeth_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO teeth_app;
GRANT EXECUTE ON FUNCTION audit_append(uuid, uuid, uuid, uuid, text, text, text, uuid, text, text, jsonb, text) TO teeth_app;
GRANT EXECUTE ON FUNCTION auth_memberships(uuid) TO teeth_app;
GRANT EXECUTE ON FUNCTION erx_resolve_org(text) TO teeth_app;
REVOKE EXECUTE ON FUNCTION audit_verify_chain(uuid) FROM PUBLIC;
