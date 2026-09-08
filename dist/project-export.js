import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, open, unlink } from 'node:fs/promises';
import { basename, dirname, join, parse, relative } from 'node:path';
import { ApiClient } from './api.js';
import { CliError, EXIT } from './errors.js';
import { resolveLocalPath } from './project.js';
async function checkDestination(destination) {
    let cursor = parse(destination).root;
    for (const segment of relative(cursor, dirname(destination)).split(/[\\/]/).filter(Boolean)) {
        cursor = join(cursor, segment);
        const info = await lstat(cursor);
        if (!info.isDirectory() || info.isSymbolicLink())
            throw new CliError('Export requires an existing directory without symbolic links.', EXIT.filesystem, 'unsafe_export_directory');
    }
    try {
        await lstat(destination);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        throw error;
    }
    throw new CliError('The export destination already exists. Choose a new filename.', EXIT.filesystem, 'target_exists');
}
export async function exportProject(input, profile) {
    const args = [...input];
    const projectId = args.shift();
    if (!projectId || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(projectId)) {
        throw new CliError('Use projects export PROJECT_UUID --output ./project.zip.', EXIT.usage, 'invalid_project_id');
    }
    if (args.length !== 2 || args[0] !== '--output' || !args[1] || args[1].startsWith('--')) {
        throw new CliError('Choose a new ZIP filename with --output. Existing files are never replaced.', EXIT.usage, 'export_output_required');
    }
    const destination = resolveLocalPath(args[1]);
    if (!basename(destination).toLowerCase().endsWith('.zip'))
        throw new CliError('The export filename must end in .zip.', EXIT.usage, 'export_output_invalid');
    await checkDestination(destination);
    const client = await ApiClient.create(profile);
    const body = await client.projectArchive(projectId);
    await checkDestination(destination);
    const temporary = join(dirname(destination), `.blinkhost-export-${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
        await file.writeFile(body);
        await file.sync();
        await file.close();
        // A hard link publishes only the complete archive and fails if the destination
        // was created meanwhile. Never rename over an existing customer file.
        await link(temporary, destination);
    }
    catch (error) {
        if (error.code === 'EEXIST')
            throw new CliError('The export destination already exists. Choose a new filename.', EXIT.filesystem, 'target_exists');
        throw error;
    }
    finally {
        await file.close().catch(() => undefined);
        await unlink(temporary);
    }
    return { project_id: projectId, path: destination, size_bytes: body.length,
        sha256: createHash('sha256').update(body).digest('hex'), format: 'zip', extracted: false,
        includes_database_backup: false, includes_runtime_secrets: false,
        next_steps: ['Review the archive before extracting or sharing it.', 'Configure resources and secrets separately in the destination environment.'] };
}
//# sourceMappingURL=project-export.js.map