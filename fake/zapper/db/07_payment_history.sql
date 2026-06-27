-- ============================================================
-- Zapper — Seed: Payment Attempts  (FIXED — public schema)
-- Table already created in 01_schema.sql
-- Run AFTER 04_seed_disconnect.sql
-- ============================================================

-- ── Failed payments driving active disconnect requests ────────────────────

INSERT INTO payment_attempts (disconnect_request_id, attempt_date, amount_gbp, payment_method, payment_status, reference, failure_reason) VALUES
-- ZAP-REQ-700001 (BrightSpark, £720 arrears)
('ZAP-REQ-700001','2026-04-10 09:15:00+00',720.00,'direct_debit','failed','DD-2026-041001','Insufficient funds — account balance £12.44'),
('ZAP-REQ-700001','2026-04-24 09:00:00+00',720.00,'direct_debit','failed','DD-2026-042401','Direct debit instruction cancelled by bank'),
('ZAP-REQ-700001','2026-05-08 14:30:00+00',360.00,'card',        'failed','CARD-5588-0508','Card declined — issuer declined transaction'),

-- ZAP-REQ-700002 (NorthGrid, £1,240 arrears)
('ZAP-REQ-700002','2026-03-15 09:00:00+00',1240.00,'direct_debit','failed','DD-2026-031502','Refer to payer — account closed'),
('ZAP-REQ-700002','2026-04-15 09:00:00+00', 620.00,'direct_debit','failed','DD-2026-041502','Insufficient funds'),

-- ZAP-REQ-700003 (ClearVolt, £455 arrears)
('ZAP-REQ-700003','2026-04-02 10:00:00+00',455.00,'cheque',       'failed','CHQ-00447821',  'Cheque returned unpaid — refer to drawer'),
('ZAP-REQ-700003','2026-04-20 11:30:00+00',455.00,'card',         'failed','CARD-3312-0420','Card declined — insufficient credit'),

-- ZAP-REQ-700004 (ArcLight, £2,800 arrears — large commercial)
('ZAP-REQ-700004','2026-02-01 09:00:00+00',2800.00,'bank_transfer','failed','BACS-20260201-04','Payment returned — beneficiary account details incorrect'),
('ZAP-REQ-700004','2026-02-28 09:00:00+00',2800.00,'bank_transfer','failed','BACS-20260228-04','Payment recalled by originator'),
('ZAP-REQ-700004','2026-03-31 09:00:00+00',1400.00,'direct_debit', 'failed','DD-2026-033104', 'Refer to payer — account frozen'),
('ZAP-REQ-700004','2026-04-30 09:00:00+00',1400.00,'card',         'failed','CARD-7741-0430', 'Do not honour — bank refused transaction'),

-- ZAP-REQ-700005 (Kinetic, £880 arrears)
('ZAP-REQ-700005','2026-03-20 09:00:00+00',880.00,'direct_debit','failed','DD-2026-032005','Instruction cancelled — bank mandate lapsed'),
('ZAP-REQ-700005','2026-04-20 09:00:00+00',880.00,'direct_debit','failed','DD-2026-042005','Insufficient funds'),
('ZAP-REQ-700005','2026-05-10 13:45:00+00',440.00,'card',         'failed','CARD-2209-0510','Card expired'),

-- ZAP-REQ-700006 (TerraWatt, £620 arrears)
('ZAP-REQ-700006','2026-04-05 09:00:00+00',620.00,'direct_debit','failed','DD-2026-040506','Insufficient funds'),
('ZAP-REQ-700006','2026-05-05 09:00:00+00',620.00,'direct_debit','failed','DD-2026-050506','Account closed — mandate invalid'),

-- ZAP-REQ-700007 (Meridian, £310 arrears)
('ZAP-REQ-700007','2026-05-01 10:00:00+00',310.00,'cash','failed','CASH-REF-07-001','Payment office closed — cheque not received'),
('ZAP-REQ-700007','2026-05-15 10:00:00+00',155.00,'card','failed','CARD-9901-0515', 'Transaction declined by issuer'),

-- ZAP-REQ-700008 (Apex, £1,560 arrears)
('ZAP-REQ-700008','2026-03-10 09:00:00+00',1560.00,'bank_transfer','failed','BACS-20260310-08','Sort code/account number mismatch'),
('ZAP-REQ-700008','2026-04-10 09:00:00+00', 780.00,'direct_debit', 'failed','DD-2026-041008',  'Insufficient funds'),
('ZAP-REQ-700008','2026-05-10 14:00:00+00', 780.00,'direct_debit', 'failed','DD-2026-051008',  'Refer to payer'),

-- ZAP-REQ-700010 (Zenith, £490 arrears)
('ZAP-REQ-700010','2026-04-18 09:00:00+00',490.00,'direct_debit','failed','DD-2026-041810','Instruction not held — new DD needed'),
('ZAP-REQ-700010','2026-05-18 09:00:00+00',490.00,'direct_debit','failed','DD-2026-051810','Insufficient funds'),

-- ZAP-REQ-800001 (pending)
('ZAP-REQ-800001','2026-05-01 09:00:00+00',340.00,'direct_debit','failed', 'DD-2026-050138','Insufficient funds'),
('ZAP-REQ-800001','2026-05-31 09:00:00+00',340.00,'direct_debit','pending','DD-2026-053138', NULL),

-- ZAP-REQ-800002
('ZAP-REQ-800002','2026-04-05 09:00:00+00',1080.00,'bank_transfer','failed','BACS-20260405-39','Payment returned — account dormant'),
('ZAP-REQ-800002','2026-05-05 09:00:00+00', 540.00,'card',         'failed','CARD-4453-0505',  'Stolen card reported — transaction blocked'),

-- ZAP-REQ-100001 (historic failures)
('ZAP-REQ-100001','2026-04-15 09:00:00+00',920.00,'direct_debit','failed','DD-2026-041510','Insufficient funds'),
('ZAP-REQ-100001','2026-05-15 09:00:00+00',460.00,'direct_debit','failed','DD-2026-051510','Account closed'),

-- ZAP-REQ-200001
('ZAP-REQ-200001','2026-05-12 09:00:00+00',680.00,'direct_debit','failed','DD-2026-051205','Insufficient funds'),
('ZAP-REQ-200001','2026-05-26 14:00:00+00',340.00,'card',         'failed','CARD-6620-0526', 'Card declined — limit exceeded');

-- ── Cleared payments (customers who paid — request cancelled) ─────────────

INSERT INTO payment_attempts (disconnect_request_id, attempt_date, amount_gbp, payment_method, payment_status, reference, failure_reason) VALUES
-- ZAP-REQ-999001 (WaveGrid paid £750)
('ZAP-REQ-999001','2026-05-10 09:00:00+00',750.00,'direct_debit', 'failed', 'DD-2026-051049','Insufficient funds'),
('ZAP-REQ-999001','2026-05-30 11:22:00+00',750.00,'bank_transfer','cleared','BACS-20260530-99',NULL),

-- ZAP-REQ-999002 (TitanWatt paid £250 in two instalments)
('ZAP-REQ-999002','2026-05-20 09:00:00+00',150.00,'card','cleared','CARD-1102-0520',NULL),
('ZAP-REQ-999002','2026-06-01 10:45:00+00',100.00,'card','cleared','CARD-1102-0601',NULL);
