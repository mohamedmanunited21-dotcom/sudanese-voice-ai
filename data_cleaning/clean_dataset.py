#!/usr/bin/env python3
"""المرحلة 1: فلترة بيانات التدريب آليًا وترشيح مقاطع للمراجعة البشرية.

لا يعدّل شيئًا في مجلد البيانات (قراءة فقط). كل المخرجات في --work-dir:
  review_sheet.json  المقاطع المرشّحة للمراجعة (تقرؤها أداة المراجعة review_server.js)
  rejected.csv       كل المقاطع المرفوضة مع السبب
  report.txt         ملخص الأرقام

مثال:
  python clean_dataset.py --dataset-dir "G:/My Drive/Sudanese_Voice_Project/fine_tuning_dataset" --per-speaker 40
"""
import argparse
import collections
import csv
import json
import math
import os
import random
import re
import statistics
import sys
import wave

import numpy as np

from textnorm import hallucination_reason, letters_only, normalize_text, validate_text

# ---- عتبات قابلة للتعديل ----
MIN_DUR, MAX_DUR = 2.5, 11.0   # max_wav_length في التدريب = 255995 عينة ≈ 11.6 ثانية؛ الأطول يُسقطه المحمّل
IDEAL_DUR = 6.5
ABS_RATE = (5.0, 22.0)         # حروف/ثانية؛ خارجها غالبًا النص لا يطابق الصوت
REL_RATE = (0.6, 1.5)          # نسبة لوسيط المتحدث
MAX_CLIP_FRAC = 0.001
MAX_SILENCE_FRAC = 0.45
MIN_SNR_DB = 12.0
MIN_RMS_DB, MAX_RMS_DB = -40.0, -8.0
MAX_EDGE_SILENCE = 1.2

VIDEO_RE = re.compile(r'^(?P<sp>[^_]+)_(?P<vid>.+)_seg_(?P<n>\d+)\.wav$')


def parse_name(audio_file):
    base = os.path.basename(audio_file)
    m = VIDEO_RE.match(base)
    if m:
        return m.group('sp') + '_' + m.group('vid')
    return base


def analyze_audio(path):
    """مقاييس جودة بسيطة بـ numpy فقط. ترفع استثناء إن تعذر قراءة الملف."""
    with wave.open(path, 'rb') as w:
        sr, ch, sw, n = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
        raw = w.readframes(n)
    if sw != 2:
        raise ValueError(f'sample width {sw}')
    x = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    dur = len(x) / sr
    frame, hop = int(sr * 0.025), int(sr * 0.010)
    if len(x) < frame * 2:
        raise ValueError('too short')
    nfr = 1 + (len(x) - frame) // hop
    idx = np.arange(frame)[None, :] + hop * np.arange(nfr)[:, None]
    e = np.sqrt((x[idx] ** 2).mean(axis=1)) + 1e-9
    db = 20 * np.log10(e)
    voiced = np.where(db > -40)[0]
    lead = (voiced[0] * hop / sr) if len(voiced) else dur
    trail = ((nfr - 1 - voiced[-1]) * hop / sr) if len(voiced) else dur
    return {
        'duration': dur,
        'peak': float(np.abs(x).max()),
        'clip_frac': float((np.abs(x) >= 0.999).mean()),
        'rms_db': float(20 * np.log10(np.sqrt((x ** 2).mean()) + 1e-9)),
        'silence_frac': float((db < -45).mean()),
        'snr_db': float(np.percentile(db, 90) - np.percentile(db, 10)),
        'lead_sil': float(lead),
        'trail_sil': float(trail),
    }


def audio_reject_reason(m):
    if m['clip_frac'] > MAX_CLIP_FRAC:
        return 'clipping'
    if m['silence_frac'] > MAX_SILENCE_FRAC:
        return 'too_much_silence'
    if m['snr_db'] < MIN_SNR_DB:
        return 'noisy_low_snr'
    if m['rms_db'] < MIN_RMS_DB:
        return 'too_quiet'
    if m['rms_db'] > MAX_RMS_DB:
        return 'too_loud'
    if m['lead_sil'] > MAX_EDGE_SILENCE or m['trail_sil'] > MAX_EDGE_SILENCE:
        return 'long_edge_silence'
    return None


def pick(rows, k, max_per_video):
    out, per_video = [], collections.Counter()
    for r in rows:
        if len(out) >= k:
            break
        if per_video[r['video']] >= max_per_video:
            continue
        per_video[r['video']] += 1
        out.append(r)
    return out


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dataset-dir', required=True, help='المجلد الذي فيه metadata.csv ومجلد wavs')
    ap.add_argument('--work-dir', default='work')
    ap.add_argument('--per-speaker', type=int, default=40, help='عدد المقاطع المرشحة لكل متحدث')
    ap.add_argument('--speakers', default='', help='قائمة متحدثين مفصولة بفواصل (الافتراضي: الكل)')
    ap.add_argument('--max-per-video', type=int, default=5, help='حد المقاطع من الحلقة الواحدة لضمان التنوع')
    ap.add_argument('--audio-factor', type=float, default=2.5, help='يُفحص صوتيًا عدد = per-speaker × هذا الرقم')
    ap.add_argument('--no-audio-check', action='store_true', help='تخطّي فحص الصوت (أسرع، ولا يقرأ ملفات Drive)')
    ap.add_argument('--seed', type=int, default=42)
    args = ap.parse_args()

    ds = args.dataset_dir
    os.makedirs(args.work_dir, exist_ok=True)
    rng = random.Random(args.seed)
    wanted = {s.strip() for s in args.speakers.split(',') if s.strip()}

    with open(os.path.join(ds, 'metadata.csv'), encoding='utf-8', newline='') as f:
        rd = csv.reader(f, delimiter='|')
        header = next(rd)
        data = [r for r in rd if len(r) >= 3]
    total = len(data)
    rejected = []  # (audio_file, reason, text)
    reasons = collections.Counter()

    def reject(af, reason, text):
        reasons[reason.split(':')[0]] += 1
        rejected.append((af, reason, text))

    gaf_rows = sum(1 for r in data if '\u06AF' in r[1])
    print(f'{total:,} صفًا في metadata.csv ({header})')

    seen_text = set()
    passing = []
    for af, raw_text, speaker in ((r[0], r[1], r[2]) for r in data):
        if wanted and speaker not in wanted:
            reasons['speaker_not_selected'] += 1
            continue
        t = normalize_text(raw_text)
        why = validate_text(t) or hallucination_reason(t)
        if why:
            reject(af, why, raw_text)
            continue
        if t in seen_text:
            reject(af, 'duplicate_text', raw_text)
            continue
        seen_text.add(t)
        path = os.path.join(ds, af)
        try:
            size = os.stat(path).st_size
        except OSError:
            reject(af, 'missing_wav', raw_text)
            continue
        dur = (size - 44) / (24000 * 2)  # wav أحادي 24kHz/16bit (تم التحقق من عينة عشوائية)
        if dur < MIN_DUR:
            reject(af, 'too_short_audio', raw_text)
            continue
        if dur > MAX_DUR:
            reject(af, 'too_long_audio', raw_text)
            continue
        rate = len(letters_only(t)) / dur
        if not (ABS_RATE[0] <= rate <= ABS_RATE[1]):
            reject(af, 'speech_rate_abs', raw_text)
            continue
        passing.append({'audio_file': af, 'speaker': speaker, 'video': parse_name(af),
                        'text': t, 'whisper_text': raw_text, 'duration': round(dur, 2), 'rate': round(rate, 2)})

    # سرعة الكلام النسبية لكل متحدث
    by_speaker = collections.defaultdict(list)
    for r in passing:
        by_speaker[r['speaker']].append(r)
    selected = []
    per_speaker_stats = {}
    for sp, rows in sorted(by_speaker.items()):
        med = statistics.median(r['rate'] for r in rows)
        ok = []
        for r in rows:
            if not (REL_RATE[0] * med <= r['rate'] <= REL_RATE[1] * med):
                reject(r['audio_file'], 'speech_rate_rel', r['whisper_text'])
                continue
            dur_pen = abs(r['duration'] - IDEAL_DUR) / IDEAL_DUR
            rate_pen = abs(r['rate'] - med) / med
            r['score'] = 1 - 0.5 * dur_pen - 0.5 * rate_pen + rng.uniform(0, 0.1)
            ok.append(r)
        ok.sort(key=lambda r: -r['score'])
        pool_size = math.ceil(args.per_speaker * (1 if args.no_audio_check else args.audio_factor))
        pool = pick(ok, pool_size, args.max_per_video)
        kept = []
        for r in pool:
            if not args.no_audio_check:
                try:
                    m = analyze_audio(os.path.join(ds, r['audio_file']))
                except Exception as e:  # noqa: BLE001
                    reject(r['audio_file'], 'unreadable_audio', r['whisper_text'])
                    continue
                why = audio_reject_reason(m)
                if why:
                    reject(r['audio_file'], why, r['whisper_text'])
                    continue
                r.update({k: round(v, 2) for k, v in m.items() if k in ('rms_db', 'snr_db', 'silence_frac')})
                r['score'] += min(m['snr_db'], 40) / 100.0  # أنقى = أعلى
            kept.append(r)
        kept.sort(key=lambda r: -r['score'])
        final = pick(kept, args.per_speaker, args.max_per_video)
        per_speaker_stats[sp] = (len(rows), len(ok), len(final))
        selected.extend(final)

    for i, r in enumerate(selected):
        r['id'] = r['audio_file']
        r['score'] = round(r['score'], 3)

    with open(os.path.join(args.work_dir, 'review_sheet.json'), 'w', encoding='utf-8') as f:
        json.dump(selected, f, ensure_ascii=False, indent=1)
    with open(os.path.join(args.work_dir, 'rejected.csv'), 'w', encoding='utf-8', newline='') as f:
        w = csv.writer(f, delimiter='|')
        w.writerow(['audio_file', 'reason', 'text'])
        w.writerows(rejected)

    lines = [
        f'الإجمالي في metadata.csv: {total:,}',
        f'صفوف فيها الحرف «گ»: {gaf_rows:,}  (مفردات XTTS لا تحتوي «گ» أصلًا؛ يُكتب [g] بالحرف «ق»)',
        f'مرّت الفلترة النصية والمدة: {len(passing):,}',
        f'مرشّحة للمراجعة: {len(selected):,}',
        '', 'أسباب الرفض:',
    ]
    lines += [f'  {k:24s} {v:,}' for k, v in reasons.most_common()]
    lines += ['', 'لكل متحدث (بعد الفلترة | بعد السرعة | مرشّح):']
    lines += [f'  {sp:18s} {a:6,d} | {b:6,d} | {c:4d}' for sp, (a, b, c) in per_speaker_stats.items()]
    report = '\n'.join(lines)
    with open(os.path.join(args.work_dir, 'report.txt'), 'w', encoding='utf-8') as f:
        f.write(report + '\n')
    sys.stdout.reconfigure(encoding='utf-8')
    print(report)
    print(f'\nالخطوة التالية: node review_server.js --dataset-dir "{ds}" --work-dir "{args.work_dir}"')


if __name__ == '__main__':
    main()
