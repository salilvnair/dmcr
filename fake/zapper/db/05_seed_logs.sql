-- ============================================================
-- Zapper — Seed: API Request Logs
-- Generates realistic log patterns NS9 can analyse:
--   • High volume of /callbacks/ratsni at status 700
--   • Slow response times on RATSNI callbacks
--   • 400/422 spikes on validation failures
--   • Normal 200s on submit/status
-- Run AFTER 04_seed_disconnect.sql
-- ============================================================

-- helper function to generate timestamps within a range
-- (removed; we use explicit timestamps below)

-- ── Last 24 hrs — heavy RATSNI callback traffic (explains "so many 700s") ──
INSERT INTO api_request_logs
  (endpoint, method, request_id, correlation_id, customer_id, disconnect_req_id, status_code, response_time_ms, error_code, error_message, user_agent, ip_address, created_at)
VALUES
-- Status 700 callbacks incoming (RATSNI → Zapper webhook)
('/callbacks/ratsni/status',           'POST','RATSNI-CB-0001','CORR-A0001',1,'ZAP-REQ-700001',200, 142, NULL, NULL, 'RATSNI/2.1', '10.10.5.100', NOW() - INTERVAL '23 hours'),
('/callbacks/ratsni/status',           'POST','RATSNI-CB-0002','CORR-A0002',3,'ZAP-REQ-700002',200, 138, NULL, NULL, 'RATSNI/2.1', '10.10.5.100', NOW() - INTERVAL '22 hours 50 min'),
('/callbacks/ratsni/status',           'POST','RATSNI-CB-0003','CORR-A0003',4,'ZAP-REQ-700003',200, 155, NULL, NULL, 'RATSNI/2.1', '10.10.5.100', NOW() - INTERVAL '22 hours 40 min'),
('/callbacks/ratsni/status',           'POST','RATSNI-CB-0004','CORR-A0004',6,'ZAP-REQ-700004',200, 168, NULL, NULL, 'RATSNI/2.1', '10.10.5.100', NOW() - INTERVAL '22 hours 30 min'),
('/callbacks/ratsni/status',           'POST','RATSNI-CB-0005','CORR-A0005',9,'ZAP-REQ-700005',200, 172, NULL, NULL, 'RATSNI/2.1', '10.10.5.100', NOW() - INTERVAL '22 hours 20 min'),
('/callbacks/ratsni/status',           'POST','RATSNI-CB-0006','CORR-A0006',11,'ZAP-REQ-700006',200,145, NULL, NULL, 'RATSNI/2.1', '10.10.5.100', NOW() - INTERVAL '22 hours 10 min'),
('/callbacks/ratsni/status',           'POST','RATSNI-CB-0007','CORR-A0007',12,'ZAP-REQ-700007',200,189, NULL, NULL, 'RATSNI/2.1', '10.10.5.100', NOW() - INTERVAL '22 hours'),
('/callbacks/ratsni/status',           'POST','RATSNI-CB-0008','CORR-A0008',13,'ZAP-REQ-700008',200,203, NULL, NULL, 'RATSNI/2.1', '10.10.5.100', NOW() - INTERVAL '21 hours 50 min'),
('/callbacks/ratsni/status',           'POST','RATSNI-CB-0009','CORR-A0009',14,'ZAP-REQ-700009',200,178, NULL, NULL, 'RATSNI/2.1', '10.10.5.100', NOW() - INTERVAL '21 hours 40 min'),
('/callbacks/ratsni/status',           'POST','RATSNI-CB-0010','CORR-A0010',16,'ZAP-REQ-700010',200,165, NULL, NULL, 'RATSNI/2.1', '10.10.5.100', NOW() - INTERVAL '21 hours 30 min'),
-- RATSNI retries (slow + timeout pattern — same requests re-polled)
('/callbacks/ratsni/status',           'POST','RATSNI-CB-0011','CORR-A0011',9,'ZAP-REQ-700005', 504,8500,'RATSNI_TIMEOUT','RATSNI did not respond within 8s', 'RATSNI/2.1', '10.10.5.100', NOW() - INTERVAL '21 hours'),
('/callbacks/ratsni/status',           'POST','RATSNI-CB-0012','CORR-A0012',12,'ZAP-REQ-700007',504,9100,'RATSNI_TIMEOUT','RATSNI did not respond within 8s', 'RATSNI/2.1', '10.10.5.100', NOW() - INTERVAL '20 hours 45 min'),
('/callbacks/ratsni/status',           'POST','RATSNI-CB-0013','CORR-A0013',9,'ZAP-REQ-700005', 200, 210, NULL, NULL, 'RATSNI/2.1', '10.10.5.100', NOW() - INTERVAL '20 hours 30 min'),
('/callbacks/ratsni/status',           'POST','RATSNI-CB-0014','CORR-A0014',12,'ZAP-REQ-700007',200, 198, NULL, NULL, 'RATSNI/2.1', '10.10.5.100', NOW() - INTERVAL '20 hours 15 min'),
-- Status polls from customers checking on their 700s
('/disconnect/{id}/status',            'GET', 'STATUS-0001',   'CORR-B0001', 1,'ZAP-REQ-700001',200,  55, NULL, NULL, 'ZapperClient/3.0', '192.168.1.10', NOW() - INTERVAL '20 hours'),
('/disconnect/{id}/status',            'GET', 'STATUS-0002',   'CORR-B0002', 3,'ZAP-REQ-700002',200,  61, NULL, NULL, 'ZapperClient/3.0', '192.168.1.11', NOW() - INTERVAL '19 hours 50 min'),
('/disconnect/{id}/status',            'GET', 'STATUS-0003',   'CORR-B0003', 4,'ZAP-REQ-700003',200,  58, NULL, NULL, 'ZapperClient/3.0', '192.168.1.12', NOW() - INTERVAL '19 hours 40 min'),
('/disconnect/{id}/status',            'GET', 'STATUS-0004',   'CORR-B0004', 6,'ZAP-REQ-700004',200,  70, NULL, NULL, 'ZapperClient/3.0', '192.168.1.13', NOW() - INTERVAL '19 hours 30 min'),
('/disconnect/{id}/status',            'GET', 'STATUS-0005',   'CORR-B0005', 9,'ZAP-REQ-700005',200,  63, NULL, NULL, 'ZapperClient/3.0', '192.168.1.14', NOW() - INTERVAL '19 hours 20 min'),
-- Repeated status polls (customers anxious about 700 stuck)
('/disconnect/{id}/status',            'GET', 'STATUS-0006',   'CORR-B0006', 1,'ZAP-REQ-700001',200,  52, NULL, NULL, 'ZapperClient/3.0', '192.168.1.10', NOW() - INTERVAL '18 hours'),
('/disconnect/{id}/status',            'GET', 'STATUS-0007',   'CORR-B0007', 1,'ZAP-REQ-700001',200,  59, NULL, NULL, 'ZapperClient/3.0', '192.168.1.10', NOW() - INTERVAL '16 hours'),
('/disconnect/{id}/status',            'GET', 'STATUS-0008',   'CORR-B0008', 1,'ZAP-REQ-700001',200,  48, NULL, NULL, 'ZapperClient/3.0', '192.168.1.10', NOW() - INTERVAL '14 hours'),
('/disconnect/{id}/status',            'GET', 'STATUS-0009',   'CORR-B0009', 3,'ZAP-REQ-700002',200,  54, NULL, NULL, 'ZapperClient/3.0', '192.168.1.11', NOW() - INTERVAL '13 hours'),
('/disconnect/{id}/status',            'GET', 'STATUS-0010',   'CORR-B0010', 4,'ZAP-REQ-700003',200,  66, NULL, NULL, 'ZapperClient/3.0', '192.168.1.12', NOW() - INTERVAL '12 hours'),
-- New submissions (status 100 → enter queue)
('/disconnect',                        'POST','SUBMIT-0001',   'CORR-C0001',10, NULL,             201,  92, NULL, NULL, 'ZapperClient/3.0', '192.168.1.20', NOW() - INTERVAL '23 hours 30 min'),
('/disconnect',                        'POST','SUBMIT-0002',   'CORR-C0002',15, NULL,             201,  88, NULL, NULL, 'ZapperClient/3.0', '192.168.1.21', NOW() - INTERVAL '23 hours'),
('/disconnect',                        'POST','SUBMIT-0003',   'CORR-C0003',22, NULL,             201,  95, NULL, NULL, 'ZapperClient/3.0', '192.168.1.22', NOW() - INTERVAL '22 hours 30 min'),
('/disconnect',                        'POST','SUBMIT-0004',   'CORR-C0004',37, NULL,             201,  79, NULL, NULL, 'ZapperClient/3.0', '192.168.1.23', NOW() - INTERVAL '22 hours'),
('/disconnect',                        'POST','SUBMIT-0005',   'CORR-C0005',43, NULL,             201,  84, NULL, NULL, 'ZapperClient/3.0', '192.168.1.24', NOW() - INTERVAL '21 hours 30 min'),
-- Validation failures (400s)
('/disconnect',                        'POST','SUBMIT-FAIL-1', 'CORR-D0001',46, NULL,             422, 110,'VALIDATION_FAIL','MPAN 1012334567201 not in PRSU registry', 'ZapperClient/3.0', '192.168.1.30', NOW() - INTERVAL '20 hours'),
('/disconnect',                        'POST','SUBMIT-FAIL-2', 'CORR-D0002',47, NULL,             422, 108,'DATE_OUT_RANGE', 'Disconnect date outside bundle window', 'ZapperClient/3.0', '192.168.1.31', NOW() - INTERVAL '19 hours'),
('/disconnect',                        'POST','SUBMIT-FAIL-3', 'CORR-D0003',48, NULL,             409, 115,'DUPLICATE',      'Active request exists for MPAN', 'ZapperClient/3.0', '192.168.1.32', NOW() - INTERVAL '18 hours'),
-- PRSU callbacks
('/callbacks/prsu/validation',         'POST','PRSU-CB-0001',  'CORR-E0001', 5,'ZAP-REQ-200001', 200,  88, NULL, NULL, 'PRSU-Gateway/1.4', '10.10.6.50', NOW() - INTERVAL '22 hours'),
('/callbacks/prsu/validation',         'POST','PRSU-CB-0002',  'CORR-E0002', 8,'ZAP-REQ-200002', 200,  91, NULL, NULL, 'PRSU-Gateway/1.4', '10.10.6.50', NOW() - INTERVAL '21 hours'),
('/callbacks/prsu/validation',         'POST','PRSU-CB-0003',  'CORR-E0003',20,'ZAP-REQ-200003', 200,  97, NULL, NULL, 'PRSU-Gateway/1.4', '10.10.6.50', NOW() - INTERVAL '20 hours'),
-- DNO callbacks (status 800)
('/callbacks/dno/confirm',             'POST','DNO-CB-0001',   'CORR-F0001',38,'ZAP-REQ-800001', 200, 124, NULL, NULL, 'DNO-Connect/5.0', '10.10.7.22', NOW() - INTERVAL '10 hours'),
('/callbacks/dno/confirm',             'POST','DNO-CB-0002',   'CORR-F0002',39,'ZAP-REQ-800002', 200, 132, NULL, NULL, 'DNO-Connect/5.0', '10.10.7.22', NOW() - INTERVAL '9 hours'),
('/callbacks/dno/confirm',             'POST','DNO-CB-0003',   'CORR-F0003',40,'ZAP-REQ-800003', 200, 119, NULL, NULL, 'DNO-Connect/5.0', '10.10.7.22', NOW() - INTERVAL '8 hours'),
-- Health checks
('/health',                            'GET', NULL,            NULL,         NULL,NULL,            200,   8, NULL, NULL, 'k8s-probe/1.0', '10.0.0.1', NOW() - INTERVAL '23 hours'),
('/health',                            'GET', NULL,            NULL,         NULL,NULL,            200,   7, NULL, NULL, 'k8s-probe/1.0', '10.0.0.1', NOW() - INTERVAL '22 hours'),
('/health',                            'GET', NULL,            NULL,         NULL,NULL,            200,   6, NULL, NULL, 'k8s-probe/1.0', '10.0.0.1', NOW() - INTERVAL '21 hours'),
('/health',                            'GET', NULL,            NULL,         NULL,NULL,            200,   9, NULL, NULL, 'k8s-probe/1.0', '10.0.0.1', NOW() - INTERVAL '20 hours'),
('/health',                            'GET', NULL,            NULL,         NULL,NULL,            200,   8, NULL, NULL, 'k8s-probe/1.0', '10.0.0.1', NOW() - INTERVAL '19 hours'),
('/health',                            'GET', NULL,            NULL,         NULL,NULL,            200,   7, NULL, NULL, 'k8s-probe/1.0', '10.0.0.1', NOW() - INTERVAL '18 hours')
;

-- ── Past 7 days — general traffic pattern ────────────────────────────────
INSERT INTO api_request_logs
  (endpoint, method, request_id, correlation_id, customer_id, disconnect_req_id, status_code, response_time_ms, error_code, ip_address, created_at)
VALUES
-- Day -2 (busy RATSNI day)
('/callbacks/ratsni/status','POST','RATSNI-D2-001','CORR-G001',17,'ZAP-REQ-700011',200,155,NULL,'10.10.5.100', NOW() - INTERVAL '2 days'),
('/callbacks/ratsni/status','POST','RATSNI-D2-002','CORR-G002',19,'ZAP-REQ-700012',200,162,NULL,'10.10.5.100', NOW() - INTERVAL '2 days 1 hour'),
('/callbacks/ratsni/status','POST','RATSNI-D2-003','CORR-G003',21,'ZAP-REQ-700013',200,148,NULL,'10.10.5.100', NOW() - INTERVAL '2 days 2 hours'),
('/callbacks/ratsni/status','POST','RATSNI-D2-004','CORR-G004',23,'ZAP-REQ-700014',200,175,NULL,'10.10.5.100', NOW() - INTERVAL '2 days 3 hours'),
('/callbacks/ratsni/status','POST','RATSNI-D2-005','CORR-G005',24,'ZAP-REQ-700015',504,8900,'RATSNI_TIMEOUT','10.10.5.100', NOW() - INTERVAL '2 days 4 hours'),
('/callbacks/ratsni/status','POST','RATSNI-D2-006','CORR-G006',25,'ZAP-REQ-700016',200,183,NULL,'10.10.5.100', NOW() - INTERVAL '2 days 5 hours'),
('/callbacks/ratsni/status','POST','RATSNI-D2-007','CORR-G007',26,'ZAP-REQ-700017',200,190,NULL,'10.10.5.100', NOW() - INTERVAL '2 days 6 hours'),
('/callbacks/ratsni/status','POST','RATSNI-D2-008','CORR-G008',27,'ZAP-REQ-700018',200,167,NULL,'10.10.5.100', NOW() - INTERVAL '2 days 7 hours'),
('/callbacks/ratsni/status','POST','RATSNI-D2-009','CORR-G009',28,'ZAP-REQ-700019',504,9200,'RATSNI_TIMEOUT','10.10.5.100', NOW() - INTERVAL '2 days 8 hours'),
('/callbacks/ratsni/status','POST','RATSNI-D2-010','CORR-G010',30,'ZAP-REQ-700020',200,153,NULL,'10.10.5.100', NOW() - INTERVAL '2 days 9 hours'),
-- Day -3
('/disconnect',             'POST','SUBMIT-D3-001','CORR-H001',31, NULL,           201, 88,NULL,'192.168.1.40', NOW() - INTERVAL '3 days'),
('/disconnect',             'POST','SUBMIT-D3-002','CORR-H002',32, NULL,           201, 93,NULL,'192.168.1.41', NOW() - INTERVAL '3 days 2 hours'),
('/disconnect',             'POST','SUBMIT-D3-003','CORR-H003',33, NULL,           201, 79,NULL,'192.168.1.42', NOW() - INTERVAL '3 days 4 hours'),
('/disconnect/{id}/status', 'GET', 'STATUS-D3-001','CORR-H004',31,'ZAP-REQ-700021',200, 55,NULL,'192.168.1.40', NOW() - INTERVAL '3 days 6 hours'),
('/disconnect/{id}/status', 'GET', 'STATUS-D3-002','CORR-H005',32,'ZAP-REQ-700022',200, 61,NULL,'192.168.1.41', NOW() - INTERVAL '3 days 8 hours'),
-- Day -5 — completed requests
('/callbacks/dno/confirm',  'POST','DNO-D5-001',  'CORR-I001', 41,'ZAP-REQ-950001',200,128,NULL,'10.10.7.22', NOW() - INTERVAL '5 days'),
('/callbacks/dno/confirm',  'POST','DNO-D5-002',  'CORR-I002', 42,'ZAP-REQ-950002',200,135,NULL,'10.10.7.22', NOW() - INTERVAL '5 days 2 hours'),
('/disconnect/{id}/complete','POST','COMP-D5-001', 'CORR-I003', 41,'ZAP-REQ-950001',200, 98,NULL,'10.10.7.22', NOW() - INTERVAL '5 days 4 hours'),
('/disconnect/{id}/complete','POST','COMP-D5-002', 'CORR-I004', 42,'ZAP-REQ-950002',200,102,NULL,'10.10.7.22', NOW() - INTERVAL '5 days 6 hours'),
-- Day -7 — older submissions
('/disconnect',             'POST','SUBMIT-D7-001','CORR-J001', 34, NULL,           201, 87,NULL,'192.168.1.50', NOW() - INTERVAL '7 days'),
('/disconnect',             'POST','SUBMIT-D7-002','CORR-J002', 35, NULL,           201, 91,NULL,'192.168.1.51', NOW() - INTERVAL '7 days 2 hours'),
('/disconnect',             'POST','SUBMIT-D7-003','CORR-J003', 36, NULL,           201, 83,NULL,'192.168.1.52', NOW() - INTERVAL '7 days 4 hours'),
('/disconnect/{id}/cancel', 'POST','CANCEL-D7-001','CORR-J004', 49,'ZAP-REQ-999001',200, 74,NULL,'192.168.1.53', NOW() - INTERVAL '7 days 6 hours')
;

-- ── External system messages (key ones) ──────────────────────────────────
INSERT INTO external_system_messages
  (request_id, system_name, direction, message_type, response_code, retry_number, sent_at, received_at, is_timeout)
VALUES
('ZAP-REQ-700001','PRSU','outbound','VALIDATION_REQUEST','200',0, '2026-06-01 10:00:00+00','2026-06-01 10:05:00+00',false),
('ZAP-REQ-700001','MOIG','outbound','ORDER_NUMBER_REQUEST','200',0,'2026-06-01 13:00:00+00','2026-06-01 14:30:00+00',false),
('ZAP-REQ-700001','FDE', 'outbound','JOB_DISPATCH',       '202',0,'2026-06-01 18:00:00+00','2026-06-01 18:45:00+00',false),
('ZAP-REQ-700001','RATSNI','outbound','PROCESSING_REQUEST','200',0,'2026-06-02 14:00:00+00','2026-06-02 15:00:00+00',false),
('ZAP-REQ-700005','RATSNI','outbound','PROCESSING_REQUEST','504',1,'2026-06-04 09:00:00+00', NULL,                   true),
('ZAP-REQ-700005','RATSNI','outbound','PROCESSING_REQUEST','200',2,'2026-06-04 09:30:00+00','2026-06-04 09:45:00+00',false),
('ZAP-REQ-950001','RATSNI','outbound','PROCESSING_REQUEST','200',0,'2026-05-15 10:00:00+00','2026-05-15 11:00:00+00',false),
('ZAP-REQ-950001','DNO',  'inbound', 'DISCONNECT_CONFIRM','200',0,'2026-05-28 14:00:00+00','2026-05-28 14:05:00+00',false),
('ZAP-REQ-900001','PRSU', 'inbound', 'VALIDATION_FAILED', '422',0,'2026-06-04 09:45:00+00','2026-06-04 09:45:00+00',false);

-- ── Summary view useful for NS9 context (stored as a comment for docs) ────
-- SELECT status, count(*) FROM disconnect_requests GROUP BY status ORDER BY status;
-- Expected: 100→8, 200→6, 300→9, 400→7, 500→29, 700→25+, 800→3, 900→3, 950→3, 999→2
-- SELECT endpoint, count(*), avg(response_time_ms)::int, sum(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) errors
--   FROM api_request_logs GROUP BY endpoint ORDER BY count(*) DESC;
