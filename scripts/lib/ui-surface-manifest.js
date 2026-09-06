'use strict';

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'start' || key === 'end') continue;
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit);
    } else if (value && typeof value.type === 'string') {
      walk(value, visit);
    }
  }
}

function literalString(node) {
  return node?.type === 'Literal' && typeof node.value === 'string' ? node.value : null;
}

function middlewareName(node) {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'CallExpression' && node.callee?.type === 'MemberExpression') {
    const object = node.callee.object?.name;
    const property = node.callee.property?.name;
    return object && property ? `${object}.${property}()` : null;
  }
  return null;
}

function handlerTargets(handler) {
  const pages = new Set();
  const redirects = new Set();

  walk(handler, node => {
    if (node.type !== 'CallExpression') return;

    if (node.callee?.type === 'Identifier' && node.callee.name === 'renderWithCsrf') {
      const target = node.arguments[0];
      if (target?.type !== 'CallExpression' || target.callee?.name !== 'pub') return;
      const parts = target.arguments.map(literalString);
      if (parts.every(part => part !== null)) pages.add(path.posix.join('public', ...parts));
    }

    if (
      node.callee?.type === 'MemberExpression' &&
      node.callee.object?.name === 'res' &&
      node.callee.property?.name === 'redirect'
    ) {
      const target = requestTarget(node.arguments[0]).target;
      redirects.add(target);
    }
  });

  return { pages: [...pages].sort(), redirects: [...redirects].sort() };
}

function extractRoutes(source) {
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const routes = [];
  const inheritedRegistrations = [];

  walk(ast, node => {
    if (
      node.type !== 'CallExpression' ||
      node.callee?.type !== 'MemberExpression' ||
      node.callee.object?.name !== 'app' ||
      node.callee.property?.name !== 'use'
    ) return;
    const mountPath = literalString(node.arguments[0]);
    if (!mountPath?.endsWith('*')) return;
    inheritedRegistrations.push({
      start: node.start,
      prefix: mountPath.slice(0, -1),
      middleware: node.arguments.slice(1).map(middlewareName).filter(Boolean),
    });
  });

  walk(ast, node => {
    if (
      node.type !== 'CallExpression' ||
      node.callee?.type !== 'MemberExpression' ||
      node.callee.object?.name !== 'app' ||
      node.callee.property?.name !== 'get'
    ) return;

    const routePath = literalString(node.arguments[0]);
    if (routePath === null) return;
    const handler = node.arguments.at(-1);
    if (!handler || !['ArrowFunctionExpression', 'FunctionExpression'].includes(handler.type)) return;

    const { pages, redirects } = handlerTargets(handler);
    if (pages.length === 0 && redirects.length === 0) return;

    routes.push({
      method: 'GET',
      path: routePath,
      kind: pages.length > 0 && redirects.length > 0 ? 'mixed' : pages.length > 0 ? 'page' : 'redirect',
      pageTargets: pages,
      redirectTargets: redirects,
      declaredMiddleware: node.arguments.slice(1, -1).map(middlewareName).filter(Boolean),
      inheritedMiddleware: inheritedRegistrations
        .filter(registration => registration.start < node.start && routePath.startsWith(registration.prefix))
        .flatMap(registration => registration.middleware),
    });
  });

  return routes.sort((a, b) => a.method.localeCompare(b.method) || a.path.localeCompare(b.path));
}

function listFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  });
}

function extractPages(root, routes) {
  const publicRoot = path.join(root, 'public');
  const routeMap = new Map();
  for (const route of routes) {
    for (const target of route.pageTargets) {
      const mapped = routeMap.get(target) || [];
      mapped.push(route.path);
      routeMap.set(target, mapped);
    }
  }

  return listFiles(publicRoot)
    .filter(file => file.endsWith('.html'))
    .map(file => {
      const relative = path.relative(root, file).split(path.sep).join('/');
      const source = fs.readFileSync(file, 'utf8');
      const scripts = [];
      const scriptPattern = /<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi;
      for (const match of source.matchAll(scriptPattern)) scripts.push(match[2]);
      return {
        file: relative,
        routes: [...(routeMap.get(relative) || [])].sort(),
        scripts,
      };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}

function requestTarget(node) {
  const literal = literalString(node);
  if (literal !== null) return { target: literal, targetKind: 'literal' };
  if (node?.type === 'TemplateLiteral') {
    const target = node.quasis.map((quasi, index) =>
      quasi.value.cooked + (index < node.expressions.length ? '{dynamic}' : '')
    ).join('');
    return { target, targetKind: 'template' };
  }
  if (node?.type === 'BinaryExpression' && node.operator === '+') {
    const flatten = part => {
      const value = literalString(part);
      if (value !== null) return value;
      if (part?.type === 'BinaryExpression' && part.operator === '+') {
        return `${flatten(part.left)}${flatten(part.right)}`;
      }
      return '{dynamic}';
    };
    return { target: flatten(node), targetKind: 'template' };
  }
  return { target: '{dynamic}', targetKind: 'unresolved' };
}

function requestMethod(options) {
  if (!options) return 'GET';
  if (options.type !== 'ObjectExpression') return 'DYNAMIC';

  let method = 'GET';
  for (const property of options.properties) {
    if (property.type === 'SpreadElement') {
      method = 'DYNAMIC';
      continue;
    }
    if (
      property.type !== 'Property' ||
      property.computed ||
      !((property.key.type === 'Identifier' && property.key.name === 'method') || literalString(property.key) === 'method')
    ) continue;
    const value = literalString(property.value);
    method = value === null ? 'DYNAMIC' : value.toUpperCase();
  }
  return method;
}

function localScriptPath(source) {
  return source.split(/[?#]/, 1)[0];
}

function extractCapabilities(root, pages) {
  const scriptFiles = new Set();
  for (const page of pages) {
    for (const source of page.scripts) {
      if (!source.startsWith('/') || source.startsWith('//')) continue;
      const relative = path.posix.join('public', localScriptPath(source));
      if (fs.existsSync(path.join(root, relative))) scriptFiles.add(relative);
    }
  }

  const capabilities = [];
  for (const script of scriptFiles) {
    const source = fs.readFileSync(path.join(root, script), 'utf8');
    const ast = acorn.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowAwaitOutsideFunction: true,
    });
    walk(ast, node => {
      if (node.type !== 'CallExpression' || node.callee?.type !== 'Identifier' || node.callee.name !== 'fetch') return;
      const request = requestTarget(node.arguments[0]);
      if (request === null) return;
      capabilities.push({
        script,
        transport: 'fetch',
        method: requestMethod(node.arguments[1]),
        target: request.target,
        targetKind: request.targetKind,
      });
    });
  }

  const unique = [...new Map(capabilities.map(capability => [JSON.stringify(capability), capability])).values()];
  return unique.sort((a, b) =>
    a.script.localeCompare(b.script) || a.method.localeCompare(b.method) || a.target.localeCompare(b.target)
  );
}

function buildManifest(root) {
  const routesSource = fs.readFileSync(path.join(root, 'src', 'app', 'registerRoutes.js'), 'utf8');
  const routes = extractRoutes(routesSource);
  const pages = extractPages(root, routes);
  return {
    schemaVersion: 1,
    routes,
    pages,
    capabilities: extractCapabilities(root, pages),
  };
}

function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

module.exports = {
  buildManifest,
  serializeManifest,
};
