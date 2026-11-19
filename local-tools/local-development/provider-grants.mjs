/** Explicit grants to fixtures created by this local stack, never caller URLs. */
function fail(code) { throw new Error(code); }

export function providerPermissions(value, providers) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2 || value.module !== 'customer-local'
    || !Array.isArray(value.fixtures) || !value.fixtures.length || value.fixtures.length > 8
    || new Set(value.fixtures).size !== value.fixtures.length
    || value.fixtures.some(name => typeof name !== 'string' || !Object.hasOwn(providers, name))) {
    fail('invalid_local_provider_permissions');
  }
  for (const name of value.fixtures) {
    if (!/^[a-z][a-z0-9-]{0,46}[a-z0-9]$|^[a-z]$/.test(name)) fail('invalid_local_provider_permissions');
    for (const route of providers[name].routes) {
      if (route.path.length > 2048 || /[%\\?#\s\u0080-\uffff]/.test(route.path)
        || route.path.startsWith('//') || new URL('http://127.0.0.1:1' + route.path).pathname !== route.path) {
        fail('invalid_local_provider_permissions');
      }
    }
  }
  return { module: value.module, fixtures: [...value.fixtures] };
}

export function localProviderGrant(permissions, artifactSha256, definitions, started) {
  if (!permissions) return null;
  return { artifact_sha256: artifactSha256, module: permissions.module,
    fixtures: permissions.fixtures.map(name => {
      const owned = started.find(provider => provider.name === name);
      if (!owned || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(owned.fixture.origin)) {
        fail('local_provider_owned_fixture_missing');
      }
      return { name, origin: owned.fixture.origin,
        routes: definitions[name].routes.map(({ method, path }) => ({ method, path })) };
    }) };
}
