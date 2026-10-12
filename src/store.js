import { randomUUID } from 'node:crypto';

const EXCERPT_LENGTH = 140;

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`${field} is required`);
  }
  return value.trim();
}

export function slugify(title) {
  const slug = String(title)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'post';
}

function normalizeTags(tags) {
  if (tags === undefined) return [];
  if (!Array.isArray(tags)) throw badRequest('tags must be an array of strings');
  return [...new Set(tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))];
}

function excerpt(body) {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length <= EXCERPT_LENGTH ? flat : `${flat.slice(0, EXCERPT_LENGTH - 1)}…`;
}

function summarize(post) {
  const { body, ...rest } = post;
  return { ...rest, excerpt: excerpt(body), commentCount: post.commentCount ?? 0 };
}

function sortPosts(posts, sort) {
  const sorted = [...posts];
  switch (sort) {
    case 'title':
      return sorted.sort((a, b) => a.title.localeCompare(b.title));
    case 'publishedAt':
      return sorted.sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
    case 'createdAt':
    default:
      return sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

export function createStore() {
  const posts = new Map();
  const comments = new Map();

  function uniqueSlug(title, ignoreId) {
    const base = slugify(title);
    let candidate = base;
    let n = 2;
    while ([...posts.values()].some((post) => post.slug === candidate && post.id !== ignoreId)) {
      candidate = `${base}-${n}`;
      n += 1;
    }
    return candidate;
  }

  function commentsFor(postId) {
    return [...comments.values()]
      .filter((comment) => comment.postId === postId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  function withCount(post) {
    return { ...post, commentCount: commentsFor(post.id).length };
  }

  return {
    create(input = {}) {
      const now = new Date().toISOString();
      const published = input.published === true;
      const post = {
        id: randomUUID(),
        title: nonEmptyString(input.title, 'title'),
        body: nonEmptyString(input.body, 'body'),
        author: typeof input.author === 'string' && input.author.trim() ? input.author.trim() : 'Anonymous',
        tags: normalizeTags(input.tags),
        slug: '',
        published,
        createdAt: now,
        updatedAt: now,
        publishedAt: published ? now : null,
      };
      post.slug = input.slug ? nonEmptyString(input.slug, 'slug') : uniqueSlug(post.title);
      posts.set(post.id, post);
      return withCount(post);
    },

    get(key) {
      const post = [...posts.values()].find((p) => p.id === key || p.slug === key);
      return post ? withCount(post) : null;
    },

    /** List summaries (no full body). */
    list(filters = {}) {
      let result = [...posts.values()];
      if (filters.published !== undefined) {
        result = result.filter((post) => post.published === filters.published);
      }
      if (typeof filters.tag === 'string' && filters.tag.trim() !== '') {
        const tag = filters.tag.trim().toLowerCase();
        result = result.filter((post) => post.tags.includes(tag));
      }
      if (typeof filters.q === 'string' && filters.q.trim() !== '') {
        const needle = filters.q.trim().toLowerCase();
        result = result.filter(
          (post) => post.title.toLowerCase().includes(needle) || post.body.toLowerCase().includes(needle),
        );
      }
      return sortPosts(result, filters.sort).map((post) => summarize(withCount(post)));
    },

    update(key, patch = {}) {
      const post = [...posts.values()].find((p) => p.id === key || p.slug === key);
      if (!post) return null;

      const next = { ...post };
      if ('title' in patch) {
        next.title = nonEmptyString(patch.title, 'title');
        if (!('slug' in patch)) next.slug = uniqueSlug(next.title, post.id);
      }
      if ('body' in patch) next.body = nonEmptyString(patch.body, 'body');
      if ('author' in patch) {
        next.author = typeof patch.author === 'string' && patch.author.trim() ? patch.author.trim() : 'Anonymous';
      }
      if ('tags' in patch) next.tags = normalizeTags(patch.tags);
      if ('slug' in patch) next.slug = nonEmptyString(patch.slug, 'slug');
      if ('published' in patch) {
        next.published = patch.published === true;
        next.publishedAt = next.published ? post.publishedAt ?? new Date().toISOString() : null;
      }
      next.updatedAt = new Date().toISOString();
      posts.set(post.id, next);
      return withCount(next);
    },

    publish(key) {
      const post = [...posts.values()].find((p) => p.id === key || p.slug === key);
      if (!post) return null;
      post.published = true;
      post.publishedAt = post.publishedAt ?? new Date().toISOString();
      post.updatedAt = new Date().toISOString();
      return withCount(post);
    },

    unpublish(key) {
      const post = [...posts.values()].find((p) => p.id === key || p.slug === key);
      if (!post) return null;
      post.published = false;
      post.publishedAt = null;
      post.updatedAt = new Date().toISOString();
      return withCount(post);
    },

    remove(key) {
      const post = [...posts.values()].find((p) => p.id === key || p.slug === key);
      if (!post) return false;
      posts.delete(post.id);
      for (const comment of commentsFor(post.id)) comments.delete(comment.id);
      return true;
    },

    addComment(postKey, input = {}) {
      const post = [...posts.values()].find((p) => p.id === postKey || p.slug === postKey);
      if (!post) return null;
      const comment = {
        id: randomUUID(),
        postId: post.id,
        author: typeof input.author === 'string' && input.author.trim() ? input.author.trim() : 'Anonymous',
        body: nonEmptyString(input.body, 'body'),
        createdAt: new Date().toISOString(),
      };
      comments.set(comment.id, comment);
      return comment;
    },

    listComments(postKey) {
      const post = [...posts.values()].find((p) => p.id === postKey || p.slug === postKey);
      if (!post) return null;
      return commentsFor(post.id);
    },

    removeComment(id) {
      return comments.delete(id);
    },

    stats() {
      const all = [...posts.values()];
      return {
        posts: all.length,
        published: all.filter((post) => post.published).length,
        comments: comments.size,
      };
    },
  };
}
