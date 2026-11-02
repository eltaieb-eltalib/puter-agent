// Small syntax highlighter for code blocks (no dependencies). One tokenizer pass per line with
// language-family rules: comments, strings, numbers, keywords, built-ins, function calls.
// Good enough for reading code in a terminal; it never changes the text, only colours it.

import { paint } from './style.js';

const KEYWORDS = {
  js: 'as async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield',
  py: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield',
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var',
  rs: 'as async await break const continue crate else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while',
  java: 'abstract assert break case catch class const continue default do else enum extends final finally for if implements import instanceof interface native new package private protected public return static super switch synchronized this throw throws try void volatile while var record',
  sh: 'if then else elif fi for while until do done case esac function in return export local readonly set unset source echo cd',
  sql: 'select from where insert into values update set delete create table drop alter index join left right inner outer on group by order having limit offset as and or not null primary key foreign references distinct union all',
  css: '',
  json: '',
};
KEYWORDS.ts = `${KEYWORDS.js} interface type enum implements namespace declare readonly private public protected abstract keyof`;
KEYWORDS.c = 'auto break case char const continue default do double else enum extern float for goto if int long register return short signed sizeof static struct switch typedef union unsigned void volatile while class public private protected namespace template typename using virtual new delete';
KEYWORDS.php = 'abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global goto if implements include instanceof insteadof interface isset list match namespace new or print private protected public readonly require return static switch throw trait try unset use var while yield';
KEYWORDS.rb = 'alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield';

const LITERALS = /^(?:true|false|null|undefined|None|True|False|nil|NaN|Infinity)$/;
const ALIASES = {
  javascript: 'js', mjs: 'js', cjs: 'js', jsx: 'js', node: 'js', typescript: 'ts', tsx: 'ts', python: 'py', py3: 'py', golang: 'go', rust: 'rs',
  kotlin: 'java', kt: 'java', cs: 'java', csharp: 'java', 'c#': 'java', swift: 'java', dart: 'java', scala: 'java', cpp: 'c', 'c++': 'c', h: 'c', hpp: 'c',
  bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', powershell: 'sh', ps1: 'sh', bat: 'sh', cmd: 'sh', ruby: 'rb', yaml: 'yaml', yml: 'yaml', scss: 'css', less: 'css', html: 'html', xml: 'html', vue: 'html', svelte: 'html',
};

export function normalizeLang(lang) {
  const l = String(lang ?? '').trim().toLowerCase().split(/\s/)[0];
  return ALIASES[l] ?? l;
}

const COMMENT = {
  js: ['//', '/*'], ts: ['//', '/*'], go: ['//', '/*'], rs: ['//', '/*'], java: ['//', '/*'], c: ['//', '/*'], php: ['//', '/*'], css: [null, '/*'],
  py: ['#'], sh: ['#'], rb: ['#'], yaml: ['#'], sql: ['--'],
};

const keywordSets = new Map();
const keywordsFor = (lang) => {
  if (!keywordSets.has(lang)) keywordSets.set(lang, new Set((KEYWORDS[lang] ?? '').split(/\s+/).filter(Boolean)));
  return keywordSets.get(lang);
};

/** Highlight a block of code. Returns an array of coloured lines. State (block comments, multi-line strings) carries across lines. */
export function highlight(code, lang) {
  const l = normalizeLang(lang);
  const lines = String(code).replace(/\t/g, '  ').split('\n');
  if (!l || l === 'text' || l === 'txt' || l === 'plain') return lines;
  if (l === 'html') return lines.map(highlightHtml);
  if (l === 'diff' || l === 'patch') return lines.map((x) => (x.startsWith('+') ? paint.add(x) : x.startsWith('-') ? paint.del(x) : x.startsWith('@@') ? paint.meta(x) : x));
  const keys = keywordsFor(l);
  const [lineComment, blockComment] = COMMENT[l] ?? ['//', '/*'];
  let inBlock = false;
  let inTriple = null;
  return lines.map((line) => {
    let out = '';
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i);
        const stop = end === -1 ? line.length : end + 2;
        out += paint.comment(line.slice(i, stop));
        i = stop;
        if (end !== -1) inBlock = false;
        continue;
      }
      if (inTriple) {
        const end = line.indexOf(inTriple, i);
        const stop = end === -1 ? line.length : end + 3;
        out += paint.string(line.slice(i, stop));
        i = stop;
        if (end !== -1) inTriple = null;
        continue;
      }
      const rest = line.slice(i);
      if (lineComment && rest.startsWith(lineComment) && !(l === 'sh' && i > 0 && line[i - 1] === '$')) {
        out += paint.comment(rest);
        break;
      }
      if (blockComment && rest.startsWith('/*')) {
        inBlock = true;
        continue;
      }
      if (l === 'py' && (rest.startsWith('"""') || rest.startsWith("'''"))) {
        inTriple = rest.slice(0, 3);
        out += paint.string(inTriple);
        i += 3;
        continue;
      }
      const ch = line[i];
      if (ch === '"' || ch === "'" || ch === '`') {
        let j = i + 1;
        while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1;
        out += paint.string(line.slice(i, j + 1));
        i = j + 1;
        continue;
      }
      const num = /^(?:0x[\da-f]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)\b/i.exec(rest);
      if (num && !/[\w$]/.test(line[i - 1] ?? '')) {
        out += paint.number(num[0]);
        i += num[0].length;
        continue;
      }
      const word = /^[A-Za-z_$@][\w$]*/.exec(rest);
      if (word) {
        const w = word[0];
        const next = line.slice(i + w.length).trimStart()[0];
        if (keys.has(l === 'sql' ? w.toLowerCase() : w)) out += paint.keyword(w);
        else if (LITERALS.test(w)) out += paint.number(w);
        else if (l === 'json' && next === ':') out += paint.prop(w);
        else if (next === '(') out += paint.fn(w);
        else if (/^[A-Z][a-z]/.test(w) && l !== 'sh') out += paint.type(w);
        else out += w;
        i += w.length;
        continue;
      }
      if (l === 'css' && ch === '#' ) {
        const sel = /^#[\w-]+/.exec(rest);
        if (sel) {
          out += paint.fn(sel[0]);
          i += sel[0].length;
          continue;
        }
      }
      out += /[{}()[\];,.:=<>+\-*/%!&|^~?]/.test(ch) ? paint.punct(ch) : ch;
      i++;
    }
    return out;
  });
}

function highlightHtml(line) {
  return line
    .replace(/(<!--.*?-->)/g, (m) => paint.comment(m))
    .replace(/(<\/?)([\w-]+)/g, (_, a, tag) => `${paint.punct(a)}${paint.keyword(tag)}`)
    .replace(/([\w-]+)=("[^"]*"|'[^']*')/g, (_, attr, val) => `${paint.prop(attr)}=${paint.string(val)}`);
}
