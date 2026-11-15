# تنظيف بيانات تدريب XTTS للهجة السودانية

ثلاث خطوات، تعمل على جهازك مباشرة (مجلد Drive متاح كـ `G:`). تحتاج `python` مع `numpy`، و`node`.

```
cd data_cleaning
# 1) فلترة آلية وترشيح مقاطع (قراءة فقط؛ ~10 دقائق لأن Drive يحمّل الملفات المفحوصة)
python clean_dataset.py --dataset-dir "G:/My Drive/Sudanese_Voice_Project/fine_tuning_dataset" --per-speaker 40

# 2) مراجعتك بالسمع: صحّح النص ليطابق الكلام فعلًا، واعتمد أو احذف (يحفظ تقدّمك تلقائيًا في work/reviewed.json)
node review_server.js --dataset-dir "G:/My Drive/Sudanese_Voice_Project/fine_tuning_dataset" --work-dir work
#    ثم افتح http://localhost:3100

# 3) تصدير ملفات التدريب (يكتب metadata_train_clean.csv و metadata_eval_clean.csv ولا يمس metadata.csv)
python export_training_set.py --dataset-dir "G:/My Drive/Sudanese_Voice_Project/fine_tuning_dataset" \
    --vocab "G:/My Drive/Sudanese_Voice_Project/fine_tuned_model/vocab.json"
```

بعدها شغّل `Sudanese_XTTS_Fine_Tuning.ipynb`: إن وجد الملفين `_clean` استخدمهما تلقائيًا (20 دورة)، وإلا يعود للعينة العشوائية القديمة.

## قواعد كتابة النص أثناء المراجعة

- اكتب **ما يُقال بالضبط**، بإملاء ثابت: «دا، دي، شنو، هسي، دحين…». لا تصحّحه إلى الفصحى.
- الصوت [g] اكتبه **«ق»** (مثل «قال» التي تُنطق گال). مفردات XTTS لا تعرف «گ» وتحذفها بصمت. لو كتبتها «گ» فالتصدير يحوّلها إلى «ق».
- بلا تشكيل، وبلا أرقام ولا حروف لاتينية (اكتب الرقم كلامًا: «ألفين وخمسة»).
- احذف المقطع إن كان فيه أكثر من متحدث، أو موسيقى/ضجيج، أو كلام مقطوع، أو لا تثق بنصه.

## ما يفعله `clean_dataset.py` آليًا

يرفض: حروف غير عربية/أرقام، نصوص أقل من 3 كلمات، تكرار كلمات (حلقات Whisper)، عبارات هلوسة معروفة («اشتركوا في القناة»…)، نصوص مكررة، ملفات مفقودة، مدة خارج 2.5–11 ثانية (التدريب يُسقط ما فوق ~11.6 ث)، سرعة كلام غير معقولة (النص لا يطابق الصوت)، تشبّع/ضجيج/صمت زائد. ويوزّع الترشيح على المتحدثين والحلقات لضمان التنوع. السبب لكل مقطع مرفوض في `work/rejected.csv`.

## اختبار الأدوات

```
python test_pipeline.py
```
