// Local request analysis: decides HOW MUCH structure a request needs, in plain JavaScript,
// without spending a model call. The result shapes a tiny "task frame" sent with the request:
//   simple   -> act directly, no plan (saves tokens and steps on trivial work)
//   moderate -> brief plan only if needed
//   complex  -> todo_write plan first, verify, then summarise
// It also gives the loop a soft step budget: when the budget is used up the model receives one
// short "checkpoint" note (re-check the plan / converge) instead of an extra reasoning call.

import { normalizeArabic, routeRequest } from './router.js';

const AR = '\\u0600-\\u06FF';
const ar = (src) => new RegExp(`(?<![${AR}])(?:${src})(?![${AR}])`);
const en = (src) => new RegExp(`\\b(?:${src})\\b`, 'i');

const CHANGE = [
  en('create|build|make|write|fix|implement|refactor|delete|install|edit|add|update|rename|move|debug|migrate|port|optimi[sz]e|improve|convert|integrate'),
  ar('انشئ|اعمل|اصنع|ابني|برمج|اكتب|اصلح|صلح|عدل|احذف|ثبت|حدث|طور|ضيف|اضف|انقل|غير|حسن|حول'),
];
const RUN = [en('run|execute|test|start|launch|compile'), ar('شغل|نفذ|اختبر|جرب')];
const QUESTION = [en('what|why|how|where|which|explain|does|is there|show me'), ar('ما|ماذا|لماذا|كيف|اين|وين|اشرح|هل|وضح')];
const BROAD = [
  en('entire|whole|all files|every|across|architecture|codebase|project-wide|full|complete|end-to-end|system'),
  ar('كامل|كل|جميع|المشروع|بنية|شامل|النظام'),
];
const STEPS_WORDS = [en('then|after that|and also|finally|step'), ar('ثم|بعد ذلك|بعدها|واخيرا|وايضا|خطوة')];

const any = (patterns, text) => patterns.some((re) => re.test(text));

/** Count list items / numbered lines: a long checklist means a multi-step task. */
function countItems(text) {
  return String(text).split(/\r?\n/).filter((l) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(l)).length;
}

/**
 * Analyse a request. Pure function: same input -> same output.
 * Returns { kind, complexity, goal, signals, needsPlan, softBudget }.
 */
export function analyzeRequest(text, { mode = 'build', maxSteps = 60 } = {}) {
  const raw = String(text ?? '').trim();
  const t = normalizeArabic(raw);
  const signals = [];
  const words = t.split(/\s+/).filter(Boolean).length;
  const items = countItems(raw);
  const files = (raw.match(/[\w./-]+\.[a-z]{1,5}\b/gi) ?? []).length;

  const research = routeRequest(raw).research;
  const change = mode !== 'plan' && any(CHANGE, t);
  const run = mode !== 'plan' && any(RUN, t);
  const question = any(QUESTION, t) || /[?؟]\s*$/.test(raw);

  let kind = 'chat';
  if (change) kind = 'change';
  else if (run) kind = 'run';
  else if (research) kind = 'research';
  else if (question) kind = 'question';

  let score = 0;
  if (words > 40) (score += 1), signals.push('long request');
  if (words > 150) score += 1;
  if (items >= 3) (score += 2), signals.push(`${items} listed items`);
  if (files >= 3) (score += 1), signals.push(`${files} files named`);
  if (any(BROAD, t)) (score += 1), signals.push('broad scope');
  if (any(STEPS_WORDS, t)) (score += 1), signals.push('sequenced steps');
  if (change && run) score += 1;
  if (kind === 'chat' || (kind === 'question' && words < 25)) score = Math.min(score, 0);

  const complexity = score >= 3 ? 'complex' : score >= 1 ? 'moderate' : 'simple';
  const firstSentence = raw.split(/(?<=[.!?؟])\s|\n/)[0] ?? raw;
  const goal = firstSentence.length > 160 ? `${firstSentence.slice(0, 159)}…` : firstSentence;
  const budgets = { simple: 8, moderate: 20, complex: Math.max(30, Math.round(maxSteps * 0.75)) };
  return {
    kind,
    complexity,
    goal,
    signals,
    needsPlan: complexity === 'complex' && kind !== 'chat',
    softBudget: Math.min(maxSteps, budgets[complexity]),
  };
}

const FRAME = {
  simple: 'simple: act directly with the fewest tool calls; no plan, no todo list.',
  moderate: 'moderate: inspect only what you need, then act; a todo list only if there are 3+ distinct steps.',
  complex: 'complex: first todo_write a short plan (3-7 steps), execute one step at a time, adapt the plan when results change it, verify, then summarise.',
};

/** One short line appended to the user message (NOT the system prompt, which stays cache-stable). */
export function taskFrame(analysis) {
  if (!analysis || analysis.kind === 'chat') return '';
  return `\n\n[task frame: ${analysis.kind}, ${FRAME[analysis.complexity]}]`;
}

/** Note sent once when the soft budget is spent: a self-check instead of an extra model call. */
export function checkpointNote(steps, analysis) {
  return `Checkpoint: ${steps} steps used (expected ~${analysis.softBudget} for a ${analysis.complexity} task). Re-check: is the goal ("${analysis.goal}") reached? If yes, stop and summarise. If not, state in one line what is still missing and take the most direct step. Do not repeat earlier calls.`;
}
