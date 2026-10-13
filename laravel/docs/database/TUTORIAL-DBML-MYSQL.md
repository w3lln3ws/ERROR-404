# Tutorial: DBML sampai MySQL Laragon

Panduan ini menjelaskan alur dari mengubah rancangan DBML sampai perubahan
struktur terlihat di database MySQL melalui extension SQL di VS Code.

## Ringkasan alur

```text
Edit Daily_cart.dbml lalu simpan
                |
                v
       Watcher mendeteksi file
                |
                v
 @dbml/core menghasilkan Daily_cart.mysql.sql
                |
                v
 Skrip sinkronisasi membaca struktur MySQL
                |
                v
 Jalankan SQL perubahan pada daily_cart
                |
                v
 Refresh koneksi di extension SQL VS Code
```

Komponen yang terlibat:

| Komponen | Peran |
| --- | --- |
| `database/Daily_cart.dbml` | Sumber rancangan skema yang akan diterapkan |
| `@dbml/core` | Library yang mem-parse DBML dan menghasilkan SQL MySQL |
| `scripts/generate-dbml-sql.mjs` | Membuat file SQL dari DBML |
| `database/Daily_cart.mysql.sql` | Hasil SQL; bisa dibaca dan diperiksa |
| `scripts/sync-dbml-to-mysql.mjs` | Membandingkan skema lalu menjalankan perubahan SQL di MySQL |
| `scripts/watch-dbml-sql.mjs` | Memantau perubahan file dan memanggil generator/sinkronisasi |
| Laragon MySQL | Server database yang menyimpan struktur dan data |
| Extension SQL VS Code | Klien untuk melihat data dan menjalankan SQL manual |

## 1. Siapkan koneksi lokal

Pastikan MySQL sedang berjalan di Laragon. File `laravel/.env` harus mengarah ke
database lokal yang benar:

```dotenv
DB_CONNECTION=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=daily_cart
DB_USERNAME=root
DB_PASSWORD=
```

Kata sandi dapat berbeda di komputer Anda. Jangan membagikan atau memasukkan
kata sandi ke file skrip.

Skrip sinkronisasi membaca konfigurasi tersebut, tetapi hanya mengizinkan target
database bernama `daily_cart`. Nama DBML sumber yang disinkronkan juga dibatasi
ke `database/Daily_cart.dbml`.

Extension MySQL VS Code terhubung langsung ke server yang sama:

- Host: `127.0.0.1`
- Port: `3306`
- User: `root`
- Password: sesuai konfigurasi MySQL Laragon
- Database: `daily_cart`

Extension hanya menampilkan atau menjalankan SQL. Watcher tidak menggunakan
extension sebagai perantara.

## 2. Mulai watcher

Buka terminal di folder `laravel`, lalu jalankan:

```powershell
npm install
npm run dbml:mysql:watch
```

Biarkan terminal tetap berjalan. Saat watcher mulai, watcher juga menghasilkan
SQL untuk DBML yang sudah ada dan menyelaraskan `Daily_cart.dbml` ke MySQL.
Ketika file `.dbml` dibuat atau disimpan lagi, watcher menjalankan prosesnya
kembali.

File `.dbml` lain yang ditambahkan langsung di folder `database/` hanya
menghasilkan file `.mysql.sql`; isinya tidak diterapkan ke database. Hanya
`Daily_cart.dbml` yang disinkronkan ke `daily_cart`.

## 3. Ubah DBML

Edit dan simpan `database/Daily_cart.dbml`. Contoh menambah kolom opsional:

```dbml
Table product {
    product_id int [pk, increment]
    category_id int [not null]
    name varchar(100) [not null]
    price decimal(12, 2) [not null]
    stock int [not null, default: 0]
    sku varchar(50)
}
```

Watcher mendeteksi penyimpanan, lalu:

1. Mem-parse file DBML.
2. Menghasilkan ulang `database/Daily_cart.mysql.sql`.
3. Membandingkan tabel dan kolom yang diharapkan dengan MySQL `daily_cart`.
4. Menjalankan SQL yang diperlukan untuk membuat skema MySQL sesuai DBML.
5. Menulis ringkasan hasil di terminal watcher.

Untuk contoh di atas, `sku varchar(50)` diterjemahkan menjadi SQL kira-kira
seperti berikut:

```sql
ALTER TABLE `product` ADD COLUMN `sku` varchar(50);
```

File SQL yang dihasilkan berguna untuk ditinjau, tetapi sinkronisasi database
dijalankan oleh skrip terpisah. Skrip sinkronisasi tidak mengimpor ulang seluruh
file `CREATE TABLE` setiap kali; skrip memeriksa struktur database dan
menerapkan operasi untuk menyamakan skema.

## 4. Operasi yang diselaraskan

Sinkronisasi membandingkan dan menyelaraskan:

- Tabel: membuat tabel baru dan menghapus tabel yang sudah tidak ada di DBML.
- Kolom: menambah, memodifikasi tipe/nullability/default, dan menghapus kolom.
- Indeks: menyamakan primary key, unique, dan indeks yang didefinisikan.
- Relasi: menambah atau menghapus foreign key, termasuk aturan penghapusan.

Database dan tabel sebaiknya dikhususkan untuk skema DBML ini. Tabel lain yang
dibuat manual di `daily_cart` dan tidak ada di `Daily_cart.dbml` juga akan
dihapus ketika sinkronisasi penuh berjalan.

## 5. Update manual

Sinkronisasi biasanya dilakukan dengan mengubah DBML terlebih dahulu agar
rancangan tetap menjadi sumber kebenaran. Untuk menjalankan sinkronisasi
sekali—tanpa watcher—gunakan:

```powershell
npm run dbml:mysql:sync
```

Untuk hanya membuat file SQL tanpa menyinkronkan database:

```powershell
npm run dbml:mysql
```

SQL yang dijalankan manual dari extension tidak otomatis mengubah DBML.
Contohnya, jika kolom ditambahkan lewat `ALTER TABLE` di extension, tambahkan
definisi kolom yang sama ke DBML agar rancangan dan database kembali selaras.

## 6. Melihat hasil

Setelah watcher mencetak ringkasan sinkronisasi:

1. Di extension SQL VS Code, refresh koneksi atau daftar tabel `daily_cart`.
2. Buka tabel yang berubah untuk melihat kolom, indeks, atau relasinya.
3. Bila ada error di terminal watcher, baca pesannya sebelum mencoba ulang.

## 7. Backup dan risiko data

Mode sinkronisasi sekarang menerapkan **semua perbedaan skema tanpa konfirmasi**.
Ini sesuai mode otomatis, tetapi operasi tertentu bisa merusak atau menghapus
data:

- Menghapus tabel/kolom akan menghapus semua data di dalamnya.
- Mengubah tipe kolom dapat memotong atau mengubah nilai yang tidak muat.
- Menambahkan aturan `NOT NULL` atau `UNIQUE` bisa gagal jika data lama tidak
  memenuhi aturan tersebut.
- MySQL dapat menerapkan sebagian perubahan sebelum operasi berikutnya gagal;
  operasi DDL tidak selalu dapat dibatalkan sebagai satu transaksi.

Sebelum perubahan skema penting, buat backup melalui HeidiSQL, misalnya
**Export database as SQL**, lalu pastikan backup tersimpan. Hentikan watcher
terlebih dahulu bila Anda tidak ingin DBML yang sedang diedit langsung
diterapkan.

## Pemecahan masalah singkat

- **Tidak ada perubahan otomatis:** pastikan `npm run dbml:mysql:watch` masih
  berjalan dan terminal tidak menampilkan error.
- **Koneksi gagal:** pastikan MySQL aktif di Laragon, `laravel/.env` benar, dan
  database `daily_cart` tersedia.
- **Tabel belum terlihat di extension:** refresh koneksi dan pastikan extension
  terhubung ke host, port, serta database yang sama.
- **Butuh perubahan saja:** gunakan `npm run dbml:mysql:sync` setelah memastikan
  MySQL aktif.

Lihat juga [DBML.md](./DBML.md) untuk ringkasan perintah generator.
