# Puter Agent v0.2

وكيل ذكاء اصطناعي في الطرفية على طريقة **opencode**، مبني بـ **Node.js**، ويدعم Puter.js وGoogle Gemini وOpenAI API وAgentRouter عبر Responses API. يقرأ ويبحث وينشئ ويعدّل ويشغّل الملفات داخل مجلد عمل، **ويبحث في الإنترنت** ويقرأ الصفحات.

## الجديد في v0.2

| الميزة | الوصف |
|---|---|
| OpenAI API | SDK الرسمي مع Responses API، اكتشاف النماذج من الحساب، Function Calling بصيغة Responses، ومستويات reasoning قابلة للضبط حسب النموذج |
| AgentRouter | اتصال مباشر بـ `https://agentrouter.org/v1/responses`، نماذج GPT الثلاثة المحددة، Bearer API Key، وFunction Calling عبر Responses API |
| Gemini API | دعم Gemini مع مستويات thinking الخاصة به |
| `web_search` | بحث في الإنترنت: SearXNG (خادمك أو عام) ← DuckDuckGo ← ويكيبيديا، تلقائياً بالترتيب |
| `web_fetch` | تنزيل صفحة وتحويلها لنص مقروء (يدعم العربية والتقسيم لصفحات) |
| `run_python` | تشغيل سكربت بايثون من مجلد العمل (بجانب `run_node` و`run_command`) |
| `todo_write` / `todo_read` | قائمة مهام يظهرها الوكيل أثناء العمل |
| `ask_user` | يسألك سؤالاً واحداً فقط عند الغموض الحقيقي |
| وضعان | `/plan` للقراءة والبحث والتخطيط فقط، `/build` للتنفيذ الكامل |
| `AGENTS.md` | ملاحظات المشروع تُحمَّل تلقائياً في الـ prompt (والأمر `/init` ينشئها) |
| `/resume` | استرجاع آخر محادثة محفوظة في نفس مجلد العمل (تُحفظ تلقائياً) |
| `-p "طلب"` | تشغيل طلب واحد بدون واجهة تفاعلية ثم الخروج |
| System prompt جديد | يقرر بنفسه: بحث / سؤال عن المشروع / بناء / كتابة / تشغيل / دردشة |
| إصلاح النماذج الضعيفة | إذا كتب النموذج الأداة كنص JSON `{"tool":...}` يُنفَّذ كاستدعاء حقيقي |

## الواجهة الجديدة (على طريقة opencode)

- شاشة بداية بشعار كبير وصندوق إدخال في الوسط، ثم يتحول لعرض المحادثة مع بقاء الصندوق أسفلها.
- **اللصق آمن:** لصق نص من عدة أسطر (أو أوامر) يوضع داخل الصندوق ولا يُنفَّذ سطراً سطراً. النص الطويل يظهر كـ `[Pasted text #1 +12 lines]` ويُرسَل كاملاً عند الضغط على Enter.
- `Enter` إرسال · `Ctrl+J` أو `Alt+Enter` سطر جديد (أو اكتب `\` في نهاية السطر) · `↑/↓` السجل · `Shift+Tab` تبديل plan/build · `Ctrl+P` أو `/` قائمة الأوامر (`↑/↓` ثم `Tab`/`Enter`) · `Ctrl+C` يمسح الصندوق، وإذا كان فارغاً مرتان للخروج، وأثناء عمل الوكيل يلغي المهمة.
- أسئلة الصلاحيات تظهر كأزرار (`←/→` ثم Enter، أو الحرف `o` / `a` / `n`).
- الملفات: `terminal/input.js` (محرر الإدخال)، `terminal/home.js` (الشعار)، `terminal/interface.js`، `terminal/themes.js`.

## الموثوقية والأمان (التحسينات الجديدة)

| المشكلة | المعالجة |
|---|---|
| الكود قد يفشل | بعد تعديل أي ملف كود لا يُسمح للوكيل بإنهاء المهمة قبل تشغيل شيء (اختبار / `node --check` / البرنامج). يُذكَّر مرتين كحد أقصى (`verify` في settings). |
| أخطاء في الأرقام والنصوص | قواعد في الـ prompt: لا أرقام ولا اقتباسات من الذاكرة، الحساب بالكود، فصل "تم التحقق" عن "افتراض"، ذكر المصدر. |
| سوء فهم الطلب | قبل المهام الكبيرة/الغامضة يكتب سطرين: الفهم والافتراضات، ويسأل فقط إذا كان الخطأ مكلفاً. |
| نتائج أدوات ضعيفة | تُضاف إلى النتيجة `hint` (بحث فارغ، صفحة شبه فارغة، ملف مقتطع)، وبعد فشل نفس الاستدعاء مرتين يُطلب منه تغيير الأسلوب قبل التوقف. |
| ضياع الذاكرة | `/memory` وأدوات `memory_write/read/forget`: ملاحظات دائمة في `.puter-agent/memory.md` تُحمَّل في كل طلب. والمحادثات الطويلة تُلخَّص تلقائياً بدل قصّها (`context.compactAtChars`). |
| تعديل خاطئ | قبل أي تعديل/حذف/نقل تُحفظ نسخة، والأمر `/undo` يرجع آخر مهمة (يستعيد المعدّل ويحذف ما أُنشئ). |
| الخصوصية | قراءة `.env` والمفاتيح تحتاج موافقتك، و`search_files` يتخطاها، وأي مفتاح/توكن يظهر في نتيجة أداة يُخفى (`***`) قبل أن يراه النموذج أو الشاشة. |
| قياس التحسن | `npm run eval` يشغّل مهام اختبار للوكيل نفسه (`evals/tasks.json`)؛ شغّله قبل وبعد أي تغيير في الـ prompt وقارن النتائج. |

الأوامر الجديدة: `/undo` ، `/memory [add|forget|clear] [نص]`.

## التشغيل

```bat
cd puter-agent
npm install
copy .env.example .env
node index.js
```

خيارات: `-w <مجلد>` مجلد العمل، `-m <نموذج>`، `--mode plan|build`، `-p "نص"`.

**المصادقة:** اختر المزود من `.env` أو استخدم `/connect` داخل التطبيق.
- Puter: `PUTER_AUTH_TOKEN` أو تسجيل الدخول بالمتصفح.
- Gemini: `GEMINI_API_KEY` (تكامل Google الأصلي).
- OpenAI: `OPENAI_API_KEY` (Responses API).
- AgentRouter: `AGENTROUTER_API_KEY` (Responses API).
- Anthropic: `ANTHROPIC_API_KEY` (Messages API الأصلي).
- المزودون المتوافقون مع OpenAI Chat Completions: AnyAPI, DeepSeek, OpenRouter, Groq, Mistral, xAI, Cerebras, Together AI, Fireworks, NVIDIA NIM, Perplexity, Z.AI, Moonshot, Qwen. ضع مفتاح المزود المطابق في `.env`.
- محلياً: Ollama وLM Studio يستخدمان عناوين localhost الافتراضية؛ لا يحتاجان مفتاحاً عادةً.

التكامل المتوافق يستخدم Chat Completions مع دعم function calling، ويحاول جلب النماذج من `/models` ثم يرجع إلى قائمة افتراضية إذا لم يوفر المزود endpoint للنماذج.

**البحث:** يعمل مباشرة بلا إعداد. للحصول على أفضل نتائج شغّل SearXNG خاصاً بك (Docker) وضع `SEARXNG_URL=http://localhost:8080` في `.env`. خوادم SearXNG العامة كثيراً ما تعطّل صيغة JSON أو تتوقف، ولذلك يوجد بديل DuckDuckGo ثم ويكيبيديا. القائمة والترتيب في `config/settings.json` تحت `search`.

> مهم لـ SearXNG الخاص: فعّل JSON في `settings.yml`: `search: formats: [html, json]`.

## الأوامر

| الأمر | الوظيفة |
|---|---|
| `/help` | قائمة الأوامر |
| `/plan` ، `/build` ، `/mode` | تبديل الوضع |
| `/search <نص>` | بحث سريع بنفسك بدون الذكاء الاصطناعي |
| `/todos` | عرض قائمة مهام الوكيل |
| `/init` | يدرس المشروع وينشئ `AGENTS.md` |
| `/resume` | استرجاع آخر محادثة |
| `/model [نص]` ، `/models` | عرض/تغيير النموذج من المزود الحالي |
| `/connect [provider] [model]` | تغيير المزود والنموذج؛ اكتب `/connect` لعرض القائمة والأمثلة |
| `/thinking [level]` | ضبط thinking/reasoning effort حسب المزود والنموذج |
| `/reasoning-mode [standard|pro]` | وضع reasoning في نماذج OpenAI المدعومة |
| `/workspace [مجلد]` | تغيير مجلد العمل |
| `/tools` | الأدوات المتاحة |
| `/clear` ، `/exit` | محادثة جديدة / خروج |

**Ctrl+C** يلغي المهمة الجارية. إن توقف الوكيل بسبب حد الخطوات اكتب `continue`.

## نصائح

- النموذج الافتراضي `gpt-5.4-nano` صغير؛ للمهام الصعبة غيّره بـ `/model` (مثلاً نموذج أكبر من Claude أو GPT) فالفرق كبير في الالتزام بالأدوات.
- العمليات الحساسة (حذف، استبدال، نقل، تشغيل أوامر) تطلب موافقتك `[y/N]`؛ البحث وقراءة الصفحات لا تحتاج موافقة.
- الاختبارات: `npm test` (لا تحتاج إنترنت ولا حساب Puter).

---

## توثيق v0.1 (ما زال صالحاً)

وكيل ذكاء اصطناعي خفيف يعمل في CMD / PowerShell، مبني بـ **Node.js**، ويدعم Puter.js وGoogle Gemini وOpenAI API وAgentRouter عبر Responses API. لا يكتفي بعرض الأكواد: يضع خطة، وينشئ الملفات ويعدّلها داخل مجلد عمل محدد، ويشغّل الكود للتحقق منه، ويصلح الأخطاء، ثم يعرض ملخصاً بما أنجزه.

> **الحالة (v0.1):** المراحل 1 و2 و3 من المواصفات منفّذة: النواة وواجهة CMD، الأدوات المحلية، وحلقة الوكيل مع Function Calling. المراحل 4–7 (اختبار مشاريع أكبر، الذاكرة الدائمة، التخطيط المحفوظ، Skills وMCP) لم تُنفّذ بعد. انظر «ما تم التحقق منه» أدناه.

## المتطلبات

- Node.js 20.3 أو أحدث لمشروعنا. توثيق Puter.js نفسه يذكر **Node.js 24+**؛ إن ظهر خطأ عند تحميل Puter فحدّث Node.
- حساب على [puter.com](https://puter.com).
- Windows Terminal يُنصح به. شاشة CMD القديمة لا تعرض العربية المتصلة بشكل سليم، لذلك واجهة البرنامج بالإنجليزية، لكن الوكيل يردّ بلغتك.

## التثبيت والتشغيل

```bat
cd puter-agent
npm install
copy .env.example .env
node index.js
```

اختياري: `node index.js -w F:\AI-Projects` لتحديد مجلد العمل، و`-m <model>` لتحديد النموذج.

**المصادقة** (من توثيق Puter.js):

1. **رمز API (موصى به):** أنشئ رمزاً من [puter.com/dashboard](https://puter.com/dashboard) بزر *Create token*، وضعه في `.env` كالتالي `PUTER_AUTH_TOKEN=...`.
2. **تسجيل الدخول بالمتصفح:** إن تركت الرمز فارغاً تُفتح نافذة متصفح عند كل تشغيل.

ملف `.env` مُستثنى في `.gitignore`. لا تضعه في Git. والرمز لا يُمرَّر أبداً للأوامر التي ينفذها الوكيل، ويُحجب من رسائل الأخطاء.

## الاستخدام

```
Puter Agent v0.1.0
Model: gpt-5.4-nano
Provider: Puter.js
Workspace: F:\AI-Projects

Agent > make a calculator using HTML, CSS and JavaScript
```

يعرض الوكيل الخطة، ثم كل أداة يستعملها، ثم الملفات التي أنشأها أو عدّلها. العمليات الحساسة تتوقف وتسألك `Allow? [y/N]`. **Ctrl+C** يلغي المهمة الجارية.

| الأمر | الوظيفة |
|---|---|
| `/help` | قائمة الأوامر |
| `/model [نص]` | عرض النموذج أو تغييره (بحث في قائمة Puter، المحادثة تستمر) |
| `/models` | تحديث قائمة النماذج |
| `/workspace [مجلد]` | عرض مجلد العمل أو تغييره (تبدأ محادثة جديدة) |
| `/tools` | الأدوات المتاحة للوكيل |
| `/clear` | محادثة جديدة |
| `/exit` | خروج |

إذا توقف الوكيل بسبب حد الخطوات أو انقطاع الاتصال فاكتب `continue` ليكمل بنفس السياق.

## كيف يعمل

```
طلبك -> النموذج -> استدعاء أداة -> تنفيذ (بعد فحص المسار والصلاحية) -> نتيجة -> النموذج -> ... -> الجواب النهائي
```

الحلقة في `core/agent-loop.js`. كل استدعاء أداة يحصل دائماً على رسالة نتيجة (نجاح أو خطأ أو رفض أو إلغاء) فيبقى السجل صالحاً. الخطأ الذي ترجعه أداة يصل للنموذج ليصلحه. وتتوقف الحلقة عند الإجابة النهائية، أو عند `maxSteps`، أو إذا فشل الاستدعاء نفسه 3 مرات متتالية، أو عند الإلغاء.

```
index.js            نقطة الدخول
config/             settings.json + load.js
providers/          puter.js (الاتصال بـ Puter.js) + provider-manager.js
core/               agent.js, agent-loop.js, context.js (System Prompt)
tools/              registry.js, filesystem.js, terminal.js
security/           path-guard.js, permissions.js
terminal/           interface.js, commands.js
utils/              errors.js, retry.js, logger.js, env.js
tests/              اختبارات node:test (بلا اعتماديات)
workspace/          مجلد العمل الافتراضي
```

الأدوات: `read_file` `create_file` `edit_file` `delete_file` `list_files` `create_directory` `move_file` `search_files` `run_command` `run_node`. (`run_npm` و`run_tests` و`inspect_project` وغيرها من الأدوات المقترحة ضمن المراحل التالية، ويمكن حالياً استعمال `run_command` لتشغيل `npm test`.)

## الأمان

| الحماية | التفاصيل |
|---|---|
| مجلد عمل محدد | كل المسارات تُحسب بالنسبة له. يُمنع `..` والمسارات المطلقة الخارجية، وكذلك الهروب عبر الروابط الرمزية (symlinks). |
| خارج مجلد العمل | `security.outsideWorkspace`: `"ask"` (يسأل، الافتراضي) أو `"deny"` (منع تام) أو `"allow"` (وصول لأي مجلد في النظام بدون سؤال). |
| موافقة قبل | الحذف، الكتابة فوق ملف موجود، النقل، وتشغيل أي أمر. تُعدَّل من `approvals` في `config/settings.json`. |
| لا حذف جماعي | `delete_file` يحذف ملفاً واحداً فقط. والنقل لا يكتب فوق وجهة موجودة. |
| الأوامر | يُعرض الأمر كاملاً قبل التنفيذ. أنماط كارثية (`format C:` و`shutdown` و`rm -rf /` و`curl ... \| sh`...) تُرفض قبل السؤال أصلاً. |
| الرمز السري | لا يصل للأوامر المنفذة، ويُحجب من رسائل الأخطاء. |

**تنبيه:** هذه حماية على مستوى التطبيق وليست عزلاً (sandbox). الأمر الذي توافق عليه يعمل بصلاحياتك الكاملة، فاقرأ كل أمر قبل أن تضغط `y`.

## ميزات على طريقة opencode

| الميزة | الاستعمال |
|---|---|
| `glob` | البحث عن ملفات بالاسم: `**/*.js` و`src/**/*.{ts,tsx}` |
| `multi_edit` | عدة تعديلات على ملف واحد في استدعاء واحد (كلها تنجح أو لا يُكتب شيء) |
| `task` | وكيل فرعي للقراءة والبحث فقط بسياق نظيف، يرجع تقريراً للوكيل الرئيسي |
| `@ملف` | اكتب `@src/app.js اشرح هذا` فيُرفق محتوى الملف (أو قائمة المجلد) بالرسالة. الملفات السرية وخارج مجلد العمل لا تُرفق |
| أوامر مخصصة | ضع `.puter-agent/commands/review.md` في مجلد العمل فيصبح `/review`. السطر الأول `# وصف` يظهر في `/help`، و`$ARGUMENTS` يُستبدل بما بعد الأمر |
| `/compact` | تلخيص المحادثة الآن لتوفير السياق |
| `/export` | حفظ المحادثة كملف Markdown في `.puter-agent/exports` |

## الواجهة (TUI)

كل الصفحات والخيارات صارت واجهة طرفية تفاعلية بدل الأسئلة النصية:

| الصفحة | كيف تفتحها |
|---|---|
| **القائمة الرئيسية** (كل الصفحات والإعدادات وقيمها الحالية) | `Ctrl+P` أو `/menu` أو `/` وحدها |
| قائمة النماذج (بحث فوري، وإدخال id يدوي) | `/model` |
| قائمة المزوّدين مع حالة المفتاح، ثم النموذج | `/connect` |
| إدخال مفتاح API **مخفي** (يُحفظ في `.env` بصلاحية خاصة بك) | يظهر تلقائياً عند اختيار مزوّد بلا مفتاح |
| مستوى الوصول مع نافذة تأكيد حمراء للوصول الكامل | `/access` |
| الطور (BUILD/PLAN) ومستوى التفكير ووضع الاستدلال | `/mode` و`/thinking` و`/reasoning-mode` |
| الرجوع لمهمة سابقة مع تأكيد | `/rewind` |
| الذاكرة: عرض/إضافة/نسيان/مسح | `/memory` |
| صفحات قابلة للتمرير: المساعدة والأدوات والتغييرات (git) ونتائج البحث | `/help` `/tools` `/diff` `/search` |
| لوحات: السياق (مع مقياس) وMCP وHooks والأذونات | `/context` `/mcp` `/hooks` `/permissions` |

مفاتيح القوائم: اكتب للتصفية، `↑/↓` للتنقل، `PgUp/PgDn` للقفز، `Enter` للاختيار، `Esc` للرجوع. في الصفحات: `q` للإغلاق و`g/G` للبداية والنهاية. في حقل المفتاح: `Ctrl+R` لإظهار/إخفاء ما كتبت.

إذا لم تكن الطرفية تفاعلية (أنبوب أو CI أو اختبارات) تعود كل الصفحات تلقائياً إلى نص عادي بأرقام وأسئلة، فلا ينكسر شيء.

## ميزات على طريقة Claude Code

### قواعد الأوامر (تقليل الأسئلة دون فقدان الأمان)
في `config/settings.json`:
```json
"rules": {
  "allowCommands": ["git status*", "git diff*", "npm test*"],
  "denyCommands": ["git push*", "git reset --hard*", "npm publish*"]
}
```
`*` تعني أي نص. أوامر `allow` تُنفَّذ بدون سؤال، لكن فقط إذا كانت بسيطة: أي أمر فيه `;` أو `&` أو `|` أو `>` أو `<` أو `` ` `` أو `$(` يسأل دائماً. وقواعد `deny` تُفحص على كل جزء من الأمر المركب وتُرفض دائماً. شاهد القواعد الفعالة بالأمر `/hooks`.

### Hooks
أوامر تعمل تلقائياً حول استدعاءات الأدوات. تُقرأ **من `config/settings.json` فقط** (وليس من مجلد العمل) حتى لا يستطيع مشروع منزَّل تثبيت أوامر تعمل على جهازك.
```json
"hooks": {
  "PreToolUse":  [{ "matcher": "run_command|delete_file", "command": "node scripts/check.js" }],
  "PostToolUse": [{ "matcher": "edit_file|multi_edit|create_file", "command": "npx prettier --write ." }]
}
```
- `matcher`: تعبير نمطي على اسم الأداة (`*` أو فارغ = كل الأدوات).
- يستلم الأمر حدثاً بصيغة JSON على stdin (`event` و`tool` و`args`) ومتغيري البيئة `PUTER_HOOK_EVENT` و`PUTER_HOOK_TOOL`، ويعمل داخل مجلد العمل.
- `PreToolUse`: الخروج برمز `0` يسمح، وأي رمز آخر (أو تعذر التشغيل أو انتهاء 30 ثانية) **يمنع** الأداة ويصل النص للنموذج.
- `PostToolUse`: ما يطبعه الأمر يصل للنموذج بجانب نتيجة الأداة.

### MCP
```json
"mcpServers": {
  "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/Projects"] },
  "docs": { "command": "node", "args": ["my-server.js"], "env": { "TOKEN": "..." }, "trust": true }
}
```
تُضاف أدوات كل خادم باسم `mcp__<الخادم>__<الأداة>` وتسأل عن الإذن قبل كل استدعاء، إلا إذا وضعت `"trust": true` للخادم. خادم يفشل تشغيله يُتجاوز مع رسالة. `/mcp` يعرض الحالة. (النقل المدعوم: stdio.)

### وكلاء فرعيون مخصصون ومتوازيون
ملف `.puter-agent/agents/security.md` في مجلد العمل (السطر الأول `# متى يُستعمل`) يصبح وكيلاً فرعياً يُستدعى بـ `task` مع `agent: "security"`. الوكلاء الفرعيون للقراءة والبحث فقط دائماً. إذا طلب النموذج عدة `task` في خطوة واحدة فإنها تعمل **بالتوازي**.

### مراجعة وسياق واستعادة
| الأمر | الوظيفة |
|---|---|
| معاينة الفروقات | نافذة الإذن لتعديل ملف أو الكتابة فوقه تعرض الأسطر المحذوفة `-` والمضافة `+` |
| `/context` | حجم المحادثة ونسبة الامتلاء قبل الضغط التلقائي، وعدد الرموز المستهلكة في الجلسة |
| `/diff` | حالة git والأسطر المتغيرة |
| `/rewind` | يعرض المهام التي غيّرت ملفات، ويرجع المجلد لما قبل مهمة تختارها |

### التشغيل غير التفاعلي
```
node index.js -p "شغل الاختبارات وأصلح الفاشل" --access full --output-format json
```
يطبع سطر JSON واحداً: `result` و`stop_reason` و`steps` و`usage` و`changes` و`is_error`، ورمز الخروج `0` عند النجاح. بدون `--access full` تُرفض أي عملية تحتاج موافقة لأنه لا يوجد من يسأل.

## نافذة الإذن والاختصارات

نافذة الإذن صندوق واحد يوضح: نوع الإجراء (تشغيل أمر، حذف، خارج مجلد العمل...) ولونه حسب الخطورة (أحمر للحذف والخارج والملفات السرية)، والطور (BUILD/PLAN)، ومستوى الوصول، والأداة وخطوتها، ثم الأمر أو المسار كاملاً (يلتف على عدة أسطر بدل أن يتشوه). الخيارات: `o` مرة واحدة، `a` دائماً لهذا النوع حتى الخروج (`/permissions reset` للتراجع)، `n` رفض. اختصارات التذييل تقصر تلقائياً حسب عرض الطرفية، ومسار المجلد يُقص من البداية ليبقى اسم المجلد ظاهراً.

## الوصول الكامل للنظام

الوكيل ينفذ الأوامر (`run_command`) والأكواد (`run_node` و`run_python`) ويفتح الملفات والمجلدات والروابط بالتطبيق الافتراضي (`open_path`) ويعرف أماكن الأقراص (`list_drives`). تحكّم بمستوى الوصول أثناء التشغيل بالأمر:

| الأمر | المعنى |
|---|---|
| `/access workspace` | مجلد العمل فقط، والأوامر تسأل |
| `/access ask` | الخارج يسأل أولاً (الافتراضي) |
| `/access full` | أي مجلد في النظام، والأوامر والأكواد والفتح بدون سؤال (يطلب تأكيد `yes`) |

للتفعيل الدائم من `config/settings.json`: `"security": { "outsideWorkspace": "allow" }` و`"approvals": { "runCommand": false, "openPath": false }`.

حتى في الوصول الكامل: الحذف والكتابة فوق ملف والنقل وقراءة الملفات السرية تسأل دائماً، والأنماط الكارثية (`format` و`shutdown` و`rm -rf /`...) تُرفض دائماً. لجعل كل شيء تلقائياً ضع `false` أمام هذه الإجراءات في `approvals`.

## الإعدادات (`config/settings.json`)

`model` و`workspace` و`maxSteps` (الافتراضي 40) و`requestTimeoutMs` (120000) و`retry` (إعادة المحاولة مع Exponential Backoff) و`limits` و`approvals` و`security`. الأولوية: الافتراضيات < الملف < متغيرات البيئة < خيارات سطر الأوامر.

**الأخطاء المؤقتة** (429 وانقطاع الشبكة والمهلة وأخطاء الخادم) تُعاد محاولتها تلقائياً مع تأخير متزايد. **أخطاء المصادقة (401/403) ونفاد الرصيد (402)** لا تُعاد، ويُعرض سببها بوضوح.

## الاختبارات

```bat
npm test
```

51 اختباراً بلا اتصال بالإنترنت: حماية المسارات، كل أداة، سيناريو إنشاء آلة حاسبة متعدد الخطوات بمزوّد وهمي، الإلغاء، الإعادة والأخطاء، تحليل ردود Puter، وإخفاء الرمز السري.

## ما تم التحقق منه وما لم يتم

**تم التحقق منه:** واجهة Puter.js الفعلية من التوثيق ومن الحزمة المثبتة (2.6.5): `init` و`getAuthToken` من `src/init.cjs`، وتنسيق `tools` و`tool_calls` ونتائج `role: "tool"`. وجميع الاختبارات أعلاه، وتشغيل الواجهة الحقيقية مع مزوّد وهمي (الموافقات والرفض والأوامر).

**لم يُختبر بعد، وعليك تجربته على جهازك:**

1. **محادثة حقيقية مع Puter مع الأدوات.** بيئة التطوير لا تصل إلى `api.puter.com`، فلم أستطع إرسال طلب حقيقي. تنسيق الطلب الذي ترسله المكتبة ظهر لي في رسالة خطأ ويطابق التوثيق، لكن رد نموذج حقيقي لم أره. بعض النماذج لا تدعم Function Calling، وفي هذه الحالة جرّب غيرها بـ `/model`.
2. **Windows.** الاختبارات نُفّذت على Linux. منطق CMD (`taskkill` وتشغيل `cmd.exe` والمسارات ذات حرف القرص ومنع ADS) مكتوب لكن لم يُجرَّب هناك.

**اختبار قبول أول مقترح:**

```
Agent > make a calculator using HTML, CSS and JavaScript
Agent > read calculator/script.js and tell me what it does
Agent > add a square-root button to the calculator
```

## مشاكل شائعة

- **ظهور `TypeError: Network request to https://api.puter.com/rao failed` عند البدء:** رسالة داخلية من Puter عند عدم وجود اتصال بالإنترنت. تحقق من الشبكة أو الوكيل (proxy).
- **`Model ... is not in Puter's list`:** اختر نموذجاً بـ `/model`، أو غيّر `model` في `settings.json`.
- **نصوص عربية مشوّهة في CMD:** استعمل Windows Terminal، أو نفّذ `chcp 65001` قبل التشغيل.
- **تحذير `npm audit` عن `postal-mime`:** اعتمادية داخلية في Puter.js (تحليل البريد) لا يستعملها هذا المشروع.

## خارطة الطريق

المرحلة 4: اختبار مشاريع حقيقية أكبر. 5: تقوية الأمان والاستقرار. 6: ذاكرة دائمة (محادثات، سياق المشروع، تفضيلات) وتخطيط مع حفظ الحالة لاستكمال المهام المتوقفة. 7: نظام Skills (الحقل `skill` جاهز في `core/context.js`) ودعم MCP وأدوات إضافية.

## Providers

- Use `/connect <provider> [model]` to switch providers. The provider list is generated from the adapters registered in `providers/provider-manager.js`.
- Gemini uses real function calling, so all tools work (Gemini 3 "thought signatures" are handled). `/connect gemini gemini-3.8-flash` picks the model, `/model` lists what Google currently offers (Google retires old ids, e.g. gemini-2.5-flash); the choice is saved in `config/connect.json`.
- Gemini 3+ "thinks" before answering, which made even `hi` take ~40 s at Google's default (`medium`). The agent sends `thinkingLevel: low` by default. Change it with `GEMINI_THINKING_LEVEL` in `.env` or `"gemini": { "thinkingLevel": "medium" }` in `config/settings.json` (low | medium | high | off). `minimal` is rejected by 3.7/3.8 Flash; if a model refuses the level, the agent drops it and retries automatically.
- Inside the app: `/thinking` shows a menu (low / medium / high / off), or `/thinking high` sets it directly. It applies from the next message, is shown on the status line (`gemini-3.8-flash (thinking: high)`), and is saved in `config/connect.json`.
- A model id from one provider is never sent to the other.

## Automatic web search

For clear "search the web" requests (`ابحث لي عن ...`, `search for ...`, news, prices, lyrics) the agent runs `web_search` **in code** before the first model call, so even weak models answer from real results. Plain coding requests and conversation questions are never routed. Turn it off with `"routing": { "forceSearch": false }` in `config/settings.json`.

## web_fetch safety

`web_fetch` refuses localhost, LAN, link-local and cloud-metadata addresses, and checks every redirect hop. Set `"search": { "allowPrivateFetch": true }` only if you really need it. (Your own SearXNG on localhost still works: that is configured by you, not by the model.)


## Token optimization

Dynamic tool selection, progressive compression of older tool outputs, configurable context limits, and per-task token usage reporting are enabled by default. Configure them in `config/settings.json`.


## Terminal experience

Puter Agent keeps its own pixel wordmark, violet assistant accent, teal Build mode,
and orange Plan mode. Its terminal interactions use focused, framed selection
panels for approvals and choices, a compact prompt footer, keyboard command
palette, and consistent lifecycle notifications. The visual language is inspired
by modern coding-agent workflows while retaining Puter Agent branding.
