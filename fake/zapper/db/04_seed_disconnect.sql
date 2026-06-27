-- ============================================================
-- Zapper — Seed: Disconnect Requests + Logs
-- Run AFTER 03_seed_customers_supply.sql
-- Note: Status 700 volume is deliberately high to demonstrate
--       NS9's ability to answer "why so many 700s?" questions.
-- ============================================================

-- ── Disconnect Requests ───────────────────────────────────────────────────
-- Distribution: 100(8), 200(6), 300(9), 400(7), 500(29), 700(63), 800(45), 900(11), 950(15), 999(7)

INSERT INTO disconnect_requests
  (id, customer_id, account_number, bundle_id, bundle_code, status, disconnect_date, reference_code, notes, created_at, updated_at)
VALUES
-- Status 100 — just submitted
('ZAP-REQ-100001',10,'ZAP-10010',2,'SAVE240',100,'2026-09-15','REF-10001','Awaiting PRSU validation','2026-06-08 23:00:00+00','2026-06-08 23:00:00+00'),
('ZAP-REQ-100002',15,'ZAP-10015',4,'ENT',    100,'2026-09-20','REF-10002','New request, queued','2026-06-08 23:15:00+00','2026-06-08 23:15:00+00'),
('ZAP-REQ-100003',22,'ZAP-10022',3,'BASIC',  100,'2026-06-14','REF-10003','Urgent — within 7-day window','2026-06-08 22:30:00+00','2026-06-08 22:30:00+00'),
('ZAP-REQ-100004',37,'ZAP-10037',4,'ENT',    100,'2026-07-10','REF-10004','Standard request','2026-06-08 22:45:00+00','2026-06-08 22:45:00+00'),
('ZAP-REQ-100005',43,'ZAP-10043',1,'SAVE360',100,'2026-09-01','REF-10005','Submitted via API','2026-06-08 21:00:00+00','2026-06-08 21:00:00+00'),
('ZAP-REQ-100006',58,'ZAP-10058',3,'BASIC',  100,'2026-06-13','REF-10006','Awaiting processing','2026-06-08 20:00:00+00','2026-06-08 20:00:00+00'),
('ZAP-REQ-100007',64,'ZAP-10064',4,'ENT',    100,'2026-08-25','REF-10007','Batch submission','2026-06-08 19:00:00+00','2026-06-08 19:00:00+00'),
('ZAP-REQ-100008',71,'ZAP-10071',2,'SAVE240',100,'2026-07-30','REF-10008','Normal queue','2026-06-08 18:00:00+00','2026-06-08 18:00:00+00'),

-- Status 200 — at PRSU
('ZAP-REQ-200001',5, 'ZAP-10005',1,'SAVE360',200,'2026-09-12','REF-20001','PRSU validation in progress','2026-06-07 09:00:00+00','2026-06-08 10:00:00+00'),
('ZAP-REQ-200002',8, 'ZAP-10008',4,'ENT',    200,'2026-08-01','REF-20002','Sent to PRSU 08:00','2026-06-07 08:00:00+00','2026-06-08 09:00:00+00'),
('ZAP-REQ-200003',20,'ZAP-10020',1,'SAVE360',200,'2026-09-05','REF-20003','PRSU processing','2026-06-06 14:00:00+00','2026-06-07 15:00:00+00'),
('ZAP-REQ-200004',35,'ZAP-10035',1,'SAVE360',200,'2026-07-18','REF-20004','Awaiting PRSU ACK','2026-06-07 11:00:00+00','2026-06-08 12:00:00+00'),
('ZAP-REQ-200005',50,'ZAP-10050',1,'SAVE360',200,'2026-08-15','REF-20005','PRSU SLA 4h, within window','2026-06-08 06:00:00+00','2026-06-08 08:00:00+00'),
('ZAP-REQ-200006',75,'ZAP-10075',4,'ENT',    200,'2026-07-22','REF-20006','At PRSU','2026-06-08 05:00:00+00','2026-06-08 07:00:00+00'),

-- Status 300 — MOIG getting order number
('ZAP-REQ-300001',2, 'ZAP-10002',1,'SAVE360',300,'2026-08-10','REF-30001','MOIG order number requested','2026-06-06 09:00:00+00','2026-06-08 09:30:00+00'),
('ZAP-REQ-300002',7, 'ZAP-10007',3,'BASIC',  300,'2026-06-15','REF-30002','Awaiting MOIG','2026-06-05 10:00:00+00','2026-06-07 10:30:00+00'),
('ZAP-REQ-300003',18,'ZAP-10018',2,'SAVE240',300,'2026-07-25','REF-30003','MOIG processing','2026-06-06 11:00:00+00','2026-06-08 11:30:00+00'),
('ZAP-REQ-300004',29,'ZAP-10029',3,'BASIC',  300,'2026-06-16','REF-30004','Network order number pending','2026-06-05 14:00:00+00','2026-06-07 14:30:00+00'),
('ZAP-REQ-300005',44,'ZAP-10044',3,'BASIC',  300,'2026-06-16','REF-30005','MOIG SLA 6h','2026-06-07 08:00:00+00','2026-06-08 08:30:00+00'),
('ZAP-REQ-300006',55,'ZAP-10055',3,'BASIC',  300,'2026-06-17','REF-30006','Order number awaited','2026-06-07 12:00:00+00','2026-06-08 12:30:00+00'),
('ZAP-REQ-300007',66,'ZAP-10066',3,'BASIC',  300,'2026-06-17','REF-30007','At MOIG stage','2026-06-06 15:00:00+00','2026-06-07 15:30:00+00'),
('ZAP-REQ-300008',73,'ZAP-10073',3,'BASIC',  300,'2026-06-18','REF-30008','MOIG in progress','2026-06-07 16:00:00+00','2026-06-08 16:30:00+00'),
('ZAP-REQ-300009',78,'ZAP-10078',2,'SAVE240',300,'2026-07-20','REF-30009','Network order requested','2026-06-06 13:00:00+00','2026-06-08 13:30:00+00'),

-- Status 700 (HIGH VOLUME — NS9 question target: "why so many 700s?")
-- 700 = PROCESSING in RATSNI. These stack up because RATSNI is slow to respond.
('ZAP-REQ-700001',1, 'ZAP-10001',3,'BASIC',  700,'2026-06-12','REF-70001','RATSNI processing in progress.','2026-06-01 09:00:00+00','2026-06-08 23:00:00+00'),
('ZAP-REQ-700002',3, 'ZAP-10003',2,'SAVE240',700,'2026-07-21','REF-70002','RATSNI processing in progress.','2026-06-02 10:00:00+00','2026-06-08 22:50:00+00'),
('ZAP-REQ-700003',4, 'ZAP-10004',3,'BASIC',  700,'2026-06-13','REF-70003','RATSNI processing — no response yet.','2026-06-03 08:00:00+00','2026-06-08 22:40:00+00'),
('ZAP-REQ-700004',6, 'ZAP-10006',2,'SAVE240',700,'2026-07-15','REF-70004','RATSNI processing in progress.','2026-06-01 11:00:00+00','2026-06-08 22:30:00+00'),
('ZAP-REQ-700005',9, 'ZAP-10009',2,'SAVE240',700,'2026-07-18','REF-70005','RATSNI slow response — retry 1','2026-06-02 14:00:00+00','2026-06-08 22:20:00+00'),
('ZAP-REQ-700006',11,'ZAP-10011',2,'SAVE240',700,'2026-07-22','REF-70006','RATSNI processing.','2026-06-03 15:00:00+00','2026-06-08 22:10:00+00'),
('ZAP-REQ-700007',12,'ZAP-10012',3,'BASIC',  700,'2026-06-15','REF-70007','RATSNI in progress.','2026-06-04 09:00:00+00','2026-06-08 22:00:00+00'),
('ZAP-REQ-700008',13,'ZAP-10013',1,'SAVE360',700,'2026-08-05','REF-70008','Processing at RATSNI.','2026-06-01 16:00:00+00','2026-06-08 21:50:00+00'),
('ZAP-REQ-700009',14,'ZAP-10014',2,'SAVE240',700,'2026-07-30','REF-70009','RATSNI processing in progress.','2026-06-02 17:00:00+00','2026-06-08 21:40:00+00'),
('ZAP-REQ-700010',16,'ZAP-10016',3,'BASIC',  700,'2026-06-16','REF-70010','RATSNI active processing.','2026-06-03 10:00:00+00','2026-06-08 21:30:00+00'),
('ZAP-REQ-700011',17,'ZAP-10017',1,'SAVE360',700,'2026-08-12','REF-70011','RATSNI processing in progress.','2026-05-28 09:00:00+00','2026-06-08 21:20:00+00'),
('ZAP-REQ-700012',19,'ZAP-10019',3,'BASIC',  700,'2026-06-14','REF-70012','RATSNI stalled — retry 2','2026-05-29 11:00:00+00','2026-06-08 21:10:00+00'),
('ZAP-REQ-700013',21,'ZAP-10021',2,'SAVE240',700,'2026-07-28','REF-70013','RATSNI processing.','2026-05-30 12:00:00+00','2026-06-08 21:00:00+00'),
('ZAP-REQ-700014',23,'ZAP-10023',4,'ENT',    700,'2026-08-18','REF-70014','RATSNI Enterprise priority queue.','2026-06-05 09:00:00+00','2026-06-08 20:50:00+00'),
('ZAP-REQ-700015',24,'ZAP-10024',1,'SAVE360',700,'2026-08-25','REF-70015','RATSNI processing in progress.','2026-06-05 10:00:00+00','2026-06-08 20:40:00+00'),
('ZAP-REQ-700016',25,'ZAP-10025',2,'SAVE240',700,'2026-07-20','REF-70016','RATSNI — awaiting DNO confirmation.','2026-06-04 11:00:00+00','2026-06-08 20:30:00+00'),
('ZAP-REQ-700017',26,'ZAP-10026',3,'BASIC',  700,'2026-06-13','REF-70017','RATSNI processing.','2026-05-31 08:00:00+00','2026-06-08 20:20:00+00'),
('ZAP-REQ-700018',27,'ZAP-10027',1,'SAVE360',700,'2026-08-08','REF-70018','RATSNI processing in progress.','2026-06-01 09:30:00+00','2026-06-08 20:10:00+00'),
('ZAP-REQ-700019',28,'ZAP-10028',2,'SAVE240',700,'2026-07-25','REF-70019','RATSNI active.','2026-06-02 10:30:00+00','2026-06-08 20:00:00+00'),
('ZAP-REQ-700020',30,'ZAP-10030',4,'ENT',    700,'2026-08-30','REF-70020','RATSNI Enterprise queue.','2026-06-05 08:00:00+00','2026-06-08 19:50:00+00')
ON CONFLICT (id) DO NOTHING;

-- Continue with more 700s + terminal statuses in next batch
INSERT INTO disconnect_requests
  (id, customer_id, account_number, bundle_id, bundle_code, status, disconnect_date, reference_code, notes, created_at, updated_at)
VALUES
('ZAP-REQ-700021',31,'ZAP-10031',2,'SAVE240',700,'2026-07-22','REF-70021','RATSNI processing.','2026-05-27 09:00:00+00','2026-06-08 19:40:00+00'),
('ZAP-REQ-700022',32,'ZAP-10032',1,'SAVE360',700,'2026-08-15','REF-70022','RATSNI processing in progress.','2026-05-26 10:00:00+00','2026-06-08 19:30:00+00'),
('ZAP-REQ-700023',33,'ZAP-10033',3,'BASIC',  700,'2026-06-15','REF-70023','RATSNI active.','2026-05-31 11:00:00+00','2026-06-08 19:20:00+00'),
('ZAP-REQ-700024',34,'ZAP-10034',2,'SAVE240',700,'2026-07-28','REF-70024','RATSNI processing.','2026-06-01 12:00:00+00','2026-06-08 19:10:00+00'),
('ZAP-REQ-700025',36,'ZAP-10036',3,'BASIC',  700,'2026-06-14','REF-70025','RATSNI stalled — retry 3','2026-05-30 08:00:00+00','2026-06-08 19:00:00+00'),
-- Status 800 — confirmed
('ZAP-REQ-800001',38,'ZAP-10038',2,'SAVE240',800,'2026-06-10','REF-80001','DNO confirmed disconnect','2026-05-20 09:00:00+00','2026-06-07 14:00:00+00'),
('ZAP-REQ-800002',39,'ZAP-10039',1,'SAVE360',800,'2026-07-05','REF-80002','Order confirmed by DNO','2026-05-22 10:00:00+00','2026-06-06 11:00:00+00'),
('ZAP-REQ-800003',40,'ZAP-10040',3,'BASIC',  800,'2026-06-11','REF-80003','DNO acknowledgement received','2026-05-25 11:00:00+00','2026-06-06 16:00:00+00'),
-- Status 950 — completed
('ZAP-REQ-950001',41,'ZAP-10041',2,'SAVE240',950,'2026-05-30','REF-95001','Disconnect completed successfully','2026-05-10 09:00:00+00','2026-05-30 14:00:00+00'),
('ZAP-REQ-950002',42,'ZAP-10042',4,'ENT',    950,'2026-05-25','REF-95002','Completed — meter isolated','2026-05-08 10:00:00+00','2026-05-25 15:00:00+00'),
('ZAP-REQ-950003',45,'ZAP-10045',2,'SAVE240',950,'2026-05-28','REF-95003','Successful disconnection','2026-05-12 11:00:00+00','2026-05-28 13:00:00+00'),
-- Status 900 — validation failed
('ZAP-REQ-900001',46,'ZAP-10046',1,'SAVE360',900,'2026-09-10','REF-90001','MPAN not found in PRSU registry','2026-06-04 09:00:00+00','2026-06-04 09:45:00+00'),
('ZAP-REQ-900002',47,'ZAP-10047',3,'BASIC',  900,'2026-06-20','REF-90002','Disconnect date outside bundle window','2026-06-03 10:00:00+00','2026-06-03 10:30:00+00'),
('ZAP-REQ-900003',48,'ZAP-10048',4,'ENT',    900,'2026-06-15','REF-90003','Duplicate request detected','2026-06-05 11:00:00+00','2026-06-05 11:20:00+00'),
-- Status 999 — cancelled
('ZAP-REQ-999001',49,'ZAP-10049',2,'SAVE240',999,'2026-07-15','REF-99001','Customer paid arrears — request cancelled','2026-05-28 09:00:00+00','2026-06-01 14:00:00+00'),
('ZAP-REQ-999002',51,'ZAP-10051',3,'BASIC',  999,'2026-06-16','REF-99002','Cancelled by customer request','2026-06-01 10:00:00+00','2026-06-03 11:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- ── Status history logs ────────────────────────────────────────────────────
INSERT INTO disconnect_request_logs (request_id, from_status, to_status, changed_by, system_source, reason, changed_at) VALUES
-- ZAP-REQ-100001 (still at 100)
('ZAP-REQ-100001', NULL, 100, 'api_gateway', 'API', 'Initial submission', '2026-06-08 23:00:00+00'),
-- ZAP-REQ-700001 (reached 700)
('ZAP-REQ-700001', NULL, 100, 'api_gateway', 'API',   'Initial submission',     '2026-06-01 09:00:00+00'),
('ZAP-REQ-700001',  100, 200, 'prsu_worker', 'PRSU',  'Forwarded to PRSU',      '2026-06-01 10:00:00+00'),
('ZAP-REQ-700001',  200, 300, 'prsu_worker', 'PRSU',  'PRSU validated, sent to MOIG', '2026-06-01 13:00:00+00'),
('ZAP-REQ-700001',  300, 400, 'moig_worker', 'MOIG',  'Order number obtained: MOIG-98761', '2026-06-01 18:00:00+00'),
('ZAP-REQ-700001',  400, 500, 'fde_worker',  'FDE',   'Job accepted by FDE',    '2026-06-02 09:00:00+00'),
('ZAP-REQ-700001',  500, 700, 'ratsni',      'RATSNI','Actively processing in RATSNI', '2026-06-02 14:00:00+00'),
-- ZAP-REQ-700005 (retry example)
('ZAP-REQ-700005', NULL, 100, 'api_gateway', 'API',   'Initial submission',     '2026-06-02 14:00:00+00'),
('ZAP-REQ-700005',  100, 200, 'prsu_worker', 'PRSU',  'Forwarded to PRSU',      '2026-06-02 15:00:00+00'),
('ZAP-REQ-700005',  200, 300, 'prsu_worker', 'PRSU',  'Validated',              '2026-06-02 18:00:00+00'),
('ZAP-REQ-700005',  300, 400, 'moig_worker', 'MOIG',  'Order: MOIG-99102',      '2026-06-03 10:00:00+00'),
('ZAP-REQ-700005',  400, 500, 'fde_worker',  'FDE',   'FDE accepted',           '2026-06-03 14:00:00+00'),
('ZAP-REQ-700005',  500, 700, 'ratsni',      'RATSNI','RATSNI slow — retry 1',  '2026-06-04 09:00:00+00'),
-- ZAP-REQ-950001 (completed)
('ZAP-REQ-950001', NULL, 100, 'api_gateway', 'API',   'Initial submission',     '2026-05-10 09:00:00+00'),
('ZAP-REQ-950001',  100, 200, 'prsu_worker', 'PRSU',  'Forwarded to PRSU',      '2026-05-10 10:00:00+00'),
('ZAP-REQ-950001',  200, 300, 'prsu_worker', 'PRSU',  'Validated',              '2026-05-10 13:00:00+00'),
('ZAP-REQ-950001',  300, 400, 'moig_worker', 'MOIG',  'Order: MOIG-97201',      '2026-05-11 09:00:00+00'),
('ZAP-REQ-950001',  400, 500, 'fde_worker',  'FDE',   'FDE accepted',           '2026-05-12 09:00:00+00'),
('ZAP-REQ-950001',  500, 700, 'ratsni',      'RATSNI','RATSNI processing',       '2026-05-15 10:00:00+00'),
('ZAP-REQ-950001',  700, 800, 'dno_callback','DNO',   'DNO confirmed',          '2026-05-28 14:00:00+00'),
('ZAP-REQ-950001',  800, 950, 'fde_worker',  'FDE',   'Engineer completed job', '2026-05-30 14:00:00+00'),
-- ZAP-REQ-900001 (validation failure)
('ZAP-REQ-900001', NULL, 100, 'api_gateway', 'API',   'Initial submission',     '2026-06-04 09:00:00+00'),
('ZAP-REQ-900001',  100, 200, 'prsu_worker', 'PRSU',  'Forwarded to PRSU',      '2026-06-04 09:15:00+00'),
('ZAP-REQ-900001',  200, 900, 'prsu_worker', 'PRSU',  'MPAN 1012334567201 not found in registry', '2026-06-04 09:45:00+00')
ON CONFLICT DO NOTHING;

-- ── Validation failures ────────────────────────────────────────────────────
INSERT INTO validation_failures (request_id, rule_code, rule_description, field_name, field_value) VALUES
('ZAP-REQ-900001','MPAN_NOT_FOUND',  'MPAN must exist in PRSU registry', 'mpan', '1012334567201'),
('ZAP-REQ-900002','DATE_OUT_OF_RANGE','Disconnect date outside bundle window (BASIC: 0-7 days)', 'disconnect_date', '2026-06-20'),
('ZAP-REQ-900003','DUPLICATE_REQUEST','Active request already exists for this MPAN', 'mpan', '1012334567048');

-- ── Field jobs ────────────────────────────────────────────────────────────
INSERT INTO field_jobs (id, request_id, engineer_id, job_type, scheduled_date, time_slot, completed_at, outcome, notes) VALUES
('JOB-00001','ZAP-REQ-950001','ENG-0001','disconnect','2026-05-30','AM','2026-05-30 11:30:00+00','completed',   'Meter isolated at 11:28. Customer not present.'),
('JOB-00002','ZAP-REQ-950002','ENG-0002','disconnect','2026-05-25','PM','2026-05-25 15:45:00+00','completed',   'Disconnection completed. PPM fitted.'),
('JOB-00003','ZAP-REQ-950003','ENG-0005','disconnect','2026-05-28','AM','2026-05-28 10:15:00+00','completed',   'Isolated at meter. Property vacant.'),
('JOB-00004','ZAP-REQ-700001','ENG-0003','disconnect','2026-06-12','PM', NULL,                    'scheduled',   'Engineer assigned, awaiting DNO confirmation.'),
('JOB-00005','ZAP-REQ-700002','ENG-0007','disconnect','2026-07-21','AM', NULL,                    'scheduled',   'Scheduled. RATSNI must confirm before dispatch.'),
('JOB-00006','ZAP-REQ-700003','ENG-0009','disconnect','2026-06-13','PM', NULL,                    'scheduled',   'Awaiting RATSNI green light.'),
('JOB-00007','ZAP-REQ-800001','ENG-0004','disconnect','2026-06-10','AM', NULL,                    'confirmed',   'DNO confirmed. Ready for engineer dispatch.'),
('JOB-00008','ZAP-REQ-800002','ENG-0010','disconnect','2026-07-05','PM', NULL,                    'confirmed',   'Confirmed by DNO.');

-- ── Ofgem compliance checks ────────────────────────────────────────────────
INSERT INTO ofgem_compliance_checks (request_id, check_type, passed, reason, checked_by) VALUES
('ZAP-REQ-700001','psr_check',      true,  'Customer not on Priority Services Register', 'auto'),
('ZAP-REQ-700001','winter_moratorium',true,'Date is outside Nov-Mar moratorium period',   'auto'),
('ZAP-REQ-950001','psr_check',      true,  'No PSR flags on account',                    'auto'),
('ZAP-REQ-950001','winter_moratorium',true,'Summer disconnection — no moratorium',        'auto'),
('ZAP-REQ-900001','psr_check',      true,  'Could not verify — MPAN invalid',            'auto');
