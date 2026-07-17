/**
 * webfunction-to-openapi
 *
 * Converts a Web Function package definition (https://webfunction.org/package)
 * into an OpenAPI 3.1 document.
 *
 * Plain JavaScript, no TypeScript, no build step, no dependencies.
 */

/** JSON-type -> list of hint names whose base type matches it. */
const HINT_BASE_TYPE = {
  u32: 'number',
  u64: 'number',
  i32: 'number',
  i64: 'number',
  f32: 'number',
  f64: 'number',
  timestamp: 'number',
  date: 'string',
  time: 'string',
  datetime: 'string',
  uuid: 'string',
  base64: 'string',
  email: 'string',
  phone: 'string',
  url: 'string',
  uri: 'string',
  ipv4: 'string',
  ipv6: 'string',
  hostname: 'string',
};

/** hint name -> partial JSON Schema fragment to merge in. */
const HINT_SCHEMA = {
  u32: { format: 'int32', minimum: 0 },
  u64: { format: 'int64', minimum: 0 },
  i32: { format: 'int32' },
  i64: { format: 'int64' },
  f32: { format: 'float' },
  f64: { format: 'double' },
  timestamp: { format: 'int64', description: 'Unix timestamp (seconds since the epoch).' },
  date: { format: 'date' },
  time: { format: 'time' },
  datetime: { format: 'date-time' },
  uuid: { format: 'uuid' },
  base64: { format: 'byte' },
  email: { format: 'email' },
  phone: { description: 'Phone number in E.164 format.' },
  url: { format: 'uri' },
  uri: { format: 'uri' },
  ipv4: { format: 'ipv4' },
  ipv6: { format: 'ipv6' },
  hostname: { format: 'hostname' },
};

function pickHint(hints, jsonType) {
  if (!hints || !hints.length) return null;
  return hints.find((h) => HINT_BASE_TYPE[h] === jsonType) || null;
}

function stripSlashes(name) {
  return String(name).replace(/^\/+/, '').replace(/\/+$/, '');
}

/** camelCase an endpoint/kebab-case name for use as an operationId. */
function toOperationId(name) {
  return String(name)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part, i) => (i === 0 ? part.toLowerCase() : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()))
    .join('');
}

/**
 * Build a JSON Schema fragment for a single argument or attribute definition.
 * Arguments and attributes share the same shape (name, type, hints, flags,
 * docs) except arguments use `choices` and attributes use `values`.
 */
function fieldSchema(field) {
  const allowedValues = field.choices || field.values || null;
  const flags = field.flags || [];
  const schema = { type: field.type };

  if (field.type === 'array') {
    schema.items = {};
    if (allowedValues && allowedValues.length) {
      schema.items.enum = allowedValues;
    }
  } else {
    const hint = pickHint(field.hints, field.type);
    if (hint) Object.assign(schema, HINT_SCHEMA[hint]);
    if (allowedValues && allowedValues.length) {
      schema.enum = allowedValues;
    }
  }

  if (flags.includes('nullable')) {
    schema.type = Array.isArray(schema.type) ? schema.type : [schema.type, 'null'];
  }

  if (field.docs) schema.description = field.docs;

  return schema;
}

/** Build an object schema (properties + required) from an attributes array. */
function attributesToSchema(attributes) {
  const properties = {};
  for (const attr of attributes || []) {
    properties[attr.name] = fieldSchema(attr);
  }
  const schema = { type: 'object', properties };
  if (!Object.keys(properties).length) {
    // No attributes declared: leave the shape open rather than forbidding
    // properties outright, since the spec doesn't require attributes to be
    // exhaustive.
    schema.additionalProperties = true;
  }
  return schema;
}

/** Build an object schema (properties + required) from an arguments array. */
function argumentsToRequestSchema(args) {
  const properties = {};
  const required = [];
  for (const arg of args || []) {
    properties[arg.name] = fieldSchema(arg);
    if ((arg.flags || []).includes('required')) required.push(arg.name);
  }
  const schema = { type: 'object', properties, additionalProperties: false };
  if (required.length) schema.required = required;
  return schema;
}

/** Build the schema for one of an endpoint's declared `returns` JSON types. */
function returnTypeSchema(type, endpoint) {
  if (type === 'object') return attributesToSchema(endpoint.attributes);
  if (type === 'array') return { type: 'array', items: {} };
  const schema = { type };
  const hint = pickHint(endpoint.hints, type);
  if (hint) Object.assign(schema, HINT_SCHEMA[hint]);
  return schema;
}

/** Build the full response schema for an endpoint, combining its `returns` types. */
function buildResponseSchema(endpoint) {
  const types = endpoint.returns || [];
  const nonNull = types.filter((t) => t !== 'null');
  const nullable = types.includes('null');

  let schema;
  if (nonNull.length === 0) {
    schema = {};
  } else if (nonNull.length === 1) {
    schema = returnTypeSchema(nonNull[0], endpoint);
  } else {
    schema = { oneOf: nonNull.map((t) => returnTypeSchema(t, endpoint)) };
  }

  if (nullable) {
    if (schema.oneOf) {
      schema.oneOf.push({ type: 'null' });
    } else if (schema.type) {
      schema.type = Array.isArray(schema.type) ? schema.type : [schema.type, 'null'];
    } else {
      schema = { type: 'null' };
    }
  }

  return schema;
}

/** Build a single OpenAPI Operation object for one Web Function endpoint. */
function buildOperation(endpoint, pkg) {
  const flags = endpoint.flags || [];

  const operation = {
    operationId: toOperationId(endpoint.name),
    summary: endpoint.name,
  };
  if (endpoint.group) operation.tags = [endpoint.group];
  if (endpoint.docs) operation.description = endpoint.docs;

  operation.requestBody = {
    required: true,
    content: {
      'application/json': { schema: argumentsToRequestSchema(endpoint.arguments) },
    },
  };

  operation.responses = {
    200: {
      description: 'Successful response.',
      content: {
        'application/json': { schema: buildResponseSchema(endpoint) },
      },
    },
  };

  if (flags.includes('bearer_auth')) {
    operation.security = [{ bearerAuth: [] }];
    operation.responses[401] = { description: 'Missing or invalid bearer token.' };
  }

  if (flags.includes('error_triple')) {
    operation.responses[400] = {
      description: 'Error response, formatted as an error triple.',
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/ErrorTriple' } },
      },
    };
    const codes = [...(pkg.errors || []), ...(endpoint.errors || [])].map((e) => e.code);
    if (codes.length) operation['x-webfunction-error-codes'] = [...new Set(codes)];
  }

  if (flags.includes('paginated')) operation['x-webfunction-paginated'] = true;
  if (flags.includes('package')) operation['x-webfunction-returns-package'] = true;
  if (flags.includes('event_source')) operation['x-webfunction-event-source'] = true;
  if (flags.includes('capture_bearer')) operation['x-webfunction-capture-bearer'] = true;

  return operation;
}

/**
 * Convert a Web Function package definition into an OpenAPI 3.1 document.
 *
 * @param {object} pkg - A parsed Web Function package (see https://webfunction.org/package).
 * @param {object} [options]
 * @param {boolean} [options.includePrivate=false] - Include endpoints flagged `private`.
 * @returns {object} An OpenAPI 3.1 document (plain JSON-serializable object).
 */
function convertPackageToOpenApi(pkg, options = {}) {
  const includePrivate = options.includePrivate ?? false;

  if (!pkg || typeof pkg !== 'object') {
    throw new TypeError('convertPackageToOpenApi: pkg must be an object');
  }
  if (!pkg.base_url || typeof pkg.base_url !== 'string') {
    throw new TypeError('convertPackageToOpenApi: pkg.base_url is required and must be a string');
  }
  if (!Array.isArray(pkg.endpoints)) {
    throw new TypeError('convertPackageToOpenApi: pkg.endpoints is required and must be an array');
  }

  const paths = {};
  for (const endpoint of pkg.endpoints) {
    const flags = endpoint.flags || [];
    if (flags.includes('private') && !includePrivate) continue;
    const path = '/' + stripSlashes(endpoint.name);
    paths[path] = { post: buildOperation(endpoint, pkg) };
  }

  const usesBearer = pkg.endpoints.some((e) => (e.flags || []).includes('bearer_auth'));
  const usesErrorTriple = pkg.endpoints.some((e) => (e.flags || []).includes('error_triple'));

  const components = {};
  if (usesBearer) {
    components.securitySchemes = { bearerAuth: { type: 'http', scheme: 'bearer' } };
  }
  if (usesErrorTriple) {
    components.schemas = {
      ErrorTriple: {
        type: 'array',
        description: 'Web Function error triple: [ERROR_CODE, ERROR_MESSAGE, ERROR_DETAILS].',
        prefixItems: [
          { type: 'string', description: 'ERROR_CODE' },
          { type: 'string', description: 'ERROR_MESSAGE' },
          { description: 'ERROR_DETAILS' },
        ],
        items: false,
        minItems: 3,
      },
    };
  }

  const openapi = {
    openapi: '3.1.0',
    info: {
      title: pkg.name || 'Web Function API',
      version: pkg.version || '1.0.0',
    },
    servers: [{ url: pkg.base_url }],
    paths,
  };
  if (pkg.docs) openapi.info.description = pkg.docs;
  if (Object.keys(components).length) openapi.components = components;

  if (pkg.flags && pkg.flags.includes('versioned')) {
    openapi['x-webfunction-versioned'] = true;
    if (pkg.versions && pkg.versions.length) openapi.info['x-webfunction-versions'] = pkg.versions;
    const versionParam = {
      name: 'Api-Version',
      in: 'header',
      required: true,
      schema: { type: 'string' },
      description: 'Requested API version.',
    };
    for (const item of Object.values(paths)) {
      for (const op of Object.values(item)) {
        op.parameters = [...(op.parameters || []), versionParam];
      }
    }
  }

  if (pkg.event_source_url) openapi['x-webfunction-event-source-url'] = pkg.event_source_url;
  if (pkg.pipeline_url) openapi['x-webfunction-pipeline-url'] = pkg.pipeline_url;

  if (pkg.events && pkg.events.length) {
    openapi['x-webfunction-events'] = pkg.events.map((ev) => ({
      name: ev.name,
      ...(ev.group ? { group: ev.group } : {}),
      ...(ev.docs ? { docs: ev.docs } : {}),
      schema: attributesToSchema(ev.attributes),
    }));
  }

  if (pkg.errors && pkg.errors.length) {
    openapi['x-webfunction-package-errors'] = pkg.errors;
  }

  return openapi;
}

/**
 * Convenience wrapper: parse a JSON string containing a Web Function package
 * and convert it to an OpenAPI 3.1 document.
 *
 * @param {string} json
 * @param {object} [options]
 * @returns {object}
 */
function convertPackageJsonToOpenApi(json, options) {
  return convertPackageToOpenApi(JSON.parse(json), options);
}

export { convertPackageToOpenApi, convertPackageJsonToOpenApi };
export default convertPackageToOpenApi;
