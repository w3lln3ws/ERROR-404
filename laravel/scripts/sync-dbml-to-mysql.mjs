import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDbmlSql } from './generate-dbml-sql.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const defaultSourcePath = path.join(projectRoot, 'database', 'Daily_cart.dbml');
dotenv.config({ path: path.join(projectRoot, '.env') });

const dbConfig = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USERNAME || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_DATABASE || 'daily_cart',
};

function splitSqlStatements(sql) {
    const statements = [];
    let buffer = '';
    let quote = null;

    for (let i = 0; i < sql.length; i += 1) {
        const char = sql[i];

        if ((char === '\'' || char === '"' || char === '`') && (!quote || quote === char) && sql[i - 1] !== '\\') {
            quote = quote ? null : char;
        }

        if (char === ';' && !quote) {
            if (buffer.trim()) {
                statements.push(buffer.trim());
            }
            buffer = '';
            continue;
        }

        buffer += char;
    }

    if (buffer.trim()) {
        statements.push(buffer.trim());
    }

    return statements;
}

function splitTopLevel(body) {
    const parts = [];
    let buffer = '';
    let depth = 0;
    let quote = null;

    for (let i = 0; i < body.length; i += 1) {
        const char = body[i];

        if ((char === '\'' || char === '"' || char === '`') && (!quote || quote === char) && body[i - 1] !== '\\') {
            quote = quote ? null : char;
        }

        if (!quote) {
            if (char === '(') {
                depth += 1;
            } else if (char === ')') {
                depth -= 1;
            }
        }

        if (char === ',' && depth === 0 && !quote) {
            if (buffer.trim()) {
                parts.push(buffer.trim());
            }
            buffer = '';
            continue;
        }

        buffer += char;
    }

    if (buffer.trim()) {
        parts.push(buffer.trim());
    }

    return parts;
}

function quoteIdentifier(identifier) {
    if (!/^[\w-]+$/.test(identifier)) {
        throw new Error(`Unexpected database identifier: ${identifier}`);
    }

    return `\`${identifier}\``;
}

function parseTableDefinition(statement) {
    const match = statement.match(/^CREATE\s+TABLE\s+`?([\w-]+)`?\s*\(/i);
    if (!match) {
        return null;
    }

    const start = statement.indexOf('(', match[0].length - 1);
    const end = statement.lastIndexOf(')');
    const table = { name: match[1], columns: new Map(), indexes: new Map() };

    for (const definition of splitTopLevel(statement.slice(start + 1, end))) {
        const columnMatch = definition.match(/^`?([\w-]+)`?\s+(.+)$/s);
        if (/^(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FOREIGN)\b/i.test(definition)) {
            const primary = definition.match(/^PRIMARY\s+KEY\s*\(([^)]+)\)/i);
            const unique = definition.match(/^UNIQUE(?:\s+KEY|\s+INDEX)?(?:\s+`?([\w-]+)`?)?\s*\(([^)]+)\)/i);
            const index = definition.match(/^(?:KEY|INDEX)\s+`?([\w-]+)`?\s*\(([^)]+)\)/i);

            if (primary) {
                const columns = primary[1].replace(/`/g, '').split(',').map((column) => column.trim());
                table.indexes.set(indexSignature(columns, true, true), { name: 'PRIMARY', columns, unique: true, primary: true });
            } else if (unique) {
                const columns = unique[2].replace(/`/g, '').split(',').map((column) => column.trim());
                table.indexes.set(indexSignature(columns, true, false), {
                    name: unique[1] ?? uniqueIndexName(table.name, columns),
                    columns,
                    unique: true,
                    primary: false,
                });
            } else if (index) {
                const columns = index[2].replace(/`/g, '').split(',').map((column) => column.trim());
                table.indexes.set(indexSignature(columns, false, false), { name: index[1], columns, unique: false, primary: false });
            }
            continue;
        }
        if (!columnMatch) {
            continue;
        }

        const [, name, remainder] = columnMatch;
        const attribute = remainder.match(/\s+(?=(?:NOT\s+NULL|NULL|PRIMARY\s+KEY|UNIQUE|AUTO_INCREMENT|DEFAULT|COMMENT|ON\s+UPDATE)\b)/i);
        const type = (attribute ? remainder.slice(0, attribute.index) : remainder).trim();
        const flags = attribute ? remainder.slice(attribute.index).trim() : '';
        const cleanDefinition = definition
            .replace(/\s+PRIMARY\s+KEY\b/i, '')
            .replace(/\s+UNIQUE(?:\s+KEY)?\b/i, '');

        table.columns.set(name, {
            name,
            type,
            nullable: !/\bNOT\s+NULL\b|\bPRIMARY\s+KEY\b/i.test(flags),
            defaultValue: flags.match(/\bDEFAULT\s+(\([^)]*\)|'(?:\\.|[^'])*'|"(?:""|[^"])*"|[^\s]+)/i)?.[1] ?? null,
            autoIncrement: /\bAUTO_INCREMENT\b/i.test(flags),
            onUpdate: flags.match(/\bON\s+UPDATE\s+([A-Z_]+(?:\s*\([^)]*\))?)/i)?.[1] ?? null,
            definition: cleanDefinition.trim(),
            primary: /\bPRIMARY\s+KEY\b/i.test(flags),
            unique: /\bUNIQUE(?:\s+KEY)?\b/i.test(flags),
        });

        if (/\bPRIMARY\s+KEY\b/i.test(flags)) {
            table.indexes.set(`PRIMARY:${name}`, { name: 'PRIMARY', columns: [name], unique: true, primary: true });
        } else if (/\bUNIQUE(?:\s+KEY)?\b/i.test(flags)) {
            table.indexes.set(`UNIQUE:${name}`, { name: `unique_${name}`, columns: [name], unique: true, primary: false });
        }
    }

    for (const index of table.indexes.values()) {
        if (index.primary) {
            for (const columnName of index.columns) {
                const column = table.columns.get(columnName);
                if (column) {
                    column.nullable = false;
                }
            }
        }
    }

    return table;
}

function parseForeignKey(statement) {
    const match = statement.match(
        /ALTER\s+TABLE\s+`?([\w-]+)`?\s+ADD\s+(?:CONSTRAINT\s+`?([\w-]+)`?\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+`?([\w-]+)`?\s*\(([^)]+)\)(.*)$/i,
    );
    if (!match) {
        return null;
    }

    const actions = match[6];

    return {
        table: match[1],
        name: match[2] ?? '',
        columns: match[3].replace(/`/g, '').split(',').map((column) => column.trim()),
        referencedTable: match[4],
        referencedColumns: match[5].replace(/`/g, '').split(',').map((column) => column.trim()),
        onDelete: actions.match(/\bON\s+DELETE\s+(CASCADE|RESTRICT|SET\s+NULL|NO\s+ACTION|SET\s+DEFAULT)/i)?.[1]?.replace(/\s+/g, ' ').toUpperCase() ?? 'NO ACTION',
        onUpdate: actions.match(/\bON\s+UPDATE\s+(CASCADE|RESTRICT|SET\s+NULL|NO\s+ACTION|SET\s+DEFAULT)/i)?.[1]?.replace(/\s+/g, ' ').toUpperCase() ?? 'NO ACTION',
        statement,
    };
}

function foreignKeySignature(key) {
    return [
        key.table,
        key.columns.join(','),
        key.referencedTable,
        key.referencedColumns.join(','),
        key.onDelete,
        key.onUpdate,
    ].join('|');
}

function normalizeType(type) {
    return type.toLowerCase().replace(/\s+/g, '').replace(/,\s*/g, ',');
}

function normalizeDefault(value) {
    if (value === null || value === undefined) {
        return null;
    }

    let normalized = String(value).trim();
    if (normalized.startsWith('(') && normalized.endsWith(')')) {
        normalized = normalized.slice(1, -1).trim();
    }
    if (normalized.startsWith('\'') && normalized.endsWith('\'')) {
        normalized = normalized.slice(1, -1).replace(/''/g, '\'');
    } else if (normalized.startsWith('"') && normalized.endsWith('"')) {
        normalized = normalized.slice(1, -1);
    }

    normalized = normalized.toLowerCase();
    return normalized === 'now()' ? 'current_timestamp' : normalized;
}

function indexSignature(columns, unique, primary) {
    return `${primary ? 'PRIMARY' : unique ? 'UNIQUE' : 'INDEX'}:${columns.join(',')}`;
}

function uniqueIndexName(tableName, columns) {
    const baseName = `${tableName}_${columns.join('_')}_unique`;
    return baseName.length <= 64 ? baseName : `${baseName.slice(0, 55)}_${Buffer.from(baseName).toString('hex').slice(0, 8)}`;
}

export async function syncDbmlToMysql(sourcePath = defaultSourcePath) {
    const resolvedSourcePath = path.resolve(sourcePath);

    if (resolvedSourcePath.toLowerCase() !== path.resolve(defaultSourcePath).toLowerCase()) {
        throw new Error(`Only ${path.relative(projectRoot, defaultSourcePath)} is allowed to sync to ${dbConfig.database}.`);
    }

    if (dbConfig.database !== 'daily_cart') {
        throw new Error(`Refusing to sync DBML to "${dbConfig.database}". Set DB_DATABASE=daily_cart in laravel/.env.`);
    }

    const generatedSqlPath = await generateDbmlSql(resolvedSourcePath);
    const sql = await readFile(generatedSqlPath, 'utf8');
    const statements = splitSqlStatements(sql.replace(/^\s*--[^\r\n]*(?:\r?\n|$)/gm, ''));
    const expectedTables = new Map();
    const expectedForeignKeys = [];

    for (const statement of statements) {
        const table = parseTableDefinition(statement);
        if (table) {
            expectedTables.set(table.name, table);
            continue;
        }

        const foreignKey = parseForeignKey(statement);
        if (foreignKey) {
            expectedForeignKeys.push(foreignKey);
        }
    }

    const connection = await mysql.createConnection(dbConfig);
    const report = { createdTables: [], droppedTables: [], addedColumns: [], changedColumns: [], droppedColumns: [], addedForeignKeys: [], droppedForeignKeys: [], changedIndexes: [] };

    try {
        const [tableRows] = await connection.query('SHOW TABLES');
        const existingTables = new Set(tableRows.map((row) => Object.values(row)[0]));
        const [foreignKeyRows] = await connection.query(
            `SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME,
                    k.REFERENCED_COLUMN_NAME, r.DELETE_RULE, r.UPDATE_RULE, k.ORDINAL_POSITION
             FROM information_schema.KEY_COLUMN_USAGE k
             JOIN information_schema.REFERENTIAL_CONSTRAINTS r
               ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
              AND r.TABLE_NAME = k.TABLE_NAME
              AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
             WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
             ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
            [dbConfig.database],
        );
        const groupedForeignKeys = new Map();

        for (const row of foreignKeyRows) {
            const id = `${row.TABLE_NAME}|${row.CONSTRAINT_NAME}`;
            const key = groupedForeignKeys.get(id) ?? {
                table: row.TABLE_NAME,
                name: row.CONSTRAINT_NAME,
                columns: [],
                referencedTable: row.REFERENCED_TABLE_NAME,
                referencedColumns: [],
                onDelete: row.DELETE_RULE.toUpperCase(),
                onUpdate: row.UPDATE_RULE.toUpperCase(),
            };
            key.columns.push(row.COLUMN_NAME);
            key.referencedColumns.push(row.REFERENCED_COLUMN_NAME);
            groupedForeignKeys.set(id, key);
        }

        const expectedForeignKeySignatures = new Set(expectedForeignKeys.map(foreignKeySignature));
        const currentForeignKeys = [...groupedForeignKeys.values()];

        for (const key of currentForeignKeys) {
            if (!expectedTables.has(key.table) || !expectedTables.has(key.referencedTable) || !expectedForeignKeySignatures.has(foreignKeySignature(key))) {
                await connection.execute(`ALTER TABLE ${quoteIdentifier(key.table)} DROP FOREIGN KEY ${quoteIdentifier(key.name)}`);
                report.droppedForeignKeys.push(`${key.table}.${key.name}`);
            }
        }

        for (const tableName of existingTables) {
            if (!expectedTables.has(tableName)) {
                await connection.execute(`DROP TABLE ${quoteIdentifier(tableName)}`);
                report.droppedTables.push(tableName);
                existingTables.delete(tableName);
            }
        }

        for (const [tableName, expected] of expectedTables) {
            if (existingTables.has(tableName)) {
                continue;
            }

            const createStatement = statements.find((statement) => parseTableDefinition(statement)?.name === tableName);
            await connection.execute(createStatement);
            report.createdTables.push(tableName);
            existingTables.add(tableName);
        }

        for (const [tableName, expected] of expectedTables) {
            const [columnRows] = await connection.query(
                `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, ORDINAL_POSITION
                 FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                 ORDER BY ORDINAL_POSITION`,
                [dbConfig.database, tableName],
            );
            const existingColumns = new Map(columnRows.map((column) => [column.COLUMN_NAME, column]));
            const hasRowsQuery = await connection.query(`SELECT EXISTS(SELECT 1 FROM ${quoteIdentifier(tableName)} LIMIT 1) AS has_rows`);
            const hasRows = Boolean(hasRowsQuery[0][0].has_rows);

            for (const [columnName, current] of existingColumns) {
                if (!expected.columns.has(columnName)) {
                    await connection.execute(`ALTER TABLE ${quoteIdentifier(tableName)} DROP COLUMN ${quoteIdentifier(columnName)}`);
                    report.droppedColumns.push(`${tableName}.${columnName}`);
                }
            }

            for (const [columnName, column] of expected.columns) {
                const current = existingColumns.get(columnName);

                if (!current) {
                    const definition = column.definition;
                    const addColumn = `ALTER TABLE ${quoteIdentifier(tableName)} ADD COLUMN ${definition}`;
                    await connection.execute(addColumn);
                    report.addedColumns.push(`${tableName}.${columnName}`);
                    continue;
                }

                const expectedDefault = normalizeDefault(column.defaultValue);
                const currentDefault = normalizeDefault(current.COLUMN_DEFAULT);
                const currentAutoIncrement = /auto_increment/i.test(current.EXTRA);
                const currentOnUpdate = current.EXTRA.match(/on update\s+([a-z_]+(?:\s*\([^)]*\))?)/i)?.[1] ?? null;
                const differs = normalizeType(current.COLUMN_TYPE) !== normalizeType(column.type)
                    || (current.IS_NULLABLE === 'YES') !== column.nullable
                    || expectedDefault !== currentDefault
                    || currentAutoIncrement !== column.autoIncrement
                    || normalizeDefault(currentOnUpdate) !== normalizeDefault(column.onUpdate);

                if (differs) {
                    await connection.execute(`ALTER TABLE ${quoteIdentifier(tableName)} MODIFY COLUMN ${column.definition}`);
                    report.changedColumns.push(`${tableName}.${columnName}`);
                }
            }

            const [indexRows] = await connection.query(`SHOW INDEX FROM ${quoteIdentifier(tableName)}`);
            const currentIndexes = new Map();

            for (const row of indexRows) {
                const entry = currentIndexes.get(row.Key_name) ?? {
                    name: row.Key_name,
                    columns: [],
                    unique: row.Non_unique === 0,
                    primary: row.Key_name === 'PRIMARY',
                };
                entry.columns[row.Seq_in_index - 1] = row.Column_name;
                currentIndexes.set(row.Key_name, entry);
            }

            const currentIndexSignatures = new Set(
                [...currentIndexes.values()].map((index) => indexSignature(index.columns, index.unique, index.primary)),
            );
            const expectedIndexSignatures = new Set(
                [...expected.indexes.values()].map((index) => indexSignature(index.columns, index.unique, index.primary)),
            );

            for (const index of currentIndexes.values()) {
                const signature = indexSignature(index.columns, index.unique, index.primary);
                if (expectedIndexSignatures.has(signature)) {
                    continue;
                }

                if (!index.unique && !index.primary) {
                    const backsForeignKey = expectedForeignKeys.some((key) => (
                        key.table === tableName
                        && key.columns.length <= index.columns.length
                        && key.columns.every((column, position) => index.columns[position] === column)
                    ));

                    if (backsForeignKey) {
                        continue;
                    }
                }

                if (index.primary) {
                    await connection.execute(`ALTER TABLE ${quoteIdentifier(tableName)} DROP PRIMARY KEY`);
                } else {
                    await connection.execute(`ALTER TABLE ${quoteIdentifier(tableName)} DROP INDEX ${quoteIdentifier(index.name)}`);
                }
                report.changedIndexes.push(`${tableName}.${index.name} removed`);
                currentIndexSignatures.delete(signature);
            }

            for (const index of expected.indexes.values()) {
                const signature = indexSignature(index.columns, index.unique, index.primary);
                if (currentIndexSignatures.has(signature)) {
                    continue;
                }

                const columns = index.columns.map(quoteIdentifier).join(', ');
                if (index.primary) {
                    await connection.execute(`ALTER TABLE ${quoteIdentifier(tableName)} ADD PRIMARY KEY (${columns})`);
                } else if (index.unique) {
                    await connection.execute(
                        `ALTER TABLE ${quoteIdentifier(tableName)} ADD UNIQUE INDEX ${quoteIdentifier(uniqueIndexName(tableName, index.columns))} (${columns})`,
                    );
                } else {
                    await connection.execute(`ALTER TABLE ${quoteIdentifier(tableName)} ADD INDEX ${quoteIdentifier(index.name)} (${columns})`);
                }
                report.changedIndexes.push(`${tableName}.${index.name} added`);
            }

            if (hasRows) {
                for (const [columnName, column] of expected.columns) {
                    if (!existingColumns.has(columnName) && !column.nullable && column.defaultValue === null) {
                        report.changedColumns.push(`${tableName}.${columnName} added as required; verify MySQL's default values for existing rows.`);
                    }
                }
            }
        }

        const [finalForeignKeyRows] = await connection.query(
            `SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME,
                    k.REFERENCED_COLUMN_NAME, r.DELETE_RULE, r.UPDATE_RULE, k.ORDINAL_POSITION
             FROM information_schema.KEY_COLUMN_USAGE k
             JOIN information_schema.REFERENTIAL_CONSTRAINTS r
               ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
              AND r.TABLE_NAME = k.TABLE_NAME
              AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
             WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
             ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
            [dbConfig.database],
        );
        const finalForeignKeys = new Map();

        for (const row of finalForeignKeyRows) {
            const id = `${row.TABLE_NAME}|${row.CONSTRAINT_NAME}`;
            const key = finalForeignKeys.get(id) ?? {
                table: row.TABLE_NAME,
                name: row.CONSTRAINT_NAME,
                columns: [],
                referencedTable: row.REFERENCED_TABLE_NAME,
                referencedColumns: [],
                onDelete: row.DELETE_RULE.toUpperCase(),
                onUpdate: row.UPDATE_RULE.toUpperCase(),
            };
            key.columns.push(row.COLUMN_NAME);
            key.referencedColumns.push(row.REFERENCED_COLUMN_NAME);
            finalForeignKeys.set(id, key);
        }
        const finalSignatures = new Set([...finalForeignKeys.values()].map(foreignKeySignature));

        for (const foreignKey of expectedForeignKeys) {
            const signature = foreignKeySignature(foreignKey);
            if (finalSignatures.has(signature)) {
                continue;
            }

            await connection.execute(foreignKey.statement);
            report.addedForeignKeys.push(signature);
        }
    } finally {
        await connection.end();
    }

    return { ...report, generatedSqlPath };
}

const calledPath = process.argv[1] ? path.resolve(process.argv[1]) : '';

if (calledPath === fileURLToPath(import.meta.url)) {
    const sourcePath = process.argv[2] ? path.resolve(process.argv[2]) : defaultSourcePath;
    const report = await syncDbmlToMysql(sourcePath);
    console.log(`Generated ${path.relative(projectRoot, report.generatedSqlPath)}`);
    console.log(`Synced to ${dbConfig.database}: ${report.createdTables.length} tables created, ${report.addedColumns.length} columns added, ${report.changedColumns.length} columns modified, ${report.droppedColumns.length} columns dropped, ${report.droppedTables.length} tables dropped, ${report.addedForeignKeys.length} foreign keys added, ${report.droppedForeignKeys.length} foreign keys dropped.`);
    if (report.changedIndexes.length > 0) {
        console.log(`Updated indexes: ${report.changedIndexes.join('; ')}`);
    }
}
