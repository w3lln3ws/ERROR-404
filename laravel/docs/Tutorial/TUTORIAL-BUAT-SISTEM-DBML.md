# Tutorial: Membuat Sistem DBML ke MySQL secara Manual

Panduan ini menjelaskan cara merakit alur DBML → SQL MySQL → database Laragon,
kemudian menambahkan generator, sinkronisasi, watcher, dan seeder Laravel
langkah demi langkah. Gunakan terminal PowerShell dari folder `laravel`, kecuali
jika disebutkan lain.

> **Peringatan:** sinkronisasi pada sistem ini langsung menjalankan perubahan
> skema tanpa meminta konfirmasi. Menghapus tabel atau kolom dapat menghapus
> datanya. Selalu cek target koneksi dan buat backup sebelum sinkronisasi.

## Cara kerja

```text
database/Daily_cart.dbml
        |
        +-- generator (@dbml/core) --> database/Daily_cart.mysql.sql
        |
        +-- sinkronisasi (mysql2) --> MySQL Laragon: daily_cart
        |
        +-- watcher --> menjalankan alur saat file DBML disimpan
```

DBML adalah sumber desain. File `.mysql.sql` merupakan hasil generator, bukan
file sumber yang diedit manual. Extension SQL di VS Code atau HeidiSQL hanya
dipakai untuk menghubungkan diri ke MySQL, melihat data, dan menjalankan SQL.

## 1. Siapkan perangkat dan database lokal

Siapkan:

- Laragon dengan MySQL berjalan.
- PHP dan Composer untuk perintah Artisan Laravel.
- Node.js dan npm untuk skrip DBML.
- HeidiSQL atau extension SQL VS Code untuk memeriksa database.

Di HeidiSQL, buat database `daily_cart` dengan encoding `utf8mb4`. Atur
kredensial koneksi di `laravel/.env`:

```dotenv
DB_CONNECTION=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=daily_cart
DB_USERNAME=root
DB_PASSWORD=
```

Sesuaikan user dan password dengan Laragon Anda. Jangan membagikan `.env` atau
menaruh kata sandi database di skrip.

## 2. Tambahkan paket dan perintah npm

Dari folder `laravel`, pasang paket yang dipakai skrip:

```powershell
npm install --save-dev @dbml/core dotenv mysql2
```

Di `package.json`, pastikan modul ES dan perintah berikut tersedia. Gabungkan
entri ini dengan konfigurasi yang sudah ada; jangan mengganti seluruh
`package.json` Laravel:

```json
{
    "type": "module",
    "scripts": {
        "dbml:mysql": "node scripts/generate-dbml-sql.mjs",
        "dbml:mysql:sync": "node scripts/sync-dbml-to-mysql.mjs",
        "dbml:mysql:watch": "node scripts/watch-dbml-sql.mjs"
    }
}
```

Jalankan `npm install` untuk memasang dependency sesuai `package-lock.json`.

## 3. Buat desain DBML

Buat `database/Daily_cart.dbml`. Contoh tabel customer:

```dbml
Table customer {
    customer_id int [pk, increment]
    name varchar(200) [not null]
    email varchar(200) [unique, not null]
    phone varchar(20)
    password_hash varchar(255) [not null]
    created_at timestamp [default: `CURRENT_TIMESTAMP`]
}
```

Relasi ditulis dengan `Ref`, contohnya:

```dbml
Ref: address.customer_id > customer.customer_id [delete: cascade]
```

Tambahkan semua tabel dan relasi aplikasi ke DBML. Ukuran `varchar(200)`
menentukan panjang teks maksimum kolom, bukan jumlah baris yang ditampilkan.
Untuk meminta MySQL mengembalikan sampai 1.000 baris, gunakan query
`SELECT * FROM customer LIMIT 1000;`.

## 4. Buat generator DBML ke SQL

Buat `scripts/generate-dbml-sql.mjs`. Generator membaca DBML, memakai parser dan
exporter MySQL dari `@dbml/core`, lalu menulis file SQL di samping file DBML.
Implementasi generator proyek ini ada di
[generate-dbml-sql.mjs](../../scripts/generate-dbml-sql.mjs); gunakan sebagai
acuan saat membuat ulang skrip agar penanganan `ON UPDATE CURRENT_TIMESTAMP`
tetap sama.

Jalankan generator:

```powershell
npm run dbml:mysql
```

Hasilnya adalah `database/Daily_cart.mysql.sql`. Buka dan tinjau isinya sebelum
mengimpor. Untuk membuat tabel pertama kali, jalankan SQL hasil generator pada
database kosong `daily_cart` melalui HeidiSQL. File SQL membuat tabel dan relasi,
tetapi tidak membuat databasenya.

## 5. Buat skrip sinkronisasi skema

Buat `scripts/sync-dbml-to-mysql.mjs`. Skrip sinkronisasi proyek ini ada di
[sync-dbml-to-mysql.mjs](../../scripts/sync-dbml-to-mysql.mjs). Saat membuatnya,
urutkan tanggung jawab utamanya seperti berikut:

1. Muat `.env` dari folder Laravel dan siapkan koneksi `mysql2/promise`.
2. Batasi input ke `database/Daily_cart.dbml` dan periksa nama database target.
3. Panggil generator, lalu parse tabel, kolom, indeks, dan foreign key dari SQL
   hasil DBML.
4. Baca skema aktif dari MySQL melalui `SHOW TABLES`, `SHOW INDEX`, dan
   `information_schema`.
5. Bandingkan skema aktif dengan skema DBML.
6. Jalankan `CREATE`, `ALTER`, atau `DROP` yang diperlukan; cetak ringkasan
   perubahan dan selalu tutup koneksi.

Skrip saat ini hanya memastikan target bernama `daily_cart`; host koneksi tetap
dibaca dari `.env`. Jadi, sebelum menjalankannya, pastikan `DB_HOST`,
`DB_DATABASE`, dan kredensial mengarah ke server lokal yang benar. Sinkronisasi
dapat menghapus tabel yang tidak didefinisikan dalam DBML dan dapat menghapus
kolom beserta datanya. Perubahan DDL MySQL juga tidak selalu dapat dibatalkan
sebagai satu transaksi.

Uji pertama kali hanya pada database kosong atau salinan database yang sudah
dicadangkan. Untuk menerapkan satu kali tanpa watcher:

```powershell
npm run dbml:mysql:sync
```

## 6. Buat watcher otomatis

Buat `scripts/watch-dbml-sql.mjs`. Lihat
[watch-dbml-sql.mjs](../../scripts/watch-dbml-sql.mjs) untuk implementasi
proyek ini. Watcher menggunakan `node:fs` untuk memantau folder `database`,
menunda pemrosesan singkat agar beberapa event saat file disimpan digabung,
lalu memilih alur berdasarkan nama file:

- `Daily_cart.dbml`: generate SQL dan sinkronkan database `daily_cart`.
- File `.dbml` lain: hanya generate file `.mysql.sql`, tidak menyinkronkan DB.

Jalankan dan biarkan terminal tetap terbuka:

```powershell
npm run dbml:mysql:watch
```

Watcher juga memproses file DBML yang sudah ada saat mulai. Artinya, memulai
watcher dapat langsung menyinkronkan database—bukan hanya menunggu perubahan
berikutnya. Hentikan dengan `Ctrl+C`. Jangan biarkan watcher berjalan saat
menguji perubahan DBML yang belum ditinjau.

## 7. Periksa hasilnya

Di HeidiSQL atau extension SQL, pastikan koneksi menggunakan host, port, dan
database yang sama dengan `.env`, lalu jalankan:

```sql
SHOW TABLES;
SHOW COLUMNS FROM customer;
SELECT COUNT(*) FROM customer;
SELECT * FROM customer ORDER BY customer_id LIMIT 1000;
```

Jika hanya ingin memperbarui file SQL tanpa mengubah MySQL, jalankan
`npm run dbml:mysql`, bukan `dbml:mysql:sync` dan bukan watcher.

## 8. Tambahkan seeder untuk data tes

Seeder Laravel proyek ini ada di
[CustomerTestSeeder.php](../../database/seeders/CustomerTestSeeder.php). Seeder
tersebut menghasilkan data fiktif, memakai email `example.test`, menyimpan hash
password, dan menggunakan `upsert` berdasarkan email agar menjalankan ulangnya
tidak menggandakan alamat email tes.

Jalankan hanya pada database lokal yang sudah diperiksa:

```powershell
php artisan db:seed --class="Database\Seeders\CustomerTestSeeder"
```

Seeder yang ada saat ini mengisi nomor `001` sampai `800`. Jika membutuhkan
jumlah lain, ubah batas perulangan di seeder dan teks ringkasan agar sama,
kemudian jalankan ulang. Jika sebelumnya sudah membuat `001`–`200`, menjalankan
seeder dengan batas `800` akan memperbarui 200 data itu dan menambahkan
`201`–`800`, sehingga total data tes menjadi 800. Seeder ini untuk data uji,
bukan fitur upload CSV dan bukan untuk production. Password contoh di seeder
jangan dipakai oleh akun sungguhan.

## Alur kerja harian yang disarankan

1. Backup database sebelum perubahan berisiko.
2. Edit dan simpan DBML.
3. Jalankan `npm run dbml:mysql` dan tinjau SQL hasilnya.
4. Jika memang ingin menerapkan perubahan, pastikan `.env` menunjuk ke database
   lokal yang benar, lalu jalankan `npm run dbml:mysql:sync`.
5. Verifikasi struktur dan data melalui HeidiSQL atau extension SQL.
6. Gunakan watcher hanya jika Anda memang menghendaki setiap penyimpanan DBML
   langsung mengubah skema database.

Lihat juga [Tutorial DBML sampai MySQL Laragon](./TUTORIAL-DBML-MYSQL.md) untuk
petunjuk penggunaan alur yang sudah terpasang di proyek ini.
