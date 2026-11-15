"""تطبيع نصوص التدريب والتوليد لنموذج XTTS (مشترك بين أدوات التنظيف وكل ما يغذّي XTTS بنص).

لماذا هذه القواعد؟
 - مفردات XTTS-v2 (vocab.json) لا تحتوي الحرف «گ» (U+06AF). أي «گ» في النص يُحذف بصمت قبل أن يصل للنموذج،
   فتتحول «گال» إلى «ال». لذلك يُكتب الصوت [g] بالحرف «ق» (وهو ما يكتبه Whisper أصلًا)،
   والنموذج يتعلم من الصوت أن «قال» في هذه اللهجة تُنطق [gaal].
 - النصوص بلا تشكيل: التشكيل غير مستقر في التفريغ ويُربك الـ tokenizer، ويجب أن يكون التوليد بنفس الصيغة.
"""
import re
import unicodedata

DIACRITICS = re.compile('[ً-ٰٟـ]')  # الحركات والتنوين وألف خنجرية والتطويل
# حروف مسموحة بعد التطبيع: الحروف العربية (دون التطويل و«گ») + المسافة + ترقيم بسيط
ALLOWED_RE = re.compile(r'^[ء-غف-يٱ ،.؟!]+$')
PUNCT = '،.؟!'

MIN_WORDS, MAX_WORDS = 3, 35
MIN_LETTERS, MAX_LETTERS = 10, 170


def normalize_text(text: str) -> str:
    t = unicodedata.normalize('NFKC', str(text))
    t = t.replace('ی', 'ي').replace('ک', 'ك')  # ی→ي ، ک→ك
    t = t.replace('گ', 'ق')                                # گ→ق (غير موجود في مفردات XTTS)
    t = DIACRITICS.sub('', t)
    t = t.replace('?', '؟').replace(',', '،').replace('؛', '،').replace(';', '،')
    t = re.sub(r'\.{2,}|…', '.', t)
    t = re.sub(r'[-–—:"“”«»()\[\]\'`*_/\\|]+', ' ', t)
    t = re.sub(r'\s+', ' ', t).strip()
    t = re.sub(r'\s+([،.؟!])', r'\1', t)
    return t


def letters_only(t: str) -> str:
    return re.sub(r'[ ،.؟!]', '', t)


def validate_text(t: str):
    """يعيد None إن كان النص صالحًا للتدريب، وإلا سبب الرفض كنص قصير."""
    if not t:
        return 'empty'
    if not ALLOWED_RE.match(t):
        bad = sorted({c for c in t if not ALLOWED_RE.match(c)})
        return 'bad_chars:' + ''.join(bad)[:12]
    words = t.replace('،', ' ').replace('.', ' ').replace('؟', ' ').replace('!', ' ').split()
    if len(words) < MIN_WORDS:
        return 'too_few_words'
    if len(words) > MAX_WORDS:
        return 'too_many_words'
    n = len(letters_only(t))
    if n < MIN_LETTERS:
        return 'too_short_text'
    if n > MAX_LETTERS:
        return 'too_long_text'
    return None


HALLUCINATION_PHRASES = (
    'اشتركوا', 'اشترك في', 'الاشتراك في القناة', 'لا تنسوا', 'ترجمة', 'نانسي', 'شكرا لمشاهدتكم',
    'شكرا على المشاهدة', 'تابعونا على', 'مترجم',
)


def hallucination_reason(t: str):
    """إشارات تدل على أن Whisper تخيّل النص أو علق في حلقة تكرار."""
    plain = t.replace('،', ' ').replace('.', ' ').replace('؟', ' ').replace('!', ' ')
    words = plain.split()
    n = len(words)
    run = 1
    for i in range(1, n):
        run = run + 1 if words[i] == words[i - 1] else 1
        if run >= 3:
            return 'repeat_word'
    if n >= 6:
        bigrams = {}
        for b in zip(words, words[1:]):
            bigrams[b] = bigrams.get(b, 0) + 1
        if max(bigrams.values()) >= 3:
            return 'repeat_bigram'
    if n >= 8 and len(set(words)) / n < 0.5:
        return 'low_variety'
    for p in HALLUCINATION_PHRASES:
        if p in plain:
            return 'hallucination_phrase'
    return None


def prepare_for_xtts(text: str) -> str:
    """للاستدعاء قبل tts_to_file: نفس تطبيع التدريب، بلا حذف كلمات (الترقيم يبقى)."""
    return normalize_text(text)
