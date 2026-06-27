-- ============================================================
-- Zapper — Seed: Meter Readings  (FIXED — public schema)
-- All in public schema — table already created in 01_schema.sql
-- Run AFTER 04_seed_disconnect.sql
-- ============================================================

INSERT INTO meter_readings (supply_point_id, reading_date, reading_kwh, reading_type, submitted_by) VALUES
-- SP-00001 (BrightSpark — active ZAP-REQ-700001, escalating usage)
('SP-00001','2025-12-15',12450.234,'actual',   'engineer:ENG-0001'),
('SP-00001','2026-01-16',12722.817,'estimated','system:prsu_estimator'),
('SP-00001','2026-02-14',13018.542,'actual',   'engineer:ENG-0005'),
('SP-00001','2026-03-17',13389.104,'estimated','system:prsu_estimator'),
('SP-00001','2026-04-15',13798.671,'customer', 'portal:ZAP-10001'),
('SP-00001','2026-05-16',14301.228,'actual',   'engineer:ENG-0001'),

-- SP-00002 (BrightSpark second supply point — normal usage)
('SP-00002','2025-12-20', 8210.500,'actual',   'engineer:ENG-0005'),
('SP-00002','2026-01-21', 8418.330,'estimated','system:prsu_estimator'),
('SP-00002','2026-02-19', 8624.780,'actual',   'engineer:ENG-0009'),
('SP-00002','2026-03-22', 8810.115,'customer', 'portal:ZAP-10001'),
('SP-00002','2026-04-20', 8988.440,'estimated','system:prsu_estimator'),
('SP-00002','2026-05-19', 9155.620,'actual',   'engineer:ENG-0005'),

-- SP-00003 (GreenWave — traditional meter, estimated reads common)
('SP-00003','2025-12-10',22100.000,'actual',   'engineer:ENG-0002'),
('SP-00003','2026-01-10',22410.000,'estimated','system:prsu_estimator'),
('SP-00003','2026-02-10',22730.000,'estimated','system:prsu_estimator'),
('SP-00003','2026-03-10',23055.000,'actual',   'engineer:ENG-0002'),
('SP-00003','2026-04-10',23310.000,'estimated','system:prsu_estimator'),
('SP-00003','2026-05-10',23594.000,'customer', 'portal:ZAP-10002'),

-- SP-00004 (GreenWave — prepayment, vulnerable, ZAP-REQ-700 target)
('SP-00004','2025-12-05', 4120.875,'actual',   'engineer:ENG-0002'),
('SP-00004','2026-01-06', 4298.110,'estimated','system:prsu_estimator'),
('SP-00004','2026-02-05', 4501.445,'actual',   'engineer:ENG-0007'),
('SP-00004','2026-03-07', 4810.990,'estimated','system:prsu_estimator'),
('SP-00004','2026-04-06', 5188.334,'actual',   'engineer:ENG-0002'),
('SP-00004','2026-05-08', 5641.009,'actual',   'engineer:ENG-0007'),

-- SP-00005 (NorthGrid — smart meter, regular actuals)
('SP-00005','2026-01-03',18750.000,'actual',   'engineer:ENG-0001'),
('SP-00005','2026-02-03',19100.000,'actual',   'engineer:ENG-0001'),
('SP-00005','2026-03-03',19420.000,'actual',   'engineer:ENG-0005'),
('SP-00005','2026-04-03',19700.000,'actual',   'engineer:ENG-0005'),
('SP-00005','2026-05-03',19960.000,'actual',   'engineer:ENG-0009'),

-- SP-00006 (NorthGrid second supply point)
('SP-00006','2026-01-08', 6340.500,'customer', 'portal:ZAP-10003'),
('SP-00006','2026-02-09', 6530.100,'estimated','system:prsu_estimator'),
('SP-00006','2026-03-10', 6714.660,'actual',   'engineer:ENG-0001'),
('SP-00006','2026-04-11', 6880.220,'estimated','system:prsu_estimator'),
('SP-00006','2026-05-12', 7030.780,'customer', 'portal:ZAP-10003'),

-- SP-00007 (ClearVolt — traditional, vulnerable, ZAP-REQ-700003)
('SP-00007','2025-12-18', 9800.000,'actual',   'engineer:ENG-0003'),
('SP-00007','2026-01-20',10240.000,'estimated','system:prsu_estimator'),
('SP-00007','2026-02-18',10840.000,'estimated','system:prsu_estimator'),
('SP-00007','2026-03-19',11620.000,'actual',   'engineer:ENG-0003'),
('SP-00007','2026-04-20',12580.000,'estimated','system:prsu_estimator'),
('SP-00007','2026-05-22',13780.000,'actual',   'engineer:ENG-0009'),

-- SP-00008 (PureWatt — smart, normal usage)
('SP-00008','2026-01-15', 3300.000,'actual',   'engineer:ENG-0004'),
('SP-00008','2026-02-16', 3498.000,'actual',   'engineer:ENG-0004'),
('SP-00008','2026-03-15', 3680.000,'actual',   'engineer:ENG-0008'),
('SP-00008','2026-04-14', 3840.000,'customer', 'portal:ZAP-10005'),
('SP-00008','2026-05-15', 3984.000,'actual',   'engineer:ENG-0004'),

-- SP-00009 (PureWatt prepayment — intermittent reads)
('SP-00009','2026-01-10', 1150.000,'customer', 'portal:ZAP-10005'),
('SP-00009','2026-03-12', 1530.000,'customer', 'portal:ZAP-10005'),
('SP-00009','2026-05-10', 1990.000,'actual',   'engineer:ENG-0002'),

-- SP-00010 (ArcLight — smart, ZAP-REQ-700004, escalating)
('SP-00010','2025-12-22',15200.000,'actual',   'engineer:ENG-0010'),
('SP-00010','2026-01-23',15890.000,'estimated','system:prsu_estimator'),
('SP-00010','2026-02-22',16720.000,'actual',   'engineer:ENG-0010'),
('SP-00010','2026-03-24',17780.000,'estimated','system:prsu_estimator'),
('SP-00010','2026-04-23',19100.000,'actual',   'engineer:ENG-0010'),
('SP-00010','2026-05-24',20850.000,'actual',   'engineer:ENG-0010'),

-- SP-00011 (BluePeak — traditional, vulnerable, PSR)
('SP-00011','2026-01-05', 4900.000,'actual',   'engineer:ENG-0006'),
('SP-00011','2026-02-06', 5110.000,'estimated','system:prsu_estimator'),
('SP-00011','2026-03-05', 5290.000,'actual',   'engineer:ENG-0006'),
('SP-00011','2026-04-04', 5450.000,'customer', 'portal:ZAP-10007'),
('SP-00011','2026-05-06', 5620.000,'actual',   'engineer:ENG-0006'),

-- SP-00012 (VoltEdge — London smart, ZAP-REQ-200002)
('SP-00012','2026-01-20',29800.000,'actual',   'engineer:ENG-0008'),
('SP-00012','2026-02-21',30550.000,'actual',   'engineer:ENG-0008'),
('SP-00012','2026-03-22',31180.000,'actual',   'engineer:ENG-0008'),
('SP-00012','2026-04-21',31740.000,'estimated','system:prsu_estimator'),
('SP-00012','2026-05-20',32220.000,'actual',   'engineer:ENG-0008');
