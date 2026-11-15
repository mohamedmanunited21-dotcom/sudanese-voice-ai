"""اختبار شامل على بيانات اصطناعية: python test_pipeline.py"""
import csv
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable
SR = 24000


def write_wav(path, seconds, amp=0.3, noise=0.003, clip=False, silence_tail=0.0):
    t = np.arange(int(SR * seconds)) / SR
    # "كلام" اصطناعي: جيب بتعديل سعة متقطع ليحاكي مقاطع صوت وصمت قصيرة
    env = (np.sin(2 * np.pi * 3 * t) > -0.6).astype(np.float32)
    x = amp * env * np.sin(2 * np.pi * 180 * t) + noise * np.random.randn(len(t))
    if clip:
        x = np.clip(x * 8, -1, 1)
    if silence_tail:
        x[-int(SR * silence_tail):] = 0
    pcm = (np.clip(x, -1, 1) * 32767).astype('<i2')
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def run(*cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', **kw)
    return r.returncode, r.stdout + r.stderr


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    np.random.seed(0)
    tmp = tempfile.mkdtemp(prefix='clean_test_')
    ds = os.path.join(tmp, 'ds')
    work = os.path.join(tmp, 'work')
    os.makedirs(os.path.join(ds, 'wavs'))

    good_text = 'والله يا زول الموضوع دا سمح شديد وانا فرحان بيهو'
    rows = []

    def add(name, text, seconds, speaker='spk1', **wavkw):
        if seconds:
            write_wav(os.path.join(ds, 'wavs', name), seconds, **wavkw)
        rows.append([f'wavs/{name}', text, speaker])

    # 12 مقطعًا جيدًا بنصوص مختلفة من حلقات مختلفة
    base = ['قال', 'لي', 'الراجل', 'وقت', 'قدام', 'البيت', 'شنو', 'الحاصل', 'يا', 'جماعة', 'والله', 'كدا']
    for i in range(12):
        words = (base + base)[i:i + 7] + ['كلمة' + 'ابتثجحخدذرزسشصضط'[i]]
        add(f'spk1_vid{i}_seg_000{i}.wav', ' '.join(words), 4.0)
    # حالات مرفوضة
    add('bad_hebrew.wav', 'على أساس أو الحقوق على أסאס القبيلة كلها', 5.0)
    add('bad_digits.wav', 'جاء في سنة 2025 وقال لنا الكلام كله', 5.0)
    add('bad_repeat.wav', 'ايوه ايوه ايوه ايوه والله كدا طيب', 5.0)
    add('bad_short.wav', 'قال لي', 5.0)
    add('bad_dup_a.wav', good_text, 5.0)
    add('bad_dup_b.wav', good_text, 5.0)
    add('bad_toolong.wav', 'كلام طويل جدا في مقطع طويل جدا يتجاوز الحد المسموح', 14.0)
    add('bad_tooshortaudio.wav', 'كلام قصير في مقطع قصير جدا جدا', 1.0)
    add('bad_missing.wav', 'هذا المقطع ملفه مفقود تماما من المجلد', 0)
    add('bad_clip.wav', 'مقطع مشبع بالصوت يحدث فيه تشويه كثير جدا', 5.0, clip=True)
    add('bad_noisy.wav', 'مقطع ضجيجه عال جدا ولا يصلح للتدريب ابدا', 5.0, amp=0.01, noise=0.05)
    add('bad_halluc.wav', 'ترجمة نانسي قنقر وشكرا لكم جميعا على المتابعة', 5.0)
    # حرف گ: يجب أن يتحول إلى ق ولا يُرفض
    add('gaf_ok.wav', 'گال لي الراجل وقت گدام البيت يا جماعة', 5.0)

    with open(os.path.join(ds, 'metadata.csv'), 'w', encoding='utf-8', newline='') as f:
        w = csv.writer(f, delimiter='|')
        w.writerow(['audio_file', 'text', 'speaker_name'])
        w.writerows(rows)

    code, out = run(PY, os.path.join(HERE, 'clean_dataset.py'), '--dataset-dir', ds, '--work-dir', work,
                    '--per-speaker', '50', '--audio-factor', '3')
    assert code == 0, out
    sheet = json.load(open(os.path.join(work, 'review_sheet.json'), encoding='utf-8'))
    ids = {i['id'] for i in sheet}
    rej = {r[0]: r[1] for r in csv.reader(open(os.path.join(work, 'rejected.csv'), encoding='utf-8'), delimiter='|')}

    expect_rej = {
        'bad_hebrew.wav': 'bad_chars', 'bad_digits.wav': 'bad_chars', 'bad_repeat.wav': 'repeat_word',
        'bad_short.wav': 'too_few_words', 'bad_toolong.wav': 'too_long_audio', 'bad_tooshortaudio.wav': 'too_short_audio',
        'bad_missing.wav': 'missing_wav', 'bad_clip.wav': 'clipping', 'bad_noisy.wav': 'noisy_low_snr',
        'bad_halluc.wav': 'hallucination_phrase',
    }
    for name, reason in expect_rej.items():
        key = f'wavs/{name}'
        assert key not in ids, f'{name} يجب ألا يكون مرشّحًا'
        assert rej.get(key, '').startswith(reason), f'{name}: متوقع {reason} والفعلي {rej.get(key)}\n{out}'
    # المكرر: واحد يبقى (أي منهما) والآخر يُرفض
    dup_in = [n for n in ('bad_dup_a.wav', 'bad_dup_b.wav') if f'wavs/{n}' in ids]
    assert len(dup_in) == 1 and sum(1 for n in ('bad_dup_a.wav', 'bad_dup_b.wav') if rej.get(f'wavs/{n}') == 'duplicate_text') == 1, out
    # الگاف تحول إلى قاف وبقي مرشحًا
    gaf = next(i for i in sheet if i['id'] == 'wavs/gaf_ok.wav')
    assert 'گ' not in gaf['text'] and gaf['text'].startswith('قال'), gaf['text']
    print('✓ فلترة المرحلة 1: كل حالات الرفض والقبول صحيحة (%d مرشّحًا)' % len(sheet))

    # --- خادم المراجعة ---
    port = '3177'
    srv = subprocess.Popen(['node', os.path.join(HERE, 'review_server.js'), '--dataset-dir', ds, '--work-dir', work, '--port', port],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        time.sleep(1.5)
        base = f'http://127.0.0.1:{port}'
        d = json.load(urllib.request.urlopen(base + '/api/items'))
        assert len(d['items']) == len(sheet)
        html = urllib.request.urlopen(base + '/').read().decode('utf-8')
        assert 'مراجعة بيانات التدريب' in html
        first = d['items'][0]['id']
        req = urllib.request.Request(base + '/audio?id=' + urllib.request.quote(first), headers={'Range': 'bytes=0-99'})
        resp = urllib.request.urlopen(req)
        assert resp.status == 206 and len(resp.read()) == 100
        # حماية: id غير معروف لا يقرأ ملفات عشوائية
        try:
            urllib.request.urlopen(base + '/audio?id=' + urllib.request.quote('../../secret.txt'))
            raise AssertionError('كان يجب رفض id غير معروف')
        except urllib.error.HTTPError as e:
            assert e.code == 404

        def save(i, text, status):
            r = urllib.request.Request(base + '/api/save', data=json.dumps({'id': i, 'text': text, 'status': status}).encode('utf-8'),
                                       headers={'Content-Type': 'application/json'}, method='POST')
            return json.load(urllib.request.urlopen(r))

        # اعتماد 11 مقطعًا (منها واحد بنص فيه گ وتشكيل)، وحذف واحد
        keepers = [i['id'] for i in sheet if i['id'].startswith('wavs/spk1_vid')][:10] + ['wavs/gaf_ok.wav']
        for k in keepers:
            t = next(i['text'] for i in sheet if i['id'] == k)
            if k == 'wavs/gaf_ok.wav':
                t = 'گَالَ لي الراجل وقت گدام البيت يا جماعة'
            assert save(k, t, 'keep')['ok']
        other = next(i['id'] for i in sheet if i['id'] not in keepers)
        assert save(other, 'x', 'drop')['ok']
    finally:
        srv.terminate()
    rev = json.load(open(os.path.join(work, 'reviewed.json'), encoding='utf-8'))
    assert len(rev) == len(keepers) + 1
    print('✓ أداة المراجعة: تحميل، تشغيل صوت بـ Range، حفظ تلقائي، ورفض id غريب')

    # --- التصدير مع مفردات ناقصة ثم كاملة ---
    vocab_bad = os.path.join(tmp, 'vocab_bad.json')
    letters = set('ابتثجحخدذرزسشصضطظعغفقكلمنهويةىءأإآ')
    json.dump({'model': {'vocab': {c: i for i, c in enumerate(sorted(letters - {'ظ'}))}}}, open(vocab_bad, 'w', encoding='utf-8'), ensure_ascii=False)
    vocab_ok = os.path.join(tmp, 'vocab_ok.json')
    json.dump({'model': {'vocab': {c: i for i, c in enumerate(sorted(letters))}}}, open(vocab_ok, 'w', encoding='utf-8'), ensure_ascii=False)

    # أضف نصًا فيه ظ ليظهر النقص مع المفردات الناقصة
    rev_path = os.path.join(work, 'reviewed.json')
    rev['wavs/gaf_ok.wav']['text'] = 'ظل الراجل قدام البيت يا جماعة كلهم'
    json.dump(rev, open(rev_path, 'w', encoding='utf-8'), ensure_ascii=False)
    code, out = run(PY, os.path.join(HERE, 'export_training_set.py'), '--dataset-dir', ds, '--work-dir', work, '--vocab', vocab_bad)
    assert code == 2 and 'ظ' in out, out
    assert not os.path.exists(os.path.join(ds, 'metadata_train_clean.csv')), 'يجب ألا يكتب شيئًا عند نقص المفردات'

    rev['wavs/gaf_ok.wav']['text'] = 'گَالَ لي الراجل وقت گدام البيت يا جماعة'
    json.dump(rev, open(rev_path, 'w', encoding='utf-8'), ensure_ascii=False)
    code, out = run(PY, os.path.join(HERE, 'export_training_set.py'), '--dataset-dir', ds, '--work-dir', work, '--vocab', vocab_ok, '--min-eval', '2')
    assert code == 0, out
    train = list(csv.reader(open(os.path.join(ds, 'metadata_train_clean.csv'), encoding='utf-8'), delimiter='|'))
    ev = list(csv.reader(open(os.path.join(ds, 'metadata_eval_clean.csv'), encoding='utf-8'), delimiter='|'))
    assert train[0] == ['audio_file', 'text', 'speaker_name'] and len(train) - 1 + len(ev) - 1 == len(keepers), (len(train), len(ev))
    alltext = ''.join(r[1] for r in train[1:] + ev[1:])
    assert 'گ' not in alltext and not any('ً' <= c <= 'ْ' for c in alltext), 'يجب تحويل گ→ق وحذف التشكيل'
    assert os.path.exists(os.path.join(ds, 'metadata.csv')) and sum(1 for _ in open(os.path.join(ds, 'metadata.csv'), encoding='utf-8')) == len(rows) + 1
    # لا استبدال دون --force
    code, out = run(PY, os.path.join(HERE, 'export_training_set.py'), '--dataset-dir', ds, '--work-dir', work, '--vocab', vocab_ok)
    assert code != 0 and '--force' in out, out
    print('✓ التصدير: فحص المفردات، تحويل گ→ق، حذف التشكيل، عدم المساس بـ metadata.csv، وحماية من الاستبدال')
    print('\nنجحت كل الاختبارات')


if __name__ == '__main__':
    main()
