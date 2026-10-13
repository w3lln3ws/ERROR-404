# Generate MySQL schema from DBML

`database/Daily_cart.dbml` is the source schema. After editing it, run this from
the `laravel` directory:

For the end-to-end workflow, see [Tutorial: DBML sampai MySQL Laragon](./TUTORIAL-DBML-MYSQL.md).
For a step-by-step guide to assembling the system manually, see
[Tutorial: Membuat Sistem DBML ke MySQL secara Manual](./TUTORIAL-BUAT-SISTEM-DBML.md).

```powershell
npm install
npm run dbml:mysql
```

The generated MySQL script is `database/Daily_cart.mysql.sql`. Do not edit that
file directly; regenerate it from the DBML source instead.

To regenerate SQL automatically whenever a DBML file is created or saved, run
this from the `laravel` directory and leave it running:

```powershell
npm run dbml:mysql:watch
```

The watcher generates a matching `.mysql.sql` file for every `.dbml` file
directly inside `database/`. Only `Daily_cart.dbml` is synchronized to
`daily_cart`; other DBML files only generate SQL.

For `Daily_cart.dbml`, schema changes are applied automatically: tables and
columns can be created, modified, or dropped, and indexes and foreign keys are
synchronized to match the DBML. This includes destructive changes. Removing a
table or column permanently deletes its data; changing a type may alter or lose
values that do not fit the new type. Back up `daily_cart` before editing the
DBML. The sync connection uses `laravel/.env` and refuses to write to any
database other than `daily_cart`.

To force a one-off synchronization without the watcher:

```powershell
npm run dbml:mysql:sync
```

Initial setup in Laragon:

1. Start MySQL in Laragon.
2. Create a database named `daily_cart` in HeidiSQL.
3. Import `database/Daily_cart.mysql.sql` into that empty database.
4. Copy `.env.example` to `.env` if needed, then use the MySQL settings shown
   there.

The generated script creates tables and relationships; it does not create the
database itself. The `MySQL: ON UPDATE CURRENT_TIMESTAMP` note in the DBML is
translated into MySQL's `ON UPDATE CURRENT_TIMESTAMP` column clause.

## Seed 800 customer test records

From the `laravel` directory, run the dedicated seeder:

```powershell
php artisan db:seed --class="Database\Seeders\CustomerTestSeeder"
```

It creates or updates 800 rows with `example.test` email addresses. Running it
again does not add duplicate test customers. The seeder only permits the local
MySQL `daily_cart` database and does not change the table schema. To remove only
these test records after testing, run:

```powershell
php artisan tinker --execute="DB::table('customer')->whereBetween('email', ['dbml-test-customer-001@example.test', 'dbml-test-customer-800@example.test'])->delete();"
```
