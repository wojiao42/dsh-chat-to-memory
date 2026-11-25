// 回灌 provenance：从 profile\inbox\candidates-*.json 建立「候选文本 → 来源会话」索引
import fs from 'node:fs';
import path from 'node:path';
import { recordProvenance } from './provenance.mjs';

const WORKDIR = process.argv[2] || 'D:\\deepseek workspace';
const inbox = path.join(WORKDIR, 'profile', 'inbox');
let added = 0;
let files = 0;
for (const f of fs.readdirSync(inbox)) {
  if (!/^candidates-.*\.json$/.test(f)) continue;
  files++;
  const p = path.join(inbox, f);
  const r = recordProvenance(WORKDIR, { source: '', datasetPath: '', candidatesFile: p, runId: 'backfill-' + f.replace(/^candidates-|\.json$/g, '') });
  added += r.added;
}
console.log(JSON.stringify({ ok: true, files, added, provenanceLines: fs.existsSync(path.join(WORKDIR, 'profile', 'imports', 'provenance.jsonl')) ? fs.readFileSync(path.join(WORKDIR, 'profile', 'imports', 'provenance.jsonl'), 'utf8').trim().split('\n').length : 0 }, null, 2));
