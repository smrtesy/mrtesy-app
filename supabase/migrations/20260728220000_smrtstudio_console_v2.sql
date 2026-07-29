-- smrtStudio operator console — v2 reshape to the approved 10-stage design.
--
-- Purely ADDITIVE at the schema level: studio_stages gains six columns (the
-- stage `kind`, and the four-field plan charter that replaces the old
-- gates-driven view), and two new tables are created:
--
--   studio_items   — the per-stage task rows. Research stages fold their items
--                    into three visible groups (Research / Tests / Decisions);
--                    the Build stage groups them by tool. `group_order` drives
--                    display order, `group_note_en` carries a Build group's note.
--   studio_outputs — the artifacts a stage produced (image/video/audio/text/tool),
--                    each with a deep link to the exact file/doc.
--
-- The content below is copied verbatim from the approved console mockup
-- (smart-studio-mockup.html): the STAGES / PLANS data, and the mockup's own
-- url()/shortlink() rules for turning a [repo,path] link into a
-- github.com/smrtesy/<repo>/blob/main/<path> URL with the last path segment as
-- its label. English strings are kept exactly, including the unicode
-- right-single-quote (’, U+2019) which is safe inside single-quoted SQL. There
-- are no straight apostrophes in the content, so nothing needs doubling.
--
-- Seeding is scoped to the smrtStudio-entitled orgs (the same `studio_orgs`
-- temp-view resolution the core seed uses) and is delete-then-insert, so a
-- re-run reshapes cleanly. studio_gates is intentionally left untouched — the
-- v2 design drives stage progress from the plan charter, not gates.

-- 1. schema: extend studio_stages ---------------------------------------------
alter table public.studio_stages
  add column if not exists kind text not null default 'research',
  add column if not exists plan_desc_en text not null default '',
  add column if not exists plan_general text not null default 'todo',
  add column if not exists plan_detail text not null default 'todo',
  add column if not exists plan_verify text not null default 'todo',
  add column if not exists smrtplan_url text not null default '';

-- 2. schema: studio_items -----------------------------------------------------
create table if not exists public.studio_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  stage_slug text not null,
  group_key text not null,
  group_order integer not null default 0,
  group_note_en text not null default '',
  position integer not null default 0,
  title_en text not null,
  status text not null default 'todo' check (status in ('done','now','todo')),
  desc_en text not null default '',
  link_url text not null default '',
  link_label text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, stage_slug, group_key, position)
);

-- 3. schema: studio_outputs ---------------------------------------------------
create table if not exists public.studio_outputs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  stage_slug text not null,
  position integer not null default 0,
  out_kind text not null default 'text' check (out_kind in ('image','video','audio','text','tool')),
  label_en text not null,
  meta_en text not null default '',
  link_url text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, stage_slug, position)
);

-- 4. indexes ------------------------------------------------------------------
create index if not exists studio_items_org_idx   on public.studio_items (org_id, stage_slug, group_order, position);
create index if not exists studio_outputs_org_idx on public.studio_outputs (org_id, stage_slug, position);

-- 5. updated_at triggers ------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['studio_items','studio_outputs']
  loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I
                    for each row execute function set_updated_at()', t, t);
  end loop;
end $$;

-- 6. RLS — the repo's standard org_members policy -----------------------------
do $$
declare t text;
begin
  foreach t in array array['studio_items','studio_outputs']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I_org on public.%I', t, t);
    execute format(
      'create policy %I_org on public.%I for all
         using (org_id in (select org_members.org_id from public.org_members
                            where org_members.user_id = (select auth.uid())))
         with check (org_id in (select org_members.org_id from public.org_members
                            where org_members.user_id = (select auth.uid())))', t, t);
  end loop;
end $$;

-- 7. seed ---------------------------------------------------------------------
-- The orgs this seed applies to, resolved exactly like the core seed. Guarded
-- with a drop so a lingering temp view from an earlier migration in the same
-- session cannot make the create fail.
drop view if exists studio_orgs;
create temporary view studio_orgs as
select o.id, o.created_by
from public.organizations o
join public.app_memberships m on m.org_id = o.id
join public.apps a on a.id = m.app_id and a.slug = 'smrtstudio';

-- Reset — children first, then stages. (gates are intentionally left as-is.)
delete from public.studio_items      where org_id in (select id from studio_orgs);
delete from public.studio_outputs    where org_id in (select id from studio_orgs);
delete from public.studio_challenges where org_id in (select id from studio_orgs);
delete from public.studio_stages     where org_id in (select id from studio_orgs);

-- 7a. stages (name_he=name_en, blurb_he=blurb_en; plan charter from PLANS) -----
insert into public.studio_stages
  (org_id, slug, position, name_he, name_en, blurb_he, blurb_en, hue,
   kind, plan_desc_en, plan_general, plan_detail, plan_verify, smrtplan_url)
select o.id, s.slug, s.position, s.name, s.name, s.blurb, s.blurb, s.hue,
       s.kind, s.plan_desc_en, s.plan_general, s.plan_detail, s.plan_verify,
       'https://app.smrtesy.com/plan'
from studio_orgs o
cross join (values
 ('planning', 1,'Planning',
  'Strategy and working methods for the whole operation — how we plan projects, who we hire, and a full map of the AI models on the market.',
  262,'research',
  'What to research to run the whole operation — the AI-model landscape, how we plan, and who we hire.',
  'done','done','done'),
 ('tools', 2,'Building Tools',
  'The software that runs the production pipeline. Each tool is built in four steps — Architecture, POC, UAT, and Deployment.',
  232,'build',
  'Which tools to build to run the pipeline, and the architecture of each.',
  'done','done','done'),
 ('script', 3,'Script',
  'The method for writing high-level scripts and handling what AI cannot yet write well.',
  204,'research',
  'What to research about high-level scriptwriting and where AI struggles, and how to test scenes.',
  'now','todo','todo'),
 ('chars', 4,'Characters',
  'The method for creating consistent 3D characters — visual style, the right model, and accuracy for our audience.',
  174,'research',
  'What to research to lock a consistent character — style, the right model, cultural accuracy — and how to score consistency.',
  'done','done','done'),
 ('voice', 5,'Voices',
  'The method for producing the character voices — model choice, correct Chabad pronunciation, and mixing Hebrew, English and Yiddish.',
  150,'research',
  'What to research for natural, Chabad-correct voices, and how to blind-test the candidate models.',
  'done','done','now'),
 ('sets', 6,'Set & Props',
  'The method for building accurate backgrounds and props and keeping them identical across every shot.',
  120,'research',
  'What to research to build and lock consistent backgrounds and props, and how to measure set consistency.',
  'now','todo','todo'),
 ('motion', 7,'Frames & Motion',
  'The core stage — choosing the video model that keeps characters consistent while they move. Everything downstream depends on this choice.',
  44,'research',
  'What to research and test to pick the video model that keeps a character consistent while it moves.',
  'done','done','done'),
 ('lipsync', 8,'Lip Sync & Translation',
  'The method for syncing mouths to our audio — even with several characters — and adapting to multi-language dubbing.',
  24,'research',
  'What to research and test for syncing mouths to our audio across languages.',
  'done','now','todo'),
 ('assembly', 9,'Assembly',
  'The method for joining video, audio and backgrounds into a finished episode — transitions, music and final editing.',
  350,'research',
  'What to research to assemble the finished episode — joining, transitions, music and editing.',
  'todo','todo','todo'),
 ('market',10,'Marketing',
  'The method for reaching new audiences — who they are, which channels work, the budget, and the plan to go live.',
  290,'research',
  'What to research to reach the audience — who they are, channels, budget and go-to-market.',
  'todo','todo','todo')
) as s(slug, position, name, blurb, hue, kind,
       plan_desc_en, plan_general, plan_detail, plan_verify);

-- 7b. items --------------------------------------------------------------------
-- Research stages: group_key from PHMAP (ph 0|1→research/1, 2|3|4→tests/2,
-- 5→decisions/3), position = running index within the group, group_note_en ''.
-- Build stage (tools): group_key = tool title, group_order running, note carried.
insert into public.studio_items
  (org_id, stage_slug, group_key, group_order, group_note_en, position,
   title_en, status, desc_en, link_url, link_label)
select o.id, i.stage_slug, i.group_key, i.group_order, i.group_note_en, i.position,
       i.title_en, i.status, i.desc_en, i.link_url, i.link_label
from studio_orgs o
cross join (values
 -- planning
 ('planning','research',1,'',0,'AI-model research','done','A survey of every AI image, video and voice model available — what each one does, what it costs, and how to operate it.','https://github.com/smrtesy/video-lab/blob/main/docs/models/catalog.json','catalog.json'),
 ('planning','research',1,'',1,'Plan-building methodology','done','A standard, repeatable method for turning any goal into a detailed work plan.','https://github.com/smrtesy/mrtesy-app/blob/main/docs/project-planning-protocol.md','project-planning-protocol.md'),
 ('planning','research',1,'',2,'Worker-productivity methods','done','The science of productivity applied to how we work and delegate — a roadmap kept in smrtTask.','https://docs.google.com/document/d/1YqHixpoLFt8ZsHDfKduPJGE4NW_yDjOEZBD_J0-DHdw/edit?usp=sharing','roadmap'),
 ('planning','research',1,'',3,'Overseas hiring & remote teams','done','A strategy for finding, hiring and managing an overseas team member.','https://github.com/smrtesy/mrtesy-app/blob/main/docs/onlinejobs-marketing-hire-plan.md','onlinejobs-marketing-hire-plan.md'),
 ('planning','decisions',3,'',0,'Model shortlist','todo','A short, ranked list of the models we recommend using, chosen from the full survey.','',''),
 -- tools (Build — one group per tool)
 ('tools','smrtStudio',1,'The management dashboard that tracks the build and runs the pipeline.',0,'Architecture','done','The design of the screens and the data behind them.','',''),
 ('tools','smrtStudio',1,'The management dashboard that tracks the build and runs the pipeline.',1,'POC','now','A first working version that proves the idea.','https://github.com/smrtesy/mrtesy-app/blob/main/server/src/modules/smrtstudio/routes.ts','routes.ts'),
 ('tools','smrtStudio',1,'The management dashboard that tracks the build and runs the pipeline.',2,'UAT','todo','Real-world use and a round of fixes.','',''),
 ('tools','smrtStudio',1,'The management dashboard that tracks the build and runs the pipeline.',3,'Deployment','todo','Live and used every day.','',''),
 ('tools','fal harness',2,'The engine that sends jobs to the AI models in parallel and collects the results.',0,'Architecture','done','The design of the runner, cost limits and safety checks.','https://github.com/smrtesy/video-lab/blob/main/harness/runner.py','runner.py'),
 ('tools','fal harness',2,'The engine that sends jobs to the AI models in parallel and collects the results.',1,'POC','now','A first working version that proves the idea.','https://github.com/smrtesy/video-lab/blob/main/harness/runner.py','runner.py'),
 ('tools','fal harness',2,'The engine that sends jobs to the AI models in parallel and collects the results.',2,'UAT','todo','The first real run on our own material.','',''),
 ('tools','fal harness',2,'The engine that sends jobs to the AI models in parallel and collects the results.',3,'Deployment','todo','Live and used every day.','',''),
 ('tools','voice-engine',3,'The service that produces the character voice-overs.',0,'Architecture','done','The design of the voice-generation service.','',''),
 ('tools','voice-engine',3,'The service that produces the character voice-overs.',1,'POC','done','A first working version that proves the idea.','https://github.com/smrtesy/voice-engine/blob/main/src/voice_engine/workers/orchestrator.py','orchestrator.py'),
 ('tools','voice-engine',3,'The service that produces the character voice-overs.',2,'UAT','now','Real-world use and a round of fixes.','https://github.com/smrtesy/voice-engine/blob/main/src/voice_engine/workers/orchestrator.py','orchestrator.py'),
 ('tools','voice-engine',3,'The service that produces the character voice-overs.',3,'Deployment','todo','Live and used every day.','',''),
 -- script
 ('script','research',1,'',0,'Script needs & AI limits','todo','A study of what a strong script needs and where AI writing falls short.','https://github.com/smrtesy/video-lab/blob/main/docs/research-index.md','research-index.md'),
 ('script','research',1,'',1,'Series / Script Bible','done','The locked reference for the whole series — its characters, world, tone and rules.','https://github.com/smrtesy/video-lab/blob/main/docs/series.md','series.md'),
 ('script','tests',2,'',0,'Test-scene set','todo','A fixed set of short scenes used to run the whole pipeline end to end.','https://github.com/smrtesy/video-lab/blob/main/.claude/skills/scenes-write/SKILL.md','SKILL.md'),
 -- chars
 ('chars','research',1,'',0,'Image-model shortlist','done','A comparison of the candidate image models — cost, strengths, and how each keeps a character on-model.','https://github.com/smrtesy/video-lab/blob/main/docs/models/prices-memo.md','prices-memo.md'),
 ('chars','research',1,'',1,'Image-model recipes','done','The exact, verified way to call each image model.','https://github.com/smrtesy/video-lab/blob/main/docs/models/nano-banana-pro.md','nano-banana-pro.md'),
 ('chars','research',1,'',2,'Style & series look','done','The locked visual identity of the characters and their world.','https://github.com/smrtesy/video-lab/blob/main/docs/series.md','series.md'),
 ('chars','research',1,'',3,'Cultural accuracy — what the audience needs','todo','Research into exactly what our Chabad/Haredi audience needs a character to get right — dress, symbols and conduct.','https://github.com/smrtesy/video-lab/blob/main/docs/series.md','series.md'),
 ('chars','tests',2,'',0,'Scoring criteria','done','The definition of "consistent enough", and the pass bar, fixed before any result was seen.','https://github.com/smrtesy/video-lab/blob/main/docs/criteria.md','criteria.md'),
 ('chars','tests',2,'',1,'Cultural-accuracy test plan','todo','A plan to test whether a model actually produces the audience’s required details correctly.','',''),
 ('chars','tests',2,'',2,'Character sheets — 10 views each','now','Reference sheets showing each character from several angles and expressions.','https://github.com/smrtesy/video-lab/blob/main/docs/assets-index.json','assets-index.json'),
 ('chars','tests',2,'',3,'Cover the second character','todo','Running the second character through the same models as the first, for a fair comparison.','',''),
 ('chars','tests',2,'',4,'Consistency scores','done','A measurement of how well each model kept a character’s face the same.','https://github.com/smrtesy/video-lab/blob/main/docs/assets/char-sheet-scores.json','char-sheet-scores.json'),
 ('chars','decisions',3,'',0,'Lock the model + canonical reference','todo','Choosing the final model and freezing one reference image per character.','',''),
 -- voice
 ('voice','research',1,'',0,'Voice-model research','done','A comparison of the voice models and how to drive each one; only a few support Hebrew at all.','https://github.com/smrtesy/video-lab/blob/main/docs/models/voice-memo.md','voice-memo.md'),
 ('voice','research',1,'',1,'Pronunciation (havara) playbook','done','The official ways to force correct Chabad pronunciation on each model.','https://github.com/smrtesy/video-lab/blob/main/docs/models/havara-playbook.md','havara-playbook.md'),
 ('voice','research',1,'',2,'Pronunciation word-table','now','A confirmed list of how the key words should be pronounced.','https://github.com/smrtesy/video-lab/blob/main/docs/models/havara-playbook.md','havara-playbook.md'),
 ('voice','tests',2,'',0,'Voice panel — blind test','now','A blind comparison of voice takes across the candidate models.','https://github.com/smrtesy/video-lab/blob/main/docs/panels/voice-panel-01-readback.md','voice-panel-01-readback.md'),
 ('voice','tests',2,'',1,'Readback analysis','now','Checking the takes by transcribing them back to see which pronunciation controls actually worked.','https://github.com/smrtesy/video-lab/blob/main/docs/panels/voice-panel-01-readback.md','voice-panel-01-readback.md'),
 ('voice','decisions',3,'',0,'Lock a voice per character','todo','Choosing the final model and voice for each character.','',''),
 -- sets
 ('sets','research',1,'',0,'The right way to build backgrounds & props','todo','A proper method for designing and locking sets and props — the same way it was done for characters.','',''),
 ('sets','research',1,'',1,'Reference mechanisms','done','Which models can keep a background or prop identical by anchoring it to one image.','https://github.com/smrtesy/video-lab/blob/main/docs/models/shot-grammar.json','shot-grammar.json'),
 ('sets','tests',2,'',0,'How to measure set consistency','now','A proposed way to score whether a background stayed the same across shots.','https://github.com/smrtesy/video-lab/blob/main/docs/models/shot-grammar.json','shot-grammar.json'),
 ('sets','tests',2,'',1,'Set & prop reference sheets','todo','One locked reference image for each location and each recurring prop.','https://github.com/smrtesy/video-lab/blob/main/.claude/skills/assets/SKILL.md','SKILL.md'),
 ('sets','decisions',3,'',0,'Decide whether we score location consistency','todo','A decision on whether background consistency becomes a measured gate.','',''),
 -- motion
 ('motion','research',1,'',0,'Video-model survey','done','A survey of all the video models and their verified specs — the full field of candidates.','https://github.com/smrtesy/video-lab/blob/main/docs/models/sub-research-2b.md','sub-research-2b.md'),
 ('motion','research',1,'',1,'Which models accept our audio','done','Which video models can be driven by our voice track, and which only paste it on top.','https://github.com/smrtesy/video-lab/blob/main/docs/models/sub-research-2b.md','sub-research-2b.md'),
 ('motion','research',1,'',2,'Control & direction matrix','done','What each model actually lets us control — camera, angle and shot-to-shot continuity.','https://github.com/smrtesy/video-lab/blob/main/docs/models/shot-grammar.json','shot-grammar.json'),
 ('motion','research',1,'',3,'Video-model recipes','done','The exact, verified way to call each leading video model.','https://github.com/smrtesy/video-lab/blob/main/docs/models/ltx-2.3-audio-to-video.md','ltx-2.3-audio-to-video.md'),
 ('motion','research',1,'',4,'Frame pairs & continuity','done','The method for chaining shots so a character carries over cleanly from one to the next.','https://github.com/smrtesy/video-lab/blob/main/docs/models/shot-grammar.json','shot-grammar.json'),
 ('motion','research',1,'',5,'Cross-dependency map','now','How the chosen model changes the script cutting, the number of frames, characters per shot and the voice timing.','https://github.com/smrtesy/video-lab/blob/main/docs/models/shot-grammar.json','shot-grammar.json'),
 ('motion','research',1,'',6,'Rebuild the model ranking','todo','A fresh ranked shortlist built from the complete model survey.','',''),
 ('motion','research',1,'',7,'Identity-in-motion strategy','todo','Ways to keep a character on-model in the tools that cannot lock it while moving.','',''),
 ('motion','tests',2,'',0,'Model-comparison test plan','done','The plan for the model comparison — which scenes, which models, and how each is scored.','https://github.com/smrtesy/video-lab/blob/main/docs/criteria.md','criteria.md'),
 ('motion','tests',2,'',1,'Run the models on our scenes','todo','Generating video from each candidate model on the test scenes.','https://github.com/smrtesy/video-lab/blob/main/.claude/skills/test-b/SKILL.md','SKILL.md'),
 ('motion','tests',2,'',2,'Score the results','todo','Rating each model’s output on character consistency, motion and lip-sync.','',''),
 ('motion','decisions',3,'',0,'Lock the video model + pipeline path','todo','Choosing the final video model and whether the pipeline runs in one stage or two.','',''),
 ('motion','decisions',3,'',1,'Quality-vs-cost decision','todo','A decision between the cheaper and more expensive models based on the results.','',''),
 -- lipsync
 ('lipsync','research',1,'',0,'Lip-sync model recipes','done','Two approaches researched: full-face "avatar" models, and "mouth-fix" models that only repaint the mouth.','https://github.com/smrtesy/video-lab/blob/main/docs/models/latentsync.md','latentsync.md'),
 ('lipsync','research',1,'',1,'Multi-language dubbing approach','now','The plan to make each video once and add every language’s lip-sync on top.','',''),
 ('lipsync','tests',2,'',0,'Lip-sync quality metric','now','A way to score how well the mouth matches the audio.','https://github.com/smrtesy/video-lab/blob/main/docs/models/qc-models.json','qc-models.json'),
 ('lipsync','tests',2,'',1,'Lip-sync test on our audio','todo','Testing the models on our real Hebrew and English recordings.','https://github.com/smrtesy/video-lab/blob/main/.claude/skills/test-lipsync/SKILL.md','SKILL.md'),
 -- assembly
 ('assembly','research',1,'',0,'Assembly & joining methods','todo','How to stitch all the pieces into one video efficiently.','',''),
 ('assembly','research',1,'',1,'Transitions & seams','todo','How to blend between shots and scenes with no jarring jumps.','',''),
 ('assembly','research',1,'',2,'Sound effects & music','todo','How to add sound effects and background music.','',''),
 ('assembly','research',1,'',3,'Final editing tools','todo','Which editing tool to finish the video with.','',''),
 -- market
 ('market','research',1,'',0,'Audience research + Marketing Bible','todo','A study of who the audience is, their language, and what may and may not be said.','',''),
 ('market','research',1,'',1,'Tools & tactics','todo','Which platforms and marketing tactics work best today.','',''),
 ('market','research',1,'',2,'Scaling & budget','todo','How to start small and grow the spend sensibly.','',''),
 ('market','research',1,'',3,'Creative & execution plan','todo','Creative ideas and the plan to turn it all into real marketing actions.','','')
) as i(stage_slug, group_key, group_order, group_note_en, position,
       title_en, status, desc_en, link_url, link_label);

-- 7c. challenges (kind='expected'; title_he=title_en, detail_he=detail_en) -----
insert into public.studio_challenges
  (org_id, stage_slug, position, kind, title_he, title_en, solved, detail_he, detail_en)
select o.id, c.stage_slug, c.position, 'expected', c.title, c.title, c.solved,
       c.detail, c.detail
from studio_orgs o
cross join (values
 ('script',0,'A Hebrew line and its English translation are different lengths, so a shot timed for one is wrong for the other.',false,''),
 ('chars',0,'The character still looks AI-made rather than hand-crafted.',false,''),
 ('chars',1,'The most expensive model scored the lowest on consistency.',true,'Kept scoring blind and switched to a better metric (StyleID) that matches what the eye sees.'),
 ('chars',2,'Only one of the two characters has been tried so far.',false,''),
 ('voice',0,'Names and Chabad terms get mispronounced.',true,'A pronunciation dictionary forces the right sound for each word.'),
 ('voice',1,'The voice comes out emotionally flat.',false,''),
 ('sets',0,'The classroom looks different from shot to shot and breaks the episode.',true,'Lock one reference image per location and reuse that exact file everywhere.'),
 ('sets',1,'We are not yet measuring whether the set stayed consistent.',false,''),
 ('motion',0,'5 of 6 video models cannot hold the character identity once it starts moving.',false,''),
 ('motion',1,'The cheapest and most expensive models differ 7× in cost per episode.',false,''),
 ('motion',2,'No single clip length is legal on every model (some ban 5s, some ban 4s).',true,'The planner picks a legal cut per model automatically instead of forcing one grid.'),
 ('lipsync',0,'Lip-sync quality on Hebrew is unknown — no model advertises Hebrew.',false,''),
 ('lipsync',1,'Faces distort when several characters are in one shot.',true,'One character per shot, and prefer "mouth-fix" models that leave the rest of the face untouched.')
) as c(stage_slug, position, title, solved, detail);

-- 7d. outputs ------------------------------------------------------------------
insert into public.studio_outputs
  (org_id, stage_slug, position, out_kind, label_en, meta_en, link_url)
select o.id, u.stage_slug, u.position, u.out_kind, u.label_en, u.meta_en, u.link_url
from studio_orgs o
cross join (values
 -- planning
 ('planning',0,'text','Model catalog','1,394 models','https://github.com/smrtesy/video-lab/blob/main/docs/models/catalog.json'),
 ('planning',1,'text','Planning protocol','v3.2','https://github.com/smrtesy/mrtesy-app/blob/main/docs/project-planning-protocol.md'),
 ('planning',2,'text','Productivity roadmap','in smrtTask','https://docs.google.com/document/d/1YqHixpoLFt8ZsHDfKduPJGE4NW_yDjOEZBD_J0-DHdw/edit?usp=sharing'),
 ('planning',3,'text','Hiring plan','locked','https://github.com/smrtesy/mrtesy-app/blob/main/docs/onlinejobs-marketing-hire-plan.md'),
 -- tools
 ('tools',0,'tool','smrtStudio','at POC','https://github.com/smrtesy/mrtesy-app/blob/main/server/src/modules/smrtstudio/routes.ts'),
 ('tools',1,'tool','fal harness','at POC','https://github.com/smrtesy/video-lab/blob/main/harness/runner.py'),
 ('tools',2,'tool','voice-engine','at UAT','https://github.com/smrtesy/voice-engine/blob/main/src/voice_engine/workers/orchestrator.py'),
 -- script
 ('script',0,'text','Series Bible','locked','https://github.com/smrtesy/video-lab/blob/main/docs/series.md'),
 -- chars
 ('chars',0,'image','Character sheets','produced','https://github.com/smrtesy/video-lab/blob/main/docs/assets-index.json'),
 ('chars',1,'text','Consistency scores','computed','https://github.com/smrtesy/video-lab/blob/main/docs/assets/char-sheet-scores.json'),
 ('chars',2,'text','Criteria','locked','https://github.com/smrtesy/video-lab/blob/main/docs/criteria.md'),
 -- voice
 ('voice',0,'audio','Voice panel','blind takes','https://github.com/smrtesy/video-lab/blob/main/docs/panels/voice-panel-01-readback.md'),
 ('voice',1,'text','Voice-model memo','done','https://github.com/smrtesy/video-lab/blob/main/docs/models/voice-memo.md'),
 ('voice',2,'text','Havara playbook','draft','https://github.com/smrtesy/video-lab/blob/main/docs/models/havara-playbook.md'),
 -- sets
 ('sets',0,'text','Shot grammar','set section','https://github.com/smrtesy/video-lab/blob/main/docs/models/shot-grammar.json'),
 -- motion
 ('motion',0,'text','Video survey','done','https://github.com/smrtesy/video-lab/blob/main/docs/models/sub-research-2b.md'),
 ('motion',1,'text','Shot grammar','done','https://github.com/smrtesy/video-lab/blob/main/docs/models/shot-grammar.json'),
 ('motion',2,'text','Video recipes','done','https://github.com/smrtesy/video-lab/blob/main/docs/models/ltx-2.3-audio-to-video.md'),
 -- lipsync
 ('lipsync',0,'text','Lip-sync recipes','done','https://github.com/smrtesy/video-lab/blob/main/docs/models/latentsync.md')
) as u(stage_slug, position, out_kind, label_en, meta_en, link_url);
