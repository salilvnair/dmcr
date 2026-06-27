-- ============================================================
-- Zapper — Seed: Alerts & Notifications  (FIXED — public schema)
-- Table already created in 01_schema.sql
-- Run AFTER 09_functions.sql (so SLA-based alerts reflect reality)
-- ============================================================

INSERT INTO alerts (alert_type, severity, disconnect_request_id, message, details, acknowledged, acknowledged_by, acknowledged_at) VALUES

-- ── SLA breach alerts ─────────────────────────────────────────────────────
('sla_breach','critical','ZAP-REQ-700001',
 'SLA breached: ZAP-REQ-700001 (BrightSpark Energy — SP-00001) exceeded ENT bundle 2h SLA',
 '{"bundle":"ENT","sla_hours":2,"breached_at":"2026-05-20T11:00:00Z","current_status":700,"arrears_gbp":720.00}',
 TRUE, 'ops_team:alice.brown@zapper.io', '2026-05-20 11:35:00+00'),

('sla_breach','critical','ZAP-REQ-700002',
 'SLA breached: ZAP-REQ-700002 (NorthGrid Power — SP-00005) exceeded ENT bundle 2h SLA',
 '{"bundle":"ENT","sla_hours":2,"breached_at":"2026-05-18T15:00:00Z","current_status":700,"arrears_gbp":1240.00}',
 TRUE, 'ops_team:james.harris@zapper.io', '2026-05-18 15:52:00+00'),

('sla_breach','critical','ZAP-REQ-700004',
 'SLA breached: ZAP-REQ-700004 (ArcLight Systems — SP-00010) exceeded ENT bundle 2h SLA. Largest arrears in backlog.',
 '{"bundle":"ENT","sla_hours":2,"breached_at":"2026-04-20T09:00:00Z","current_status":700,"arrears_gbp":2800.00,"escalated":true}',
 FALSE, NULL, NULL),

('sla_breach','warning','ZAP-REQ-700005',
 'SLA approaching breach: ZAP-REQ-700005 (Kinetic Energy UK — SP-00013) in SAVE360 bundle (4h SLA)',
 '{"bundle":"SAVE360","sla_hours":4,"elapsed_hours":3.5,"current_status":700,"arrears_gbp":880.00}',
 FALSE, NULL, NULL),

('sla_breach','warning','ZAP-REQ-700006',
 'SLA breached: ZAP-REQ-700006 (TerraWatt Ltd — SP-00014) exceeded SAVE240 bundle 8h SLA',
 '{"bundle":"SAVE240","sla_hours":8,"breached_at":"2026-05-22T14:00:00Z","current_status":700,"arrears_gbp":620.00}',
 FALSE, NULL, NULL),

('sla_breach','critical','ZAP-REQ-700008',
 'SLA breached: ZAP-REQ-700008 (Apex Energy Solutions — SP-00018) exceeded SAVE360 bundle 4h SLA',
 '{"bundle":"SAVE360","sla_hours":4,"breached_at":"2026-05-14T10:00:00Z","current_status":700,"arrears_gbp":1560.00}',
 TRUE, 'ops_team:sarah.jones@zapper.io', '2026-05-14 11:10:00+00'),

-- ── Validation failure alerts ─────────────────────────────────────────────
('validation_failed','warning','ZAP-REQ-700003',
 'Validation warning: ZAP-REQ-700003 vulnerable customer flag — PSR check required before proceeding to MOIG',
 '{"rule":"PSR_VULNERABLE_CHECK","customer_id":3,"is_vulnerable":true,"psr_flag":true,"supply_point":"SP-00007"}',
 TRUE, 'compliance_team:mary.white@zapper.io', '2026-05-01 09:10:00+00'),

('validation_failed','warning','ZAP-REQ-700007',
 'Validation warning: ZAP-REQ-700007 associated supply point SP-00016 flagged as prepayment meter — additional confirmation needed',
 '{"rule":"PREPAYMENT_METER_CONFIRM","supply_point":"SP-00016","meter_type":"prepayment"}',
 FALSE, NULL, NULL),

('validation_failed','info','ZAP-REQ-800001',
 'Validation info: ZAP-REQ-800001 is in BASIC bundle — no SLA enforcement, monitoring only',
 '{"rule":"BASIC_BUNDLE_INFO","bundle":"BASIC","sla_hours":24,"current_status":800}',
 TRUE, 'system:auto_ack', '2026-05-28 09:00:00+00'),

-- ── RATSNI timeout alerts ─────────────────────────────────────────────────
('ratsni_timeout','critical','ZAP-REQ-700001',
 'RATSNI queue timeout: ZAP-REQ-700001 has been at status 700 for 29 days — escalate to DNO liaison',
 '{"days_at_status_700":29,"last_external_msg":"RATSNI_ACK_2026-04-21","queue_position":1}',
 FALSE, NULL, NULL),

('ratsni_timeout','critical','ZAP-REQ-700004',
 'RATSNI queue timeout: ZAP-REQ-700004 has been at status 700 for 57 days — commercial escalation path invoked',
 '{"days_at_status_700":57,"last_external_msg":"RATSNI_ACK_2026-04-01","queue_position":2,"commercial_escalation":true}',
 FALSE, NULL, NULL),

('ratsni_timeout','warning','ZAP-REQ-700002',
 'RATSNI monitoring: ZAP-REQ-700002 at status 700 for 34 days — within SLA but approaching escalation threshold',
 '{"days_at_status_700":34,"threshold_days":45,"last_external_msg":"RATSNI_ACK_2026-04-15"}',
 TRUE, 'ops_team:james.harris@zapper.io', '2026-05-20 14:00:00+00'),

-- ── DNO rejection alerts ──────────────────────────────────────────────────
('dno_rejected','warning','ZAP-REQ-700009',
 'DNO rejection: ZAP-REQ-700009 (BluePeak Utilities — SP-00011) returned by UK Power Networks — engineer slot unavailable',
 '{"dno":"UK Power Networks","rejection_code":"ENG_UNAVAILABLE","rejection_date":"2026-05-12","next_available_slot":"2026-06-10"}',
 FALSE, NULL, NULL),

('dno_rejected','info','ZAP-REQ-700010',
 'DNO soft reject: ZAP-REQ-700010 (Zenith Power — SP-00021) — requested appointment date unavailable, rescheduled +7d',
 '{"dno":"Northern Powergrid","rejection_code":"DATE_UNAVAILABLE","requested_date":"2026-05-25","rescheduled_to":"2026-06-01"}',
 TRUE, 'field_ops:tom.green@zapper.io', '2026-05-16 10:22:00+00'),

-- ── Engineer unavailability alerts ────────────────────────────────────────
('engineer_unavailable','warning','ZAP-REQ-700003',
 'No engineer available: ZAP-REQ-700003 (ClearVolt — SP-00007) — all engineers in EM1 region are on leave 2026-06-14 to 2026-06-21',
 '{"dno_region":"EM1","leave_window_start":"2026-06-14","leave_window_end":"2026-06-21","next_available":"2026-06-22"}',
 FALSE, NULL, NULL),

-- ── Bulk threshold alerts (operational) ──────────────────────────────────
('bulk_threshold','warning', NULL,
 'Bulk threshold alert: 63 disconnect requests currently at status 700 (RATSNI backlog) — exceeds normal operating limit of 40',
 '{"status":700,"count":63,"threshold":40,"timestamp":"2026-06-18T08:00:00Z","oldest_req_id":"ZAP-REQ-700001","oldest_days":29}',
 FALSE, NULL, NULL),

('bulk_threshold','info', NULL,
 'Bulk threshold info: 12 disconnect requests at status 800 (pending MOIG submission) — approaching threshold of 15',
 '{"status":800,"count":12,"threshold":15,"timestamp":"2026-06-18T08:00:00Z"}',
 FALSE, NULL, NULL),

('bulk_threshold','info', NULL,
 'Daily digest: 8 requests moved to terminal status (999) in last 24h — disconnect confirmed (BASIC bundle)',
 '{"status":999,"moved_in_24h":8,"bundle":"BASIC","timestamp":"2026-06-18T07:00:00Z"}',
 TRUE, 'system:auto_ack', '2026-06-18 07:01:00+00');
