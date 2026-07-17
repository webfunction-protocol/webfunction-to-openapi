# webfunction-to-openapi

Convert a [Web Function](https://webfunction.org/) package definition into an
[OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0) document.

Plain JavaScript (ESM), no TypeScript, no build step, zero dependencies.

## Install

Copy `index.js` (and `bin/wfn-to-openapi.js` if you want the CLI) into your
project, or drop the whole folder in as a local package:

```json
{
  "dependencies": {
    "webfunction-to-openapi": "file:./vendor/webfunction-to-openapi"
  }
}
```

Requires Node 18+ (or any modern bundler that understands ESM).

## Usage (library)

```js
import { convertPackageToOpenApi } from 'webfunction-to-openapi';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json.wfn', 'utf8'));
const openapi = convertPackageToOpenApi(pkg, { includePrivate: false });

console.log(JSON.stringify(openapi, null, 2));
```

There's also a convenience wrapper if you have a raw JSON string:

```js
import { convertPackageJsonToOpenApi } from 'webfunction-to-openapi';

const openapi = convertPackageJsonToOpenApi(jsonString);
```

### Options

| Option            | Default | Description                                                     |
| ----------------- | ------- | ----------------------------------------------------------------- |
| `includePrivate`  | `false` | Include endpoints flagged `private` in the output. The Web Function spec says documentation tooling SHOULD omit these, so they're excluded by default. |

## Usage (CLI)

```bash
# From a file
node bin/wfn-to-openapi.js package.json.wfn --pretty -o openapi.json

# From stdin
curl -s https://api.example.com/describe | node bin/wfn-to-openapi.js --pretty
```

```
Usage: wfn-to-openapi [input.json] [options]

Options:
  -o, --output <file>   Write the result to a file instead of stdout
  --include-private     Include endpoints flagged as "private"
  --pretty              Pretty-print the JSON output (2-space indent)
  -h, --help            Show this help message
```

## Mapping reference

| Web Function                                   | OpenAPI                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------ |
| `base_url`                                      | `servers[0].url`                                                        |
| `name`, `docs`, `version`                       | `info.title`, `info.description`, `info.version`                       |
| each `endpoints[]` entry                        | a `POST /{name}` path item                                              |
| `endpoint.arguments`                            | `requestBody` JSON schema (required args go in the schema's `required`) |
| `endpoint.attributes` (when `returns` has `object`) | `200` response JSON schema                                          |
| `endpoint.returns`                              | response schema type(s) — multiple types become `oneOf`, `null` becomes a `type` array |
| `hints` (`u32`, `uuid`, `date`, ...)             | JSON Schema `format` (and `minimum: 0` for unsigned ints)               |
| `choices` / `values`                            | `enum` (on `items` when the field type is `array`)                     |
| argument flag `required`                        | listed in the request schema's `required` array                        |
| attribute flag `nullable`                       | field's `type` becomes e.g. `["string", "null"]`                       |
| endpoint flag `bearer_auth`                     | `security: [{ bearerAuth: [] }]` + a `401` response + a `bearerAuth` security scheme |
| endpoint flag `error_triple`                    | a `400` response referencing a shared `ErrorTriple` tuple schema        |
| package/endpoint `errors[]`                     | listed under `x-webfunction-error-codes` on the relevant operation      |
| endpoint flag `private`                         | endpoint is **omitted** unless `includePrivate: true`                   |
| endpoint flag `paginated`                       | `x-webfunction-paginated: true` extension on the operation              |
| endpoint flag `package`                         | `x-webfunction-returns-package: true` extension on the operation        |
| endpoint flag `event_source`                    | `x-webfunction-event-source: true` extension on the operation           |
| endpoint flag `capture_bearer`                  | `x-webfunction-capture-bearer: true` extension on the operation         |
| package flag `versioned`                        | adds a required `Api-Version` header parameter to every operation, plus `x-webfunction-versioned` / `x-webfunction-versions` |
| `event_source_url`, `pipeline_url`              | `x-webfunction-event-source-url`, `x-webfunction-pipeline-url` extensions on the document |
| `events[]`                                      | `x-webfunction-events` extension (SSE streams aren't first-class in OpenAPI 3, so these are documented rather than turned into paths) |

Anything Web Function doesn't have a direct OpenAPI equivalent for is kept as
an `x-webfunction-*` [specification extension](https://spec.openapis.org/oas/v3.1.0#specification-extensions)
rather than silently dropped.

## What this doesn't do

- It doesn't validate that the input actually conforms to the Web Function
  spec (required keys, RFC 3986 URLs, flag scoping, etc.) — it assumes
  well-formed input and will throw a `TypeError` only for the handful of
  fields it strictly needs (`base_url`, `endpoints`).
- Pipelining and SSE event streams don't map cleanly onto OpenAPI's
  request/response model, so they're carried through as extensions/notes
  rather than modeled as paths.
- Output targets OpenAPI **3.1**, since it's the version aligned with JSON
  Schema 2020-12 (needed for tuple validation on the `ErrorTriple` schema,
  and clean `null` handling). If you need 3.0.x, the `nullable: true` /
  `type` differences and the `prefixItems` → `items` tuple downgrade are the
  main things to adjust.

## Tests

```bash
npm test
```
