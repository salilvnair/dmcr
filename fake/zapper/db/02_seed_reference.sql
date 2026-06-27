-- ============================================================
-- Zapper — Seed: Reference Data
-- Run AFTER 01_schema.sql
-- ============================================================

-- ── Bundles ───────────────────────────────────────────────────────────────
INSERT INTO bundles (id, code, name, description, max_disconnect_days, min_disconnect_days, sla_hours) VALUES
(1, 'SAVE360', 'Save360',  'Premium tier: disconnect ±30 days from today. 4hr SLA.',   30, -30, 4),
(2, 'SAVE240', 'Save240',  'Standard tier: disconnect ±60 days from today. 8hr SLA.',  60, -60, 8),
(3, 'BASIC',   'Basic',    'Entry tier: disconnect within 7 days. 24hr SLA.',           7,   0, 24),
(4, 'ENT',     'Enterprise','Enterprise: disconnect ±90 days. 2hr SLA. Priority queue.', 90, -90, 2)
ON CONFLICT (code) DO NOTHING;

-- ── Status codes ──────────────────────────────────────────────────────────
-- These are the status codes NS9 must understand to answer
-- "Why are there so many 700s?" type questions.
INSERT INTO disconnect_status_codes (code, label, description, system_owner, is_terminal, next_statuses, sla_hours) VALUES
(100, 'SUBMITTED',       'Disconnect request received and queued for processing',                   'API',    false, ARRAY[200, 900],      2),
(200, 'PRSU_SENT',       'Request forwarded to Pre-Registration Supply Unit for validation',        'PRSU',   false, ARRAY[300, 900],      4),
(300, 'MOIG_SENT',       'PRSU validated; forwarded to MOIG to obtain network order number',        'MOIG',   false, ARRAY[400, 900],      6),
(400, 'FDE_SENT',        'Order number received; forwarded to Field Disconnect Engine',             'FDE',    false, ARRAY[500, 900],      8),
(500, 'PPL_SENT',        'FDE accepted job; forwarded to Power Provider Liaison for scheduling',    'PPL',    false, ARRAY[700, 900],     12),
(700, 'PROCESSING',      'Actively processing in RATSNI (Real-time All-Territory Supply Network Intelligence). Engineer en route or on site.', 'RATSNI', false, ARRAY[800, 950, 999], 24),
(800, 'ORDER_CONFIRMED', 'Disconnect order confirmed by Distribution Network Operator',             'DNO',    false, ARRAY[950],           2),
(900, 'VALIDATION_FAILED','Request failed business validation rules. See validation_failures table.','PRSU',  true,  ARRAY[]::INTEGER[],   0),
(950, 'COMPLETED',       'Disconnection successfully completed. Meter physically isolated.',        'FDE',    true,  ARRAY[]::INTEGER[],   0),
(999, 'CANCELLED',       'Request cancelled by customer, agent, or compliance check.',              'API',    true,  ARRAY[]::INTEGER[],   0)
ON CONFLICT (code) DO NOTHING;

-- ── Field engineers ───────────────────────────────────────────────────────
INSERT INTO field_engineers (id, name, employee_number, dno_region, status, skills) VALUES
('ENG-0001', 'Marcus Webb',       'E10042', 'Northern DNO',     'available', ARRAY['disconnect','reconnect','smart_meter']),
('ENG-0002', 'Sarah Okafor',      'E10078', 'Western Power',    'available', ARRAY['disconnect','reconnect','prepayment']),
('ENG-0003', 'James Thornton',    'E10091', 'SP Energy',        'on_job',    ARRAY['disconnect','inspection']),
('ENG-0004', 'Priya Sharma',      'E10105', 'UK Power Networks', 'available', ARRAY['reconnect','smart_meter','prepayment']),
('ENG-0005', 'David Kowalski',    'E10118', 'Northern DNO',     'available', ARRAY['disconnect','reconnect']),
('ENG-0006', 'Amara Osei',        'E10130', 'Western Power',    'off_duty',  ARRAY['disconnect','inspection','smart_meter']),
('ENG-0007', 'Tom Harrison',      'E10144', 'SP Energy',        'available', ARRAY['disconnect','reconnect','prepayment']),
('ENG-0008', 'Nadia Volkov',      'E10157', 'UK Power Networks', 'on_job',   ARRAY['reconnect','smart_meter']),
('ENG-0009', 'Ben Cartwright',    'E10169', 'Northern DNO',     'available', ARRAY['disconnect','reconnect','inspection']),
('ENG-0010', 'Fatima Al-Rashid',  'E10182', 'Western Power',    'available', ARRAY['disconnect','reconnect','smart_meter','prepayment'])
ON CONFLICT (id) DO NOTHING;

-- ── Customers (80 electricity suppliers using Zapper) ─────────────────────
-- Truncated here — see 03_seed_customers.sql for full 80-customer insert
INSERT INTO customers (id, account_number, name, email, phone, bundle_id, bundle_code, company_reg, ofgem_licence, status) VALUES
(1,  'ZAP-10001', 'BrightSpark Energy Ltd',       'ops@brightspark.co.uk',    '+44 161 900 1001', 3, 'BASIC',   'BC123456', 'OE/2019/001', 'active'),
(2,  'ZAP-10002', 'GreenWave Power plc',           'team@greenwave.co.uk',     '+44 161 900 1002', 1, 'SAVE360', 'GW234567', 'OE/2019/002', 'active'),
(3,  'ZAP-10003', 'NorthGrid Solutions',           'admin@northgrid.co.uk',    '+44 161 900 1003', 2, 'SAVE240', 'NG345678', 'OE/2020/003', 'active'),
(4,  'ZAP-10004', 'ClearVolt Energy',              'support@clearvolt.co.uk',  '+44 161 900 1004', 3, 'BASIC',   'CV456789', 'OE/2020/004', 'active'),
(5,  'ZAP-10005', 'PureWatt Electricity',          'info@purewatt.co.uk',      '+44 161 900 1005', 1, 'SAVE360', 'PW567890', 'OE/2020/005', 'active'),
(6,  'ZAP-10006', 'ArcLight Energy Services',      'ops@arclight.co.uk',       '+44 161 900 1006', 2, 'SAVE240', 'AL678901', 'OE/2021/006', 'active'),
(7,  'ZAP-10007', 'BluePeak Power Ltd',            'billing@bluepeak.co.uk',   '+44 161 900 1007', 3, 'BASIC',   'BP789012', 'OE/2021/007', 'active'),
(8,  'ZAP-10008', 'VoltEdge Utilities',            'admin@voltedge.co.uk',     '+44 161 900 1008', 4, 'ENT',     'VE890123', 'OE/2021/008', 'active'),
(9,  'ZAP-10009', 'Kinetic Energy UK',             'service@kinetic.co.uk',    '+44 161 900 1009', 2, 'SAVE240', 'KE901234', 'OE/2022/009', 'active'),
(10, 'ZAP-10010', 'SolarGrid Connections',         'ops@solargrid.co.uk',      '+44 161 900 1010', 1, 'SAVE360', 'SG012345', 'OE/2022/010', 'active')
ON CONFLICT (account_number) DO NOTHING;
