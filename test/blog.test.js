import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/app.js';
import { createStore, slugify } from '../src/store.js';

let server;
let base;

before(async () => {
  server = createServer(createStore());
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const api = (path, init) => fetch(`${base}${path}`, init);
const post = (path, body) =>
  api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('store basics', () => {
  test('slugify produces url-safe slugs', () => {
    assert.equal(slugify('Hello, World!'), 'hello-world');
    assert.equal(slugify('  Café déjà vu  '), 'cafe-deja-vu');
    assert.equal(slugify('!!!'), 'post');
  });

  test('generates unique slugs and lowercases tags', () => {
    const store = createStore();
    const a = store.create({ title: 'Same Title', body: 'one', tags: ['Node', 'node', 'API'] });
    const b = store.create({ title: 'Same Title', body: 'two' });
    assert.equal(a.slug, 'same-title');
    assert.equal(b.slug, 'same-title-2');
    assert.deepEqual(a.tags, ['node', 'api']);
  });

  test('requires title and body', () => {
    const store = createStore();
    assert.throws(() => store.create({ body: 'x' }), /title is required/);
    assert.throws(() => store.create({ title: 'x' }), /body is required/);
  });

  test('adds comments and cascades deletes', () => {
    const store = createStore();
    const post = store.create({ title: 'Post', body: 'body' });
    store.addComment(post.id, { author: 'Ada', body: 'Great' });
    assert.equal(store.listComments(post.id).length, 1);

    store.remove(post.id);
    assert.equal(store.get(post.id), null);
    assert.equal(store.stats().comments, 0);
  });

  test('publish sets publishedAt and unpublish clears it', () => {
    const store = createStore();
    const draft = store.create({ title: 'Draft', body: 'x' });
    assert.equal(draft.published, false);

    const published = store.publish(draft.id);
    assert.equal(published.published, true);
    assert.ok(published.publishedAt);

    const unpublished = store.unpublish(draft.id);
    assert.equal(unpublished.published, false);
    assert.equal(unpublished.publishedAt, null);
  });
});

describe('HTTP api', () => {
  test('health reports stats', async () => {
    const res = await api('/health');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok', posts: 0, published: 0, comments: 0 });
  });

  test('creates a post and returns a summary in the list', async () => {
    const res = await post('/api/posts', {
      title: 'First Post',
      body: 'A'.repeat(200),
      tags: ['intro'],
      published: true,
    });
    assert.equal(res.status, 201);
    const created = await res.json();
    assert.equal(created.slug, 'first-post');
    assert.equal(created.commentCount, 0);

    const list = await (await api('/api/posts')).json();
    assert.equal(list.count, 1);
    assert.ok(list.posts[0].excerpt.length <= 140);
    assert.ok(!('body' in list.posts[0]), 'list summaries omit the body');
  });

  test('fetches a post by id and by slug', async () => {
    const created = await (await post('/api/posts', { title: 'Lookup Me', body: 'hi' })).json();
    const byId = await (await api(`/api/posts/${created.id}`)).json();
    const bySlug = await (await api('/api/posts/lookup-me')).json();
    assert.equal(byId.id, created.id);
    assert.equal(bySlug.id, created.id);
  });

  test('rejects a post with no title (400)', async () => {
    const res = await post('/api/posts', { body: 'no title' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /title is required/);
  });

  test('patches a post, re-slugs on title change and bumps updatedAt', async () => {
    const created = await (await post('/api/posts', { title: 'Original', body: 'x' })).json();
    await new Promise((r) => setTimeout(r, 5));
    const patched = await (
      await api(`/api/posts/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Renamed Post' }),
      })
    ).json();
    assert.equal(patched.slug, 'renamed-post');
    assert.notEqual(patched.updatedAt, created.updatedAt);
  });

  test('publish and unpublish actions', async () => {
    const created = await (await post('/api/posts', { title: 'Toggle', body: 'x' })).json();
    const published = await (await post(`/api/posts/${created.id}/publish`)).json();
    assert.equal(published.published, true);
    const unpublished = await (await post(`/api/posts/${created.id}/unpublish`)).json();
    assert.equal(unpublished.published, false);
  });

  test('filters by published, tag and search text', async () => {
    const store = createStore();
    const local = createServer(store);
    await new Promise((r) => local.listen(0, r));
    const lb = `http://127.0.0.1:${local.address().port}`;
    const mk = (body) =>
      fetch(`${lb}/api/posts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    await mk({ title: 'Alpha', body: 'about node', tags: ['node'], published: true });
    await mk({ title: 'Beta', body: 'about css', tags: ['css'], published: false });

    assert.equal((await (await fetch(`${lb}/api/posts?published=true`)).json()).count, 1);
    assert.equal((await (await fetch(`${lb}/api/posts?tag=node`)).json()).count, 1);
    assert.equal((await (await fetch(`${lb}/api/posts?q=node`)).json()).count, 1);

    const bad = await fetch(`${lb}/api/posts?published=maybe`);
    assert.equal(bad.status, 400);

    await new Promise((r) => local.close(r));
  });

  test('comments lifecycle', async () => {
    const created = await (await post('/api/posts', { title: 'Commented', body: 'x' })).json();

    const added = await (await post(`/api/posts/${created.id}/comments`, { author: 'Ada', body: 'Nice' })).json();
    assert.equal(added.author, 'Ada');
    assert.equal(added.postId, created.id);

    const list = await (await api(`/api/posts/${created.id}/comments`)).json();
    assert.equal(list.count, 1);
    assert.equal((await (await api(`/api/posts/${created.id}`)).json()).commentCount, 1);

    const del = await api(`/api/comments/${added.id}`, { method: 'DELETE' });
    assert.equal(del.status, 204);
    assert.equal((await (await api(`/api/posts/${created.id}/comments`)).json()).count, 0);
  });

  test('comment on missing post returns 404', async () => {
    const res = await post('/api/posts/missing/comments', { body: 'x' });
    assert.equal(res.status, 404);
  });

  test('delete a post cascades its comments', async () => {
    const created = await (await post('/api/posts', { title: 'Cascade', body: 'x' })).json();
    await post(`/api/posts/${created.id}/comments`, { body: 'bye' });
    const del = await api(`/api/posts/${created.id}`, { method: 'DELETE' });
    assert.equal(del.status, 204);
    assert.equal((await api(`/api/posts/${created.id}`)).status, 404);
  });

  test('missing post returns 404 and unsupported method 405', async () => {
    assert.equal((await api('/api/posts/nope')).status, 404);
    assert.equal((await api('/api/posts', { method: 'DELETE' })).status, 405);
  });
});
