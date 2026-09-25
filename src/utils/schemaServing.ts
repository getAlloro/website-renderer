type SchemaObject = Record<string, unknown>;

function isSchemaObject(value: unknown): value is SchemaObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseHttpUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

function sourceOriginForSchema(schemas: SchemaObject[], servingOrigin: string): string | null {
  for (const schema of schemas) {
    // A business entity with an address describes this site. Its stored URL
    // can still point to the practice's old website after a v2 migration.
    if (!isSchemaObject(schema.address)) continue;
    const url = parseHttpUrl(schema.url);
    if (url && url.origin !== servingOrigin) return url.origin;
  }
  for (const schema of schemas) {
    // Post schema may have no business entity; its breadcrumb items still
    // identify the site's former origin.
    if (schema['@type'] !== 'BreadcrumbList' || !Array.isArray(schema.itemListElement)) continue;
    for (const item of schema.itemListElement) {
      if (!isSchemaObject(item)) continue;
      const url = parseHttpUrl(item.item);
      if (url && url.origin !== servingOrigin) return url.origin;
    }
  }
  return null;
}

function rewriteInternalSchemaUrls(value: unknown, sourceOrigin: string, servingOrigin: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteInternalSchemaUrls(item, sourceOrigin, servingOrigin));
  }
  if (!isSchemaObject(value)) return value;

  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (typeof child === 'string' && ['url', 'item', '@id'].includes(key)) {
      const url = parseHttpUrl(child);
      if (url?.origin === sourceOrigin) {
        return [key, `${servingOrigin}${url.pathname}${url.search}${url.hash}`];
      }
    }
    return [key, rewriteInternalSchemaUrls(child, sourceOrigin, servingOrigin)];
  }));
}

/** Align site URLs in generated JSON-LD with the host that actually serves it. */
export function schemaForServing(
  schemas: SchemaObject[],
  servingHost: string
): SchemaObject[] {
  const servingOrigin = `https://${servingHost}`;
  const sourceOrigin = sourceOriginForSchema(schemas, servingOrigin);
  if (!sourceOrigin) return schemas;
  return schemas.map((schema) =>
    rewriteInternalSchemaUrls(schema, sourceOrigin, servingOrigin) as SchemaObject
  );
}
