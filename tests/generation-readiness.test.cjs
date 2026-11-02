const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { beforeEach, after, test } = require('node:test');
const { GenerationRenderModel } = require('../dist/models/GenerationRenderModel');
const { generationPublishedReadinessMarker, generationPostReadinessMarker } = require('../dist/services/generation-render.service');
const { generationReadinessMarker } = require('../dist/utils/generation-readiness');
const { generationArtifactHash } = require('../dist/utils/generation-style');
const original = { pinned: GenerationRenderModel.findPinned, deps: GenerationRenderModel.readinessDependencies, runs: GenerationRenderModel.publishedRunIds };
const css = '.site{color:red}'; const styleHash = createHash('sha256').update(css).digest('hex');
const render = { runId: 'run', planHash: 'plan', styleHash, wrapper: `<html data-generation-contract="1"><style data-alloro-generation-style="1" data-content-hash="${styleHash}">${css}</style>{{slot}}</html>`, header: '', footer: '', singlePostLayouts: [{ postTypeId: 'stories', sections: [{name:'detail',content:'<h1>{{post.title}}</h1>'}] }] };
const project = { id: 'project', organization_id: 2 };
const page = { id: 'page', path: '/', status: 'published', generation_run_id: 'run', sections: [{name:'hero',content:'<h1>Cedar</h1>'}] };
let dependencies;
beforeEach(() => { dependencies = { posts: [], blocks: [] }; GenerationRenderModel.findPinned = async (projectId, org, runId) => { assert.equal(projectId, 'project'); assert.equal(org, 2); return [{ payload: {...render,runId}, content_hash: generationArtifactHash({...render,runId}) }]; }; GenerationRenderModel.readinessDependencies = async () => dependencies; GenerationRenderModel.publishedRunIds = async () => ['run']; });
after(() => { GenerationRenderModel.findPinned = original.pinned; GenerationRenderModel.readinessDependencies = original.deps; GenerationRenderModel.publishedRunIds = original.runs; });
test('public marker binds selected page, exact run/render and dynamic native dependencies', async () => {
  const result = await generationPublishedReadinessMarker(project,page);
  assert.equal(result, generationReadinessMarker({projectId:'project',organizationId:2,runId:'run',pageId:'page',path:'/',sections:page.sections,renderHash:generationArtifactHash(render),dependencies}));
  dependencies.posts.push({id:'post',title:'Changed'}); assert.notEqual(await generationPublishedReadinessMarker(project,page),result);
  assert.notEqual(await generationPublishedReadinessMarker(project,{...page,sections:[]}),result);
});
test('legacy/draft pages never receive a public readiness marker', async () => { assert.equal(await generationPublishedReadinessMarker(project,{...page,generation_run_id:null}),null); assert.equal(await generationPublishedReadinessMarker(project,{...page,status:'draft'}),null); });
test('native post detail marker is pinned to one published run and exact layout', async () => {
  const result = await generationPostReadinessMarker(project,'stories','story','/stories/story'); assert.match(result,/^[a-f0-9]{64}$/);
  assert.notEqual(await generationPostReadinessMarker(project,'stories','other','/stories/other'),result);
  assert.equal(await generationPostReadinessMarker(project,'missing','story','/stories/story'),null);
  GenerationRenderModel.publishedRunIds = async () => ['run','other']; assert.equal(await generationPostReadinessMarker(project,'stories','story','/stories/story'),null);
});
test('date-bearing dependencies normalize to matching serialized database values', () => {
  const base={projectId:'p',organizationId:2,runId:'r',pageId:'x',path:'/',sections:[],renderHash:'hash'};
  assert.equal(generationReadinessMarker({...base,dependencies:{date:new Date('2026-10-01T00:00:00Z')}}),generationReadinessMarker({...base,dependencies:{date:'2026-10-01T00:00:00.000Z'}}));
});
