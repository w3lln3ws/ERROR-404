<?php

namespace Database\Seeders;

use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Schema;
use RuntimeException;

class CustomerTestSeeder extends Seeder
{
    public function run(): void
    {
        $mysql = config('database.connections.mysql');

        if (
            config('database.default') !== 'mysql'
            || ! in_array($mysql['host'] ?? null, ['127.0.0.1', 'localhost', '::1'], true)
            || ($mysql['database'] ?? null) !== 'daily_cart'
        ) {
            throw new RuntimeException('Customer test data can only be seeded into the local daily_cart MySQL database.');
        }

        if (! Schema::connection('mysql')->hasTable('customer')) {
            throw new RuntimeException('The customer table does not exist in the daily_cart database.');
        }

        $faker = fake();
        $passwordHash = Hash::make('Tester123!');
        $now = now();
        $customers = [];

        for ($i = 1; $i <= 800; $i++) {
            $customers[] = [
                'name' => $faker->name(),
                'email' => sprintf('dbml-test-customer-%03d@example.test', $i),
                'phone' => $faker->numerify('08##########'),
                'password_hash' => $passwordHash,
                'created_at' => $now,
            ];
        }

        DB::connection('mysql')->table('customer')->upsert(
            $customers,
            ['email'],
            ['name', 'phone', 'password_hash', 'created_at'],
        );

        $this->command?->info('Seeded 800 test customers (emails: dbml-test-customer-001@example.test to dbml-test-customer-800@example.test).');
    }
}
