import { ApiClient } from './api.js';
import { CliError, EXIT } from './errors.js';

export function designArguments(args: string[]): { project: string; body: Record<string, unknown> } {
  args = [...args];
  const action = args.shift() || 'list';
  const take = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i < 0) return;
    const value = args[i + 1];
    if (!value || value.startsWith('--')) throw new CliError(`${name} needs a value.`, EXIT.usage, 'missing_option_value');
    args.splice(i, 2);
    return value;
  };
  const project = take('--project');
  const revision = take('--revision');
  const framework = take('--framework');
  const limit = take('--limit');
  const attachment = take('--attachment');
  const imageIndex = take('--image-index');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!project || !uuid.test(project)) throw new CliError('Use --project with the project UUID.', EXIT.usage, 'project_id_invalid');
  const resources: Record<string, string> = { list: 'design_catalogue', search: 'design_search', show: 'design_reference', notices: 'design_notices' };
  if (!resources[action]) throw new CliError('Use design list, search QUERY, show REFERENCE_ID or notices REFERENCE_ID.', EXIT.usage, 'design_command_invalid');
  const body: Record<string, unknown> = { resource: resources[action] };
  if (action === 'search') {
    const query = args.shift();
    if (!query || query.trim().length < 2 || query.length > 600 || /[\x00-\x1f\x7f]/.test(query))
      throw new CliError('Use a focused search of 2–600 characters.', EXIT.usage, 'design_query_invalid');
    body.design_query = query.trim();
    if (framework) body.design_framework = framework;
    if (limit) {
      if (!/^[1-8]$/.test(limit)) throw new CliError('--limit must be 1–8.', EXIT.usage, 'design_limit_invalid');
      body.design_limit = Number(limit);
    }
    if (attachment) {
      if (!uuid.test(attachment) || (imageIndex !== undefined && !/^[0-7]$/.test(imageIndex)))
        throw new CliError('Use a ready upload UUID and an image index of 0–7.', EXIT.usage, 'design_image_invalid');
      body.attachment_id = attachment;
      body.design_image_index = Number(imageIndex || '0');
    } else if (imageIndex !== undefined) throw new CliError('--image-index needs --attachment.', EXIT.usage, 'design_image_invalid');
    if (revision) args.push('--revision');
  } else {
    if (framework || limit || attachment || imageIndex !== undefined) args.push('search-only options');
    if (action !== 'list') {
      const reference = args.shift();
      if (!reference || reference.length > 190 || /[\x00-\x1f\x7f]/.test(reference) || !revision || !/^[a-f0-9]{64}$/.test(revision))
        throw new CliError('Use a reference ID and --revision from design search.', EXIT.usage, 'design_reference_invalid');
      body.design_reference_id = reference;
      body.design_revision = revision;
    } else if (revision) args.push('--revision');
  }
  if (args.length) throw new CliError('Unexpected design argument. Use blinkhost help design.', EXIT.usage, 'unexpected_argument');
  return { project, body };
}

export async function runDesign(args: string[], profile?: string): Promise<unknown> {
  const { project, body } = designArguments(args);
  const client = await ApiClient.create(profile);
  const metadata = await client.request(`/api/sites/${project}/`) as { id?: unknown; organization?: unknown } | null;
  const workspace = metadata?.organization;
  if (metadata?.id !== project || !(typeof workspace === 'string' && /^[1-9]\d*$/.test(workspace)
      || typeof workspace === 'number' && Number.isSafeInteger(workspace) && workspace > 0)) {
    throw new CliError('Design references need an accessible project in a workspace.', EXIT.remote, 'project_workspace_unavailable');
  }
  return client.request(`/api/idam/projects/${project}/design-references/`, {
    method: 'POST', headers: { 'X-Organization-Id': String(workspace) }, body: JSON.stringify(body),
  });
}
