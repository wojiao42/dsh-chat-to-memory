// LLM 蒸馏：把扫描出的数据集分批交给模型，产出记忆候选 JSON。
// 使用 DSH Host 的 ctx.llm.stream（provider/model 由插件配置提供）。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const RULES = `提取规则（严格执行）：
1. 只有 role=user 的消息能作为事实来源；role=assistant 只是上下文，绝不能把 AI 的话当成用户事实。
2. 禁止推断、记录、提及用户的职业。
3. 禁止从问句反推持有：如「如果我把内存升到 256G 呢」是假设，不能记成已持有。
4. 一次性求知的科普内容不算持久事实，除非用户明确表达了自己的持有/使用/立场。
5. 输出三类条目：fact（持久事实：身份/家庭/硬件/消费/项目/习惯/边界）、interest（具体作品/议题/流派等兴趣）、viewpoint（稳定观点/审美/论事风格）。
6. confidence：用户明确陈述=high；需上下文推断=medium；模糊片段=low。
7. sensitivity：孩子健康/成长、家庭构成、财务=private；账号/身份=restricted；其余=normal。
8. 同一事实只输出一条；quotes 最多 2 条、每条≤60 字；宁缺勿滥，没有就输出空 items。`;

const SCHEMA_HINT = `只输出 JSON（不要解释、不要代码块外文字）：
{"version":1,"source":"chatgpt-export","exportDate":"<日期>","items":[{"type":"fact|interest|viewpoint","category":"...","text":"一句话中文，具体可核实","confidence":"high|medium|low","sensitivity":"normal|private|restricted","date":"YYYY-MM-DD","title":"会话标题","convId":"会话 id","quotes":["用户原话摘录≤60字"]}]}`;

/** 从模型输出里抠 JSON（允许 ```json 包裹），解析失败返回 null */
export function extractJson(text) {
  const s = String(text || '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 收集一次 stream 的文本输出 */
async function collectText(stream) {
  let text = '';
  let failure = null;
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue;
    if (chunk.type === 'text-delta') text += chunk.text ?? chunk.delta ?? '';
    else if (chunk.type === 'finish') {
      if (chunk.kind === 'error' || chunk.kind === 'aborted') {
        failure = chunk.failure || { code: chunk.kind };
      }
      break;
    }
  }
  if (failure) throw new Error(`LLM 调用失败：${failure.code || JSON.stringify(failure)}`);
  return text;
}

/**
 * 蒸馏一个数据集文件。
 * @param {object} ctx Host 插件 ctx（需要 ctx.llm）
 * @param {string} datasetPath dataset.json 路径
 * @param {{workdir:string, provider:string, model?:string, batchConvs?:number, exportDate?:string}} opts
 */
const normForVerify = (x) =>
  String(x || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[。，、！？；：""''（）()\[\]{}<>《》…·.,!?;:'"\`~\-—_]/g, '')
    .trim();

export async function distillDataset(ctx, datasetPath, opts = {}) {
  if (!ctx || !ctx.llm || typeof ctx.llm.stream !== 'function') {
    throw new Error('ctx.llm 不可用：蒸馏需要 Host 的 LLM 服务');
  }
  const provider = opts.provider || 'deepseek-official';
  let model = opts.model || '';
  if (!model) {
    model = await resolveDefaultModel(ctx, provider);
  }
  const batchSize = Math.max(1, Number(opts.batchConvs) || 20);
  const workdir = opts.workdir || process.cwd();
  const data = JSON.parse(readFileSync(datasetPath, 'utf8'));
  const conversations = Array.isArray(data.conversations) ? data.conversations : [];
  const batches = [];
  for (let i = 0; i < conversations.length; i += batchSize) batches.push(conversations.slice(i, i + batchSize));

  const items = [];
  let skippedBatches = 0;
  const errors = [];
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    // 只给蒸馏必要的字段，控制 token
    const payload = batch.map((c) => ({
      convId: c.convId,
      title: c.title,
      updatedAt: c.updatedAt,
      messages: (c.messages || []).map((m) => ({ role: m.role, at: m.at, text: m.text })),
    }));
    const prompt = [
      '你是记忆蒸馏器。下面是用户自己 ChatGPT 对话的片段（JSON）。请按规则提炼持久记忆条目。',
      RULES,
      SCHEMA_HINT,
      `本批会话：${JSON.stringify(payload)}`,
    ].join('\n\n');
    let text = '';
    try {
      text = await collectText(
        ctx.llm.stream({
          provider,
          model,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        }),
      );
    } catch (e) {
      skippedBatches++;
      errors.push(`batch ${bi + 1}: ${e.message}`);
      continue;
    }
    let parsed = extractJson(text);
    if (!parsed) {
      // 重试一次：要求只输出 JSON
      try {
        const retry = await collectText(
          ctx.llm.stream({
            provider,
            model,
            messages: [
              { role: 'user', content: [{ type: 'text', text: prompt }] },
              { role: 'assistant', content: [{ type: 'text', text }] },
              { role: 'user', content: [{ type: 'text', text: '上一次输出无法解析为 JSON。请只输出一个合法 JSON 对象，不要任何其它文字。' }] },
            ],
          }),
        );
        parsed = extractJson(retry);
      } catch (e) {
        errors.push(`batch ${bi + 1} retry: ${e.message}`);
      }
    }
    if (!parsed || !Array.isArray(parsed.items)) {
      skippedBatches++;
      continue;
    }
    for (const it of parsed.items) {
      if (!it || typeof it.text !== 'string' || !it.text.trim()) continue;
      items.push({
        type: it.type === 'interest' || it.type === 'viewpoint' ? it.type : 'fact',
        category: String(it.category || ''),
        text: it.text.trim(),
        confidence: ['high', 'medium', 'low'].includes(it.confidence) ? it.confidence : 'low',
        sensitivity: ['normal', 'private', 'restricted'].includes(it.sensitivity) ? it.sensitivity : 'normal',
        date: /^\d{4}-\d{2}-\d{2}$/.test(String(it.date || '')) ? it.date : new Date().toISOString().slice(0, 10),
        title: String(it.title || ''),
        convId: String(it.convId || ''),
        quotes: Array.isArray(it.quotes) ? it.quotes.slice(0, 2).map((q) => String(q).slice(0, 60)) : [],
      });
    }
  }

  // quotes 校验：摘录必须能在数据集用户原话里找到，否则标记为未核实（防止模型编造）
  let unverified = 0;
  let missingQuote = 0;
  try {
    const ds = JSON.parse(readFileSync(datasetPath, 'utf8'));
    const corpus = [];
    for (const c of ds.conversations || []) {
      for (const m of c.messages || []) if (m.role === 'user' && m.text) corpus.push(normForVerify(m.text));
    }
    for (const it of items) {
      const qs = it.quotes || [];
      if (!qs.length) {
        missingQuote++;
        it.quotesUnverified = true;
        continue;
      }
      const verified = qs.filter((q) => {
        const nq = normForVerify(q);
        return nq && corpus.some((t) => t.includes(nq));
      });
      if (!verified.length) {
        unverified++;
        it.quotesUnverified = true;
        if (it.confidence === 'high') it.confidence = 'medium';
      } else {
        it.quotes = verified;
      }
    }
  } catch {
    // 校验失败不影响主流程
  }

  const exportDate = opts.exportDate || new Date().toISOString().slice(0, 10);
  const inbox = join(workdir, 'profile', 'inbox');
  mkdirSync(inbox, { recursive: true });
  const file = join(inbox, `candidates-${new Date().toISOString().slice(0, 10)}-plugin.json`);
  writeFileSync(file, `${JSON.stringify({ version: 1, source: 'chatgpt-export', exportDate, items }, null, 2)}\n`, 'utf8');
  return { file, itemCount: items.length, batches: batches.length, skippedBatches, errors, unverifiedQuotes: unverified, missingQuotes: missingQuote };
}

/** 取 provider 的第一个可用模型 */
export async function resolveDefaultModel(ctx, provider) {
  try {
    const list = await ctx.llm.listModels(provider);
    const arr = Array.isArray(list) ? list : list?.models || [];
    const first = arr.find((m) => m && (m.id || m.name)) || arr[0];
    return first ? String(first.id || first.name) : '';
  } catch {
    return '';
  }
}
