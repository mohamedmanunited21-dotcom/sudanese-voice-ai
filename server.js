const http = require('http');
const https = require('https');
const dns = require('dns');
const fs = require('fs');
const path = require('path');

dns.setDefaultResultOrder('ipv4first');

const PORT = process.env.PORT || 3000;
const ENV_PATH = path.join(__dirname, '.env');
const RULES_PATH = path.join(__dirname, 'sudanese_rules.txt');
const OUTPUT_DIR = path.join(__dirname, 'output');
const KB_PATH = path.join(__dirname, 'sudanese_master_knowledge_base.json');
const BOOKS_CORPUS_DIR = path.join(__dirname, 'corpus_books');

function getKnowledgeBase() {
  if (fs.existsSync(KB_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
    } catch(e) {}
  }
  return null;
}

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Helper for reliable IPv4 HTTPS requests on Windows
function httpsRequest(urlStr, options = {}, bodyBuffer = null) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlStr);
    const reqOptions = {
      protocol: urlObj.protocol,
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      family: 4, // Force IPv4 to avoid IPv6 timeout on Windows
      timeout: 15000
    };

    if (bodyBuffer) {
      reqOptions.headers['Content-Length'] = Buffer.byteLength(bodyBuffer);
    }

    const req = https.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          buffer,
          text: () => buffer.toString('utf8'),
          json: () => JSON.parse(buffer.toString('utf8'))
        });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('Request timed out'));
    });
    req.on('error', reject);

    if (bodyBuffer) {
      req.write(bodyBuffer);
    }
    req.end();
  });
}

function loadEnv() {
  const env = {};
  if (fs.existsSync(ENV_PATH)) {
    const lines = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        const k = trimmed.slice(0, idx).trim();
        const v = trimmed.slice(idx + 1).trim();
        env[k] = v;
      }
    }
  }
  return env;
}

function saveEnv(updates) {
  const current = loadEnv();
  const merged = { ...current, ...updates };
  const content = [
    '# ضع مفتاح Gemini API الخاص بك هنا بعد علامة يساوي (=) بدون مسافات أو علامات تنصيص',
    `GEMINI_API_KEY=${merged.GEMINI_API_KEY || ''}`,
    '',
    '# ضع مفتاح ElevenLabs API الخاص بك هنا',
    `ELEVENLABS_API_KEY=${merged.ELEVENLABS_API_KEY || ''}`,
    ''
  ].join('\n');
  fs.writeFileSync(ENV_PATH, content, 'utf8');
}

function loadRules() {
  if (fs.existsSync(RULES_PATH)) {
    return fs.readFileSync(RULES_PATH, 'utf8');
  }
  return '';
}

// Local fallback phonetic normalizer based on sudanese_rules.txt
function localSudaneseNormalizer(text) {
  let out = text.trim();
  const phraseReplacements = [
    [/ماذا تريد أن تفعل الآن\s*؟?/g, 'داير تِعمِلْ شِنو هَسِّي؟'],
    [/ماذا تفعل الآن\s*؟?/g, 'بِتَعمِلْ فِي شِنو هَسِّي؟'],
    [/كيف حالك اليوم\s*؟?/g, 'كِيفِنَّكْ اليُوم؟ إنْ شاء الله طَيِّبْ'],
    [/كيف حالك\s*؟?/g, 'كِيفِنَّكْ؟ إنْ شاء الله طَيِّبْ'],
    [/أين وضعت الملفات\s*؟?/g, 'خَتِّيتْ المَلَفَّاتْ وِينْ؟'],
    [/هذا الأمر جيد جداً/g, 'الموضوع دَه سَمِحْ شَديدْ'],
    [/يجب علينا الذهاب مبكراً لكي نلحق/g, 'لازم نِمشِي بَدرِي عَشانْ نِلحَگْ'],
    [/لماذا لم تخبرني بذلك من قبل\s*؟?/g, 'لِيه ما كَلَّمتَني بالكلام دَه مِن گَبُلْ؟'],
    [/الآن/g, 'هَسِّي'],
    [/جداً/g, 'شَديدْ'],
    [/كثيراً/g, 'كَتيرْ'],
    [/كثير/g, 'كَتيرْ'],
    [/أريد أن/g, 'داير'],
    [/أريد/g, 'داير'],
    [/نريد/g, 'دايرين'],
    [/لماذا/g, 'لِيه'],
    [/ماذا/g, 'شِنو'],
    [/أين/g, 'وِينْ'],
    [/هكذا/g, 'كِدَة'],
    [/هذا/g, 'دَه'],
    [/هذه/g, 'دِي'],
    [/هؤلاء/g, 'دِيلْ'],
    [/أولئك/g, 'دِيلَكْ'],
    [/ثلاثة/g, 'تَلاتَة'],
    [/ثلاجة/g, 'تَلاجَة'],
    [/ثاني/g, 'تَانِي'],
    [/اثنين/g, 'اتنِينْ'],
    [/مثلاً/g, 'مَسَلاً'],
    [/ثابت/g, 'سَابِتْ'],
    [/تأثير/g, 'تَأْسِيرْ'],
    [/بالذات/g, 'بِالزَّاتْ'],
    [/أستاذ/g, 'أُستازْ'],
    [/ظروف/g, 'زُروفْ'],
    [/نظيف/g, 'نَضيفْ'],
    [/مظبوط/g, 'مَزبوطْ'],
    [/مضبوط/g, 'مَزبوطْ'],
    [/ظل/g, 'ضُلْ'],
    [/قال/g, 'گالْ'],
    [/قدام/g, 'گِدَّامْ'],
    [/قروش/g, 'گُروشْ'],
    [/فوق/g, 'فُوگْ'],
    [/دقيقة/g, 'دَگيگَة'],
    [/حقيقة/g, 'حَگيگَة'],
    [/طريقة/g, 'طَريگَة'],
    [/ثقيل/g, 'تَگيلْ'],
    [/قاعد/g, 'گاعِدْ'],
    [/وقت/g, 'وَگِتْ'],
    [/رأس/g, 'راسْ'],
    [/كأس/g, 'كاسْ'],
    [/قرأت/g, 'قَرَيتْ'],
    [/بدأ/g, 'بَدَا'],
    [/مائل/g, 'مَايِلْ'],
    [/دائم/g, 'دايِمْ'],
    [/على شان/g, 'عَشانْ'],
    [/علشان/g, 'عَشانْ'],
    [/لكي/g, 'عَشانْ']
  ];

  for (const [pattern, replacement] of phraseReplacements) {
    out = out.replace(pattern, replacement);
  }

  const kb = getKnowledgeBase();
  if (kb && kb.phonetic_rules && kb.phonetic_rules.qaf_to_gaf_mapping) {
    for (const [orig, gafWord] of Object.entries(kb.phonetic_rules.qaf_to_gaf_mapping)) {
      const rx = new RegExp(`(^|[\\s،.؟!])${orig}(?=[\\s،.?!]|$)`, 'g');
      out = out.replace(rx, `$1${gafWord}`);
    }
  }
  return out;
}

async function callGeminiNormalize(text, customKey, genre = 'chat_intimacy') {
  const env = loadEnv();
  const apiKey = (customKey || env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('مفتاح Gemini API غير موجود. يرجى إضافته في الإعدادات أو في ملف .env');
  }

  const genreHints = {
    formal_media: 'السياق المطلوب: [إعلام وإذاعة رصينة - نبرة تلفزيونية وإذاعية راقية كمذيعي سودانية 24، والإعلامية سلمى سيد، وإذاعة PRO FM]. وقار، مخارج حروف واضحة، هدوء، لغة وسطية راقية.',
    chat_intimacy: 'السياق المطلوب: [ونسة وفضفضة وحوار يومي حميم - البيت والشارع والدراما السودانية ولقاء ميديا]. تعبيرات الألفة، المجاملات الصادقة، العفوية والدفء الأسري.',
    intellectual_podcast: 'السياق المطلوب: [بودكاست ونقاش فكري وتاريخي متزن - مثل بودكاست السودان، الفاتح عروة، بريك لوجيك]. وقفات تفكير هادئة، رزانة في الطرح، استرسال واثق.',
    comedy: 'السياق المطلوب: [كوميديا وقفشات ومفارقة شعبية - مثل شيلبان وأبوبكر فيصل]. إيقاع متفاعل، قفشات، مدود تعبيرية ساخرة.',
    narrative_audiobook: 'السياق المطلوب: [سرد قصصي ورواية وكتب صوتية كاملة]. صوت الحكاء الهادئ، استرسال انسيابي، تلوين نغمي هادئ يشد المستمع.'
  };

  const contextInstruction = genreHints[genre] || genreHints.chat_intimacy;
  const rules = loadRules();
  const payload = JSON.stringify({
    systemInstruction: {
      parts: [{ text: `${rules}\n\n${contextInstruction}` }]
    },
    contents: [
      {
        role: 'user',
        parts: [{ text }]
      }
    ],
    generationConfig: {
      temperature: 0.35
    }
  });

  const models = ['gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-3.6-flash', 'gemini-3.8-flash'];
  let lastError = null;

  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    try {
      const res = await httpsRequest(
        url,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        Buffer.from(payload, 'utf8')
      );
      const data = res.json();
      if (res.ok && data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
        return {
          phoneticText: data.candidates[0].content.parts[0].text.trim(),
          source: `Google Gemini (${model})`
        };
      }
      lastError = data?.error?.message || `HTTP ${res.status}`;
    } catch (err) {
      lastError = err.message;
    }
  }

  throw new Error(`تعذر الاتصال بـ Gemini API: ${lastError}`);
}

function pcmToWav(pcmBuffer, sampleRate = 24000, numChannels = 1, bitsPerSample = 16) {
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmBuffer.length;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmBuffer.copy(buffer, 44);
  return buffer;
}

async function generateGeminiAudio(phoneticText, voiceName = 'Charon', customKey = '') {
  const env = loadEnv();
  const apiKey = (customKey || env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('مفتاح Gemini API غير موجود.');
  }

  // Send ONLY the Arabic text (no English instructions) so the engine never reads instructions aloud
  const prompt = phoneticText;

  const payload = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: voiceName || 'Charon'
          }
        }
      }
    }
  });

  const ttsModels = ['gemini-3.8-flash-lite-tts', 'gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts', 'gemini-3.8-flash-tts'];
  let lastError = null;

  for (const model of ttsModels) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    try {
      const res = await httpsRequest(
        url,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        Buffer.from(payload, 'utf8')
      );
      const data = res.json();
      const inlineData = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
      if (res.ok && inlineData?.data) {
        const rawBuffer = Buffer.from(inlineData.data, 'base64');
        const mimeType = inlineData.mimeType || 'audio/pcm';
        let finalBuffer = rawBuffer;
        let ext = 'wav';
        let outMime = 'audio/wav';

        if (mimeType.includes('pcm') || mimeType.includes('L16')) {
          finalBuffer = pcmToWav(rawBuffer, 24000, 1, 16);
        } else if (mimeType.includes('mp3') || mimeType.includes('mpeg')) {
          ext = 'mp3';
          outMime = 'audio/mpeg';
        }

        const fileName = `sudanese_gemini_${Date.now()}.${ext}`;
        fs.writeFileSync(path.join(OUTPUT_DIR, fileName), finalBuffer);
        return {
          audioBase64: finalBuffer.toString('base64'),
          mimeType: outMime,
          fileName
        };
      }
      lastError = data?.error?.message || `HTTP ${res.status}`;
    } catch (err) {
      lastError = err.message;
    }
  }
  throw new Error(`تعذر توليد الصوت عبر Gemini TTS: ${lastError}`);
}

async function generateElevenLabsAudio(phoneticText, options = {}) {
  const env = loadEnv();
  const apiKey = (options.elevenLabsKey || env.ELEVENLABS_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('مفتاح ElevenLabs API غير مضاف بعد. يرجى إدخاله في زر (إعدادات المفاتيح) بالأعلى، أو اختر تبويب (⚡ Gemini Audio TTS) لتوليد الصوت مجاناً بمفتاح Gemini المتصل حالياً!');
  }

  const voiceId = options.voiceId || 'onwK4e9ZLuTAKqWW03F9';
  const modelId = options.modelId || 'eleven_multilingual_v2';
  const stability = typeof options.stability === 'number' ? options.stability : 0.55;
  const similarityBoost = typeof options.similarityBoost === 'number' ? options.similarityBoost : 0.78;
  const style = typeof options.style === 'number' ? options.style : 0.35;

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`;
  const payload = JSON.stringify({
    text: phoneticText,
    model_id: modelId,
    voice_settings: {
      stability,
      similarity_boost: similarityBoost,
      style,
      use_speaker_boost: true
    }
  });

  const res = await httpsRequest(
    url,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      }
    },
    Buffer.from(payload, 'utf8')
  );

  if (!res.ok) {
    const errText = res.text();
    let msg = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(errText);
      msg = parsed?.detail?.message || parsed?.detail || msg;
    } catch (_) {
      msg = errText.slice(0, 200) || msg;
    }
    throw new Error(`خطأ من ElevenLabs: ${msg}`);
  }

  const buffer = res.buffer;
  const fileName = `sudanese_elevenlabs_${Date.now()}.mp3`;
  fs.writeFileSync(path.join(OUTPUT_DIR, fileName), buffer);

  return {
    audioBase64: buffer.toString('base64'),
    mimeType: 'audio/mpeg',
    fileName
  };
}

// ===== Free unlimited engine: Microsoft Edge Neural voices (via edge-tts, no key, no cost) =====
const { spawn } = require('child_process');

function applyGafMode(text, gafMode) {
  if (gafMode === 'jeem') return text.replace(/گ/g, 'ج'); // Egyptian voices read ج as [g]
  if (gafMode === 'qaf') return text.replace(/گ/g, 'ق');
  if (gafMode === 'kaf') return text.replace(/گ/g, 'ك');
  return text; // keep
}

function generateEdgeAudio(phoneticText, options = {}) {
  return new Promise((resolve, reject) => {
    const voice = options.voice || 'ar-EG-ShakirNeural';
    const rate = Number.isFinite(options.rate) ? options.rate : -5;
    const pitch = Number.isFinite(options.pitch) ? options.pitch : 0;
    const text = applyGafMode(phoneticText, options.gafMode || 'jeem');

    const stamp = Date.now() + '_' + Math.floor(Math.random() * 1000);
    const txtPath = path.join(OUTPUT_DIR, `_input_${stamp}.txt`);
    const fileName = `sudanese_free_${voice.split('-').slice(0, 2).join('-')}_${stamp}.mp3`;
    const outPath = path.join(OUTPUT_DIR, fileName);
    fs.writeFileSync(txtPath, text, 'utf8');

    const args = [
      '-m', 'edge_tts',
      '--voice', voice,
      '--file', txtPath,
      `--rate=${rate >= 0 ? '+' : ''}${rate}%`,
      `--pitch=${pitch >= 0 ? '+' : ''}${pitch}Hz`,
      '--write-media', outPath
    ];
    const proc = spawn('python', args, { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let stderr = '';
    proc.stderr.on('data', d => (stderr += d.toString()));
    proc.on('error', err => reject(new Error('تعذر تشغيل محرك الأصوات المجاني (تأكد من تثبيت: pip install edge-tts): ' + err.message)));
    proc.on('close', code => {
      try { fs.unlinkSync(txtPath); } catch (_) {}
      if (code !== 0 || !fs.existsSync(outPath)) {
        return reject(new Error('فشل توليد الصوت المجاني: ' + (stderr.slice(-300) || `exit ${code}`)));
      }
      const buffer = fs.readFileSync(outPath);
      resolve({ audioBase64: buffer.toString('base64'), mimeType: 'audio/mpeg', fileName });
    });
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && urlObj.pathname === '/api/status') {
    const env = loadEnv();
    const rules = loadRules();
    return sendJson(res, 200, {
      hasGeminiKey: Boolean(env.GEMINI_API_KEY),
      geminiKeyPreview: env.GEMINI_API_KEY
        ? `${env.GEMINI_API_KEY.slice(0, 6)}...${env.GEMINI_API_KEY.slice(-4)}`
        : '',
      hasElevenLabsKey: Boolean(env.ELEVENLABS_API_KEY),
      elevenLabsKeyPreview: env.ELEVENLABS_API_KEY
        ? `${env.ELEVENLABS_API_KEY.slice(0, 5)}...${env.ELEVENLABS_API_KEY.slice(-4)}`
        : '',
      rules
    });
  }

  if (req.method === 'POST' && urlObj.pathname === '/api/save-keys') {
    try {
      const body = await parseBody(req);
      const updates = {};
      if (typeof body.geminiKey === 'string' && body.geminiKey.trim() !== '') {
        updates.GEMINI_API_KEY = body.geminiKey.trim();
      }
      if (typeof body.elevenLabsKey === 'string' && body.elevenLabsKey.trim() !== '') {
        updates.ELEVENLABS_API_KEY = body.elevenLabsKey.trim();
      }
      saveEnv(updates);
      return sendJson(res, 200, { ok: true, message: 'تم حفظ المفاتيح في ملف .env بنجاح' });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  if (req.method === 'POST' && urlObj.pathname === '/api/save-rules') {
    try {
      const body = await parseBody(req);
      if (typeof body.rules === 'string') {
        fs.writeFileSync(RULES_PATH, body.rules, 'utf8');
      }
      return sendJson(res, 200, { ok: true, message: 'تم تحديث ملف sudanese_rules.txt بنجاح' });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  if (req.method === 'GET' && urlObj.pathname === '/api/knowledge-base') {
    const kb = getKnowledgeBase();
    if (!kb) {
      return sendJson(res, 404, { ok: false, error: 'لم يتم العثور على قاعدة المعرفة المعجمية' });
    }
    return sendJson(res, 200, { ok: true, data: kb });
  }

  if (req.method === 'GET' && urlObj.pathname === '/api/sudanese-search') {
    const query = (urlObj.searchParams.get('q') || '').trim();
    if (!query) {
      return sendJson(res, 400, { ok: false, error: 'كلمة البحث فارغة' });
    }
    const kb = getKnowledgeBase();
    const results = {
      lexiconMatches: [],
      proverbMatches: [],
      literatureQuotes: []
    };
    if (kb) {
      results.lexiconMatches = (kb.lexicon || []).filter(item =>
        item.word.includes(query) || item.meaning.includes(query) || (item.example && item.example.includes(query))
      );
      results.proverbMatches = (kb.proverbs || []).filter(item =>
        item.proverb.includes(query) || item.meaning.includes(query)
      );
    }
    if (fs.existsSync(BOOKS_CORPUS_DIR)) {
      const txtFiles = fs.readdirSync(BOOKS_CORPUS_DIR).filter(f => f.endsWith('.txt'));
      for (const f of txtFiles) {
        if (results.literatureQuotes.length >= 15) break;
        try {
          const content = fs.readFileSync(path.join(BOOKS_CORPUS_DIR, f), 'utf8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.includes(query)) {
              results.literatureQuotes.push({
                book: f.replace('.txt', '').replace(/_/g, ' '),
                lineNum: i + 1,
                quote: line
              });
              if (results.literatureQuotes.length >= 15) break;
            }
          }
        } catch (_) {}
      }
    }
    return sendJson(res, 200, { ok: true, query, results });
  }

  if (req.method === 'POST' && urlObj.pathname === '/api/phonetic-calibrate') {
    try {
      const body = await parseBody(req);
      const text = (body.text || '').trim();
      if (!text) {
        return sendJson(res, 400, { ok: false, error: 'يرجى إدخال نص لمعايرته' });
      }
      const kb = getKnowledgeBase();
      let calibrated = text;
      const changes = [];
      if (kb && kb.phonetic_rules && kb.phonetic_rules.qaf_to_gaf_mapping) {
        const mapping = kb.phonetic_rules.qaf_to_gaf_mapping;
        for (const [orig, gafWord] of Object.entries(mapping)) {
          const regex = new RegExp(`(^|[\\s،.؟!])${orig}(?=[\\s،.?!]|$)`, 'g');
          if (regex.test(calibrated)) {
            calibrated = calibrated.replace(regex, `$1${gafWord}`);
            changes.push(`استبدال [${orig}] بـ [${gafWord}]`);
          }
        }
      }
      return sendJson(res, 200, {
        ok: true,
        original: text,
        calibrated,
        changes
      });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  if (req.method === 'POST' && urlObj.pathname === '/api/normalize') {
    try {
      const body = await parseBody(req);
      const inputText = (body.text || '').trim();
      if (!inputText) {
        return sendJson(res, 400, { ok: false, error: 'يرجى إدخال نص لتحويله' });
      }
      try {
        const result = await callGeminiNormalize(inputText, body.geminiKey, body.genre);
        return sendJson(res, 200, {
          ok: true,
          phoneticText: result.phoneticText,
          source: result.source
        });
      } catch (geminiErr) {
        const fallbackText = localSudaneseNormalizer(inputText);
        return sendJson(res, 200, {
          ok: true,
          phoneticText: fallbackText,
          source: 'المحول السوداني المحلي (Fallback)',
          warning: geminiErr.message
        });
      }
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  if (req.method === 'POST' && urlObj.pathname === '/api/tts') {
    try {
      const body = await parseBody(req);
      const phoneticText = (body.phoneticText || '').trim();
      if (!phoneticText) {
        return sendJson(res, 400, { ok: false, error: 'النص الصوتي المشكّل فارغ' });
      }

      const engine = body.engine || 'free';
      if (engine === 'free') {
        const audio = await generateEdgeAudio(phoneticText, {
          voice: body.voice,
          rate: Number(body.rate),
          pitch: Number(body.pitch),
          gafMode: body.gafMode
        });
        return sendJson(res, 200, { ok: true, ...audio, engine: 'Free Neural Voice' });
      } else if (engine === 'gemini') {
        const audio = await generateGeminiAudio(phoneticText, body.geminiVoice, body.geminiKey);
        return sendJson(res, 200, { ok: true, ...audio, engine: 'Gemini TTS' });
      } else {
        const audio = await generateElevenLabsAudio(phoneticText, {
          elevenLabsKey: body.elevenLabsKey,
          voiceId: body.voiceId,
          modelId: body.modelId,
          stability: body.stability,
          similarityBoost: body.similarityBoost,
          style: body.style
        });
        return sendJson(res, 200, { ok: true, ...audio, engine: 'ElevenLabs' });
      }
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  if (req.method === 'GET' && urlObj.pathname.startsWith('/output/')) {
    const name = path.basename(decodeURIComponent(urlObj.pathname));
    const fp = path.join(OUTPUT_DIR, name);
    if (fs.existsSync(fp)) {
      const mime = name.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg';
      res.writeHead(200, { 'Content-Type': mime });
      return fs.createReadStream(fp).pipe(res);
    }
  }

  let filePath = urlObj.pathname === '/' ? '/index.html' : urlObj.pathname;
  const fullPath = path.join(__dirname, 'public', path.normalize(filePath));
  if (fullPath.startsWith(path.join(__dirname, 'public')) && fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
    const ext = path.extname(fullPath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.wav': 'audio/wav',
      '.mp3': 'audio/mpeg'
    };
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    fs.createReadStream(fullPath).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`Sudanese Voice AI Server running at http://localhost:${PORT}`);
});
