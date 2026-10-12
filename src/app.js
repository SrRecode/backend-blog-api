import http from 'node:http';
import { createStore } from './store.js';

const MAX_BODY_BYTES = 64 * 1024;

function send(res, status, payload, headers = {}) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(Object.assign(new Error('Body must be a JSON object'), { status: 400 }));
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function parseBoolean(value) {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw Object.assign(new Error('published filter must be true or false'), { status: 400 });
}

export function createHandler(store = createStore()) {
  return async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const { pathname, searchParams } = url;
      const method = req.method ?? 'GET';

      if (pathname === '/health' && method === 'GET') {
        return send(res, 200, { status: 'ok', ...store.stats() });
      }

      if (pathname === '/api/posts') {
        if (method === 'GET') {
          const posts = store.list({
            published: parseBoolean(searchParams.get('published') ?? undefined),
            tag: searchParams.get('tag') ?? undefined,
            q: searchParams.get('q') ?? undefined,
            sort: searchParams.get('sort') ?? undefined,
          });
          return send(res, 200, { posts, count: posts.length });
        }
        if (method === 'POST') {
          const body = await readJson(req);
          return send(res, 201, store.create(body));
        }
        return send(res, 405, { error: 'Method not allowed' });
      }

      // Comments on a post: /api/posts/:key/comments
      const commentMatch = pathname.match(/^\/api\/posts\/([^/]+)\/comments$/);
      if (commentMatch) {
        const key = decodeURIComponent(commentMatch[1]);
        if (method === 'GET') {
          const comments = store.listComments(key);
          if (comments === null) return send(res, 404, { error: 'Post not found' });
          return send(res, 200, { comments, count: comments.length });
        }
        if (method === 'POST') {
          const body = await readJson(req);
          const comment = store.addComment(key, body);
          if (!comment) return send(res, 404, { error: 'Post not found' });
          return send(res, 201, comment);
        }
        return send(res, 405, { error: 'Method not allowed' });
      }

      // Publish actions: /api/posts/:key/publish|unpublish
      const actionMatch = pathname.match(/^\/api\/posts\/([^/]+)\/(publish|unpublish)$/);
      if (actionMatch && method === 'POST') {
        const key = decodeURIComponent(actionMatch[1]);
        const post = actionMatch[2] === 'publish' ? store.publish(key) : store.unpublish(key);
        if (!post) return send(res, 404, { error: 'Post not found' });
        return send(res, 200, post);
      }

      const itemMatch = pathname.match(/^\/api\/posts\/([^/]+)$/);
      if (itemMatch) {
        const key = decodeURIComponent(itemMatch[1]);
        if (method === 'GET') {
          const post = store.get(key);
          if (!post) return send(res, 404, { error: 'Post not found' });
          return send(res, 200, post);
        }
        if (method === 'PATCH' || method === 'PUT') {
          const body = await readJson(req);
          const post = store.update(key, body);
          if (!post) return send(res, 404, { error: 'Post not found' });
          return send(res, 200, post);
        }
        if (method === 'DELETE') {
          const removed = store.remove(key);
          if (!removed) return send(res, 404, { error: 'Post not found' });
          return send(res, 204, undefined);
        }
        return send(res, 405, { error: 'Method not allowed' });
      }

      const commentItem = pathname.match(/^\/api\/comments\/([^/]+)$/);
      if (commentItem) {
        const id = decodeURIComponent(commentItem[1]);
        if (method === 'DELETE') {
          const removed = store.removeComment(id);
          if (!removed) return send(res, 404, { error: 'Comment not found' });
          return send(res, 204, undefined);
        }
        return send(res, 405, { error: 'Method not allowed' });
      }

      return send(res, 404, { error: 'Not found' });
    } catch (error) {
      const status = error.status ?? 500;
      return send(res, status, { error: error.message ?? 'Internal server error' });
    }
  };
}

export function createServer(store) {
  return http.createServer(createHandler(store));
}
