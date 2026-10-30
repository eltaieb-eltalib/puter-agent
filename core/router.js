/**
 * Code-level routing for "search the web" requests.
 *
 * Weak models often ignore the prompt rule "research questions -> web_search" and start building an app
 * or answer "I can't browse". So for clear requests we run web_search ourselves, before the first model
 * call, and put the call + its result into the history as if the model had made it. The model then
 * continues from real results (reads pages with web_fetch, answers with sources).
 */

const AR = '\\u0600-\\u06FF';
const wordAr = (src) => new RegExp(`(?<![${AR}])(?:${src})(?![${AR}])`);
const wordEn = (src) => new RegExp(`\\b(?:${src})\\b`, 'i');

/** Remove tashkeel/tatweel and unify alef/yaa forms so one pattern matches every spelling. */
export function normalizeArabic(text) {
  return String(text ?? '')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي');
}

// The user clearly asks to search: always route to web_search, even if the request also builds something.
const EXPLICIT = [
  wordAr('ابحث|ابحثي|دور|فتش|سوي بحث|اعمل بحث|بحث عن'),
  wordAr('(?:في|على|من) (?:الانترنت|النت|الويب|جوجل|قوقل)'),
  wordEn('search(?: for| the (?:web|internet))?|look\\s?up|google|find (?:me )?(?:info|information|out)|on the (?:web|internet)|online'),
];

// Questions that need current/external facts. Only routed when nothing suggests building or touching files.
// Plain "what is X" explanations are NOT routed: the model already knows those (and often they are about
// the conversation itself, e.g. "what is my name?").
const IMPLICIT = [
  wordAr('من هو|من هي|متى|كم سعر|سعر|اخبار|احدث|اخر|كلمات|نشيد|قصيدة|طقس'),
  wordEn('who is|who was|when did|when is|latest|news|price of|lyrics|weather'),
];

// References to the conversation / the user / "this thing" mean the answer is not on the web.
const PERSONAL = [
  wordAr('اسمي|انا|اني|عندي|معي|لي|هذا|هذه|ده|دي|قلت|قلنا|سابقا'),
  wordEn('my|mine|me|you|your|this|that|we|our|earlier|before'),
];

// Verbs and words that mean "do something in the workspace", not "look something up".
const BUILD = [
  wordAr('انشئ|اعمل|اصنع|ابني|برمج|اكتب|صلح|عدل|احذف|شغل|ثبت|حدث|ضيف|انقل|غير|ترجم'),
  wordEn('create|build|make|write|fix|implement|refactor|delete|install|run|edit|add|update|rename|move|debug|test|translate'),
  wordAr('ملف|ملفات|مشروع|الكود|كود|مجلد|سكربت|تطبيق|برنامج|موقع'),
  wordEn('file|files|project|code|function|repo|folder|script|app|website|workspace'),
];

const matches = (list, text) => list.some((re) => re.test(text));

/** Strip the command words ("ابحث لي عن", "search the internet for") and keep the topic. Exported for tests. */
export function extractQuery(text) {
  let q = String(text ?? '').replace(/[\u064B-\u065F\u0670\u0640]/g, '').trim();
  const polite = /^(?:(?:من فضلك|لو سمحت|رجاء|ممكن|لو تكرمت|please|can you|could you|kindly)\s+)+/i;
  const lead =
    /^(?:[اأإآ]بحث(?:ي)?|دور|فتش|اعمل بحث|سوي بحث|search|look\s?up|google|find(?: me)?|tell me)\s*(?:لي|لنا|ليا|me)?\s*(?:عن|في|على|about|for)?\s*(?:(?:الا?نترنت|الإنترنت|النت|الويب|جوجل|قوقل|the\s+(?:internet|web)|internet|web|online)\s*(?:عن|about|for)?\s*)?/i;
  const trail = /\s*(?:(?:في|على|من)\s+(?:الا?نترنت|الإنترنت|النت|الويب|جوجل|قوقل)|on the (?:internet|web)|online)\s*[.؟?!]*$/i;
  q = q.split(/\s+(?:ثم|وبعدها|وبعدين|بعدين|then|and then|after that)\s+/i)[0];
  q = q.replace(polite, '').replace(lead, '').replace(trail, '').replace(/[؟?!.\s]+$/g, '').trim();
  return q || String(text ?? '').trim();
}

/**
 * Decide whether a user message should trigger an automatic web_search.
 * Returns { research: boolean, reason: 'explicit' | 'implicit' | null, query }.
 */
export function routeRequest(text) {
  const raw = String(text ?? '').trim();
  const none = { research: false, reason: null, query: '' };
  if (!raw || raw.startsWith('/')) return none;
  const norm = normalizeArabic(raw);
  if (matches(EXPLICIT, norm)) return { research: true, reason: 'explicit', query: extractQuery(raw) };
  if (matches(IMPLICIT, norm) && !matches(BUILD, norm) && !matches(PERSONAL, norm)) return { research: true, reason: 'implicit', query: extractQuery(raw) };
  return none;
}
