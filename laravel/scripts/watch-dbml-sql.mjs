import { watch } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDbmlSql } from './generate-dbml-sql.mjs';
import { syncDbmlToMysql } from './sync-dbml-to-mysql.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const databaseDirectory = path.join(projectRoot, 'database');
const debounceTimers = new Map();

async function regenerateAndSync(sourcePath) {
    try {
        const file = await stat(sourcePath);

        if (!file.isFile()) {
            return;
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
            return;
        }

        throw error;
    }

    let generatedSql;
    let report;

    if (path.basename(sourcePath).toLowerCase() === 'daily_cart.dbml') {
        report = await syncDbmlToMysql(sourcePath);
        generatedSql = report.generatedSqlPath;
    } else {
        generatedSql = await generateDbmlSql(sourcePath);
    }

    console.log(`Generated ${path.relative(projectRoot, generatedSql)}`);
    if (report) {
        console.log(
            `Synced to MySQL: ${report.createdTables.length} tables created, `
            + `${report.droppedTables.length} tables dropped, `
            + `${report.addedColumns.length} columns added, `
            + `${report.changedColumns.length} columns modified, `
            + `${report.droppedColumns.length} columns dropped, `
            + `${report.addedForeignKeys.length} foreign keys added, `
            + `${report.droppedForeignKeys.length} foreign keys dropped.`,
        );
    }
}

function scheduleRegeneration(sourcePath) {
    clearTimeout(debounceTimers.get(sourcePath));
    debounceTimers.set(sourcePath, setTimeout(() => {
        debounceTimers.delete(sourcePath);
        regenerateAndSync(sourcePath).catch((error) => {
            console.error(`Failed to sync ${path.basename(sourcePath)} to MySQL:`, error);
        });
    }, 200));
}

const watcher = watch(databaseDirectory, (eventType, filename) => {
    const name = filename?.toString();

    if (!name || path.extname(name).toLowerCase() !== '.dbml') {
        return;
    }

    scheduleRegeneration(path.join(databaseDirectory, name));
});

watcher.on('error', (error) => {
    console.error('DBML file watcher failed:', error);
    process.exitCode = 1;
    watcher.close();
});

for (const name of await readdir(databaseDirectory)) {
    if (path.extname(name).toLowerCase() === '.dbml') {
        await regenerateAndSync(path.join(databaseDirectory, name));
    }
}

console.log('Watching database/*.dbml. All schema changes from Daily_cart.dbml sync automatically to daily_cart; other files only generate SQL.');
