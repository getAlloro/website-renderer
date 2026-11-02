const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { after, beforeEach, test } = require('node:test');
const vm = require('node:vm');
const { inspectGenerationStyle, generationArtifactHash } = require('../dist/utils/generation-style');
const { processTailwindCSS } = require('../dist/utils/tailwind');
const { GenerationRenderModel } = require('../dist/models/GenerationRenderModel');
const { resolveGenerationRender, resolveGenerationSinglePost, resolvePrivateGenerationCandidate, resolveGenerationCandidatePage, resolveGenerationCandidatePostLayout } = require('../dist/services/generation-render.service');
const { bindWorktreePreviewNavigation, worktreePreviewDestination } = require('../dist/utils/worktree-preview-navigation');
const singlePosts = require('../dist/services/singlepost.service');
const { ProjectPostBlockModel } = require('../dist/models/ProjectPostBlockModel');
const database = require('../dist/lib/db');
const redis = require('../dist/lib/redis');
const { resolvePostBlocks } = require('../dist/services/postblock.service');
const site = require('../dist/routes/site');
const { worktreeGenerationPreviewRoute } = require('../dist/routes/generation-preview');
const original = { pinned: GenerationRenderModel.findPinned, runs: GenerationRenderModel.publishedRunIds,
  candidate: GenerationRenderModel.findCandidateArtifact, privateRun: GenerationRenderModel.findPrivateRun, singlePost: singlePosts.getSinglePostData,
  privatePage: GenerationRenderModel.findPrivatePage, block: ProjectPostBlockModel.findPinned,
  db: database.getDb, redis: redis.getRedis, assemble: site.assembleHtml };
const css = '.site{--site-primary:#a6192e;color:var(--site-primary)}';
const styleHash = createHash('sha256').update(css).digest('hex');
const wrapper = `<html data-generation-contract="1"><head><style data-alloro-generation-style="1" data-content-hash="${styleHash}">${css}</style></head><body class="site">{{slot}}</body></html>`;
const project = { id: 'project-1', organization_id: 12, wrapper: 'LEGACY', header: 'OLD', footer: 'OLD' };
let payload;
beforeEach(() => {
  GenerationRenderModel.findCandidateArtifact = original.candidate;
  GenerationRenderModel.findPrivateRun = original.privateRun;
  GenerationRenderModel.findPrivatePage = original.privatePage;
  singlePosts.getSinglePostData = original.singlePost;
  site.assembleHtml = original.assemble;
  payload = { runId: 'run-1', wrapper, header: '<header>Confirmed brand</header>', footer: '<footer>Confirmed reach</footer>', styleHash, planHash: 'plan-hash' };
  GenerationRenderModel.findPinned = async (projectId, organizationId, runId) => {
    assert.equal(projectId, 'project-1'); assert.equal(organizationId, 12); assert.equal(runId, 'run-1');
    return [{ payload, content_hash: generationArtifactHash(payload) }];
  };
});
after(() => { GenerationRenderModel.findPinned = original.pinned; GenerationRenderModel.publishedRunIds = original.runs;
  GenerationRenderModel.findCandidateArtifact = original.candidate; GenerationRenderModel.findPrivateRun = original.privateRun; singlePosts.getSinglePostData = original.singlePost;
  GenerationRenderModel.findPrivatePage = original.privatePage; ProjectPostBlockModel.findPinned = original.block;
  database.getDb = original.db; redis.getRedis = original.redis; site.assembleHtml = original.assemble; });

test('published and draft custom pages preserve exactly compiled CSS without a browser compiler', async () => {
  for (const draft of [false, true]) {
    const output = await processTailwindCSS(wrapper.replace('{{slot}}', '<h1>Brand</h1>'), draft);
    assert.equal(inspectGenerationStyle(output).cssHash, styleHash);
    assert.doesNotMatch(output, /cdn.tailwindcss|data-tailwind-compiled/);
    assert.ok(output.includes(css));
  }
});

const candidateProjectId = '11111111-1111-4111-8111-111111111111';
const candidateRunId = '22222222-2222-4222-8222-222222222222';
const candidateId = '33333333-3333-4333-8333-333333333333';
const pageArtifactId = '44444444-4444-4444-8444-444444444444';
const planHash = 'a'.repeat(64);
const candidateProject = { ...project, id: candidateProjectId, template_id: 'template-a' };
function candidateFixture(attempt = 0, marker = 'Original') {
  const id = attempt ? '55555555-5555-4555-8555-555555555555' : candidateId;
  const pageId = attempt ? '66666666-6666-4666-8666-666666666666' : pageArtifactId;
  const page = { pageKey: 'home', path: '/', title: 'Home', sections: [{ name: 'intro', content: `<h1>${marker}</h1><a href="/about#team">About</a>` }], seo: { meta_title: marker, meta_description: 'Saved candidate' } };
  const pagePayload = { runId: candidateRunId, planHash, page };
  const manifest = { schemaVersion: 1, projectId: candidateProjectId, organizationId: 12, runId: candidateRunId, attempt, planHash,
    render: { runId: candidateRunId, planHash, wrapper, header: `<header>${marker} header</header>`, footer: '<footer>Saved footer</footer>', styleHash,
      singlePostLayouts: [{ postTypeId: 'post-type-a', sections: [{ name: 'detail', content: '<article><h1>{{post.title}}</h1><div>{{post.content}}</div></article>' }] }] },
    pageRefs: [{ pageKey: 'home', path: '/', title: 'Home', artifactId: pageId, contentHash: generationArtifactHash(pagePayload) }] };
  const row = (artifactId, kind, key, data) => ({ id: artifactId, project_id: candidateProjectId, organization_id: 12, run_id: candidateRunId,
    schema_version: 1, object_key: null, kind, artifact_key: key, payload: data, content_hash: generationArtifactHash(data) });
  return { id, pageId, manifest: row(id, 'publication_snapshot', `review-candidate:${attempt}`, manifest),
    page: row(pageId, 'page', `review-candidate:${attempt}:page:home`, pagePayload) };
}
function useCandidates(...fixtures) {
  const rows = new Map(fixtures.flatMap(fixture => [[fixture.id, fixture.manifest], [fixture.pageId, fixture.page]]));
  GenerationRenderModel.findPrivateRun = async (projectId, runId) => projectId === candidateProjectId && runId === candidateRunId ? candidateProject : null;
  GenerationRenderModel.findCandidateArtifact = async (projectId, organizationId, runId, id) => {
    assert.equal(projectId, candidateProjectId); assert.equal(organizationId, 12); assert.equal(runId, candidateRunId);
    return rows.get(id);
  };
  GenerationRenderModel.findPinned = async () => { throw new Error('CANONICAL_FALLBACK_FORBIDDEN'); };
  GenerationRenderModel.findPrivatePage = async () => { throw new Error('NATIVE_PAGE_FALLBACK_FORBIDDEN'); };
  database.getDb = () => () => {
    const query = { where: () => query, orderBy: () => query, whereIn: () => query, select: () => query,
      then: (resolve, reject) => Promise.resolve([]).then(resolve, reject) };
    return query;
  };
  redis.getRedis = () => ({ get: async () => null, set: async () => {} });
  return rows;
}
function responseRecorder() {
  const output = { status: 200, body: '', headers: {} };
  const res = { status(code) { output.status = code; return this; }, end() {},
    setHeader(key, value) { output.headers[key] = value; }, type() { return this; }, send(html) { output.body = html; } };
  return { output, res };
}
async function candidateRequest(query = {}, remoteAddress = '127.0.0.1') {
  const { output, res } = responseRecorder();
  await worktreeGenerationPreviewRoute({ params: { projectId: candidateProjectId, runId: candidateRunId },
    query: { path: '/', candidateId, ...query }, socket: { remoteAddress }, get: () => 'fixture.localhost' }, res);
  return output;
}

test('candidate lookup filters exact artifact, project, organization and run through the model', async () => {
  let selected;
  database.getDb = () => table => {
    assert.equal(table, 'generation_artifacts as artifact');
    const query = { join(name, callback) { assert.equal(name, 'generation_runs as run');
      const joins = []; const join = { on(a,b) { joins.push([a,b]); return this; }, andOn(a,b) { joins.push([a,b]); return this; } };
      callback.call(join); assert.equal(joins.length, 3); return query; },
    where(value) { selected = value; return query; }, select() { return query; }, first: async () => undefined };
    return query;
  };
  await GenerationRenderModel.findCandidateArtifact(candidateProjectId, 12, candidateRunId, candidateId);
  assert.deepEqual(selected, { 'artifact.id': candidateId, 'artifact.project_id': candidateProjectId, 'artifact.organization_id': 12, 'artifact.run_id': candidateRunId });
});
test('old candidates keep exact page, chrome and style when a later attempt exists', async () => {
  const first = candidateFixture(), second = candidateFixture(1, 'Newer'); useCandidates(first, second);
  const selected = await resolvePrivateGenerationCandidate(candidateProjectId, candidateRunId, first.id);
  const page = await resolveGenerationCandidatePage(selected, '/');
  const html = await site.assembleResolvedHtml(selected.project, page, 'fixture.localhost');
  assert.ok(html.includes('Original header')); assert.ok(html.includes('<h1>Original</h1>')); assert.ok(!html.includes('Newer'));
  assert.equal(inspectGenerationStyle(html).cssHash, styleHash); assert.equal(candidateProject.wrapper, 'LEGACY');
  assert.equal(await resolveGenerationCandidatePage(selected, '/not-selected'), null);
  await assert.rejects(resolvePrivateGenerationCandidate('foreign-project', candidateRunId, first.id), { status: 404 });
});
test('tampered candidate scope, manifest, style and page bindings refuse even when outer hashes are recomputed', async () => {
  const mutations = [
    f => { f.manifest.payload.projectId = 'foreign'; }, f => { f.manifest.payload.organizationId = 99; },
    f => { f.manifest.payload.runId = 'foreign'; }, f => { f.manifest.payload.render.runId = 'foreign'; },
    f => { f.manifest.payload.render.planHash = 'b'.repeat(64); }, f => { f.manifest.artifact_key = 'site-render'; },
    f => { f.manifest.payload.pageRefs.push({ ...f.manifest.payload.pageRefs[0] }); },
    f => { f.manifest.payload.render.wrapper = wrapper.replace(css, css + 'p{color:red}'); },
    f => { f.manifest.payload.pageRefs[0].contentHash = 'b'.repeat(64); },
    f => { f.page.payload.page.title = 'Different'; }, f => { f.page.payload.planHash = 'b'.repeat(64); },
    f => { f.page.artifact_key = 'review-candidate:1:page:home'; }, f => { f.page.organization_id = 99; },
    f => { f.manifest.object_key = 'private-object'; }, f => { f.page.payload.page.sections = []; },
  ];
  for (const mutate of mutations) {
    const fixture = candidateFixture(); mutate(fixture);
    fixture.manifest.content_hash = generationArtifactHash(fixture.manifest.payload);
    fixture.page.content_hash = generationArtifactHash(fixture.page.payload);
    useCandidates(fixture);
    await assert.rejects(async () => resolveGenerationCandidatePage(await resolvePrivateGenerationCandidate(candidateProjectId, candidateRunId, fixture.id), '/'), { status: 409 });
  }
  const fixture = candidateFixture(); fixture.manifest.content_hash = '0'.repeat(64); useCandidates(fixture);
  await assert.rejects(resolvePrivateGenerationCandidate(candidateProjectId, candidateRunId, fixture.id), { status: 409 });
});
test('candidate route renders through shared assembly without native pages and refuses missing revisions or paths', async () => {
  const previous = process.env.ALLORO_WORKTREE_TEST_MODE;
  try {
    process.env.ALLORO_WORKTREE_TEST_MODE = 'true'; useCandidates(candidateFixture());
    const result = await candidateRequest();
    assert.equal(result.status, 200); assert.ok(result.body.includes('<h1>Original</h1>'));
    assert.ok(result.body.includes(`candidateId=${candidateId}#team`));
    assert.equal(result.headers['Cache-Control'], 'private, no-store'); assert.equal(result.headers['X-Robots-Tag'], 'noindex, nofollow');
    assert.equal((await candidateRequest({ candidateId: '77777777-7777-4777-8777-777777777777' })).status, 404);
    assert.equal((await candidateRequest({ path: '/not-selected' })).status, 404);
    for (const query of [{ candidateId: '' }, { candidateId: ['one', 'two'] }, { path: '/?candidateId=other' }, { path: '//other.example' }]) assert.equal((await candidateRequest(query)).status, 400);
    assert.equal((await candidateRequest({}, '203.0.113.1')).status, 404);
    delete process.env.ALLORO_WORKTREE_TEST_MODE; assert.equal((await candidateRequest()).status, 404);
  } finally { if (previous === undefined) delete process.env.ALLORO_WORKTREE_TEST_MODE; else process.env.ALLORO_WORKTREE_TEST_MODE = previous; }
});
test('candidate single posts use scoped published data and only their exact layout; no legacy layout fallback', async () => {
  const previous = process.env.ALLORO_WORKTREE_TEST_MODE;
  try {
    process.env.ALLORO_WORKTREE_TEST_MODE = 'true'; useCandidates(candidateFixture());
    singlePosts.getSinglePostData = async (projectId, templateId, typeSlug, postSlug) => {
      assert.equal(projectId, candidateProjectId); assert.equal(templateId, 'template-a'); assert.equal(typeSlug, 'stories');
      return postSlug === 'published' ? { postType: { id: 'post-type-a', slug: typeSlug, single_template: [{ content: 'WRONG LEGACY' }] },
        post: { title: 'Published story', slug: postSlug, content: '<p>Real published body</p>', custom_fields: {} } } : null;
    };
    const result = await candidateRequest({ path: '/stories/published' });
    assert.equal(result.status, 200); assert.ok(result.body.includes('Original header')); assert.ok(result.body.includes('<h1>Published story</h1>'));
    assert.ok(result.body.includes('Real published body')); assert.ok(!result.body.includes('WRONG LEGACY'));
    assert.equal((await candidateRequest({ path: '/stories/draft' })).status, 404);
    const fixture = candidateFixture(); fixture.manifest.payload.render.singlePostLayouts = []; fixture.manifest.content_hash = generationArtifactHash(fixture.manifest.payload); useCandidates(fixture);
    assert.equal((await candidateRequest({ path: '/stories/published' })).status, 404);
    const candidate = await resolvePrivateGenerationCandidate(candidateProjectId, candidateRunId, candidateId);
    assert.throws(() => resolveGenerationCandidatePostLayout(candidate, 'post-type-a'), { status: 404 });
  } finally { if (previous === undefined) delete process.env.ALLORO_WORKTREE_TEST_MODE; else process.env.ALLORO_WORKTREE_TEST_MODE = previous; }
});
test('worktree navigation preserves selected candidate, hashes and query while leaving runtime assets and external URLs alone', () => {
  const context = { projectId: candidateProjectId, runId: candidateRunId, candidateId, path: '/blog' };
  const destination = worktreePreviewDestination('/about?topic=one&tag=two#team', context);
  const url = new URL(destination, 'http://fixture.localhost');
  assert.equal(url.searchParams.get('path'), '/about'); assert.equal(url.searchParams.get('candidateId'), candidateId);
  assert.equal(url.searchParams.get('topic'), 'one'); assert.equal(url.searchParams.get('tag'), 'two'); assert.equal(url.hash, '#team');
  assert.equal(worktreePreviewDestination(destination, context), destination);
  const html = bindWorktreePreviewNavigation('<html><head><link rel="stylesheet" href="/imports/runtime.css"></head><body><a href="/about?topic=one&amp;tag=two#team">About</a><a href="https://external.example/">External</a><a href="#same">Anchor</a></body></html>', context);
  assert.ok(html.includes('href="/imports/runtime.css"')); assert.ok(html.includes('href="https://external.example/"')); assert.ok(html.includes('href="#same"'));
  assert.ok(html.includes(`candidateId=${candidateId}#team`));
});
test('dynamic post links and numbered pagination retain candidate identity through history and reload', () => {
  const context = { projectId: candidateProjectId, runId: candidateRunId, candidateId, path: '/blog' };
  const source = bindWorktreePreviewNavigation('<body></body>', context).match(/<script data-alloro-worktree-navigation>([\s\S]*?)<\/script>/)[1];
  const anchor = href => ({ href, getAttribute() { return this.href; }, setAttribute(_key, value) { this.href = value; }, matches: () => true, querySelectorAll: () => [], closest() { return this; } });
  const first = anchor('/stories/first'); const location = { href: `http://fixture.localhost/__worktree/generation/${candidateProjectId}/${candidateRunId}?path=%2Fblog&candidateId=${candidateId}&tag=community#list` };
  let observer; const listeners = {}; const history = {};
  for (const name of ['pushState', 'replaceState']) history[name] = (_state, _title, url) => { location.href = new URL(url, location.href).href; };
  vm.runInNewContext(source, { URL, location, history, document: { documentElement: {}, querySelectorAll: () => [first], addEventListener: (name, callback) => { listeners[name] = callback; } },
    MutationObserver: class { constructor(callback) { observer = callback; } observe() {} } });
  assert.equal(new URL(first.href, location.href).searchParams.get('candidateId'), candidateId);
  const dynamic = anchor('/stories/second'); observer([{ type: 'childList', addedNodes: [dynamic] }]);
  assert.equal(new URL(dynamic.href, location.href).searchParams.get('path'), '/stories/second');
  assert.equal(new URL(dynamic.href, location.href).searchParams.get('candidateId'), candidateId);
  const stylesheet = { ...anchor('/imports/later.css'), matches: () => false };
  observer([{ type: 'attributes', target: stylesheet }]);
  assert.equal(stylesheet.href, '/imports/later.css');
  const immediate = anchor('/stories/third'); listeners.click({ target: immediate });
  assert.equal(new URL(immediate.href, location.href).searchParams.get('candidateId'), candidateId);
  history.pushState({ alloroPage: 2 }, '', '?page=2');
  const reload = new URL(location.href);
  assert.equal(reload.searchParams.get('path'), '/blog'); assert.equal(reload.searchParams.get('candidateId'), candidateId);
  assert.equal(reload.searchParams.get('page'), '2'); assert.equal(reload.searchParams.get('tag'), 'community'); assert.equal(reload.hash, '#list');
  history.replaceState({}, '', '?page=3#new-list'); assert.equal(new URL(location.href).searchParams.get('candidateId'), candidateId); assert.equal(new URL(location.href).hash, '#new-list');
});
test('changed, missing and unknown style revisions fail closed', async () => {
  for (const html of [wrapper.replace(css, css + 'p{color:red}'), wrapper.replace('data-generation-contract="1"', 'data-generation-contract="2"'), wrapper.replace(/<style[\s\S]*?<\/style>/, '')]) {
    assert.equal(inspectGenerationStyle(html).valid, false);
    await assert.rejects(processTailwindCSS(html, false), /REVISION_INVALID/);
  }
});
test('a page pins its exact run chrome without changing project-global layouts', async () => {
  const output = await resolveGenerationRender(project, { generation_run_id: 'run-1' });
  assert.equal(output.header, '<header>Confirmed brand</header>'); assert.equal(output.wrapper, wrapper);
  assert.equal(project.wrapper, 'LEGACY');
  assert.equal(await resolveGenerationRender(project, {}), project);
});
test('missing or ambiguous snapshots cannot silently fall back to mutable global layouts', async () => {
  for (const rows of [[], [{ payload }, { payload }]]) {
    GenerationRenderModel.findPinned = async () => rows;
    await assert.rejects(resolveGenerationRender(project, { generation_run_id: 'run-1' }), /MISSING_OR_AMBIGUOUS/);
  }
});
test('snapshot payload and style hashes both bind reviewed bytes', async () => {
  GenerationRenderModel.findPinned = async () => [{ payload, content_hash: 'wrong' }];
  await assert.rejects(resolveGenerationRender(project, { generation_run_id: 'run-1' }), /HASH_MISMATCH/);
  payload.wrapper = payload.wrapper.replace(css, css + 'p{color:red}');
  GenerationRenderModel.findPinned = async () => [{ payload, content_hash: generationArtifactHash(payload) }];
  await assert.rejects(resolveGenerationRender(project, { generation_run_id: 'run-1' }), /STYLE_MISMATCH/);
});
test('foreign run and missing tenant context cannot resolve a snapshot', async () => {
  payload.runId = 'other-run';
  await assert.rejects(resolveGenerationRender(project, { generation_run_id: 'run-1' }), /HASH_MISMATCH/);
  await assert.rejects(resolveGenerationRender({ ...project, organization_id: null }, { generation_run_id: 'run-1' }), /OWNER_MISSING/);
});
test('project block pins preserve dynamic post data and never use another revision or type', async () => {
  redis.getRedis = () => ({ get: async () => null, set: async () => {} });
  database.getDb = () => table => {
    assert.ok(['posts', 'post_category_assignments', 'post_tag_assignments'].includes(table));
    const rows = table === 'posts' ? [{ id: 'post-1', title: 'Real project', slug: 'real', content: '', excerpt: '', custom_fields: {}, featured_image: null }] : [];
    const query = { join: () => query, where: () => query, whereIn: () => query, select: () => query, orderBy: () => query, limit: () => query, offset: () => query,
      then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject) };
    return query;
  };
  ProjectPostBlockModel.findPinned = async (projectId, id) => {
    assert.equal(projectId, 'project-1'); assert.equal(id, 'project:portfolio:2');
    return { slug: id, post_type_slug: 'projects', sections: [{ content: '<div>{{start_post_loop}}<h2>{{post.title}}</h2>{{end_post_loop}}</div>' }] };
  };
  const shortcode = "{{ post_block id='project:portfolio:2' items='projects' }}";
  assert.equal(await resolvePostBlocks(shortcode, 'template', 'project-1'), '<div><h2>Real project</h2></div>');
  await assert.rejects(resolvePostBlocks(shortcode.replace("items='projects'", "items='doctors'"), 'template', 'project-1'), /TYPE_MISMATCH/);
  ProjectPostBlockModel.findPinned = async () => null;
  await assert.rejects(resolvePostBlocks(shortcode, 'template', 'project-1'), /REVISION_MISSING/);
});
test('shared post detail uses exact published-run chrome and keeps real post data', async () => {
  GenerationRenderModel.publishedRunIds = async id => { assert.equal(id, project.id); return ['run-1']; };
  payload.singlePostLayouts = [{ postTypeId: 'post-type', sections: [{ name: 'detail', content: '<article><h1>{{post.title}}</h1><div>{{post.content}}</div></article>' }] }];
  database.getDb = () => () => {
    const query = { where: () => query, orderBy: () => query, whereIn: () => query, select: () => query,
      then: (resolve, reject) => Promise.resolve([]).then(resolve, reject) };
    return query;
  };
  const html = await site.assembleSinglePostHtml(project, { id: 'post-type', slug: 'projects', single_template: [] },
    { title: 'Real project title', slug: 'real', content: '<p>Real project body</p>', custom_fields: {} }, 'example.org');
  assert.ok(html.includes('<h1>Real project title</h1>')); assert.ok(html.includes('<p>Real project body</p>'));
  assert.ok(html.includes('Confirmed brand')); assert.equal(inspectGenerationStyle(html).cssHash, styleHash);
  assert.equal(project.wrapper, 'LEGACY');
  assert.equal((await resolveGenerationSinglePost(project, 'other-post-type')).sections, null);
});
test('conflicting published detail bindings fail closed; unreferenced draft runs are never selected', async () => {
  GenerationRenderModel.publishedRunIds = async () => ['run-1', 'run-2'];
  GenerationRenderModel.findPinned = async (_project, _org, runId) => {
    const artifact = { ...payload, runId, header: `<header>${runId}</header>`, singlePostLayouts: [{ postTypeId: 'type', sections: [{ name: 'detail', content: '<article>{{post.content}}</article>' }] }] };
    return [{ payload: artifact, content_hash: generationArtifactHash(artifact) }];
  };
  await assert.rejects(resolveGenerationSinglePost(project, 'type'), /AMBIGUOUS/);
  GenerationRenderModel.publishedRunIds = async () => [];
  assert.equal((await resolveGenerationSinglePost(project, 'type')).project, project);
  assert.ok((await resolveGenerationSinglePost(project, 'type', 'run-2')).project.header.includes('run-2'));
});
test('private preview is local-only and retains navigable per-run page links', async () => {
  const previous = process.env.ALLORO_WORKTREE_TEST_MODE;
  const projectId = '11111111-1111-4111-8111-111111111111', runId = '22222222-2222-4222-8222-222222222222';
  const req = { params: { projectId, runId }, query: { path: '/' }, socket: { remoteAddress: '127.0.0.1' }, get: () => 'fixture.localhost' };
  let status = 200, body = '', reads = 0;
  const res = { status(value) { status = value; return this; }, end() {}, setHeader() {}, type() { return this; }, send(value) { body = value; } };
  GenerationRenderModel.findPrivatePage = async () => { reads++; return { project, page: {} }; };
  site.assembleHtml = async () => wrapper.replace('{{slot}}', '<a href="/about#team">About</a><a href="https://other.example/">External</a>');
  try {
    delete process.env.ALLORO_WORKTREE_TEST_MODE;
    await worktreeGenerationPreviewRoute(req, res); assert.equal(status, 404); assert.equal(reads, 0);
    process.env.ALLORO_WORKTREE_TEST_MODE = 'true'; req.socket.remoteAddress = '203.0.113.10';
    await worktreeGenerationPreviewRoute(req, res); assert.equal(reads, 0);
    req.socket.remoteAddress = '127.0.0.1'; await worktreeGenerationPreviewRoute(req, res);
    assert.ok(body.includes(`/__worktree/generation/${projectId}/${runId}?path=%2Fabout#team`));
    assert.ok(body.includes('href="https://other.example/"')); assert.equal(inspectGenerationStyle(body).cssHash, styleHash);
  } finally { if (previous === undefined) delete process.env.ALLORO_WORKTREE_TEST_MODE; else process.env.ALLORO_WORKTREE_TEST_MODE = previous; }
});
