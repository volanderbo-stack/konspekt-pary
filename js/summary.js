// Конспект пари через Claude (Anthropic SDK) або OpenAI. Довгі транскрипції — map-reduce:
// спершу конспект кожної частини, потім зведення в один.

import { fmtTime } from './util.js';
import { summaryToMarkdown } from './markdown.js';
import { ApiError, openaiError, withRetry } from './transcribe.js';

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.135.0/+esm';
const SINGLE_PASS_CHARS = 150_000; // ~2 год пари вкладається в один запит
const PART_CHARS = 60_000;
// Моделі, для яких доступний серверний fallback при відмові класифікатора
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5', 'claude-fable-5-1']);

const item = (props) => ({
  type: 'object', additionalProperties: false, required: Object.keys(props), properties: props,
});
const str = { type: 'string' };
const SCHEMA = item({
  summary: { type: 'array', items: str },
  terms: { type: 'array', items: item({ term: str, definition: str }) },
  homework: { type: 'array', items: item({ task: str, deadline: str, time: str }) },
  questions: { type: 'array', items: item({ question: str, time: str, to_whom: str }) },
  mentions: { type: 'array', items: item({ time: str, context: str }) },
});

function systemPrompt(myName) {
  return `Ти допомагаєш студенту скласти конспект пари за транскрипцією конференції Teams.
Транскрипція — автоматична, тож можливі помилки розпізнавання: виправляй очевидні, але не вигадуй змісту, якого немає в тексті.
Пиши українською. Кожен рядок транскрипції починається з таймкоду [ГГ:ХХ:СС].

Поверни JSON:
- summary: 10–15 пунктів короткого змісту пари в порядку викладу, кожен — одне-два речення по суті.
- terms: ключові терміни й поняття з поясненнями простими словами (як пояснював викладач).
- homework: що задали (завдання, сторінки, задачі, проєкти), deadline — строк, якщо названо, інакше порожній рядок; time — таймкод ГГ:ХХ:СС, де про це сказано.
- questions: питання, які викладач ставив студентам (не риторичні), з таймкодом і to_whom — кому звернено (імʼя або порожній рядок).
- mentions: ${myName ? `місця, де звертались до студента на імʼя «${myName}» (або схожі форми імені), з таймкодом і коротким контекстом.` : 'порожній масив.'}
Таймкоди бери тільки з транскрипції.`;
}

function transcriptText(lec) {
  return lec.paragraphs.map((p) => {
    const t = p.t != null ? `[${fmtTime(p.t)}] ` : '';
    const who = p.speaker ? `${p.speaker}: ` : '';
    return `${t}${who}${p.text}`;
  }).join('\n');
}

function splitText(text, size) {
  const parts = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length > size) { parts.push(cur); cur = ''; }
    cur += `${line}\n`;
  }
  if (cur) parts.push(cur);
  return parts;
}

let sdkPromise;
async function claudeJSON({ apiKey, model, system, user, signal }) {
  sdkPromise ??= import(SDK_URL).catch((e) => {
    sdkPromise = null;
    throw new ApiError(`Не вдалося завантажити бібліотеку Claude (немає мережі?): ${e.message}`);
  });
  const { default: Anthropic } = await sdkPromise;
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 3 });
  const params = {
    model,
    max_tokens: 32000,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    system,
    messages: [{ role: 'user', content: user }],
  };
  if (FALLBACK_MODELS.has(model)) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  let msg;
  try {
    const stream = client.beta.messages.stream(params, { signal });
    msg = await stream.finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new ApiError('Невірний API-ключ Anthropic. Перевірте його в Налаштуваннях.');
    if (e instanceof Anthropic.PermissionDeniedError) throw new ApiError('Ключ Anthropic не має доступу до цієї моделі.');
    if (e instanceof Anthropic.RateLimitError) throw new ApiError('Ліміт запитів Anthropic — спробуйте за хвилину.');
    if (e instanceof Anthropic.BadRequestError && /credit|balance/i.test(e.message)) {
      throw new ApiError('На рахунку Anthropic закінчились кошти.');
    }
    if (e instanceof Anthropic.APIConnectionError) throw new ApiError('Немає зʼєднання з інтернетом.');
    if (e instanceof Anthropic.APIError) throw new ApiError(`Помилка Claude ${e.status ?? ''}: ${e.message}`);
    throw e;
  }
  if (msg.stop_reason === 'refusal') throw new ApiError('Claude відмовився обробити цей текст. Спробуйте OpenAI в Налаштуваннях.');
  if (msg.stop_reason === 'max_tokens') throw new ApiError('Відповідь вийшла задовгою й обірвалась. Спробуйте ще раз.');
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

async function openaiJSON({ apiKey, model, system, user, signal }) {
  return withRetry(async () => {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        response_format: { type: 'json_schema', json_schema: { name: 'konspekt', strict: true, schema: SCHEMA } },
      }),
      signal,
    });
    if (!res.ok) throw await openaiError(res);
    const j = await res.json();
    return JSON.parse(j.choices[0].message.content);
  }, { signal });
}

/** @returns {Promise<string>} Markdown конспекту */
export async function generateSummary(lec, settings, { signal, onProgress }) {
  if (!lec.paragraphs?.length) throw new ApiError('Немає тексту для конспекту.');
  const useClaude = settings.summaryProvider !== 'openai';
  const apiKey = useClaude ? settings.anthropicKey : settings.openaiKey;
  if (!apiKey) throw new ApiError(`Додайте API-ключ ${useClaude ? 'Anthropic' : 'OpenAI'} в Налаштуваннях.`);
  const call = useClaude ? claudeJSON : openaiJSON;
  const model = useClaude ? settings.anthropicModel : settings.openaiModel;
  const system = systemPrompt(settings.myName.trim());
  const header = `Предмет: ${lec.subject || '—'}\nТема: ${lec.title || '—'}\nДата: ${lec.date || '—'}\n\n`;

  const text = transcriptText(lec);
  let result;
  if (text.length <= SINGLE_PASS_CHARS) {
    onProgress?.('Готую конспект… (зазвичай 1–3 хв)');
    result = await call({ apiKey, model, system, user: `${header}ТРАНСКРИПЦІЯ:\n${text}`, signal });
  } else {
    const parts = splitText(text, PART_CHARS);
    const partials = [];
    for (let i = 0; i < parts.length; i++) {
      onProgress?.(`Конспектую частину ${i + 1} з ${parts.length}…`);
      partials.push(await call({
        apiKey, model, system, signal,
        user: `${header}Це частина ${i + 1} з ${parts.length} транскрипції. Для цієї частини дай 4–6 пунктів summary.\n\nТРАНСКРИПЦІЯ (частина):\n${parts[i]}`,
      }));
    }
    onProgress?.('Зводжу частини в один конспект…');
    result = await call({
      apiKey, model, system, signal,
      user: `${header}Нижче — конспекти послідовних частин однієї пари (JSON). Зведи їх в один фінальний конспект: summary 10–15 пунктів, обʼєднай дублікати термінів, збережи всі завдання, питання й таймкоди.\n\n${JSON.stringify(partials)}`,
    });
  }
  return summaryToMarkdown(result, { subject: lec.subject, title: lec.title, myName: settings.myName.trim() });
}
