#!/usr/bin/env python3
"""المرحلة 3: تحويل ما اعتمدتَه في أداة المراجعة إلى ملفات تدريب XTTS.

يكتب metadata_train_clean.csv و metadata_eval_clean.csv داخل مجلد البيانات (ملفات جديدة فقط؛ لا يمس metadata.csv
ولا الصوتيات ولا يستبدل ملفًا موجودًا إلا بـ --force).

مثال:
  python export_training_set.py --dataset-dir "G:/My Drive/Sudanese_Voice_Project/fine_tuning_dataset" \
      --vocab "G:/My Drive/Sudanese_Voice_Project/fine_tuned_model/vocab.json"
"""
import argparse
import collections
import csv
import json
import os
import random
import sys

from textnorm import normalize_text, validate_text


def vocab_chars(path):
    with open(path, encoding='utf-8') as f:
        v = json.load(f)
    chars = set()
    for tok in v['model']['vocab']:
        chars.update(tok)
    return chars


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dataset-dir', required=True)
    ap.add_argument('--work-dir', default='work')
    ap.add_argument('--vocab', default='', help='vocab.json الخاص بـ XTTS للتحقق من أن كل حرف موجود فيه')
    ap.add_argument('--suffix', default='_clean')
    ap.add_argument('--eval-fraction', type=float, default=0.1)
    ap.add_argument('--min-eval', type=int, default=20, help='أقل عدد لمقاطع التقييم الإجمالية')
    ap.add_argument('--seed', type=int, default=42)
    ap.add_argument('--force', action='store_true', help='السماح باستبدال ملفات _clean موجودة')
    args = ap.parse_args()

    with open(os.path.join(args.work_dir, 'review_sheet.json'), encoding='utf-8') as f:
        sheet = {it['id']: it for it in json.load(f)}
    rev_path = os.path.join(args.work_dir, 'reviewed.json')
    if not os.path.exists(rev_path):
        sys.exit('لا يوجد reviewed.json — راجع المقاطع أولًا بأداة المراجعة.')
    with open(rev_path, encoding='utf-8') as f:
        reviewed = json.load(f)

    kept, skipped = [], []
    for rid, r in reviewed.items():
        if r.get('status') != 'keep' or rid not in sheet:
            continue
        text = normalize_text(r.get('text', ''))
        why = validate_text(text)
        if why:
            skipped.append((rid, why, r.get('text', '')))
            continue
        kept.append({'audio_file': sheet[rid]['audio_file'], 'text': text, 'speaker_name': sheet[rid]['speaker']})

    dropped = sum(1 for r in reviewed.values() if r.get('status') == 'drop')
    print(f'معتمد: {len(kept)} | محذوف: {dropped} | مُهمَل بعد التحقق: {len(skipped)} | لم يُراجَع: {len(sheet) - len(reviewed)}')
    for rid, why, t in skipped[:15]:
        print(f'  ✗ {why:22s} {rid}  «{t}»')
    if not kept:
        sys.exit('لا مقاطع معتمدة.')

    # التحقق من المفردات
    missing = collections.Counter()
    if args.vocab:
        vc = vocab_chars(args.vocab)
        for k in kept:
            for ch in set(k['text']):
                if ch != ' ' and ch not in vc:
                    missing[ch] += 1
        if missing:
            print('⚠️ حروف غير موجودة في مفردات XTTS (ستُحذف بصمت أثناء التدريب):', dict(missing))
            sys.exit(2)
        print('✓ كل الحروف موجودة في مفردات XTTS')
    else:
        print('تنبيه: لم تُمرِّر --vocab فلم أتحقق من المفردات.')

    # تقسيم تدريب/تقييم لكل متحدث
    rng = random.Random(args.seed)
    by_sp = collections.defaultdict(list)
    for k in kept:
        by_sp[k['speaker_name']].append(k)
    train, ev = [], []
    for sp, rows in by_sp.items():
        rng.shuffle(rows)
        n_eval = round(len(rows) * args.eval_fraction) if len(rows) >= 10 else 0
        ev += rows[:n_eval]
        train += rows[n_eval:]
    if len(ev) < args.min_eval and len(train) > args.min_eval * 3:
        rng.shuffle(train)
        need = args.min_eval - len(ev)
        ev += train[:need]
        train = train[need:]

    out_train = os.path.join(args.dataset_dir, f'metadata_train{args.suffix}.csv')
    out_eval = os.path.join(args.dataset_dir, f'metadata_eval{args.suffix}.csv')
    for p in (out_train, out_eval):
        if os.path.exists(p) and not args.force:
            sys.exit(f'{p} موجود. استخدم --force لاستبداله.')
    for path, rows in ((out_train, train), (out_eval, ev)):
        with open(path, 'w', encoding='utf-8', newline='') as f:
            w = csv.writer(f, delimiter='|')
            w.writerow(['audio_file', 'text', 'speaker_name'])
            w.writerows([[r['audio_file'], r['text'], r['speaker_name']] for r in rows])

    print(f'\nكُتب: {out_train}  ({len(train)} مقطعًا)')
    print(f'كُتب: {out_eval}  ({len(ev)} مقطعًا)')
    print('لكل متحدث:', {sp: len(r) for sp, r in by_sp.items()})
    if len(train) < 150:
        print('تنبيه: أقل من 150 مقطعًا للتدريب؛ النتيجة غالبًا ضعيفة. زد المراجعة قبل التدريب.')


if __name__ == '__main__':
    main()
