# Demo infrastructure for the README GIF (not shipped): a throwaway PostgreSQL container with
# shop_test / shop_prod, and an empty DMCR Web home + git workspace under C:\dmcr-demo.
#   powershell -File scripts\demo-video\setup.ps1 up     create (or recreate) everything
#   powershell -File scripts\demo-video\setup.ps1 down   remove the container and C:\dmcr-demo
# Passwords are generated and kept in C:\dmcr-demo\passwords.json (outside the repository).
param([ValidateSet('up', 'down')][string]$Action = 'up')
$ErrorActionPreference = 'Stop'
$root = 'C:\dmcr-demo'; $name = 'dmcr-demo-pg'; $port = 5442
docker rm -f $name 2>$null | Out-Null
if (Test-Path $root) { Remove-Item -Recurse -Force $root }
if ($Action -eq 'down') { 'removed'; exit 0 }

function NewPw { -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 20 | ForEach-Object { [char]$_ }) }
$pw = @{ postgres = NewPw; test = NewPw; prod = NewPw }
New-Item -ItemType Directory -Force "$root\home", "$root\shop" | Out-Null
$pw | ConvertTo-Json | Set-Content -Encoding utf8 "$root\passwords.json"

docker run -d --name $name -p "${port}:5432" -e "POSTGRES_PASSWORD=$($pw.postgres)" postgres:16 | Out-Null
for ($i = 0; $i -lt 60; $i++) { docker exec $name pg_isready -U postgres 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep 1 }
Start-Sleep 2

function Q([string]$db, [string]$sql) { $sql | docker exec -i $name psql -U postgres -d $db -X -q -v ON_ERROR_STOP=1 | Out-Null; if ($LASTEXITCODE -ne 0) { throw "psql failed on $db" } }
$seed = @'
CREATE TABLE customers (id bigserial PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE products (id bigserial PRIMARY KEY, sku text NOT NULL UNIQUE, title text NOT NULL, price numeric(10,2) NOT NULL);
CREATE TABLE orders (id bigserial PRIMARY KEY, customer_id bigint NOT NULL REFERENCES customers(id), status text NOT NULL DEFAULT 'new', total numeric(10,2) NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
INSERT INTO customers (name, email) VALUES ('Ada Park','ada@example.com'),('Ben Ortiz','ben@example.com'),('Chen Wu','chen@example.com'),('Dana Lee','dana@example.com');
INSERT INTO products (sku, title, price) VALUES ('MUG-01','Coffee mug',12.50),('TEE-02','T-shirt',24.00),('CAP-03','Cap',18.00);
INSERT INTO orders (customer_id, status, total) VALUES (1,'paid',36.50),(2,'new',24.00),(3,'shipped',18.00),(1,'new',12.50);
'@
foreach ($e in @(@{ db = 'shop_test'; user = 'shop_dbo_st'; role = 'shop_st'; pw = $pw.test }, @{ db = 'shop_prod'; user = 'shop_dbo'; role = 'shop'; pw = $pw.prod })) {
  Q 'postgres' "CREATE ROLE $($e.role) NOLOGIN; CREATE ROLE $($e.user) LOGIN PASSWORD '$($e.pw)'; CREATE DATABASE $($e.db) OWNER $($e.user);"
  Q $e.db "CREATE SCHEMA $($e.user) AUTHORIZATION $($e.user); ALTER ROLE $($e.user) SET search_path = $($e.user), public;"
  $seed | docker exec -i -e "PGPASSWORD=$($e.pw)" $name psql -h localhost -U $e.user -d $e.db -X -q -v ON_ERROR_STOP=1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "seed failed on $($e.db)" }
}

git init -q --bare "$root\shop.git"
git init -q -b main "$root\shop"
git -C "$root\shop" config user.name 'dba-one'
git -C "$root\shop" config user.email 'dba-one@example.com'
git -C "$root\shop" remote add origin "$root\shop.git"
Set-Content -Encoding utf8 "$root\shop\README.md" "# shop database changes"
git -C "$root\shop" add README.md; git -C "$root\shop" commit -q -m 'start'; git -C "$root\shop" push -q -u origin main
"ready: $name on localhost:$port, workspace $root\shop"
