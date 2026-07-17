import test from 'node:test';
import assert from 'node:assert/strict';
import { convertPackageToOpenApi } from '../index.js';

// Straight from https://webfunction.org/package
const simplePackage = {
  base_url: 'https://api.example.com',
  name: 'ExamplePackage',
  flags: [],
  docs: 'This package defines endpoints for Example API.',
  errors: [],
  endpoints: [
    {
      name: 'find-user-by',
      returns: ['object'],
      flags: [],
      group: 'users',
      docs: 'Retrieves user data.',
      errors: [],
      arguments: [
        {
          name: 'id',
          type: 'string',
          choices: [],
          flags: ['required'],
          docs: 'Identifier of the user.',
        },
      ],
    },
  ],
};

test('converts base_url to a server entry', () => {
  const doc = convertPackageToOpenApi(simplePackage);
  assert.equal(doc.openapi, '3.1.0');
  assert.deepEqual(doc.servers, [{ url: 'https://api.example.com' }]);
});

test('maps package name/docs/version to info', () => {
  const doc = convertPackageToOpenApi(simplePackage);
  assert.equal(doc.info.title, 'ExamplePackage');
  assert.equal(doc.info.description, 'This package defines endpoints for Example API.');
  assert.equal(doc.info.version, '1.0.0'); // no version given -> fallback
});

test('builds a POST path per endpoint with a request body from arguments', () => {
  const doc = convertPackageToOpenApi(simplePackage);
  const op = doc.paths['/find-user-by'].post;
  assert.equal(op.operationId, 'findUserBy');
  assert.deepEqual(op.tags, ['users']);
  const reqSchema = op.requestBody.content['application/json'].schema;
  assert.deepEqual(reqSchema.properties.id, { type: 'string', description: 'Identifier of the user.' });
  assert.deepEqual(reqSchema.required, ['id']);
});

test('empty choices/values arrays do not produce an enum', () => {
  const doc = convertPackageToOpenApi(simplePackage);
  const reqSchema = doc.paths['/find-user-by'].post.requestBody.content['application/json'].schema;
  assert.equal('enum' in reqSchema.properties.id, false);
});

test('builds response schema from attributes when returns includes object', () => {
  const pkg = {
    base_url: 'https://api.example.com',
    endpoints: [
      {
        name: 'get-user',
        returns: ['object'],
        arguments: [],
        attributes: [
          { name: 'id', type: 'string', hints: ['uuid'] },
          { name: 'age', type: 'number', hints: ['u32'] },
          { name: 'nickname', type: 'string', flags: ['nullable'] },
        ],
      },
    ],
  };
  const doc = convertPackageToOpenApi(pkg);
  const respSchema = doc.paths['/get-user'].post.responses[200].content['application/json'].schema;
  assert.deepEqual(respSchema.properties.id, { type: 'string', format: 'uuid' });
  assert.deepEqual(respSchema.properties.age, { type: 'number', format: 'int32', minimum: 0 });
  assert.deepEqual(respSchema.properties.nickname, { type: ['string', 'null'] });
});

test('handles multiple returns types with oneOf, plus null', () => {
  const pkg = {
    base_url: 'https://api.example.com',
    endpoints: [
      {
        name: 'find-thing',
        returns: ['object', 'null'],
        arguments: [],
        attributes: [{ name: 'id', type: 'string' }],
      },
    ],
  };
  const doc = convertPackageToOpenApi(pkg);
  const schema = doc.paths['/find-thing'].post.responses[200].content['application/json'].schema;
  // Single non-null type + null -> type array, not oneOf
  assert.deepEqual(schema.type, ['object', 'null']);
  assert.ok(schema.properties);
});

test('oneOf used when more than one non-null return type is declared', () => {
  const pkg = {
    base_url: 'https://api.example.com',
    endpoints: [
      {
        name: 'weird-endpoint',
        returns: ['string', 'number'],
        arguments: [],
      },
    ],
  };
  const doc = convertPackageToOpenApi(pkg);
  const schema = doc.paths['/weird-endpoint'].post.responses[200].content['application/json'].schema;
  assert.ok(schema.oneOf);
  assert.equal(schema.oneOf.length, 2);
});

test('error_triple flag adds a 400 response and ErrorTriple schema', () => {
  const pkg = {
    base_url: 'https://api.example.com',
    errors: [{ code: 'RATE_LIMITED', docs: 'Too many requests.' }],
    endpoints: [
      {
        name: 'find-user-by',
        returns: ['object'],
        flags: ['error_triple'],
        arguments: [{ name: 'id', type: 'string', flags: ['required'] }],
        errors: [{ code: 'NOT_FOUND', docs: 'No such user.' }],
      },
    ],
  };
  const doc = convertPackageToOpenApi(pkg);
  const op = doc.paths['/find-user-by'].post;
  assert.equal(op.responses[400].content['application/json'].schema.$ref, '#/components/schemas/ErrorTriple');
  assert.deepEqual(op['x-webfunction-error-codes'].sort(), ['NOT_FOUND', 'RATE_LIMITED']);
  assert.equal(doc.components.schemas.ErrorTriple.type, 'array');
  assert.equal(doc.components.schemas.ErrorTriple.prefixItems.length, 3);
});

test('bearer_auth flag adds security requirement, scheme, and 401 response', () => {
  const pkg = {
    base_url: 'https://api.example.com',
    endpoints: [
      { name: 'secret-thing', returns: ['boolean'], flags: ['bearer_auth'], arguments: [] },
    ],
  };
  const doc = convertPackageToOpenApi(pkg);
  const op = doc.paths['/secret-thing'].post;
  assert.deepEqual(op.security, [{ bearerAuth: [] }]);
  assert.ok(op.responses[401]);
  assert.deepEqual(doc.components.securitySchemes.bearerAuth, { type: 'http', scheme: 'bearer' });
});

test('private endpoints are excluded by default and includable via option', () => {
  const pkg = {
    base_url: 'https://api.example.com',
    endpoints: [
      { name: 'internal-tool', returns: ['boolean'], flags: ['private'], arguments: [] },
      { name: 'public-tool', returns: ['boolean'], flags: [], arguments: [] },
    ],
  };
  const doc = convertPackageToOpenApi(pkg);
  assert.equal(doc.paths['/internal-tool'], undefined);
  assert.ok(doc.paths['/public-tool']);

  const docWithPrivate = convertPackageToOpenApi(pkg, { includePrivate: true });
  assert.ok(docWithPrivate.paths['/internal-tool']);
});

test('versioned package flag adds Api-Version header parameter to every operation', () => {
  const pkg = {
    base_url: 'https://api.example.com',
    flags: ['versioned'],
    version: '2024-01-01',
    versions: ['2023-01-01', '2024-01-01'],
    endpoints: [{ name: 'do-thing', returns: ['boolean'], arguments: [] }],
  };
  const doc = convertPackageToOpenApi(pkg);
  const op = doc.paths['/do-thing'].post;
  assert.ok(op.parameters.some((p) => p.name === 'Api-Version' && p.in === 'header' && p.required));
  assert.equal(doc['x-webfunction-versioned'], true);
  assert.deepEqual(doc.info['x-webfunction-versions'], ['2023-01-01', '2024-01-01']);
});

test('array-typed argument with choices puts enum on items, not the array itself', () => {
  const pkg = {
    base_url: 'https://api.example.com',
    endpoints: [
      {
        name: 'set-roles',
        returns: ['boolean'],
        arguments: [{ name: 'roles', type: 'array', choices: ['admin', 'editor', 'viewer'], flags: ['required'] }],
      },
    ],
  };
  const doc = convertPackageToOpenApi(pkg);
  const schema = doc.paths['/set-roles'].post.requestBody.content['application/json'].schema.properties.roles;
  assert.equal(schema.type, 'array');
  assert.deepEqual(schema.items.enum, ['admin', 'editor', 'viewer']);
});

test('throws on missing base_url or endpoints', () => {
  assert.throws(() => convertPackageToOpenApi({ endpoints: [] }), TypeError);
  assert.throws(() => convertPackageToOpenApi({ base_url: 'https://x.com' }), TypeError);
});

test('endpoint name is joined onto the path with a single leading slash', () => {
  const pkg = {
    base_url: 'https://api.example.com/',
    endpoints: [{ name: '/oddly-slashed/', returns: ['boolean'], arguments: [] }],
  };
  const doc = convertPackageToOpenApi(pkg);
  assert.ok(doc.paths['/oddly-slashed']);
});
